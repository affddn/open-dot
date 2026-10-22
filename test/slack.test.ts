import { beforeEach, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { step } from "../src/daemon";
import { type Db, openDatabase } from "../src/db";
import { outbox, slack, dots, slackThreads, slackPolls } from "../src/schema";
import { slackChat, slackClient, slackFeed } from "../src/slack";
import { fakeOpenCode } from "./fake-opencode";

const owner = "UOWNER";
const botUser = "UBOT";
const dm = "DBOT";
// The daemon starts at 1000 s, written as Slack writes a ts.
const started = 1_000_000;
const ts = (n: number) => `1000.${String(n).padStart(6, "0")}`;

type Message = Record<string, unknown> & { ts: string };

/** An in-memory Slack Web API. "lost" posts but drops the response; "dropped" fails before posting. */
function fakeSlack() {
  const state = {
    dm,
    authOwner: owner,
    authBot: "B1",
    authTeam: "T1",
    history: [] as Message[],
    pageSize: 100,
    expireCursor: false,
    repliesError: undefined as string | undefined,
    requests: [] as { method: string; params: Record<string, string> }[],
    posts: [] as Record<string, string>[],
    post: "ok" as "ok" | "lost" | "dropped" | "refused",
    onPost: (_params: Record<string, string>) => {},
    mentions: [] as unknown[],
    dms: [] as unknown[],
    lastRead: new Map<string, string>(),
    infos: [] as string[],
    queries: [] as string[],
    // What the Keychain holds, how often it was read, and the client's clock in ms.
    tokens: { bot: "xoxb", user: "xoxp" },
    reads: { bot: 0, user: 0 },
    time: 0,
    // Each call as "<token> <method>", and the methods that answer missing_scope.
    calls: [] as string[],
    missing: new Set<string>(),
    // The user token's x-oauth-scopes header, or undefined to send none.
    scopes: undefined as string | undefined,
    // An error Slack gives the bot token's auth.test, as during an outage.
    botCheck: undefined as string | undefined,
    names: new Map([
      [owner, "Afif"],
      ["UFRIEND", "Friend"],
    ]),
  };
  // One clock for everyone's messages, as Slack's ts only grows.
  let clock = 1;
  const now = () => ts(clock++);
  const route = async (url: string, init: RequestInit) => {
    const method = url.split("/").at(-1) ?? "";
    const params = Object.fromEntries(
      new URLSearchParams(typeof init.body === "string" ? init.body : ""),
    );
    const token = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    state.calls.push(`${token} ${method}`);
    state.requests.push({ method, params });
    if (state.expireCursor && params.cursor) {
      state.expireCursor = false;
      return Response.json({ ok: false, error: "invalid_cursor" });
    }
    if (method === "conversations.replies" && state.repliesError)
      return Response.json({ ok: false, error: state.repliesError });
    if (state.missing.has(method)) return Response.json({ ok: false, error: "missing_scope" });
    const user = token.startsWith("xoxp");
    switch (method) {
      case "auth.test":
        if (!user && state.botCheck) return Response.json({ ok: false, error: state.botCheck });
        return Response.json({
          ok: true,
          user: user ? "owner" : "open-dot",
          user_id: user ? state.authOwner : botUser,
          team_id: state.authTeam,
          ...(!user && { bot_id: state.authBot }),
        });
      case "users.info": {
        const name = state.names.get(params.user ?? "");
        return name
          ? Response.json({
              ok: true,
              user: { id: params.user, name: "handle", profile: { display_name: name } },
            })
          : Response.json({ ok: false, error: "user_not_found" });
      }
      case "conversations.open":
        return Response.json({ ok: true, channel: { id: state.dm } });
      case "conversations.history":
      case "conversations.replies": {
        const newer = state.history
          .filter((message) =>
            method === "conversations.replies"
              ? message.ts === params.ts || message.thread_ts === params.ts
              : !message.thread_ts || message.thread_ts === message.ts,
          )
          .filter((message) => Number(message.ts) > Number(params.oldest ?? 0))
          .toSorted((a, b) =>
            method === "conversations.history"
              ? Number(b.ts) - Number(a.ts)
              : Number(a.ts) - Number(b.ts),
          )
          .map(({ metadata, ...message }) =>
            params.include_all_metadata === "true" ? { ...message, metadata } : message,
          );
        const start = Number(params.cursor ?? 0);
        const more = start + state.pageSize < newer.length;
        return Response.json({
          ok: true,
          messages: newer.slice(start, start + state.pageSize),
          response_metadata: { next_cursor: more ? String(start + state.pageSize) : "" },
        });
      }
      case "chat.postMessage": {
        state.onPost(params);
        if (state.post === "refused") return Response.json({ ok: false, error: "no_text" });
        if (state.post === "dropped") throw new Error("connection reset");
        state.posts.push(params);
        const posted = {
          ts: now(),
          user: botUser,
          bot_id: "B1",
          text: params.markdown_text,
          thread_ts: params.thread_ts,
        };
        state.history.push({ ...posted, metadata: JSON.parse(params.metadata ?? "{}") });
        if (state.post === "lost") throw new Error("connection reset");
        return Response.json({ ok: true, channel: dm, ts: posted.ts });
      }
      case "search.messages":
        state.queries.push(params.query ?? "");
        return Response.json({
          ok: true,
          messages: { matches: params.query?.startsWith("is:dm") ? state.dms : state.mentions },
        });
      case "conversations.info":
        state.infos.push(params.channel ?? "");
        return Response.json({
          ok: true,
          channel: { id: params.channel, last_read: state.lastRead.get(params.channel ?? "") },
        });
      default:
        return Response.json({ ok: false, error: "unknown_method" });
    }
  };
  const fetch = async (url: string, init: RequestInit) => {
    const response = await route(url, init);
    const user = new Headers(init.headers).get("authorization")?.startsWith("Bearer xoxp");
    if (user && state.scopes !== undefined) response.headers.set("x-oauth-scopes", state.scopes);
    return response;
  };
  const connect = () =>
    slackClient(
      fetch,
      {
        bot: async () => {
          state.reads.bot++;
          return state.tokens.bot;
        },
        user: async () => {
          state.reads.user++;
          return state.tokens.user;
        },
      },
      () => state.time,
    );
  return { state, client: connect(), connect, now };
}

let db: Db;
let opencode: ReturnType<typeof fakeOpenCode>;
let fake: ReturnType<typeof fakeSlack>;
let pass: () => Promise<void>;

beforeEach(() => {
  db = openDatabase(":memory:");
  opencode = fakeOpenCode();
  fake = fakeSlack();
  const chat = slackChat(db, fake.client, opencode.layer, started);
  pass = () => Effect.runPromise(chat);
  for (const [name, createdAt] of [
    ["polnareff", 0],
    ["jotaro", 1],
  ] as const)
    db.insert(dots)
      .values({
        name,
        directory: `/dots/${name}`,
        sessionID: `ses_${name}`,
        sessionState: "ready",
        createdAt,
      })
      .run();
});

/** The owner's message, or someone's given in `extra`. Gives its ts. */
const say = (text: string, extra: Record<string, unknown> = {}) => {
  const sent = { ts: fake.now(), user: owner, text, ...extra };
  fake.state.history.push(sent);
  return sent.ts;
};

const rows = () => db.select().from(slack).all();
const row = (at: string) => db.select().from(slack).where(eq(slack.ts, at)).get();
const lastPost = () => fake.state.history.findLast((message) => message.user === botUser)?.ts;
const deliver = () => Effect.runPromise(Effect.provide(step(db), opencode.layer));

test("the owner's top-level DMs reach the named or last dot once, and nothing else does", async () => {
  fake.state.history.push({ ts: "999.000001", user: owner, text: "from before the daemon" });
  const first = say("Jotaro: hi &lt;there&gt; &amp; bye");
  say("not the owner", { user: "UOTHER" });
  say("a bot post", { user: botUser, bot_id: "B1" });
  say("an edit", { subtype: "message_changed" });
  say("an unbound thread reply", { thread_ts: "999.000001" });

  await pass();
  await pass();

  expect(rows()).toMatchObject([{ ts: first, dot: "jotaro", state: "waiting" }]);
  expect(db.select().from(outbox).all()).toMatchObject([
    {
      sessionID: "ses_jotaro",
      messageID: rows()[0]?.messageID ?? "missing",
      ownerText: "hi <there> & bye",
      fromOwner: true,
    },
  ]);

  say("and you?");
  say("@polnareff where are you");
  await pass();

  expect(rows().map((saved) => saved.dot)).toEqual(["jotaro", "jotaro", "polnareff"]);
  expect(
    db
      .select()
      .from(outbox)
      .all()
      .map((message) => message.ownerText),
  ).toEqual(["hi <there> & bye", "and you?", "where are you"]);
});

test("a reply is saved before it is posted under the dot's name, and a lost post is looked up first", async () => {
  const seen: string[] = [];
  fake.state.onPost = (params) => {
    // Already "unknown", so a crash right after this post can't lead to a second one.
    const metadata: unknown = JSON.parse(params.metadata ?? "{}");
    assert(typeof metadata === "object" && metadata !== null && "event_payload" in metadata);
    const payload = metadata.event_payload;
    assert(typeof payload === "object" && payload !== null && "reply_id" in payload);
    const replyID = payload.reply_id;
    assert(typeof replyID === "string", "The dispatched reply must have a metadata ID");
    const saved = rows().find((candidate) => candidate.replyID === replyID);
    assert(saved, "The dispatched reply ID must already be persisted");
    expect(saved.state).toBe("unknown");
    seen.push(`${saved.replyID === replyID}`);
  };
  opencode.state.turns.set("ses_jotaro", { outcome: "succeeded", text: "**Hello**" });

  const first = say("jotaro: hi");
  await pass();
  expect(row(first)?.state).toBe("waiting");
  await deliver();
  await pass();

  expect(seen).toEqual(["true"]);
  expect(fake.state.posts).toMatchObject([
    { channel: dm, username: "jotaro", markdown_text: "**Hello**" },
  ]);
  expect(JSON.parse(fake.state.posts[0]?.metadata ?? "{}")).toEqual({
    event_type: "open_dot_reply",
    event_payload: { reply_id: row(first)?.replyID },
  });
  expect(row(first)).toMatchObject({ state: "posted", replyTS: lastPost() });

  // The post landed but its answer was lost: found by its reply ID, never posted again.
  fake.state.post = "lost";
  const second = say("again");
  await pass();
  await deliver();
  await pass();
  expect(row(second)?.state).toBe("unknown");
  fake.state.post = "ok";
  await pass();
  expect(row(second)).toMatchObject({ state: "posted", replyTS: lastPost() });
  expect(fake.state.posts).toHaveLength(2);

  // An empty read cannot prove the post never landed: lookup only.
  fake.state.post = "dropped";
  const third = say("once more");
  await pass();
  await deliver();
  await pass();
  expect(row(third)?.state).toBe("unknown");
  fake.state.post = "ok";
  await pass();
  expect(row(third)?.state).toBe("unknown");
  await pass();
  await pass();
  expect(row(third)?.state).toBe("unknown");
  expect(fake.state.posts).toHaveLength(2);

  // Slack refused: the reply stays in the notch only.
  fake.state.post = "refused";
  const fourth = say("last one");
  await pass();
  await deliver();
  await pass();
  await pass();
  expect(row(fourth)?.state).toBe("failed");
  expect(row(third)?.state).toBe("unknown");
  expect(fake.state.posts).toHaveLength(2);
  expect(seen).toEqual(["true", "true", "true", "true"]);
});

test("a reply goes to the DM its message came from, even when the tokens change", async () => {
  opencode.state.turns.set("ses_jotaro", { outcome: "succeeded", text: "Hi." });
  const first = say("jotaro: hi");
  await pass();
  await deliver();

  // The daemon restarts with a bot token whose DM with the owner is another conversation.
  fake.state.dm = "DOTHER";
  await Effect.runPromise(slackChat(db, fake.connect(), opencode.layer, started));

  expect(row(first)).toMatchObject({ channel: dm, state: "posted" });
  expect(fake.state.posts).toMatchObject([{ channel: dm, markdown_text: "Hi." }]);
});

test("a bot token check that fails leaves a reply unsent and posts it later, never failed or unknown", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    opencode.state.turns.set("ses_jotaro", { outcome: "succeeded", text: "Hi." });
    const first = say("jotaro: hi");
    await pass();
    await deliver();

    // The daemon restarts while Slack fails the bot token's check.
    fake.state.botCheck = "internal_error";
    const chat = slackChat(db, fake.connect(), opencode.layer, started);
    await Effect.runPromise(chat);
    expect(row(first)?.state).toBe("posting");
    expect(fake.state.calls.filter((call) => call.endsWith("chat.postMessage"))).toEqual([]);

    fake.state.botCheck = undefined;
    await Effect.runPromise(chat);
    expect(row(first)?.state).toBe("posted");
    expect(fake.state.posts).toMatchObject([{ channel: dm, markdown_text: "Hi." }]);
  } finally {
    errors.mockRestore();
  }
});

