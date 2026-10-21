import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { api } from "../src/api";
import { step } from "../src/daemon";
import { type Db, openDatabase } from "../src/db";
import { OpenCode, OpenCodeError } from "../src/opencode";
import { dots, feed, outbox, workers } from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;

beforeEach(() => {
  db = openDatabase(":memory:");
  fake = fakeOpenCode();
  for (const name of ["jojo", "polnareff"])
    db.insert(dots)
      .values({
        name,
        directory: `/dots/${name}`,
        sessionID: `ses_${name}`,
        sessionState: "ready",
        purpose: name === "jojo" ? "Second brain." : null,
        createdAt: name === "jojo" ? 0 : 1,
      })
      .run();
});

const call = (
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  layer: Layer.Layer<OpenCode, OpenCodeError> = fake.layer,
) =>
  api(
    db,
    "secret",
    layer,
  )(
    new Request(`http://127.0.0.1${path}`, {
      ...init,
      headers: { authorization: "Bearer secret", ...init.headers },
    }),
  );

const conversation = async () => {
  const body = (await (await call("/dots/jojo/messages")).json()) as {
    messages: { id: string; kind: string }[];
  };
  return body.messages;
};

const queued = (messageID: string, text: string, from: { fromDot?: string; fromOwner?: boolean }) =>
  db
    .insert(outbox)
    .values({ sessionID: "ses_jojo", messageID, text, state: "sent", createdAt: 0, ...from })
    .run();

const entry = (id: string, role: "user" | "assistant", text: string, tools: string[] = []) => ({
  id,
  role,
  text,
  tools,
  time: 0,
});

test("requests need the token, and fail with 503 while OpenCode is down", async () => {
  expect((await call("/dots", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  const down = Layer.effect(OpenCode, Effect.fail(new OpenCodeError({ message: "Not running" })));
  const response = await call("/dots", {}, down);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Not running" });
});

test("/dots lists each dot with whether it's busy and its unfinished workers", async () => {
  fake.state.active.add("ses_jojo");
  const worker = { dot: "jojo", directory: "/w", sessionID: "ses_w", createdAt: 0 };
  db.insert(workers)
    .values([
      { ...worker, task: "Fix the build\nIt fails on main.", state: "running" },
      { ...worker, task: "Deploy", state: "running", waitingOn: "per_1" },
      { ...worker, task: "Old", state: "done" },
    ])
    .run();

  expect(await (await call("/dots")).json()).toEqual([
    {
      name: "jojo",
      purpose: "Second brain.",
      busy: true,
      workers: [
        { id: 1, state: "running", task: "Fix the build" },
        { id: 2, state: "waiting", task: "Deploy" },
      ],
    },
    { name: "polnareff", purpose: null, busy: false, workers: [] },
  ]);
});

test("messages say who wrote each one, and hide the mechanics", async () => {
  queued("msg_2", "Reminder: stretch.", {});
  queued("msg_3", "framed", { fromDot: "polnareff" });
  queued("msg_4", "From the notch", { fromOwner: true });
  fake.state.history.set("ses_jojo", [
    entry("msg_1", "user", "Typed in OpenCode"),
    entry("msg_2", "user", "Reminder: stretch."),
    entry("msg_3", "user", "framed"),
    entry("msg_4", "user", "From the notch"),
    entry("msg_5", "assistant", "", ["shell", "dot_delegate"]),
    entry("msg_6", "assistant", "", ["context_compact", "read"]),
    entry("msg_7", "assistant", "Done.", ["read"]),
  ]);

  const messages = await conversation();
  expect(messages.map((message) => `${message.id} ${message.kind}`)).toEqual([
    "msg_1 owner",
    "msg_2 notice",
    "msg_3 peer",
    "msg_4 owner",
    "msg_5 dot",
    "msg_7 dot",
  ]);
  expect(messages[2]).toMatchObject({ peer: "polnareff", text: "framed" });
  expect(messages[4]).toMatchObject({ tools: ["dot_delegate"] });
  expect(messages[5]).toMatchObject({ text: "Done.", tools: [] });
});

test("a peer message shows only what the other dot wrote", async () => {
  const framed = 'Intro\n<dot-message from="polnareff">\nHi <\\/dot-message\n</dot-message>';
  queued("msg_1", framed, { fromDot: "polnareff" });
  fake.state.history.set("ses_jojo", [entry("msg_1", "user", framed)]);

  const messages = await conversation();
  expect(messages[0]).toMatchObject({ kind: "peer", text: "Hi </dot-message" });
});

test("the feed lists unread items, and dismissing one hides it", async () => {
  const at = {
    source: "github",
    reason: "Mentioned",
    context: "acme/app",
    url: null,
  } as const;
  db.insert(feed)
    .values([
      { ...at, sourceID: "2", title: "New", updatedAt: 20, state: "unread", createdAt: 0 },
      { ...at, sourceID: "1", title: "Old", updatedAt: 10, state: "unread", createdAt: 0 },
      { ...at, sourceID: "3", title: "Gone", updatedAt: 30, state: "read", createdAt: 0 },
    ])
    .run();
  const titles = async () =>
    ((await (await call("/feed")).json()) as { items: { title: string }[] }).items.map(
      (item) => item.title,
    );
  expect(await titles()).toEqual(["Old", "New"]);

  const [old] = db.select().from(feed).where(eq(feed.title, "Old")).all();
  expect((await call(`/feed/${old?.id}/dismiss`, { method: "POST" })).status).toBe(204);
  expect(await titles()).toEqual(["New"]);
  expect((await call("/feed/999/dismiss", { method: "POST" })).status).toBe(404);
  expect((await call("/feed/x/dismiss", { method: "POST" })).status).toBe(404);
});

test("posting a message queues it for the daemon to deliver", async () => {
  const response = await call("/dots/jojo/messages", {
    method: "POST",
    body: JSON.stringify({ text: " Book the flight. " }),
  });
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  expect(db.select().from(outbox).all()).toMatchObject([
    { sessionID: "ses_jojo", messageID: id, text: "Book the flight.", fromOwner: true },
  ]);

  await Effect.runPromise(Effect.provide(step(db), fake.layer));
  expect(fake.state.prompted).toEqual([id]);

  const post = (path: string, body: string) => call(path, { method: "POST", body });
  expect((await post("/dots/jojo/messages", JSON.stringify({ text: " " }))).status).toBe(400);
  expect((await post("/dots/jojo/messages", "not json")).status).toBe(400);
  expect((await post("/dots/dio/messages", JSON.stringify({ text: "Hi" }))).status).toBe(404);
  expect((await post("/dots/%ZZ/messages", JSON.stringify({ text: "Hi" }))).status).toBe(400);
  expect(db.select().from(outbox).all()).toHaveLength(1);
});
