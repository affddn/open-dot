import { SessionMessage } from "@opencode/client/effect";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Cause, Effect, type Layer, Schema } from "effect";
import type { Db } from "./db";
import { listDots } from "./dots";
import { type Fetch, output, type Source } from "./feed";
import { OpenCode, type OpenCodeError } from "./opencode";
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

// Errors that mean the token itself is bad, so the Keychain is read again.
const revoked = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive"]);

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

const Auth = Schema.Struct({ user_id: Schema.String });
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
  let bot: string | undefined;
  let channel: string | undefined;

  const call = async (
    kind: Kind,
    method: string,
    params: Record<string, string> = {},
  ): Promise<Answer | undefined> => {
    const token = await saved[kind].get();
    if (!token) return undefined;
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
      if (response.status === 429) return { kind: "refused", error: "ratelimited" };
      const body: unknown = await response.json().catch(() => undefined);
      if (response.status < 500 && isRecord(body)) {
        if (body.ok === true) return { kind: "ok", body };
        if (body.ok === false && typeof body.error === "string") {
          if (revoked.has(body.error)) {
            saved[kind].forget();
            if (kind === "user") owner = channel = undefined;
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
    if (body) owner = Schema.decodeUnknownSync(Auth)(body).user_id;
    return owner;
  };

  return {
    call,
    read,
    owner: ownerID,
    /** The bot's own user ID, from the bot token. */
    bot: async () => {
      if (bot) return bot;
      const body = await read("bot", "auth.test");
      if (body) bot = Schema.decodeUnknownSync(Auth)(body).user_id;
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
 * Saves the owner's Slack message and queues it to a dot in one transaction. The dot is the one
 * the message names, or the one last messaged from Slack, or the first. False when there's no dot.
 */
export function receive(db: Db, ts: string, text: string) {
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
      .values({ ts, dot: dot.name, messageID, state: "waiting", createdAt: Date.now() })
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
      if (own && !receive(db, message.ts, unescape(message.text ?? "")))
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
      const active = yield* opencode.activeSessions;
      for (const row of waiting) {
        if (active.has(row.sessionID)) continue;
        const turn = yield* opencode.turnAfter(row);
        if (!turn) continue;
        db.update(slack)
          .set({
            state: "posting",
            replyID: crypto.randomUUID(),
            replyText: turn.text ?? `(no reply: ${turn.outcome})`,
          })
          .where(and(eq(slack.ts, row.ts), eq(slack.state, "waiting")))
          .run();
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
    if (rows.length === 0) return;
    const channel = await client.dm();
    if (!channel) return;
    for (const row of rows) {
      if (!row.replyID || row.replyText === null) continue;
      if (row.state === "unknown") {
        const messages = await history(client, channel, {
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
        channel,
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

const Search = Schema.Struct({ messages: Schema.Struct({ matches: Schema.Array(Match) }) });
const Info = Schema.Struct({
  channel: Schema.Struct({ last_read: Schema.optionalKey(Schema.String) }),
});

const isIM = (match: Match) =>
  match.channel.is_im === true || match.type === "im" || match.channel.id.startsWith("D");
const isDirect = (match: Match) => isIM(match) || match.channel.is_mpim === true;

const headline = (text: string) => {
  const line = unescape(text).replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/**
 * Slack mentions of the owner and DMs to them, with the owner's user token. A DM leaves the feed
 * once the owner reads it in Slack. Slack has no read state for a mention in a channel, so one
 * stays until dismissed or a day old, and dismissing it changes nothing in Slack.
 */
export function slackFeed(client: Slack): Source {
  return {
    name: "slack",
    unread: async (since) => {
      const owner = await client.owner();
      if (!owner) return undefined;
      // Search filters by day, so ask for a day more and filter by time here.
      const day = new Date(since - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const search = async (query: string) => {
        const body = await client.read("user", "search.messages", {
          query,
          sort: "timestamp",
          count: "100",
        });
        return body && Schema.decodeUnknownSync(Search)(body).messages.matches;
      };
      const mentions = await search(mentionQuery(owner, day));
      const direct = await search(dmQuery(day));
      if (!mentions || !direct) return undefined;
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
            (!mention && !isDirect(match))
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
      return [...found].flatMap(([sourceID, { match, reason }]) => {
        const read = lastRead.get(match.channel.id);
        if (read !== undefined && !after(match.ts, read)) return [];
        return [
          {
            sourceID,
            reason,
            title: headline(match.text ?? ""),
            context: isDirect(match) ? "DM" : `#${match.channel.name ?? match.channel.id}`,
            url: match.permalink ?? null,
            updatedAt: Math.round(Number(match.ts) * 1000),
          },
        ];
      });
    },
    // Dismissing hides the item in the notch only.
    markRead: async () => {},
  };
}