test("after a 429, no call reaches Slack until its Retry-After has passed", async () => {
  let clock = 0;
  let calls = 0;
  const client = slackClient(
    async (url) => {
      calls++;
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "5" } });
      return url.endsWith("/auth.test")
        ? Response.json({ ok: true, user_id: botUser, bot_id: "B1" })
        : Response.json({ ok: true, ts: "1.000001" });
    },
    { bot: async () => "xoxb", user: async () => "xoxp" },
    () => clock,
  );
  const post = () => client.call("bot", "chat.postMessage", { channel: dm });

  // The 429 answered the bot token's check, so the post itself was never sent.
  expect(await post()).toBeUndefined();
  clock = 4_999;
  expect(await post()).toBeUndefined();
  expect(calls).toBe(1);
  clock = 5_000;
  expect(await post()).toMatchObject({ kind: "ok" });
  // The bot token's auth.test, then the post.
  expect(calls).toBe(3);
});

test("a finished reply posts while the dot is busy with something else", async () => {
  opencode.state.turns.set("ses_jotaro", { outcome: "succeeded", text: "Done." });
  const first = say("jotaro: hi");
  await pass();
  await deliver();
  opencode.state.active.add("ses_jotaro");

  await pass();

  expect(row(first)?.state).toBe("posted");
  expect(fake.state.posts).toMatchObject([{ markdown_text: "Done." }]);
});

