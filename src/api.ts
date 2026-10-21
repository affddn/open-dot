import { SessionMessage } from "@opencode/client/effect";
import { inArray, ne } from "drizzle-orm";
import { Effect, type Layer } from "effect";
import type { Db } from "./db";
import { findDot, listDots } from "./dots";
import { dismiss, unreadFeed } from "./feed";
import { type Attachment, OpenCode, type Entry, type OpenCodeError } from "./opencode";
import { type Dot, outbox, workers } from "./schema";

const error = (status: number, message: string) => Response.json({ error: message }, { status });

// History items include idles and other events, so read more than are shown.
const shown = 50;
const read = 100;

const framed = /<dot-message from="[^"]*">\n([\s\S]*)\n<\/dot-message>$/;

const listAll = (db: Db) =>
  Effect.gen(function* () {
    const active = yield* (yield* OpenCode).activeSessions;
    const unfinished = db.select().from(workers).where(ne(workers.state, "done")).all();
    return Response.json(
      listDots(db).map((dot) => ({
        name: dot.name,
        purpose: dot.purpose,
        busy: active.has(dot.sessionID),
        workers: unfinished
          .filter((worker) => worker.dot === dot.name)
          .map((worker) => ({
            id: worker.id,
            state: worker.waitingOn ? "waiting" : worker.state,
            task: worker.task.split("\n")[0],
          })),
      })),
    );
  });

/** Who wrote each message: the owner, the dot, another dot, or open-dot itself (a notice). */
const conversation = (db: Db, dot: Dot) =>
  Effect.gen(function* () {
    if (dot.sessionState !== "ready") return Response.json({ messages: [] });
    const entries = yield* (yield* OpenCode).recentMessages(dot.sessionID, read);
    const ids = entries.map((item) => item.id);
    const sent = new Map(
      (ids.length === 0
        ? []
        : db.select().from(outbox).where(inArray(outbox.messageID, ids)).all()
      ).map((row) => [row.messageID, row]),
    );
    const label = (item: Entry) => {
      const base = {
        id: item.id,
        text: item.text,
        tools: item.tools,
        // Metadata only: the notch loads each image's bytes on its own.
        attachments: item.files.map((file, index) => ({
          index,
          mime: file.mime,
          name: file.name ?? null,
        })),
        time: item.time,
      };
      // Show what the dot said and the open-dot actions it took, not mechanics such as shell
      // commands, file reads or compaction.
      if (item.role === "assistant") {
        const actions = item.tools.filter((tool) => tool.startsWith("dot_"));
        return item.text || actions.length > 0 ? [{ ...base, tools: actions, kind: "dot" }] : [];
      }
      const row = sent.get(item.id);
      if (!row || row.fromOwner) return [{ ...base, kind: "owner" }];
      if (!row.fromDot) return [{ ...base, kind: "notice" }];
      const inner = framed.exec(item.text)?.[1]?.replace(/<\\\/dot-message/gi, "</dot-message");
      return [{ ...base, kind: "peer", peer: row.fromDot, text: inner ?? item.text }];
    };
    return Response.json({ messages: entries.flatMap(label).slice(-shown) });
  });

// The raster types the notch may decode, by the bytes each file starts with. Undefined matches any
// byte. SVG and other types aren't served, so they show only as a name.
const images = new Map<string, readonly (number | undefined)[]>(
  Object.entries({
    "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "image/jpeg": [0xff, 0xd8, 0xff],
    "image/gif": [0x47, 0x49, 0x46, 0x38],
    // RIFF, a 4-byte size, then WEBP.
    "image/webp": [
      0x52,
      0x49,
      0x46,
      0x46,
      undefined,
      undefined,
      undefined,
      undefined,
      0x57,
      0x45,
      0x42,
      0x50,
    ],
  }),
);
// The largest image served; a larger one gets 413.
const attachmentLimit = 10 * 1024 * 1024;
// Plain base64, as OpenCode stores it, or the same as an image data URL. Never a path or a URL
// to fetch.
const inline = /^(?:data:image\/[\w.+-]+;base64,)?([A-Za-z0-9+/]*={0,2})$/;

