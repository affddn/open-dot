import { SessionMessage } from "@opencode/client/effect";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Cause, Effect, type Layer, Schema } from "effect";
import type { Db } from "./db";
import { listDots } from "./dots";
import { type Fetch, output, type Source } from "./feed";
import { OpenCode, type OpenCodeError, type Turn } from "./opencode";
import { dots, outbox, slack } from "./schema";

type Kind = "bot" | "user";

/**
 * What Slack did with a call. "refused" means Slack answered that it did nothing, while "lost"
 * means the call may or may not have taken effect.
 */
export type Answer =
  | { readonly kind: "ok"; readonly body: Record<string, unknown> }
  | { readonly kind: "refused"; readonly error: string }
  | { readonly kind: "lost"; readonly reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Errors that mean the token itself is bad or the wrong one, so the Keychain is read again.
const revoked = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "account_inactive",
  "missing_scope",
]);

const keychain = (service: string) => () =>
  output(["security", "find-generic-password", "-s", service, "-w"]);

/** A token kept in memory. While it's missing, the Keychain is read at most once a minute. */
function remembered(read: () => Promise<string | undefined>, now: () => number) {
  let token: string | undefined;
  let checked = Number.NEGATIVE_INFINITY;
  let pending: Promise<string | undefined> | undefined;
  return {
    get: async () => {
      if (token || pending) return token ?? pending;
      if (now() - checked < 60_000) return undefined;
      checked = now();
      pending = read();
      token = await pending.finally(() => (pending = undefined));
      return token;
    },
    forget: () => {
      token = undefined;
      checked = now();
    },
  };
}

const Auth = Schema.Struct({ user_id: Schema.String, user: Schema.optionalKey(Schema.String) });
const Opened = Schema.Struct({ channel: Schema.Struct({ id: Schema.String }) });

/**
 * Slack's Web API with the bot token from the Keychain item `open-dot-slack-bot` and the owner's
 * user token from `open-dot-slack-user`. Calls with a token that isn't saved give undefined.
 */