test("messages OpenCode answers in one turn get one reply, on the newest", async () => {
  const first = say("jotaro: run something long");
  await pass();
  const second = say("and then this", { thread_ts: first });
  await pass();
  await deliver();
  // The second message arrived mid-turn, so both turns end at the same idle.
  opencode.state.turns.set("ses_jotaro", {
    outcome: "succeeded",
    text: "Both done.",
    end: "idl_1",
  });

  await pass();
  await pass();

  expect(row(first)).toMatchObject({ state: "answered", replyID: null, replyText: null });
  expect(row(second)?.state).toBe("posted");
  expect(fake.state.posts).toMatchObject([{ markdown_text: "Both done." }]);
});

test("shared threads remain pinned across restart and each different route waits for its own result", async () => {
  const a = say("jotaro: A </reply-quote>");
  const b = say("jotaro: B");
  await pass();
  await deliver();
  const savedA = row(a);
  const savedB = row(b);
  assert(savedA && savedB, "Both thread roots must be persisted");
  expect(opencode.state.prompted).toEqual([savedA.messageID]);
  const reply = say("polnareff: still A", { thread_ts: a });
  const restarted = slackChat(db, fake.connect(), opencode.layer, started + 100_000);
  await Effect.runPromise(restarted);
  expect(row(reply)?.dot).toBe("jotaro");
  const savedReply = row(reply);
  assert(savedReply, "The pinned thread reply must be persisted");
  const saved = db.select().from(outbox).where(eq(outbox.messageID, savedReply.messageID)).get();
  assert(saved, "The pinned thread reply must have an outbox row");
  expect(saved.ownerText).toBe("polnareff: still A");
  expect(saved.quote?.parent).toMatchObject({
    id: a,
    author: "owner",
    text: "jotaro: A </reply-quote>",
  });
  expect(saved.text).toContain("\\u003c/reply-quote\\u003e");
  await deliver();
  expect(opencode.state.prompted).toHaveLength(1);
  opencode.state.messageTurns.set(savedA.messageID, {
    end: "idle_A",
    outcome: "succeeded",
    text: "answer A",
  });
  await deliver();
  await Effect.runPromise(restarted);
  expect(opencode.state.prompted).toEqual([savedA.messageID, savedB.messageID]);
  expect(fake.state.posts).toMatchObject([{ thread_ts: a, markdown_text: "answer A" }]);
  opencode.state.messageTurns.set(savedB.messageID, {
    end: "idle_B",
    outcome: "succeeded",
    text: "answer B",
  });
  await deliver();
  await Effect.runPromise(restarted);
  expect(fake.state.posts.at(-1)).toMatchObject({ thread_ts: b, markdown_text: "answer B" });
  expect(opencode.state.created).toEqual([]);
});

