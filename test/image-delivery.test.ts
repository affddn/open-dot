import { Service } from "@opencode/client/service";
import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { api } from "../src/api";
import { deliver } from "../src/daemon";
import { openDatabase } from "../src/db";
import { OpenCode } from "../src/opencode";
import { dots, outbox } from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

test("images survive SQLite reopen and public HTTP delivery, including lost admission and failed lookup without repost", async () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-images-"));
  const path = join(directory, "open-dot.db");
  let db = openDatabase(path);
  const files = [
    {
      mime: "image/png",
      name: "one.png",
      data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString("base64"),
    },
    {
      mime: "image/jpeg",
      name: "two.jpg",
      data: Buffer.from([255, 216, 255, 2]).toString("base64"),
    },
    { mime: "image/gif", name: "three.gif", data: Buffer.from("GIF87a123").toString("base64") },
    {
      mime: "image/webp",
      name: "four.webp",
      data: Buffer.from("RIFF1234WEBP5678").toString("base64"),
    },
  ];
  const discover = spyOn(Service, "discover").mockResolvedValue({
    url: "http://opencode.test",
    auth: undefined,
  });
  const admitted = new Map<string, object>();
  const history: object[] = [];
  const posts: unknown[] = [];
  let lost = false;
  let lookupFailure = false;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const url = new URL(request.url);
    assert.equal(url.origin, "http://opencode.test", "No real network calls are allowed");
    if (url.pathname === "/api/session/ses_images/inbox") {
      if (lookupFailure) return new Response("unavailable", { status: 503 });
      return Response.json({ data: [...admitted.values()] });
    }
    if (url.pathname === "/api/session/ses_images/prompt") {
      const body = (await request.json()) as {
        id: string;
        text: string;
        files: { uri: string; name: string }[];
        delivery: string;
        resume: null;
      };
      posts.push(body);
      const saved = db
        .select()
        .from(outbox)
        .all()
        .find((row) => row.messageID === body.id);
      assert(saved, "The saved ID must precede the public prompt call");
      expect(saved.files).toEqual(files);
      expect(saved.startedAt).not.toBeNull();
      expect(body).toEqual({
        id: saved.messageID,
        text: saved.text,
        delivery: "queue",
        resume: null,
        files: files.map(({ mime, name, data }) => ({ uri: `data:${mime};base64,${data}`, name })),
      });
      const payload = {
        text: body.text,
        files: files.map((file) => ({ ...file, source: { type: "inline" } })),
      };
      const item = {
        type: "user",
        id: body.id,
        sessionID: "ses_images",
        delivery: "queue",
        time: { created: 1 },
        payload,
      };
      admitted.set(body.id, item);
      history.push({ type: "user", id: body.id, time: { created: 1 }, ...payload });
      if (lost) throw new TypeError("Response lost after admission");
      return Response.json({ data: item });
    }
    if (url.pathname === "/api/session/ses_images/message")
      return Response.json({ data: history.toReversed(), cursor: {} });
    if (url.pathname.startsWith("/api/session/ses_images/message/"))
      return Response.json(
        {
          _tag: "MessageNotFoundError",
          sessionID: "ses_images",
          messageID: url.pathname.split("/").at(-1),
          message: "Absent",
        },
        { status: 404 },
      );
    throw new Error(`Unexpected fake HTTP request: ${request.method} ${url.pathname}`);
  };
  const transport: typeof fetch = Object.assign(fakeFetch, {
    preconnect: () => {
      throw new Error("Unexpected fake HTTP preconnect");
    },
  });
  const fetched = spyOn(globalThis, "fetch").mockImplementation(transport);
  try {
    db.insert(dots)
      .values({
        name: "images",
        directory: "/dots/images",
        sessionID: "ses_images",
        sessionState: "ready",
        createdAt: 0,
      })
      .run();
    const fake = fakeOpenCode();
    for (const text of ["", "Look at these"])
      expect(
        (
          await api(
            db,
            "token",
            fake.layer,
          )(
            new Request("http://local/dots/images/messages", {
              method: "POST",
              headers: { authorization: "Bearer token" },
              body: JSON.stringify({ text, files }),
            }),
          )
        ).status,
      ).toBe(202);
    const before = db.select().from(outbox).all();
    db.$client.close();
    db = openDatabase(path);
    expect(db.select().from(outbox).all()).toEqual(before);
    const [first, second] = before;
    assert(first && second);
    await Effect.runPromise(deliver(db, first).pipe(Effect.provide(OpenCode.layer)));
    expect(db.select().from(outbox).all()[0]?.state).toBe("sent");
    lost = true;
    expect(
      await Effect.runPromise(
        deliver(db, second).pipe(Effect.provide(OpenCode.layer), Effect.isFailure),
      ),
    ).toBe(true);
    expect(db.select().from(outbox).all()[1]?.state).toBe("pending");
    db.$client.close();
    db = openDatabase(path);
    const pending = db.select().from(outbox).all()[1];
    assert(pending);
    lookupFailure = true;
    expect(
      await Effect.runPromise(
        deliver(db, pending).pipe(Effect.provide(OpenCode.layer), Effect.isFailure),
      ),
    ).toBe(true);
    expect(posts).toHaveLength(2);
    expect(db.select().from(outbox).all()[1]?.state).toBe("pending");
    lookupFailure = false;
    await Effect.runPromise(deliver(db, pending).pipe(Effect.provide(OpenCode.layer)));
    expect(posts).toHaveLength(2);
    expect(
      db
        .select()
        .from(outbox)
        .all()
        .map((row) => row.state),
    ).toEqual(["sent", "sent"]);
    const get = (suffix: string) =>
      api(
        db,
        "token",
        OpenCode.layer,
      )(
        new Request(`http://local/dots/images/messages${suffix}`, {
          headers: { authorization: "Bearer token" },
        }),
      );
    const messages = await (await get("")).json();
    expect(messages).toMatchObject({
      messages: [
        {
          id: first.messageID,
          kind: "owner",
          text: "",
          attachments: files.map(({ mime, name }, index) => ({ index, mime, name })),
        },
        { id: second.messageID, kind: "owner", text: "Look at these" },
      ],
    });
    for (const [index, file] of files.entries()) {
      const response = await get(`/${first.messageID}/attachments/${index}`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(file.data);
    }
  } finally {
    fetched.mockRestore();
    discover.mockRestore();
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
