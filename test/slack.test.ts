import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { step } from "../src/daemon";
import { type Db, openDatabase } from "../src/db";
import { outbox, slack, dots } from "../src/schema";
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
    history: [] as Message[],
    posts: [] as Record<string, string>[],
    post: "ok" as "ok" | "lost" | "dropped" | "refused",
    onPost: (_params: Record<string, string>) => {},
    mentions: [] as unknown[],
    dms: [] as unknown[],
    lastRead: new Map<string, string>(),
    infos: [] as string[],
    queries: [] as string[],
  };
  // One clock for everyone's messages, as Slack's ts only grows.
  let clock = 1;
  const now = () => ts(clock++);
  const fetch = async (url: string, init: RequestInit) => {
    const method = url.split("/").at(-1);
    const params = Object.fromEntries(
      new URLSearchParams(typeof init.body === "string" ? init.body : ""),
    );
    const user = new Headers(init.headers).get("authorization") === "Bearer xoxp";
    switch (method) {
      case "auth.test":
        return Response.json({
          ok: true,
          user: user ? "owner" : "open-dot",
          user_id: user ? owner : botUser,
        });
      case "conversations.open":
        return Response.json({ ok: true, channel: { id: state.dm } });
      case "conversations.history": {
        const newer = state.history
          .filter((message) => Number(message.ts) > Number(params.oldest ?? 0))
          .toReversed()
          .map(({ metadata, ...message }) =>
            params.include_all_metadata === "true" ? { ...message, metadata } : message,
          );
        // Two per page, to follow Slack's cursor.
        const start = Number(params.cursor ?? 0);
        const more = start + 2 < newer.length;
        return Response.json({
          ok: true,
          messages: newer.slice(start, start + 2),
          response_metadata: { next_cursor: more ? String(start + 2) : "" },
        });
      }
      case "chat.postMessage": {
        state.onPost(params);
        if (state.post === "refused") return Response.json({ ok: false, error: "no_text" });
        if (state.post === "dropped") throw new Error("connection reset");
        state.posts.push(params);
        const posted = { ts: now(), user: botUser, bot_id: "B1", text: params.markdown_text };
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
  const connect = () => slackClient(fetch, { bot: async () => "xoxb", user: async () => "xoxp" });
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
  say("a thread reply", { thread_ts: first });

  await pass();
  await pass();

  expect(rows()).toMatchObject([{ ts: first, dot: "jotaro", state: "waiting" }]);
  expect(db.select().from(outbox).all()).toMatchObject([
    {
      sessionID: "ses_jotaro",
      messageID: rows()[0]?.messageID ?? "missing",
      text: "hi <there> & bye",
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
      .map((message) => message.text),
  ).toEqual(["hi <there> & bye", "and you?", "where are you"]);
});

test("a reply is saved before it is posted under the dot's name, and a lost post is looked up first", async () => {
  const seen: string[] = [];
  fake.state.onPost = (params) => {
    // Already "unknown", so a crash right after this post can't lead to a second one.
    const saved = rows().find((candidate) => candidate.state === "unknown");
    seen.push(`${saved?.replyID === JSON.parse(params.metadata ?? "{}").event_payload?.reply_id}`);
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

  // The post never landed: not found, so it's posted once more.
  fake.state.post = "dropped";
  const third = say("once more");
  await pass();
  await deliver();
  await pass();
  expect(row(third)?.state).toBe("unknown");
  fake.state.post = "ok";
  await pass();
  expect(row(third)?.state).toBe("posting");
  await pass();
  await pass();
  expect(row(third)).toMatchObject({ state: "posted", replyTS: lastPost() });
  expect(fake.state.posts).toHaveLength(3);

  // Slack refused: the reply stays in the notch only.
  fake.state.post = "refused";
  const fourth = say("last one");
  await pass();
  await deliver();
  await pass();
  await pass();
  expect(row(fourth)?.state).toBe("failed");
  expect(fake.state.posts).toHaveLength(3);
  expect(seen).toEqual(["true", "true", "true", "true", "true"]);
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

const match = (n: number, user: string, channel: Record<string, unknown>, text = "hey") => ({
  ts: ts(n),
  user,
  text,
  permalink: `https://slack.test/${n}`,
  channel,
});

test("the feed lists mentions and unread DMs from others, not the owner's, the bot's or read ones", async () => {
  const general = { id: "C1", name: "general" };
  const friend = { id: "D1", is_im: true };
  const read = { id: "D2", is_im: true };
  fake.state.mentions = [
    match(1, "UOTHER", general, "hey <@UOWNER> &amp; look"),
    match(2, owner, general),
    { ...match(3, "UOTHER", general), ts: "999.000000" },
    match(4, "UFRIEND", friend),
  ];
  fake.state.dms = [
    match(4, "UFRIEND", friend),
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
      title: "hey <@UOWNER> & look",
      context: "#general",
      url: "https://slack.test/1",
      updatedAt: started,
    },
    {
      sourceID: `D1/${ts(4)}`,
      reason: "Mentioned",
      title: "hey",
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
  expect(fake.state.queries).toEqual([`<@${owner}> after:1969-12-31`, "is:dm after:1969-12-31"]);
});