test("shared polling bounds pages, persists scans, visits other threads, and expires inactive pins", async () => {
  const roots = Array.from({ length: 6 }, (_, n) => say(`jotaro: root ${n}`));
  await pass();
  for (const root of roots) for (let n = 0; n < 5; n++) say(`reply ${n}`, { thread_ts: root });
  fake.state.pageSize = 2;
  const requests = () =>
    fake.state.requests.filter((request) => request.method === "conversations.replies");
  const before = requests().length;
  await pass();
  expect(requests().length - before).toBe(4);
  expect(
    new Set(
      requests()
        .slice(before)
        .map(({ params }) => params.ts),
    ).size,
  ).toBe(4);
  expect(
    db
      .select()
      .from(slackThreads)
      .all()
      .some((pin) => pin.cursor !== ""),
  ).toBe(true);
  const restarted = slackChat(db, fake.connect(), opencode.layer, started + 100_000);
  for (let n = 0; n < 6; n++) await Effect.runPromise(restarted);
  expect(rows()).toHaveLength(36);
  expect(new Set(rows().map((item) => item.ts)).size).toBe(36);
  expect(
    new Set(
      requests()
        .slice(before)
        .map(({ params }) => params.ts),
    ).size,
  ).toBe(6);
  db.update(slackThreads).set({ activeAt: 0, cursor: "" }).run();
  const expired = requests().length;
  await Effect.runPromise(restarted);
  expect(requests()).toHaveLength(expired);
  expect(db.select().from(slackThreads).all()).toHaveLength(6);
});

test("one top-level history page per pass resumes its cursor after restart", async () => {
  fake.state.pageSize = 2;
  say("jotaro: choose me");
  for (let n = 0; n < 4; n++) say(`followup ${n}`);
  await pass();
  expect(rows()).toHaveLength(0);
  const scan = db.select().from(slackPolls).get();
  assert(scan, "The unfinished top-level scan must be persisted");
  expect(JSON.parse(scan.cursor).cursor).toBe("2");
  const restarted = slackChat(db, fake.connect(), opencode.layer, started + 100_000);
  await Effect.runPromise(restarted);
  await Effect.runPromise(restarted);
  expect(rows()).toHaveLength(5);
  expect(rows().every((saved) => saved.dot === "jotaro")).toBe(true);
  expect(
    fake.state.requests.filter((request) => request.method === "conversations.history"),
  ).toHaveLength(3);
});

test("expired saved cursors restart from the uncommitted watermark without losing or duplicating messages", async () => {
  fake.state.pageSize = 2;
  const root = say("jotaro: start");
  for (let n = 0; n < 4; n++) say(`jotaro: ${n}`);
  await pass();
  fake.state.expireCursor = true;
  await pass();
  expect(db.select().from(slackPolls).get()?.cursor).toBe("");
  for (let n = 0; n < 3; n++) await pass();
  expect(rows()).toHaveLength(5);
  for (let n = 0; n < 5; n++) say(`reply ${n}`, { thread_ts: root });
  await pass();
  fake.state.expireCursor = true;
  await pass();
  for (let n = 0; n < 6; n++) await pass();
  expect(rows()).toHaveLength(10);
  expect(new Set(rows().map((saved) => saved.ts)).size).toBe(10);
});