/** The attachment's bytes if it's an allowed image whose bytes match its type, else why not. */
const imageBytes = (file: Attachment) => {
  const mime = file.mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const signature = images.get(mime);
  if (!signature) return error(415, "Only PNG, JPEG, GIF and WebP attachments are served.");
  if (file.data.length > Math.ceil(attachmentLimit / 3) * 4 + 64)
    return error(413, "The attachment is over 10 MB.");
  const encoded = inline.exec(file.data)?.[1];
  if (encoded === undefined || encoded.length % 4 !== 0)
    return error(422, "The attachment isn't inline base64 data.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > attachmentLimit) return error(413, "The attachment is over 10 MB.");
  if (!signature.every((byte, at) => byte === undefined || bytes[at] === byte))
    return error(415, "The attachment's bytes aren't the image type it claims.");
  return new Response(bytes, {
    headers: {
      "content-type": mime,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
};

/** An attachment's bytes, from a user message in the dot's own session only. */
const attachment = (dot: Dot, id: string, index: string) =>
  Effect.gen(function* () {
    // One spelling per index, so "01" can't stand for 1.
    if (!/^(?:0|[1-9]\d{0,3})$/.test(index)) return error(400, "Bad attachment index.");
    if (dot.sessionState !== "ready") return error(404, "There's no such attachment.");
    const entries = yield* (yield* OpenCode).recentMessages(dot.sessionID, read);
    const file = entries.find((item) => item.id === id)?.files[Number(index)];
    return file ? imageBytes(file) : error(404, "There's no such attachment.");
  });

const send = (db: Db, dot: Dot, request: Request) =>
  Effect.gen(function* () {
    const body = yield* Effect.tryPromise(() => request.json()).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const text =
      typeof body === "object" && body !== null && "text" in body && typeof body.text === "string"
        ? body.text.trim()
        : "";
    if (!text) return error(400, "Send a JSON body with a non-empty text.");
    if (dot.sessionState !== "ready") return error(400, `${dot.name} isn't ready yet.`);
    const row = db
      .insert(outbox)
      .values({
        sessionID: dot.sessionID,
        messageID: SessionMessage.ID.create(),
        text,
        state: "pending",
        fromOwner: true,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    return Response.json({ id: row.messageID }, { status: 202 });
  });

const feedRoute = (db: Db, request: Request, path: string[]) => {
  if (path.length === 0 && request.method === "GET") {
    const items = unreadFeed(db).map(({ id, source, reason, title, context, url, updatedAt }) => ({
      id,
      source,
      reason,
      title,
      context,
      url,
      time: updatedAt,
    }));
    return Response.json({ items });
  }
  const [id, action] = path;
  if (
    path.length === 2 &&
    action === "dismiss" &&
    request.method === "POST" &&
    /^\d+$/.test(id ?? "")
  )
    return dismiss(db, Number(id))
      ? new Response(null, { status: 204 })
      : error(404, "There's no such feed item.");
  return error(404, "Not found");
};

const route = (
  db: Db,
  request: Request,
  path: string[],
): Effect.Effect<Response, OpenCodeError, OpenCode> => {
  const [root, name, rest, ...extra] = path;
  if (root !== "dots") return Effect.succeed(error(404, "Not found"));
  if (name === undefined)
    return request.method === "GET" ? listAll(db) : Effect.succeed(error(404, "Not found"));
  const decoded = (() => {
    try {
      return decodeURIComponent(name);
    } catch {
      return undefined;
    }
  })();
  if (decoded === undefined) return Effect.succeed(error(400, "Bad dot name."));
  const dot = findDot(db, decoded);
  if (!dot) return Effect.succeed(error(404, `There's no dot named "${name}".`));
  if (rest === "messages" && extra.length === 0) {
    if (request.method === "GET") return conversation(db, dot);
    if (request.method === "POST") return send(db, dot, request);
  }
  const [id, part, index, ...more] = extra;
  if (
    rest === "messages" &&
    part === "attachments" &&
    id !== undefined &&
    index !== undefined &&
    more.length === 0 &&
    request.method === "GET"
  )
    return attachment(dot, id, index);
  return Effect.succeed(error(404, "Not found"));
};

/**
 * The daemon's local API for the notch app. Every request needs the token, which only the owner's
 * account can read from api.json, so other local users and web pages can't call it.
 * The feed doesn't need OpenCode, so it works while OpenCode is down.
 */
export const api =
  (db: Db, token: string, layer: Layer.Layer<OpenCode, OpenCodeError>) =>
  (request: Request): Promise<Response> => {
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return Promise.resolve(error(401, "Unauthorized"));
    const path = new URL(request.url).pathname.split("/").filter(Boolean);
    if (path[0] === "feed") return Promise.resolve(feedRoute(db, request, path.slice(1)));
    return Effect.runPromise(
      route(db, request, path).pipe(
        Effect.provide(layer),
        Effect.catch((failure) => Effect.succeed(error(503, failure.message))),
      ),
    );
  };
