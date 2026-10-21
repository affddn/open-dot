import { SessionMessage } from "@opencode/client/effect";
import { inArray, ne } from "drizzle-orm";
import { Effect, type Layer } from "effect";
import type { Db } from "./db";
import { findDot, listDots } from "./dots";
import { dismiss, unreadFeed } from "./feed";
import { OpenCode, type Entry, type OpenCodeError } from "./opencode";
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
      const base = { id: item.id, text: item.text, tools: item.tools, time: item.time };
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
  if (root !== "dots" || extra.length > 0) return Effect.succeed(error(404, "Not found"));
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
  if (rest === "messages" && request.method === "GET") return conversation(db, dot);
  if (rest === "messages" && request.method === "POST") return send(db, dot, request);
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