test("an aged unfinished shared scan recovers an expired cursor across DB reopen without starving other threads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-aged-scan-"));
  const path = join(directory, "open-dot.db");
  const existingDots = db.select().from(dots).all();
  db.$client.close();
  db = openDatabase(path);
  db.insert(dots).values(existingDots).run();
  const oldActivity = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockReturnValue(oldActivity);
  try {
    const initial = slackChat(db, fake.client, opencode.layer, started);
    const roots = Array.from({ length: 6 }, (_, index) => say(`jotaro: old root ${index}`));
    await Effect.runPromise(initial);
    // This root was not among the first four visits. Its first real page saves a continuation.
    const root = roots[4];
    assert(root);
    const replies = Array.from({ length: 5 }, (_, index) =>
      say(`old owner reply ${index}`, { thread_ts: root }),
    );
    const secondReply = replies[1];
    const lastReply = replies.at(-1);
    assert(secondReply && lastReply);
    fake.state.pageSize = 2;
    await Effect.runPromise(initial);
    const unfinished = db
      .select()
      .from(slackThreads)
      .all()
      .find((pin) => pin.route.thread === root);
    assert(unfinished);
    expect(unfinished.cursor).not.toBe("");
    expect(unfinished.rescan).toBe(false);
    expect(unfinished.oldest).toBe(root);
    expect(unfinished.newest).toBe(secondReply);
    expect(unfinished.activeAt).toBe(oldActivity);
    expect(rows().filter((saved) => replies.includes(saved.ts))).toHaveLength(2);

    // Advance the actual activity clock, not message timestamps. No new target replies are added.
    const current = oldActivity + 8 * 86400_000;
    clock.mockReturnValue(current);
    for (const pin of db.select().from(slackThreads).all()) {
      if (pin.key !== unfinished.key)
        db.update(slackThreads)
          .set({ activeAt: current })
          .where(eq(slackThreads.key, pin.key))
          .run();
    }
    const targetHistory = fake.state.history.filter((message) => message.thread_ts === root);
    expect(targetHistory.map((message) => message.ts)).toEqual(replies);
    const boundedPass = async (chat: ReturnType<typeof slackChat>) => {
      const before = fake.state.requests.length;
      await Effect.runPromise(chat);
      const calls = fake.state.requests.slice(before);
      const history = calls.filter((request) => request.method === "conversations.history");
      const threads = calls.filter((request) => request.method === "conversations.replies");
      expect(history).toHaveLength(1);
      expect(threads.length).toBeLessThanOrEqual(4);
      expect(new Set(threads.map((request) => request.params.ts)).size).toBe(threads.length);
      expect([...history, ...threads].every((request) => request.params.limit === "100")).toBe(
        true,
      );
      return threads;
    };
    // Only the unfinished target has a cursor; the fake rejects that actual saved continuation.
    fake.state.expireCursor = true;
    const rejected = await boundedPass(slackChat(db, fake.client, opencode.layer, started));
    expect(
      rejected.some(
        (request) => request.params.ts === root && request.params.cursor === unfinished.cursor,
      ),
    ).toBe(true);
    expect(fake.state.expireCursor).toBe(false);
    const interrupted = db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.key, unfinished.key))
      .get();
    assert(interrupted);
    expect(interrupted.cursor).toBe("");
    expect(interrupted.rescan).toBe(true);
    expect(interrupted.oldest).toBe(unfinished.oldest);
    expect(interrupted.newest).toBe(unfinished.newest);
    expect(interrupted.activeAt).toBe(oldActivity);

    // A fresh database connection and connector must retain unfinished eligibility without relying
    // on an in-memory cursor or a fresh owner message to make this stale thread eligible again.
    db.$client.close();
    db = openDatabase(path);
    expect(
      db.select().from(slackThreads).where(eq(slackThreads.key, unfinished.key)).get(),
    ).toEqual(interrupted);
    const restarted = slackChat(db, fake.connect(), opencode.layer, started + 100_000);
    const recoveryCalls = [];
    for (let index = 0; index < 12; index++) recoveryCalls.push(...(await boundedPass(restarted)));
    for (const other of roots.filter((candidate) => candidate !== root))
      expect(recoveryCalls.some((request) => request.params.ts === other)).toBe(true);
    const received = rows().map((saved) => saved.ts);
    expect(new Set(received).size).toBe(received.length);
    expect(fake.state.history.filter((message) => message.thread_ts === root)).toEqual(
      targetHistory,
    );
    expect(fake.state.posts).toEqual([]);
    expect(opencode.state.created).toEqual([]);
    expect(received.filter((stamp) => replies.includes(stamp))).toEqual(replies);
    const resumed = recoveryCalls.find(
      (request) => request.params.ts === root && !request.params.cursor,
    );
    assert(resumed, "The stale scan must restart from its uncommitted oldest watermark");
    expect(resumed.params.oldest).toBe(unfinished.oldest);
    const completed = db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.key, unfinished.key))
      .get();
    assert(completed);
    expect(completed.cursor).toBe("");
    expect(completed.rescan).toBe(false);
    expect(completed.oldest).toBe(lastReply);
    expect(db.select().from(outbox).all()).toHaveLength(roots.length + replies.length);
  } finally {
    clock.mockRestore();
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a thread rescan survives repeated read failures, clears on a committed page and stops after aged completion", async () => {
  const oldActivity = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockReturnValue(oldActivity);
  try {
    const root = say("jotaro: root");
    await pass();
    const replies = Array.from({ length: 3 }, (_, index) =>
      say(`owner reply ${index}`, { thread_ts: root }),
    );
    fake.state.pageSize = 2;
    await pass();
    const unfinished = db.select().from(slackThreads).get();
    assert(unfinished);
    expect(unfinished.cursor).not.toBe("");
    expect(rows().filter((saved) => replies.includes(saved.ts))).toHaveLength(2);

    const current = oldActivity + 8 * 86400_000;
    clock.mockReturnValue(current);
    fake.state.expireCursor = true;
    await pass();
    expect(fake.state.expireCursor).toBe(false);
    expect(db.select().from(slackThreads).get()).toMatchObject({
      cursor: "",
      rescan: true,
      oldest: unfinished.oldest,
      newest: unfinished.newest,
      activeAt: oldActivity,
    });

    fake.state.repliesError = "internal_error";
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = fake.state.requests.length;
      await Effect.runPromise(slackChat(db, fake.connect(), opencode.layer, started));
      const calls = fake.state.requests
        .slice(before)
        .filter((request) => request.method === "conversations.replies");
      expect(calls).toHaveLength(1);
      const [attempted] = calls;
      assert(attempted);
      expect(attempted.params).toMatchObject({ ts: root, oldest: unfinished.oldest, limit: "100" });
      expect(attempted.params.cursor).toBeUndefined();
      expect(db.select().from(slackThreads).get()).toMatchObject({
        cursor: "",
        rescan: true,
        oldest: unfinished.oldest,
        newest: unfinished.newest,
        activeAt: oldActivity,
      });
      expect(rows().filter((saved) => replies.includes(saved.ts))).toHaveLength(2);
    }

    fake.state.repliesError = undefined;
    await pass();
    const resumed = db.select().from(slackThreads).get();
    assert(resumed);
    expect(resumed.rescan).toBe(false);
    expect(resumed.cursor).not.toBe("");
    expect(resumed.oldest).toBe(unfinished.oldest);
    expect(resumed.activeAt).toBe(oldActivity);
    await pass();
    expect(db.select().from(slackThreads).get()).toMatchObject({
      cursor: "",
      rescan: false,
      oldest: replies.at(-1),
      newest: replies.at(-1),
    });
    expect(
      rows()
        .filter((saved) => replies.includes(saved.ts))
        .map((saved) => saved.ts),
    ).toEqual(replies);

    clock.mockReturnValue(current + 8 * 86400_000);
    const before = fake.state.requests.length;
    await Effect.runPromise(slackChat(db, fake.connect(), opencode.layer, started));
    expect(
      fake.state.requests
        .slice(before)
        .filter((request) => request.method === "conversations.replies"),
    ).toEqual([]);
    expect(fake.state.posts).toEqual([]);
    expect(opencode.state.created).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test("legacy unknown top-level replies reconcile from history without inventing a root or replaying", async () => {
  db.insert(slack)
    .values({
      ts: "999.000001",
      dot: "jotaro",
      channel: dm,
      messageID: "legacy",
      replyID: "legacy-reply",
      replyText: "Old answer",
      state: "unknown",
      createdAt: 0,
    })
    .run();
  await pass();
  expect(row("999.000001")?.state).toBe("unknown");
  fake.state.history.push({
    ts: fake.now(),
    bot_id: "B1",
    metadata: { event_type: "open_dot_reply", event_payload: { reply_id: "legacy-reply" } },
  });
  await pass();
  expect(row("999.000001")).toMatchObject({ state: "posted", route: null });
  expect(fake.state.posts).toEqual([]);
  expect(
    fake.state.requests.some(
      ({ method, params }) =>
        method === "conversations.history" && params.include_all_metadata === "true",
    ),
  ).toBe(true);
  expect(fake.state.requests.some(({ method }) => method === "conversations.replies")).toBe(false);
});

test("shared saved replies cannot follow an owner, workspace, bot or session replacement", async () => {
  const root = say("jotaro: hello");
  await pass();
  await deliver();
  opencode.state.turns.set("ses_jotaro", { outcome: "succeeded", text: "Original answer" });
  for (const change of [{ authOwner: "UOTHER" }, { authTeam: "TOTHER" }, { authBot: "BOTHER" }]) {
    Object.assign(fake.state, { authOwner: owner, authTeam: "T1", authBot: "B1" }, change);
    await Effect.runPromise(slackChat(db, fake.connect(), opencode.layer, started));
    expect(fake.state.posts).toEqual([]);
  }
  Object.assign(fake.state, { authOwner: owner, authTeam: "T1", authBot: "B1" });
  db.update(dots).set({ sessionID: "ses_changed" }).where(eq(dots.name, "jotaro")).run();
  await Effect.runPromise(slackChat(db, fake.connect(), opencode.layer, started));
  expect(fake.state.posts).toEqual([]);
  expect(row(root)).toMatchObject({
    state: "posting",
    replyText: "Original answer",
    route: { owner, team: "T1", bot: "B1", sessionID: "ses_jotaro" },
  });
});

test("unknown shared replies require exact metadata and bot in the saved root, never an empty-read replay", async () => {
  const root = say("jotaro: hello");
  await pass();
  await deliver();
  opencode.state.turns.set("ses_jotaro", { outcome: "succeeded", text: "answer" });
  fake.state.post = "dropped";
  await pass();
  const savedRoot = row(root);
  assert(savedRoot, "The unknown reply's root must be persisted");
  assert(savedRoot.replyID, "The unknown reply must have a persisted metadata ID");
  const metadata = {
    event_type: "open_dot_reply",
    event_payload: { reply_id: savedRoot.replyID },
  };
  fake.state.history.push({ ts: fake.now(), thread_ts: root, bot_id: "BOTHER", metadata });
  fake.state.history.push({
    ts: fake.now(),
    thread_ts: root,
    bot_id: "B1",
    metadata: { event_type: "wrong", event_payload: metadata.event_payload },
  });
  const restarted = slackChat(db, fake.connect(), opencode.layer, started);
  await Effect.runPromise(restarted);
  expect(row(root)?.state).toBe("unknown");
  expect(fake.state.posts).toEqual([]);
  fake.state.history.push({ ts: fake.now(), thread_ts: root, bot_id: "B1", metadata });
  await Effect.runPromise(restarted);
  expect(row(root)?.state).toBe("posted");
  expect(
    fake.state.requests.some(
      ({ method, params }) =>
        method === "conversations.replies" &&
        params.ts === root &&
        params.include_all_metadata === "true",
    ),
  ).toBe(true);
  expect(fake.state.calls.filter((value) => value.endsWith("chat.postMessage"))).toHaveLength(1);
});

const match = (n: number, user: string, channel: Record<string, unknown>, text = "hey") => ({
  ts: ts(n),
  user,
  text,
  permalink: `https://slack.test/${n}`,
  channel,
});

test("the feed lists mentions and unread DMs from others, not the owner's, the bot's, read ones or false mentions", async () => {
  const general = { id: "C1", name: "general" };
  const friend = { id: "D1", is_im: true };
  const read = { id: "D2", is_im: true };
  fake.state.mentions = [
    match(
      1,
      "UOTHER",
      general,
      "<!here> hey <@UOWNER> &amp; <@UGONE>, see <https://x.test/a?b=1&amp;c=2|the doc> in <#C9|random> or <https://x.test>",
    ),
    match(2, owner, general, "<@UOWNER> note to self"),
    { ...match(3, "UOTHER", general, "<@UOWNER>"), ts: "999.000000" },
    match(4, "UFRIEND", friend, "<@UOWNER|owner> ping"),
    match(9, "UOTHER", general, "about UOWNER, not to them"),
  ];
  fake.state.dms = [
    match(4, "UFRIEND", friend, "<@UOWNER|owner> ping"),
    match(5, "UFRIEND", friend, "lunch?"),
    match(6, "UREAD", read),
    match(7, botUser, { id: dm, is_im: true }),
    match(8, "UOTHER", general),
  ];
  fake.state.lastRead.set("D2", ts(6));
  await fake.client.dm();

  const items = await slackFeed(fake.client).unread(started);

  expect(items).toEqual([
    {
      sourceID: `C1/${ts(1)}`,
      reason: "Mentioned",
      title: "@here hey @owner & @UGONE, see the doc in #random or https://x.test",
      context: "#general",
      url: "https://slack.test/1",
      updatedAt: started,
    },
    {
      sourceID: `D1/${ts(4)}`,
      reason: "Mentioned",
      title: "@owner ping",
      context: "DM",
      url: "https://slack.test/4",
      updatedAt: started,
    },
    {
      sourceID: `D1/${ts(5)}`,
      reason: "Direct message",
      title: "lunch?",
      context: "DM",
      url: "https://slack.test/5",
      updatedAt: started,
    },
  ]);
  expect(fake.state.infos).toEqual(["D1", "D2"]);
  // The owner's name comes from auth.test, so only UGONE is looked up.
  expect(fake.state.calls.filter((call) => call.endsWith("users.info"))).toEqual([
    "xoxp users.info",
  ]);
  expect(fake.state.queries).toEqual([`<@${owner}> after:1969-12-31`, "is:dm after:1969-12-31"]);
});

test("search reads pages until they pass the window, and gives up on a flood", async () => {
  const general = { id: "C1", name: "general" };
  let pages = 5;
  const asked: string[] = [];
  const client = slackClient(
    async (url, init) => {
      const params = Object.fromEntries(
        new URLSearchParams(typeof init.body === "string" ? init.body : ""),
      );
      if (url.endsWith("/auth.test"))
        return new Headers(init.headers).get("authorization") === "Bearer xoxb"
          ? Response.json({ ok: true, user_id: botUser, bot_id: "B1" })
          : Response.json({ ok: true, user_id: owner });
      if (url.endsWith("/users.info")) return Response.json({ ok: true, user: { name: "afif" } });
      const page = Number(params.page);
      asked.push(
        `${params.query?.startsWith("is:dm") ? "dm" : "mention"} ${page} ${params.sort_dir}`,
      );
      // Newest first: page 2 already reaches before the window when there are 5 pages.
      const at = pages === 5 && page === 2 ? "999.000000" : ts(100 - page);
      return Response.json({
        ok: true,
        messages: {
          matches: [{ ...match(page, "UOTHER", general, `<@${owner}> ${page}`), ts: at }],
          paging: { page, pages },
        },
      });
    },
    { bot: async () => "xoxb", user: async () => "xoxp" },
  );
  const feed = slackFeed(client);

  expect((await feed.unread(started))?.map((item) => item.title)).toEqual(["@afif 1"]);
  expect(asked).toEqual(["mention 1 desc", "mention 2 desc", "dm 1 desc", "dm 2 desc"]);

  pages = 2;
  asked.length = 0;
  expect((await feed.unread(started))?.map((item) => item.title)).toEqual(["@afif 1", "@afif 2"]);
  expect(asked).toHaveLength(4);

  pages = 11;
  asked.length = 0;
  expect(await feed.unread(started)).toBeUndefined();
  expect(asked).toHaveLength(10);
});

test("a user token saved as the bot's is dropped before any bot call, and a bot token saved later is used", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    fake.state.tokens.bot = "xoxp-wrong";
    say("jotaro: hi");
    await pass();
    await pass();

    expect(fake.state.calls.filter((call) => call.startsWith("xoxp-wrong"))).toEqual([
      "xoxp-wrong auth.test",
    ]);
    expect(rows()).toEqual([]);
    expect(errors.mock.calls.filter(([line]) => String(line).includes("xoxb-"))).toHaveLength(1);

    // The Keychain is read again only after a minute.
    fake.state.tokens.bot = "xoxb";
    await pass();
    expect(fake.state.reads.bot).toBe(1);
    fake.state.time += 60_000;
    await pass();

    expect(fake.state.reads.bot).toBe(2);
    expect(rows()).toMatchObject([{ dot: "jotaro", state: "waiting" }]);
  } finally {
    errors.mockRestore();
  }
});

