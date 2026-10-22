import { SessionMessage } from "@opencode/client/effect";
import { Service } from "@opencode/client/service";
import { beforeEach, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { api } from "../src/api";
import { step } from "../src/daemon";
import { type Db, openDatabase } from "../src/db";
import { OpenCode } from "../src/opencode";
import { dots, outbox, type Route } from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;

beforeEach(() => {
  db = openDatabase(":memory:");
  fake = fakeOpenCode();
  db.insert(dots)
    .values({
      name: "jojo",
      directory: "/dots/jojo",
      sessionID: "ses_jojo",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
});

const tick = () => Effect.runPromise(Effect.provide(step(db), fake.layer));

const call = (path: string, body?: unknown) =>
  api(
    db,
    "secret",
    fake.layer,
  )(
    new Request(`http://127.0.0.1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer secret" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** Posts the owner's notch message, as the notch does, and returns its saved ID. */
const post = async (body: unknown) => {
  const response = await call("/dots/jojo/messages", body);
  expect(response.status).toBe(202);
  return ((await response.json()) as { id: string }).id;
};

const conversation = async () =>
  (await (await call("/dots/jojo/messages")).json()) as {
    messages: { id: string; kind: string; text: string; quote?: unknown }[];
    pending: { id: string; status: string }[];
  };

const row = (messageID: string) =>
  db.select().from(outbox).where(eq(outbox.messageID, messageID)).get();

/** OpenCode hands the message to the turn, moving it from the inbox into the history. */
const deliverInto = (id: string, text: string) => {
  fake.state.inbox = fake.state.inbox.filter((item) => item.id !== id);
  fake.state.history.set("ses_jojo", [
    ...(fake.state.history.get("ses_jojo") ?? []),
    { id, role: "user", text, tools: [], files: [], time: 1 },
  ]);
};

const thread: Route = {
  kind: "shared",
  dot: "jojo",
  sessionID: "ses_jojo",
  owner: "U1",
  team: "T1",
  bot: "B1",
  dm: true,
  channel: "D1",
  thread: "1.1",
};

const unrouted = (messageID: string, route: Route | null = null) =>
  db
    .insert(outbox)
    .values({
      sessionID: "ses_jojo",
      messageID,
      text: messageID,
      route,
      state: "pending",
      createdAt: 0,
    })
    .run();

test("idle owner messages queue, busy ones steer mid-tool with files and quote, and the mode is saved before the call", async () => {
  const saved: unknown[] = [];
  fake.state.onPrompt = (id) => saved.push(row(id));
  const first = await post({ text: "Look into the build." });
  expect(row(first)).toMatchObject({ delivery: "auto", startedAt: null, state: "pending" });
  expect((await conversation()).pending).toEqual([{ id: first, status: "sending" }]);
  await tick();
  expect(fake.state.deliveries.get(first)).toBe("queue");
  expect((await conversation()).pending).toEqual([{ id: first, status: "sent" }]);

  // The turn started with the first message and is now running a tool.
  deliverInto(first, "Look into the build.");
  fake.state.active.add("ses_jojo");
  fake.state.history.set("ses_jojo", [
    ...(fake.state.history.get("ses_jojo") ?? []),
    { id: "msg_dot", role: "assistant", text: "Checking.", tools: ["shell"], files: [], time: 2 },
  ]);
  const files = [{ mime: "image/png", name: "ci.png", data: "iVBORw0KGgo=" }];
  const second = await post({ text: "Also this.", replyTo: "msg_dot", files });
  await tick();
  expect(fake.state.prompted).toEqual([first, second]);
  expect(fake.state.deliveries.get(second)).toBe("steer");
  expect(fake.state.files.get(second)).toEqual(files);
  expect(fake.state.texts[1]?.text).toContain("Also this.");
  expect(fake.state.texts[1]?.text).toContain("<reply-quote>");
  expect(saved).toMatchObject([
    { messageID: first, delivery: "queue", startedAt: expect.any(Number), state: "pending" },
    { messageID: second, delivery: "steer", startedAt: expect.any(Number), state: "pending" },
  ]);

  // Admitted but still waiting for the tool to finish: sent, not delivered.
  let shown = await conversation();
  expect(shown.pending).toEqual([{ id: second, status: "sent" }]);
  expect(shown.messages.map((message) => message.id)).toEqual([first, "msg_dot"]);
  deliverInto(second, row(second)?.text ?? "");
  shown = await conversation();
  expect(shown.pending).toEqual([]);
  expect(shown.messages.at(-1)).toMatchObject({
    id: second,
    kind: "owner",
    text: "Also this.",
    quote: { id: "msg_dot", author: "dot", text: "Checking." },
  });
});

test("notices and Slack never steer, a waiting notice holds the owner's message behind it, and another route holds it entirely", async () => {
  unrouted("slack_a", thread);
  await tick();
  fake.state.active.add("ses_jojo");
  unrouted("slack_a2", thread);
  const native = await post({ text: "Are you there?" });
  await tick();
  // The Slack follow-up joins its own thread's turn queued; the owner's message waits for that turn.
  expect(fake.state.prompted).toEqual(["slack_a", "slack_a2"]);
  expect(fake.state.deliveries.get("slack_a2")).toBe("queue");
  expect((await conversation()).pending).toEqual([{ id: native, status: "sending" }]);

  for (const id of ["slack_a", "slack_a2"])
    fake.state.messageTurns.set(id, { end: "idle_A", outcome: "succeeded", text: undefined });
  fake.state.active.clear();
  fake.state.inbox = [];
  await tick();
  expect(fake.state.deliveries.get(native)).toBe("queue");

  // The owner's turn runs; a worker report arrives and waits, queued, for the turn to end.
  fake.state.inbox = [];
  fake.state.active.add("ses_jojo");
  unrouted("report");
  await tick();
  expect(fake.state.deliveries.get("report")).toBe("queue");
  const behind = await post({ text: "One more thing." });
  await tick();
  expect(fake.state.deliveries.get(behind)).toBe("queue");

  // Once nothing queued is waiting, the next one steers.
  fake.state.inbox = [];
  const next = await post({ text: "And this." });
  await tick();
  expect(fake.state.deliveries.get(next)).toBe("steer");
  expect(fake.state.prompted).toEqual(["slack_a", "slack_a2", native, "report", behind, next]);
});

test("a lost steer survives reopening and a failed lookup, and is never sent twice or re-decided", async () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-steer-"));
  const path = join(directory, "open-dot.db");
  db.$client.close();
  db = openDatabase(path);
  db.insert(dots)
    .values({
      name: "jojo",
      directory: "/dots/jojo",
      sessionID: "ses_jojo",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
  try {
    const first = await post({ text: "First." });
    await tick();
    // The first message started the turn, so it has left the inbox.
    fake.state.inbox = [];
    fake.state.active.add("ses_jojo");
    fake.state.prompt = "lost";
    const lost = await post({ text: "Lost answer." });
    await tick();
    expect(fake.state.prompted).toEqual([first, lost]);
    expect(row(lost)).toMatchObject({ state: "pending", delivery: "steer" });
    expect((await conversation()).pending).toContainEqual({ id: lost, status: "confirming" });

    db.$client.close();
    db = openDatabase(path);
    fake.state.prompt = "ok";
    fake.state.lookupFailure = true;
    await tick();
    expect(fake.state.prompted).toEqual([first, lost]);
    expect(row(lost)?.state).toBe("pending");

    fake.state.lookupFailure = false;
    fake.state.active.clear();
    await tick();
    expect(fake.state.prompted).toEqual([first, lost]);
    expect(row(lost)).toMatchObject({ state: "sent", delivery: "steer" });

    // Refused before admission: sent again once, by the same ID, in the mode saved before the call.
    fake.state.active.add("ses_jojo");
    fake.state.inbox = [];
    fake.state.prompt = "fail";
    const refused = await post({ text: "Refused." });
    await tick();
    expect(row(refused)).toMatchObject({ state: "pending", delivery: "steer" });
    db.$client.close();
    db = openDatabase(path);
    fake.state.active.clear();
    fake.state.prompt = "ok";
    await tick();
    await tick();
    expect(fake.state.prompted).toEqual([first, lost, refused]);
    expect(fake.state.deliveries.get(refused)).toBe("steer");
    expect(row(refused)?.state).toBe("sent");
    assert.equal(db.select().from(outbox).all().length, 3);
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("over the public client, the saved mode reaches OpenCode, and only the history counts as delivered", async () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-steer-http-"));
  const path = join(directory, "open-dot.db");
  db.$client.close();
  db = openDatabase(path);
  db.insert(dots)
    .values({
      name: "jojo",
      directory: "/dots/jojo",
      sessionID: "ses_jojo",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
  const files = [{ mime: "image/png", name: "ci.png", data: "iVBORw0KGgo=" }];
  const discover = spyOn(Service, "discover").mockResolvedValue({
    url: "http://opencode.test",
    auth: undefined,
  });
  const inbox = new Map<string, Record<string, unknown>>();
  const history: Record<string, unknown>[] = [];
  const posts: { id: string; text: string; delivery: string; files?: unknown }[] = [];
  let busy = false;
  let lost = false;
  let lookupFailure = false;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const url = new URL(request.url);
    assert.equal(url.origin, "http://opencode.test", "No real network calls are allowed");
    if (url.pathname === "/api/session/active")
      return Response.json({ data: busy ? { ses_jojo: { type: "running" } } : {} });
    if (url.pathname === "/api/session/ses_jojo/inbox") {
      if (lookupFailure) return new Response("unavailable", { status: 503 });
      return Response.json({ data: [...inbox.values()] });
    }
    if (url.pathname === "/api/session/ses_jojo/prompt") {
      const body = (await request.json()) as (typeof posts)[number];
      const saved = row(body.id);
      assert(saved?.startedAt, "The ID and its start must be saved before the call");
      expect(body.delivery).toBe(saved.delivery ?? "queue");
      posts.push(body);
      const inline = files.map((file) => ({ ...file, source: { type: "inline" } }));
      const payload = { text: body.text, ...(body.files ? { files: inline } : {}) };
      const item = {
        type: "user",
        id: body.id,
        sessionID: "ses_jojo",
        delivery: body.delivery,
        time: { created: 1 },
        payload,
      };
      inbox.set(body.id, item);
      if (lost) throw new TypeError("Response lost after admission");
      return Response.json({ data: item });
    }
    if (url.pathname === "/api/session/ses_jojo/message")
      return Response.json({
        data: url.searchParams.get("order") === "asc" ? history : history.toReversed(),
        cursor: {},
      });
    if (url.pathname.startsWith("/api/session/ses_jojo/message/"))
      return Response.json(
        {
          _tag: "MessageNotFoundError",
          sessionID: "ses_jojo",
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
  // The fake goes to the Effect client as its Fetch service. FetchHttpClient caches its default,
  // globalThis.fetch, on first use, so a global spy would serve only the first such test in a run.
  const layer = Layer.merge(OpenCode.layer, Layer.succeed(FetchHttpClient.Fetch, transport));
  const fetched = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      () => {
        throw new Error("Global fetch is not allowed: use the injected fake");
      },
      { preconnect: () => {} },
    ),
  );
  // OpenCode hands admitted input to the turn: the inbox row becomes a history message.
  const handOver = (id: string) => {
    const item = inbox.get(id) as { payload: object } | undefined;
    assert(item, `${id} must be waiting in the inbox`);
    inbox.delete(id);
    history.push({ type: "user", id, time: { created: 1 }, ...item.payload });
  };
  const poll = () => Effect.runPromise(step(db).pipe(Effect.provide(layer)));
  const shown = async () =>
    (await (
      await api(
        db,
        "secret",
        layer,
      )(
        new Request("http://127.0.0.1/dots/jojo/messages", {
          headers: { authorization: "Bearer secret" },
        }),
      )
    ).json()) as { messages: { id: string }[]; pending: { id: string; status: string }[] };
  try {
    const first = await post({ text: "First." });
    await poll();
    expect(posts.map((body) => body.delivery)).toEqual(["queue"]);
    handOver(first);
    busy = true;

    // Mid-tool: admitted as a steer, it stays in the inbox, so it's sent but not delivered.
    const second = await post({ text: "Steer this.", files });
    await poll();
    expect(posts[1]).toMatchObject({
      id: second,
      delivery: "steer",
      files: [{ uri: "data:image/png;base64,iVBORw0KGgo=", name: "ci.png" }],
    });
    let view = await shown();
    expect(view.messages.map((message) => message.id)).toEqual([first]);
    expect(view.pending).toEqual([{ id: second, status: "sent" }]);

    // A worker report waits queued for the turn to end, and keeps the next owner message behind it.
    const report = SessionMessage.ID.create();
    db.insert(outbox)
      .values({
        sessionID: "ses_jojo",
        messageID: report,
        text: "Worker #1 finished (succeeded).",
        state: "pending",
        createdAt: 0,
      })
      .run();
    await poll();
    const third = await post({ text: "Behind the report." });
    await poll();
    expect(posts.map((body) => [body.id, body.delivery])).toEqual([
      [first, "queue"],
      [second, "steer"],
      [report, "queue"],
      [third, "queue"],
    ]);

    // The tool finishes: the steer is delivered first, and leaves the pending list.
    handOver(second);
    view = await shown();
    expect(view.messages.map((message) => message.id)).toEqual([first, second]);
    expect(view.pending).toEqual([{ id: third, status: "sent" }]);

    // A lost answer is confirmed by ID after reopening and a failed lookup, never posted again.
    handOver(report);
    handOver(third);
    lost = true;
    const fourth = await post({ text: "Lost answer." });
    await poll();
    expect(row(fourth)).toMatchObject({ state: "pending", delivery: "steer" });
    expect((await shown()).pending).toEqual([{ id: fourth, status: "confirming" }]);
    db.$client.close();
    db = openDatabase(path);
    lost = false;
    lookupFailure = true;
    await poll();
    expect(row(fourth)?.state).toBe("pending");
    lookupFailure = false;
    busy = false;
    await poll();
    expect(row(fourth)).toMatchObject({ state: "sent", delivery: "steer" });
    expect(posts).toHaveLength(5);
    expect(fetched).not.toHaveBeenCalled();
  } finally {
    fetched.mockRestore();
    discover.mockRestore();
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
