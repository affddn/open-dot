import { beforeEach, expect, spyOn, test } from "bun:test";
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
    if (state.missing.has(method)) return Response.json({ ok: false, error: "missing_scope" });
    const user = token.startsWith("xoxp");
    switch (method) {
      case "auth.test":
        if (!user && state.botCheck) return Response.json({ ok: false, error: state.botCheck });
        return Response.json({
          ok: true,
          user: user ? "owner" : "open-dot",
          user_id: user ? owner : botUser,
          ...(!user && { bot_id: "B1" }),
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
  const second = say("and then this");
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