test("a token Slack says lacks a scope is dropped with what came from it, and read again a minute later", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    fake.state.missing.add("conversations.open");
    say("jotaro: hi");
    await pass();
    await pass();
    expect(fake.state.calls.filter((call) => call.endsWith("conversations.open"))).toHaveLength(1);
    fake.state.missing.clear();
    fake.state.time += 60_000;
    await pass();
    expect(fake.state.reads.bot).toBe(2);
    // The bot's identity went with its token, so the new one is checked too.
    expect(fake.state.calls.filter((call) => call === "xoxb auth.test")).toHaveLength(2);
    expect(rows()).toMatchObject([{ dot: "jotaro", state: "waiting" }]);

    const general = { id: "C1", name: "general" };
    fake.state.mentions = [match(1, "UOTHER", general, "<@UOWNER> hi")];
    fake.state.missing.add("search.messages");
    const feed = slackFeed(fake.client);
    expect(await feed.unread(started).catch((error: Error) => error.message)).toContain(
      "missing_scope",
    );
    expect(await feed.unread(started)).toBeUndefined();
    fake.state.missing.clear();
    fake.state.time += 60_000;
    expect((await feed.unread(started))?.map((item) => item.title)).toEqual(["@owner hi"]);
    expect(fake.state.reads.user).toBe(2);
  } finally {
    errors.mockRestore();
  }
});