export function slackClient(
  fetch: Fetch = globalThis.fetch,
  tokens = { bot: keychain("open-dot-slack-bot"), user: keychain("open-dot-slack-user") },
  now = Date.now,
) {
  const base = process.env.OPEN_DOT_SLACK_URL ?? "https://slack.com/api";
  const saved = { bot: remembered(tokens.bot, now), user: remembered(tokens.user, now) };
  let owner: string | undefined;
  let ownerName: string | undefined;
  // The user token's scopes, from Slack's x-oauth-scopes header once a call has shown them.
  let userScopes: Set<string> | undefined;
  let announced: string | undefined;
  let bot: string | undefined;
  let channel: string | undefined;
  let wrongBot = false;
  // Slack's limits are per app and workspace, so one pause after a 429 covers every call.
  let pausedUntil = 0;

  /** Keeps the bot's user ID from its auth.test. A token without a bot_id isn't a bot's. */
  const verify = (body: Record<string, unknown>) => {
    if (typeof body.bot_id === "string" && typeof body.user_id === "string") {
      bot = body.user_id;
      wrongBot = false;
      return true;
    }
    saved.bot.forget();
    bot = channel = undefined;
    if (!wrongBot)
      console.error(
        "Slack: the Keychain item open-dot-slack-bot holds a token that isn't a bot's. Save the app's Bot User OAuth Token (xoxb-…) there instead; the daemon reads it again within a minute.",
      );
    wrongBot = true;
    return false;
  };

  const call = async (
    kind: Kind,
    method: string,
    params: Record<string, string> = {},
  ): Promise<Answer | undefined> => {
    const token = await saved[kind].get();
    if (!token) return undefined;
    // A user token saved as the bot's would act as the owner, so it's checked before any bot call.
    if (kind === "bot" && method !== "auth.test" && !bot) {
      const checked = await call("bot", "auth.test");
      // The call itself never left, so a lost check means only "not now".
      if (checked?.kind === "refused") return checked;
      if (checked?.kind !== "ok" || !verify(checked.body)) return undefined;
    }
    if (now() < pausedUntil) return { kind: "refused", error: "ratelimited" };
    try {
      const response = await fetch(`${base}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const scopes = response.headers.get("x-oauth-scopes");
      if (kind === "user" && scopes !== null)
        userScopes = new Set(scopes.split(",").map((scope) => scope.trim()));
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        pausedUntil = now() + (seconds > 0 ? seconds : 30) * 1000;
        return { kind: "refused", error: "ratelimited" };
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (response.status < 500 && isRecord(body)) {
        if (body.ok === true) return { kind: "ok", body };
        if (body.ok === false && typeof body.error === "string") {
          if (revoked.has(body.error)) {
            saved[kind].forget();
            if (kind === "user") owner = ownerName = userScopes = channel = undefined;
            else bot = channel = undefined;
          }
          return { kind: "refused", error: body.error };
        }
      }
      return { kind: "lost", reason: `Slack answered ${response.status} to ${method}` };
    } catch (error) {
      return { kind: "lost", reason: `${method}: ${failure(error)}` };
    }
  };

  /** A read's body. Any answer but ok is an error, since a read can simply run again. */
  const read = async (kind: Kind, method: string, params: Record<string, string> = {}) => {
    const answer = await call(kind, method, params);
    if (!answer || answer.kind === "ok") return answer?.body;
    throw new Error(answer.kind === "refused" ? `${method}: ${answer.error}` : answer.reason);
  };

  /** The owner's Slack user ID, from the user token. */
  const ownerID = async () => {
    if (owner) return owner;
    const body = await read("user", "auth.test");
    if (!body) return undefined;
    const identity = Schema.decodeUnknownSync(Auth)(body);
    owner = identity.user_id;
    ownerName = identity.user;
    // Whoever owns the user token can instruct the dots, so say who that is.
    if (owner !== announced) console.log(`Slack: acting for ${identity.user ?? "?"} (${owner})`);
    announced = owner;
    return owner;
  };

  return {
    call,
    read,
    owner: ownerID,
    /** The owner's Slack handle from the user token's auth.test, once it has run. */
    ownerName: () => ownerName,
    /** Whether the user token has `scope`, or undefined while Slack hasn't said. */
    userScope: (scope: string) => userScopes?.has(scope),
    /** The bot's own user ID, from the bot token. Undefined when the token isn't a bot's. */
    bot: async () => {
      if (bot) return bot;
      const body = await read("bot", "auth.test");
      if (body) verify(body);
      return bot;
    },
    /** The owner's DM with the bot. Opening it again returns the same conversation. */
    dm: async () => {
      if (channel) return channel;
      const user = await ownerID();
      if (!user) return undefined;
      const body = await read("bot", "conversations.open", { users: user });
      if (body) channel = Schema.decodeUnknownSync(Opened)(body).channel.id;
      return channel;
    },
    /** The DM's ID if a call already found it. */
    knownDM: () => channel,
  };
}

export type Slack = ReturnType<typeof slackClient>;

/** Slack escapes only these three in message text. */
const unescape = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

// A ts is seconds and six decimals, so padding makes text order time order.
const order = (ts: string) => ts.padStart(24, "0");
const after = (ts: string, than: string) => order(ts) > order(than);

const HistoryMessage = Schema.Struct({
  ts: Schema.String,
  user: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
  thread_ts: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Unknown),
});

const History = Schema.Struct({
  messages: Schema.Array(HistoryMessage),
  response_metadata: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
  ),
});

/** Every message in the conversation after `oldest`, across pages. */
async function history(client: Slack, channel: string, params: Record<string, string>) {
  const messages: (typeof HistoryMessage.Type)[] = [];
  for (let cursor = ""; ;) {
    const body = await client.read("bot", "conversations.history", {
      channel,
      limit: "100",
      ...params,
      ...(cursor && { cursor }),
    });
    if (!body) return undefined;
    const page = Schema.decodeUnknownSync(History)(body);
    messages.push(...page.messages);
    cursor = page.response_metadata?.next_cursor ?? "";
    if (!cursor) return messages;
  }
}

const replyEvent = "open_dot_reply";

const replyID = (message: typeof HistoryMessage.Type) => {
  const { metadata } = message;
  if (!isRecord(metadata) || metadata.event_type !== replyEvent) return undefined;
  return isRecord(metadata.event_payload) ? metadata.event_payload.reply_id : undefined;
};

// Picks a dot with "name:", "name," or "@name " at the start.
const addressed = /^(?:@([a-z][a-z0-9-]*)[\s:,]|([a-z][a-z0-9-]*)[:,])\s*/i;

/**
 * Saves the owner's Slack message from the DM `channel` and queues it to a dot in one transaction.
 * The dot is the one the message names, or the one last messaged from Slack, or the first.
 * False when there's no dot.
 */
export function receive(db: Db, channel: string, ts: string, text: string) {
  const ready = listDots(db).filter((dot) => dot.sessionState === "ready");
  const match = addressed.exec(text);
  const name = (match?.[1] ?? match?.[2])?.toLowerCase();
  const named = ready.find((dot) => dot.name === name);
  const last = db.select({ dot: slack.dot }).from(slack).orderBy(desc(slack.ts)).limit(1).get();
  const dot = named ?? ready.find((candidate) => candidate.name === last?.dot) ?? ready[0];
  if (!dot) return false;
  const body = (named && match ? text.slice(match[0].length) : text).trim();
  if (!body) return true;
  db.transaction((tx) => {
    const messageID = SessionMessage.ID.create();
    const saved = tx
      .insert(slack)
      .values({ ts, dot: dot.name, channel, messageID, state: "waiting", createdAt: Date.now() })
      .onConflictDoNothing()
      .returning({ ts: slack.ts })
      .get();
    if (!saved) return;
    tx.insert(outbox)
      .values({
        sessionID: dot.sessionID,
        messageID,
        text: body,
        state: "pending",
        fromOwner: true,
        createdAt: Date.now(),
      })
      .run();
  });
  return true;
}

// chat.postMessage's limit for markdown_text.
const markdownLimit = 12_000;
const clip = (text: string) =>
  text.length > markdownLimit
    ? `${text.slice(0, markdownLimit - 40)}\n\n[cut at Slack's limit]`
    : text;

const attempt = (run: () => Promise<void>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });

/**
 * The owner's chat with the dots in the Slack bot's DM, one pass per call. It reads new messages
 * from the owner, waits for each one's turn, and posts the reply under the dot's name. A reply's
 * ID is saved before it is posted, and a lost post is looked up by that ID before posting again.
 */
export function slackChat(
  db: Db,
  client: Slack,
  layer: Layer.Layer<OpenCode, OpenCodeError>,
  started = Date.now(),
) {
  // Never replay history from before the first message open-dot saw.
  let cursor: string | undefined;
  const problems = new Map<string, string>();
  const note = (part: string, problem?: string) => {
    if (problem === undefined) problems.delete(part);
    else if (problems.get(part) !== problem) {
      console.error(`Slack ${part}: ${problem}`);
      problems.set(part, problem);
    }
  };

  const poll = async () => {
    const owner = await client.owner();
    const channel = owner && (await client.dm());
    if (!channel) return;
    cursor ??=
      db.select({ ts: slack.ts }).from(slack).orderBy(desc(slack.ts)).limit(1).get()?.ts ??
      (started / 1000).toFixed(6);
    const messages = await history(client, channel, { oldest: cursor });
    for (const message of (messages ?? []).toSorted((a, b) => (after(a.ts, b.ts) ? 1 : -1))) {
      const own =
        message.user === owner &&
        !message.subtype &&
        (!message.thread_ts || message.thread_ts === message.ts);
      if (own && !receive(db, channel, message.ts, unescape(message.text ?? "")))
        console.error(`Slack message ${message.ts} ignored: there are no dots.`);
      if (after(message.ts, cursor)) cursor = message.ts;
    }
  };

  const finish = Effect.gen(function* () {
    const waiting = db
      .select({ ts: slack.ts, messageID: slack.messageID, sessionID: dots.sessionID })
      .from(slack)
      .innerJoin(dots, eq(slack.dot, dots.name))
      .innerJoin(outbox, eq(slack.messageID, outbox.messageID))
      .where(and(eq(slack.state, "waiting"), eq(outbox.state, "sent")))
      .orderBy(asc(slack.ts))
      .all();
    if (waiting.length === 0) return;
    yield* Effect.gen(function* () {
      const opencode = yield* OpenCode;
      // Messages that share a turn's end get one reply, on the newest of them.
      const ended = new Map<string, { ts: string; turn: Turn }[]>();
      for (const row of waiting) {
        // The session may already be busy with a later message, so only this turn's end counts.
        const turn = yield* opencode.turnAfter(row);
        if (!turn) continue;
        const key = `${row.sessionID} ${turn.end}`;
        ended.set(key, [...(ended.get(key) ?? []), { ts: row.ts, turn }]);
      }
      for (const group of ended.values()) {
        group.forEach(({ ts, turn }, index) =>
          db
            .update(slack)
            .set(
              index === group.length - 1
                ? {
                    state: "posting",
                    replyID: crypto.randomUUID(),
                    replyText: turn.text ?? `(no reply: ${turn.outcome})`,
                  }
                : { state: "answered" },
            )
            .where(and(eq(slack.ts, ts), eq(slack.state, "waiting")))
            .run(),
        );
      }
    }).pipe(Effect.provide(layer));
  });

  /** Moves the row on from the state it was read in. False when another pass already did. */
  const settle = (
    ts: string,
    from: "posting" | "unknown",
    set: Partial<typeof slack.$inferInsert>,
  ) =>
    db
      .update(slack)
      .set(set)
      .where(and(eq(slack.ts, ts), eq(slack.state, from)))
      .returning({ ts: slack.ts })
      .get() !== undefined;

  const post = async () => {
    const rows = db
      .select()
      .from(slack)
      .where(inArray(slack.state, ["posting", "unknown"]))
      .orderBy(asc(slack.ts))
      .all();
    for (const row of rows) {
      if (!row.replyID || row.replyText === null) continue;
      if (row.state === "unknown") {
        const messages = await history(client, row.channel, {
          oldest: row.ts,
          include_all_metadata: "true",
        });
        if (!messages) return;
        const found = messages.find((message) => replyID(message) === row.replyID);
        settle(
          row.ts,
          "unknown",
          found ? { state: "posted", replyTS: found.ts } : { state: "posting" },
        );
        continue;
      }
      // From here a crash leaves the row "unknown", so it's looked up rather than posted again.
      if (!settle(row.ts, "posting", { state: "unknown" })) continue;
      const answer = await client.call("bot", "chat.postMessage", {
        channel: row.channel,
        username: row.dot,
        markdown_text: clip(row.replyText),
        metadata: JSON.stringify({
          event_type: replyEvent,
          event_payload: { reply_id: row.replyID },
        }),
      });
      if (answer?.kind === "ok") {
        const ts = typeof answer.body.ts === "string" ? answer.body.ts : null;
        settle(row.ts, "unknown", { state: "posted", replyTS: ts });
      } else if (answer?.kind === "lost") {
        console.error(`Slack reply to ${row.ts} is unknown, looking it up: ${answer.reason}`);
      } else if (!answer || answer.error === "ratelimited") {
        // Nothing was sent, so it's posted on a later pass.
        settle(row.ts, "unknown", { state: "posting" });
        return;
      } else {
        settle(row.ts, "unknown", { state: "failed" });
        console.error(`Slack reply to ${row.ts} failed: ${answer.error}`);
      }
    }
  };

  const guard = (part: string, effect: Effect.Effect<void, unknown>) =>
    effect.pipe(
      Effect.andThen(Effect.sync(() => note(part))),
      Effect.catchCause((cause) => Effect.sync(() => note(part, failure(Cause.squash(cause))))),
    );

  return Effect.all(
    [guard("chat", attempt(poll)), guard("turn", finish), guard("reply", attempt(post))],
    {
      discard: true,
    },
  );
}

// Unverified search modifiers until a live test. The local filters in slackFeed keep a wrong one
// from showing messages that don't need the owner.
export const mentionQuery = (owner: string, day: string) => `<@${owner}> after:${day}`;
export const dmQuery = (day: string) => `is:dm after:${day}`;

const Match = Schema.Struct({
  ts: Schema.String,
  type: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.NullOr(Schema.String)),
  text: Schema.optionalKey(Schema.String),
  permalink: Schema.optionalKey(Schema.String),
  channel: Schema.Struct({
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
    is_im: Schema.optionalKey(Schema.Boolean),
    is_mpim: Schema.optionalKey(Schema.Boolean),
  }),
});
type Match = typeof Match.Type;

const Search = Schema.Struct({
  messages: Schema.Struct({
    matches: Schema.Array(Match),
    paging: Schema.optionalKey(Schema.Struct({ page: Schema.Number, pages: Schema.Number })),
  }),
});

// More pages than this in a day is a flood; the feed keeps what it had rather than miss some.
const searchPages = 10;
const Info = Schema.Struct({
  channel: Schema.Struct({ last_read: Schema.optionalKey(Schema.String) }),
});

const isIM = (match: Match) =>
  match.channel.is_im === true || match.type === "im" || match.channel.id.startsWith("D");
const isDirect = (match: Match) => isIM(match) || match.channel.is_mpim === true;

// A mention without a label, so its name has to be found elsewhere.
const bareMention = /<@(\w+)>/g;

/** The name Slack shows for a user in users.info's answer. */
const nameIn = (body: Record<string, unknown>) => {
  const user = isRecord(body.user) ? body.user : {};
  const profile = isRecord(user.profile) ? user.profile : {};
  return [profile.display_name, user.real_name, user.name].find(
    (name): name is string => typeof name === "string" && name !== "",
  );
};

/** One line of plain text: a link shows its label, a mention the name or else the ID. */
const headline = (text: string, names: ReadonlyMap<string, string | null>) => {
  const plain = text.replace(/<([^<>|]*)(?:\|([^<>]*))?>/g, (_, ref: string, label?: string) => {
    if (ref.startsWith("@")) return `@${label || names.get(ref.slice(1)) || ref.slice(1)}`;
    if (ref.startsWith("#")) return `#${label || ref.slice(1)}`;
    if (ref.startsWith("!")) return label || `@${ref.slice(1).split("^")[0]}`;
    return label || ref;
  });
  const line = unescape(plain).replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/**
 * Slack mentions of the owner and DMs to them, with the owner's user token. A DM leaves the feed
 * once the owner reads it in Slack. Slack has no read state for a mention in a channel, so one
 * stays until dismissed or a day old, and dismissing it changes nothing in Slack.
 */
export function slackFeed(client: Slack): Source {
  // Null when Slack has no name for the ID.
  const names = new Map<string, string | null>();
  let warned = false;
  const warn = (problem: string) => {
    if (!warned)
      console.error(
        `Slack: ${problem}. Feed mentions of others show user IDs until you add users:read to the app's user scopes, reinstall the app, and save its new User OAuth Token (xoxp-…) under open-dot-slack-user.`,
      );
    warned = true;
  };
  /** Names the users mentioned in `texts`, until Slack can't say for now. */
  const learn = async (owner: string, texts: string[]) => {
    const handle = client.ownerName();
    if (handle) names.set(owner, handle);
    const ids = texts.flatMap((text) => [...text.matchAll(bareMention)].map((m) => m[1] ?? ""));
    for (const id of new Set(ids)) {
      if (names.has(id)) continue;
      // Asking without the scope would drop the token and pause Slack for a minute.
      if (client.userScope("users:read") === false) return warn("the user token lacks users:read");
      const answer = await client.call("user", "users.info", { user: id });
      if (answer?.kind === "ok") {
        names.set(id, nameIn(answer.body) ?? null);
        warned = false;
        continue;
      }
      // The client has dropped the token, so a reinstalled one is read within a minute.
      if (answer?.kind === "refused" && answer.error === "missing_scope")
        warn("users.info answered missing_scope, so the user token is read again in a minute");
      // Until Slack can answer, IDs stand in for names this pass.
      if (answer?.kind !== "refused" || ["missing_scope", "ratelimited"].includes(answer.error))
        return;
      names.set(id, null);
    }
  };
  return {
    name: "slack",
    unread: async (since) => {
      const owner = await client.owner();
      if (!owner) return undefined;
      // Search filters by day, so ask for a day more and filter by time here.
      const day = new Date(since - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      /** Every match since `since`, newest first, or undefined when they can't all be read. */
      const search = async (query: string) => {
        const matches: Match[] = [];
        for (let page = 1; page <= searchPages; page++) {
          const body = await client.read("user", "search.messages", {
            query,
            sort: "timestamp",
            sort_dir: "desc",
            count: "100",
            page: String(page),
          });
          if (!body) return undefined;
          const { messages } = Schema.decodeUnknownSync(Search)(body);
          matches.push(...messages.matches);
          const oldest = messages.matches.at(-1);
          if (
            !oldest ||
            Number(oldest.ts) * 1000 < since ||
            !messages.paging ||
            messages.paging.page >= messages.paging.pages
          )
            return matches;
        }
        return undefined;
      };
      const mentions = await search(mentionQuery(owner, day));
      if (!mentions) return undefined;
      const direct = await search(dmQuery(day));
      if (!direct) return undefined;
      const mentioned = (text = "") => text.includes(`<@${owner}>`) || text.includes(`<@${owner}|`);
      const dm = client.knownDM();
      const bot = dm ? undefined : await client.bot();
      const found = new Map<string, { match: Match; reason: string }>();
      for (const [matches, mention] of [
        [mentions, true],
        [direct, false],
      ] as const) {
        for (const match of matches) {
          const id = `${match.channel.id}/${match.ts}`;
          if (
            found.has(id) ||
            Number(match.ts) * 1000 < since ||
            match.user === owner ||
            (dm ? match.channel.id === dm : bot !== undefined && match.user === bot) ||
            (mention ? !mentioned(match.text) : !isDirect(match))
          )
            continue;
          found.set(id, { match, reason: mention ? "Mentioned" : "Direct message" });
        }
      }
      const lastRead = new Map<string, string | undefined>();
      for (const { match } of found.values()) {
        if (!isIM(match) || lastRead.has(match.channel.id)) continue;
        const body = await client.read("user", "conversations.info", { channel: match.channel.id });
        if (!body) return undefined;
        lastRead.set(match.channel.id, Schema.decodeUnknownSync(Info)(body).channel.last_read);
      }
      const unread = [...found].filter(([, { match }]) => {
        const read = lastRead.get(match.channel.id);
        return read === undefined || after(match.ts, read);
      });
      await learn(
        owner,
        unread.map(([, { match }]) => match.text ?? ""),
      );
      return unread.map(([sourceID, { match, reason }]) => ({
        sourceID,
        reason,
        title: headline(match.text ?? "", names),
        context: isDirect(match) ? "DM" : `#${match.channel.name ?? match.channel.id}`,
        url: match.permalink ?? null,
        updatedAt: Math.round(Number(match.ts) * 1000),
      }));
    },
    // Dismissing hides the item in the notch only.
    markRead: async () => {},
  };
}