test("with no scopes header, a missing_scope lookup drops the token once with a log, and a reinstalled one names others", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const general = { id: "C1", name: "general" };
    fake.state.mentions = [match(1, "UOTHER", general, "<@UOWNER> meet <@UFRIEND>")];
    fake.state.missing.add("users.info");
    const feed = slackFeed(fake.client);
    const titles = async () => (await feed.unread(started))?.map((item) => item.title);
    const lookups = (token = "xoxp") =>
      fake.state.calls.filter((call) => call === `${token} users.info`).length;

    // The items already found still show, and lookups stop at the first refusal.
    expect(await titles()).toEqual(["@owner meet @UFRIEND"]);
    expect(lookups()).toBe(1);
    expect(await titles()).toBeUndefined();
    fake.state.time += 60_000;
    expect(await titles()).toEqual(["@owner meet @UFRIEND"]);
    expect(lookups()).toBe(2);
    expect(fake.state.reads.user).toBe(2);
    expect(errors.mock.calls.filter(([line]) => String(line).includes("users:read"))).toHaveLength(
      1,
    );

    // The app is reinstalled with users:read, and its new token saved.
    fake.state.tokens.user = "xoxp-scoped";
    fake.state.missing.clear();
    expect(await titles()).toBeUndefined();
    fake.state.time += 60_000;
    expect(await titles()).toEqual(["@owner meet @Friend"]);
    expect(await titles()).toEqual(["@owner meet @Friend"]);
    expect(fake.state.reads.user).toBe(3);
    expect(lookups("xoxp-scoped")).toBe(1);
  } finally {
    errors.mockRestore();
  }
});

test("a user token whose scopes lack users:read is never asked for names, and chat and the feed go on", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    fake.state.scopes = "search:read, im:read, mpim:read, channels:read, groups:read";
    // Asking would drop the token, as in the test above.
    fake.state.missing.add("users.info");
    const general = { id: "C1", name: "general" };
    fake.state.mentions = [match(1, "UOTHER", general, "<@UOWNER> meet <@UFRIEND>")];
    const feed = slackFeed(fake.client);
    const titles = async () => (await feed.unread(started))?.map((item) => item.title);

    say("jotaro: hi");
    await pass();
    expect(await titles()).toEqual(["@owner meet @UFRIEND"]);
    say("and you?");
    await pass();
    expect(await titles()).toEqual(["@owner meet @UFRIEND"]);

    expect(fake.state.calls.filter((call) => call.endsWith("users.info"))).toEqual([]);
    expect(rows().map((saved) => saved.state)).toEqual(["waiting", "waiting"]);
    expect(fake.state.reads.user).toBe(1);
    expect(
      errors.mock.calls.filter(([line]) => String(line).includes("lacks users:read")),
    ).toHaveLength(1);
  } finally {
    errors.mockRestore();
  }
});
