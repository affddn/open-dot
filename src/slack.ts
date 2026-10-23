import { SessionMessage } from "@opencode/client/effect";
import { and, asc, desc, eq, inArray, gte, or, ne } from "drizzle-orm";
import { Cause, Effect, type Layer, Schema } from "effect";
import type { Db } from "./db";
import { listDots } from "./dots";
import { quoted, quoteText, replyPrompt } from "./replies";
import { type Fetch, output, type Source } from "./feed";
import { OpenCode, type OpenCodeError, type Turn } from "./opencode";
import {
  dots,
  outbox,
  slack,
  slackConfig,
  slackNotices,
  slackThreads,
  slackPolls,
  routeKey,
  type Route,
  type QuoteSnapshot,
} from "./schema";

type Kind = "bot" | "user" | "app";

/**
 * What Slack did with a call. "refused" means Slack answered that it did nothing, while "lost"
 * means the call may or may not have taken effect.
 */
export type Answer =
  | { readonly kind: "ok"; readonly body: Record<string, unknown> }
  | { readonly kind: "refused"; readonly error: string }
  | { readonly kind: "lost"; readonly reason: string };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
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

export const keychain = (service: string) => () =>
  output(["security", "find-generic-password", "-s", service, "-w"]);

const none = async () => undefined;

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

const Auth = Schema.Struct({
  user_id: Schema.String,
  user: Schema.optionalKey(Schema.String),
  team_id: Schema.optionalKey(Schema.String),
});
const Opened = Schema.Struct({ channel: Schema.Struct({ id: Schema.String }) });

/** The app, workspace and bot a dot's own bot token must belong to. */
export interface Expected {
  readonly app: string;
  readonly team: string;
  /** The bot's user and bot IDs once a check has saved them. */
  readonly botUser?: string | null;
  readonly botID?: string | null;
}

interface Tokens {
  readonly bot: () => Promise<string | undefined>;
  readonly user: () => Promise<string | undefined>;
  readonly app?: () => Promise<string | undefined>;
}

/**
 * Slack's Web API with the bot token from the Keychain item `open-dot-slack-bot` and the owner's
 * user token from `open-dot-slack-user`. Calls with a token that isn't saved give undefined.
 * A dot's own app passes its Keychain item and `expected`, so its bot token is used only once
 * Slack shows it belongs to that app, workspace and bot. `expected` can be a function, read at
 * every check, so a bot identity saved later binds every token read after it. While it gives
 * nothing, no bot token is used.
 */
export function slackClient(
  fetch: Fetch = globalThis.fetch,
  tokens: Tokens = { bot: keychain("open-dot-slack-bot"), user: keychain("open-dot-slack-user") },
  now = Date.now,
  options: {
    readonly item?: string;
    readonly expected?: Expected | (() => Expected | undefined);
  } = {},
) {
  const base = process.env.OPEN_DOT_SLACK_URL ?? "https://slack.com/api";
  const item = options.item ?? "open-dot-slack-bot";
  const saved = {
    bot: remembered(tokens.bot, now),
    user: remembered(tokens.user, now),
    app: remembered(tokens.app ?? none, now),
  };
  let owner: string | undefined;
  let ownerName: string | undefined;
  let team: string | undefined;
  // The user token's scopes, from Slack's x-oauth-scopes header once a call has shown them.
  let userScopes: Set<string> | undefined;
  let announced: string | undefined;
  let bot: string | undefined;
  let botID: string | undefined;
  let botTeam: string | undefined;
  let channel: string | undefined;
  let wrongBot = false;
  // The last refusal of a bot token check, so it's logged once.
  let unchecked: string | undefined;
  // Slack's limits are per app and workspace, so one pause after a 429 covers every call.
  let pausedUntil = 0;

  const forget = (kind: Kind) => {
    saved[kind].forget();
    if (kind === "user") owner = ownerName = team = userScopes = channel = undefined;
    if (kind === "bot") bot = botID = botTeam = channel = undefined;
  };

  /** One call with the given token, without any identity check. */
  const send = async (
    kind: Kind,
    token: string,
    method: string,
    params: Record<string, string>,
  ): Promise<Answer> => {
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
          if (revoked.has(body.error)) forget(kind);
          return { kind: "refused", error: body.error };
        }
      }
      return { kind: "lost", reason: `Slack answered ${response.status} to ${method}` };
    } catch (error) {
      return { kind: "lost", reason: `${method}: ${failure(error)}` };
    }
  };

  /** What the bot token must show now. */
  const current = () =>
    typeof options.expected === "function" ? options.expected() : options.expected;

  const wrong = (problem: string) => {
    forget("bot");
    if (!wrongBot)
      console.error(
        `Slack: the Keychain item ${item} ${problem}. Save the right Bot User OAuth Token (xoxb-…) there instead; the daemon reads it again within a minute.`,
      );
    wrongBot = true;
    return false;
  };

  /**
   * Checks the bot token with auth.test, and for a dot's own app with bots.info, before it's used.
   * A token without a bot_id isn't a bot's, so a user token saved as the bot's never acts as the
   * owner. Gives a refusal to pass on, true when the token is fit to use, or false.
   */
  const identify = async (token: string): Promise<Answer | boolean> => {
    const checked = await send("bot", token, "auth.test", {});
    // The call itself never left, so a lost check means only "not now".
    if (checked.kind === "refused") return checked;
    if (checked.kind !== "ok") return false;
    const body = checked.body;
    if (typeof body.bot_id !== "string" || typeof body.user_id !== "string")
      return wrong("holds a token that isn't a bot's");
    if (options.expected) {
      const expected = current();
      if (!expected) return false;
      if (body.team_id !== expected.team) return wrong("holds a bot token from another workspace");
      const pinned = (want: Expected) =>
        (!want.botUser || body.user_id === want.botUser) &&
        (!want.botID || body.bot_id === want.botID);
      if (!pinned(expected)) return wrong("holds a token for another bot");
      const info = await send("bot", token, "bots.info", { bot: body.bot_id });
      if (info.kind === "refused") return info;
      if (info.kind !== "ok") return false;
      const found = isRecord(info.body.bot) ? info.body.bot : {};
      if (found.app_id !== expected.app || found.user_id !== body.user_id)
        return wrong(`holds the bot token of another app than ${expected.app}`);
      // The bot's identity may have been saved while bots.info was asked.
      const after = current();
      if (!after || after.app !== expected.app || after.team !== expected.team) return false;
      if (!pinned(after)) return wrong("holds a token for another bot");
    }
    bot = body.user_id;
    botID = body.bot_id;
    botTeam = typeof body.team_id === "string" ? body.team_id : undefined;
    wrongBot = false;
    return true;
  };

  /**
   * Calls `method`. Undefined means it was never sent: there's no usable token, or the bot token's
   * check didn't pass. A check's own refusal, such as internal_error, is never passed on as the
   * method's answer, so a write that never left can't look like one that may have happened.
   */
  const call = async (
    kind: Kind,
    method: string,
    params: Record<string, string> = {},
    guard?: () => boolean,
  ): Promise<Answer | undefined> => {
    const token = await saved[kind].get();
    if (!token) return undefined;
    if (kind === "bot" && !bot) {
      const fit = await identify(token);
      if (fit !== true) {
        const problem = typeof fit === "object" && fit.kind === "refused" ? fit.error : undefined;
        if (problem && problem !== "ratelimited" && problem !== unchecked)
          console.error(
            `Slack: couldn't check the token in ${item} (${problem}), so nothing was sent.`,
          );
        unchecked = problem;
        return undefined;
      }
      unchecked = undefined;
      if (method === "auth.test") return { kind: "ok", body: { user_id: bot, bot_id: botID } };
    }
    if (guard && !guard()) return undefined;
    return send(kind, token, method, params);
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
    team = identity.team_id;
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
    /** The owner's workspace from the user token's auth.test, once it has run. */
    team: () => team,
    knownOwner: () => owner,
    /** Whether the user token has `scope`, or undefined while Slack hasn't said. */
    userScope: (scope: string) => userScopes?.has(scope),
    /** The bot's own user ID, from the bot token. Undefined when the token isn't fit to use. */
    bot: async () => {
      if (bot) return bot;
      const token = await saved.bot.get();
      const fit = token && (await identify(token));
      if (typeof fit === "object" && fit.kind === "refused")
        throw new Error(`Slack refused to check the bot token: ${fit.error}`);
      return bot;
    },
    /** The bot's bot ID, once its token has been checked. */
    botID: () => botID,
    botTeam: () => botTeam,
    /** Drops a token, so the Keychain is read again a minute later. */
    forget,
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
export const unescape = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

// A ts is seconds and six decimals, so padding makes text order time order.
const order = (ts: string) => ts.padStart(24, "0");
export const after = (ts: string, than: string) => order(ts) > order(than);

export const HistoryMessage = Schema.Struct({
  ts: Schema.String,
  user: Schema.optionalKey(Schema.String),
  bot_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  subtype: Schema.optionalKey(Schema.String),
  thread_ts: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Unknown),
  blocks: Schema.optionalKey(Schema.Unknown),
});

export const History = Schema.Struct({
  messages: Schema.Array(HistoryMessage),
  response_metadata: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
  ),
});

/** Every message in the conversation after `oldest`, across pages. */
export async function history(client: Slack, channel: string, params: Record<string, string>) {
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

export async function thread(client: Slack, channel: string, ts: string, metadata = false) {
  const messages: (typeof HistoryMessage.Type)[] = [];
  for (let cursor = ""; ;) {
    const body = await client.read("bot", "conversations.replies", {
      channel,
      ts,
      limit: "100",
      ...(metadata && { include_all_metadata: "true" }),
      ...(cursor && { cursor }),
    });
    if (!body) throw new Error("Slack thread could not be read");
    const page = Schema.decodeUnknownSync(History)(body);
    messages.push(...page.messages);
    cursor = page.response_metadata?.next_cursor ?? "";
    if (!cursor && body.has_more === true) throw new Error("A thread page had no cursor");
    if (!cursor) return messages;
  }
}

export const replyEvent = "open_dot_reply";

export const replyID = (message: typeof HistoryMessage.Type) => {
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
export function receive(
  db: Db,
  channel: string,
  ts: string,
  text: string,
  origin?: {
    owner: string;
    team: string;
    bot: string;
    thread: string;
    parent?: QuoteSnapshot["parent"] | null;
  },
) {
  const ready = listDots(db).filter((dot) => dot.sessionState === "ready");
  const pinned =
    origin &&
    db
      .select()
      .from(slackThreads)
      .all()
      .find(
        ({ route }) =>
          route.kind === "shared" &&
          route.channel === channel &&
          route.thread === origin.thread &&
          route.owner === origin.owner &&
          route.team === origin.team &&
          route.bot === origin.bot,
      );
  if (origin && origin.thread !== ts && !pinned) return false;
  const match = addressed.exec(text);
  const name = (match?.[1] ?? match?.[2])?.toLowerCase();
  const named = ready.find((dot) => dot.name === name);
  const last = db
    .select()
    .from(slack)
    .where(eq(slack.channel, channel))
    .orderBy(desc(slack.ts))
    .all()
    .find(
      (row) =>
        /^\d+\.\d+$/.test(row.ts) &&
        (!origin ||
          !row.route ||
          (row.route.owner === origin.owner &&
            row.route.team === origin.team &&
            row.route.bot === origin.bot)),
    );
  const dot = pinned
    ? ready.find(
        (candidate) =>
          candidate.name === pinned.route.dot && candidate.sessionID === pinned.route.sessionID,
      )
    : (named ?? ready.find((candidate) => candidate.name === last?.dot) ?? ready[0]);
  if (!dot) return false;
  const body = (!pinned && named && match ? text.slice(match[0].length) : text).trim();
  if (!body) return true;
  const route: Route | null = origin
    ? (pinned?.route ?? {
        kind: "shared",
        dot: dot.name,
        sessionID: dot.sessionID,
        channel,
        thread: origin.thread,
        owner: origin.owner,
        team: origin.team,
        bot: origin.bot,
        dm: true,
      })
    : null;
  const parent = origin?.parent ?? pinned?.parent;
  const quote: QuoteSnapshot | undefined =
    parent && origin?.thread !== ts ? { prompt: body, parent } : undefined;
  db.transaction((tx) => {
    const messageID = SessionMessage.ID.create();
    const saved = tx
      .insert(slack)
      .values({
        ts,
        dot: dot.name,
        channel,
        route,
        messageID,
        state: "waiting",
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .returning({ ts: slack.ts })
      .get();
    if (!saved) return;
    if (route)
      tx.insert(slackThreads)
        .values({
          key: routeKey(route),
          route,
          parent: parent ?? {
            source: "slack",
            id: ts,
            place: channel,
            author: "owner",
            text: quoteText(text),
          },
          oldest: route.thread,
          newest: route.thread,
          activeAt: Date.now(),
        })
        .onConflictDoUpdate({ target: slackThreads.key, set: { activeAt: Date.now() } })
        .run();
    tx.insert(outbox)
      .values({
        sessionID: dot.sessionID,
        messageID,
        text: `${quote ? replyPrompt(quote) : body}\n\nSlack destination (untrusted data): ${quoted(route && { channel, thread: route.thread })}`,
        ownerText: body,
        route,
        quote,
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
 * ID is saved before it is posted, and a lost post is only looked up by that ID.
 */
export function slackChat(
  db: Db,
  client: Slack,
  layer: Layer.Layer<OpenCode, OpenCodeError>,
  started = Date.now(),
) {
  // Never replay history from before the first message open-dot saw.
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
    const bot = await client.bot();
    const botID = client.botID();
    const team = client.team();
    if (!channel || !owner || !bot || !botID || !team || client.botTeam() !== team) return;
    const fits = () =>
      client.knownOwner() === owner &&
      client.team() === team &&
      client.botID() === botID &&
      client.botTeam() === team;
    const key = JSON.stringify([owner, team, botID, channel]);
    const baseline =
      db
        .select()
        .from(slack)
        .all()
        .filter(
          (row) =>
            row.channel === channel &&
            /^\d+\.\d+$/.test(row.ts) &&
            (!row.route || row.route.thread === row.ts),
        )
        .map((row) => row.ts)
        .toSorted((a, b) => (after(a, b) ? -1 : 1))[0] ?? (started / 1000).toFixed(6);
    db.insert(slackPolls)
      .values({ key, oldest: baseline, newest: baseline })
      .onConflictDoNothing()
      .run();
    const scan = db.select().from(slackPolls).where(eq(slackPolls.key, key)).get();
    if (!scan) throw new Error("The saved Slack polling checkpoint is missing");
    const continuation = scan.cursor
      ? Schema.decodeUnknownSync(
          Schema.Struct({
            cursor: Schema.String,
            messages: Schema.Array(Schema.Struct({ ts: Schema.String, text: Schema.String })),
          }),
        )(JSON.parse(scan.cursor))
      : { cursor: "", messages: [] };
    const topBody = await client
      .read("bot", "conversations.history", {
        channel,
        oldest: scan.oldest,
        limit: "100",
        ...(continuation.cursor && { cursor: continuation.cursor }),
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "conversations.history: invalid_cursor")
          db.update(slackPolls).set({ cursor: "" }).where(eq(slackPolls.key, key)).run();
        throw error;
      });
    if (!topBody || !fits()) return;
    const top = Schema.decodeUnknownSync(History)(topBody);
    const topNext = top.response_metadata?.next_cursor ?? "";
    if (!topNext && topBody.has_more === true) throw new Error("A history page had no cursor");
    db.transaction(() => {
      let newest = scan.newest;
      const pending = [...continuation.messages];
      for (const message of top.messages.toSorted((a, b) => (after(a.ts, b.ts) ? 1 : -1))) {
        const own =
          message.user === owner &&
          !message.bot_id &&
          !message.subtype &&
          (!message.thread_ts || message.thread_ts === message.ts);
        if (own) pending.push({ ts: message.ts, text: unescape(message.text ?? "") });
        if (after(message.ts, newest)) newest = message.ts;
      }
      // Slack history pages run backwards. Delay routing until the scan is complete, so a name on
      // an older page still selects the dot for an unprefixed message on a newer page.
      if (!topNext)
        for (const message of pending.toSorted((a, b) => (after(a.ts, b.ts) ? 1 : -1))) {
          if (
            !receive(db, channel, message.ts, message.text, {
              owner,
              team,
              bot: botID,
              thread: message.ts,
            })
          )
            console.error(`Slack message ${message.ts} ignored: there are no dots.`);
        }
      db.update(slackPolls)
        .set({
          newest,
          oldest: topNext ? scan.oldest : newest,
          cursor: topNext ? JSON.stringify({ cursor: topNext, messages: pending }) : "",
        })
        .where(eq(slackPolls.key, key))
        .run();
    });
    // Four one-page visits per tick, least recently polled first; unfinished scans survive restarts.
    const threads = db
      .select()
      .from(slackThreads)
      .where(
        or(
          gte(slackThreads.activeAt, Date.now() - 7 * 86400_000),
          ne(slackThreads.cursor, ""),
          eq(slackThreads.rescan, true),
        ),
      )
      .orderBy(asc(slackThreads.polledAt), asc(slackThreads.key))
      .all()
      .filter(
        ({ route }) =>
          route.kind === "shared" &&
          route.owner === owner &&
          route.team === team &&
          route.bot === botID &&
          route.channel === channel,
      )
      .slice(0, 4);
    for (const saved of threads) {
      const last =
        db
          .select({ at: slackThreads.polledAt })
          .from(slackThreads)
          .orderBy(desc(slackThreads.polledAt))
          .limit(1)
          .get()?.at ?? 0;
      db.update(slackThreads)
        .set({ polledAt: Math.max(Date.now(), last + 1) })
        .where(eq(slackThreads.key, saved.key))
        .run();
      const pageBody = await client
        .read("bot", "conversations.replies", {
          channel,
          ts: saved.route.thread,
          oldest: saved.oldest,
          limit: "100",
          ...(saved.cursor && { cursor: saved.cursor }),
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === "conversations.replies: invalid_cursor")
            db.update(slackThreads)
              .set({ cursor: "", rescan: true })
              .where(eq(slackThreads.key, saved.key))
              .run();
          throw error;
        });
      if (!pageBody || !fits()) return;
      const page = Schema.decodeUnknownSync(History)(pageBody);
      const next = page.response_metadata?.next_cursor ?? "";
      if (!next && pageBody.has_more === true) throw new Error("A thread page had no cursor");
      const root = page.messages.find((message) => message.ts === saved.route.thread);
      const parent =
        saved.parent ??
        (root
          ? {
              source: "slack" as const,
              id: root.ts,
              place: channel,
              author:
                root.user === owner
                  ? ("owner" as const)
                  : root.bot_id === botID
                    ? ("dot" as const)
                    : ("other" as const),
              text: quoteText(unescape(root.text ?? "")),
            }
          : null);
      db.transaction(() => {
        let newest = saved.newest;
        for (const message of page.messages.toSorted((a, b) => (after(a.ts, b.ts) ? 1 : -1))) {
          if (after(message.ts, newest)) newest = message.ts;
          if (
            message.ts !== saved.route.thread &&
            message.user === owner &&
            !message.bot_id &&
            !message.subtype
          )
            receive(db, channel, message.ts, unescape(message.text ?? ""), {
              owner,
              team,
              bot: botID,
              thread: saved.route.thread,
              parent,
            });
        }
        db.update(slackThreads)
          .set({
            cursor: next,
            rescan: false,
            newest,
            oldest: next ? saved.oldest : newest,
            parent,
          })
          .where(eq(slackThreads.key, saved.key))
          .run();
      });
    }
  };

  const finish = Effect.gen(function* () {
    const waiting = db
      .select({
        ts: slack.ts,
        messageID: slack.messageID,
        sessionID: outbox.sessionID,
        route: slack.route,
      })
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
        const key = `${row.sessionID} ${routeKey(row.route)} ${turn.end}`;
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
      const bot = await client.bot();
      const botID = client.botID();
      if (!bot || !botID) continue;
      if (row.route) await client.owner();
      const fits = () =>
        client.botID() === botID &&
        (!row.route ||
          (row.route.kind === "shared" &&
            row.route.owner === client.knownOwner() &&
            row.route.team === client.team() &&
            row.route.team === client.botTeam() &&
            row.route.bot === botID &&
            db
              .select()
              .from(dots)
              .where(and(eq(dots.name, row.dot), eq(dots.sessionState, "ready")))
              .get()?.sessionID === row.route.sessionID));
      if (!fits()) continue;
      if (row.state === "unknown") {
        const messages = row.route
          ? await thread(client, row.channel, row.route.thread, true)
          : await history(client, row.channel, {
              oldest: row.ts,
              include_all_metadata: "true",
            });
        if (!messages) return;
        const found = messages.find(
          (message) => replyID(message) === row.replyID && message.bot_id === botID,
        );
        if (found && fits()) settle(row.ts, "unknown", { state: "posted", replyTS: found.ts });
        continue;
      }
      // From here a crash leaves the row "unknown", so it's looked up rather than posted again.
      if (!settle(row.ts, "posting", { state: "unknown" })) continue;
      const answer = await client.call(
        "bot",
        "chat.postMessage",
        {
          channel: row.channel,
          ...(row.route && { thread_ts: row.route.thread }),
          username: row.dot,
          markdown_text: clip(row.replyText),
          metadata: JSON.stringify({
            event_type: replyEvent,
            event_payload: { reply_id: row.replyID },
          }),
        },
        fits,
      );
      if (answer?.kind === "ok") {
        const ts = typeof answer.body.ts === "string" ? answer.body.ts : null;
        settle(row.ts, "unknown", { state: "posted", replyTS: ts });
      } else if (
        answer?.kind === "lost" ||
        (answer?.kind === "refused" &&
          ["fatal_error", "internal_error", "service_unavailable", "request_timeout"].includes(
            answer.error,
          ))
      ) {
        console.error(`Slack reply to ${row.ts} is unknown, lookup only`);
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

/**
 * Tells `user` once per conversation that `who` only answers the owner, in a note only they see.
 * The note is saved before the call, and any outcome is final: nobody is told twice, even if a
 * lost note never arrived. False while the bot token isn't usable, so it's tried again later.
 */
export async function notice(
  db: Db,
  client: Slack,
  place: { readonly channel: string; readonly user: string; readonly thread?: string | null },
  text: string,
) {
  const bot = await client.bot();
  if (!bot) return false;
  const saved = db
    .insert(slackNotices)
    .values({
      bot,
      channel: place.channel,
      user: place.user,
      state: "sending",
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .returning({ id: slackNotices.id })
    .get();
  if (!saved) return true;
  const answer = await client.call("bot", "chat.postEphemeral", {
    channel: place.channel,
    user: place.user,
    text,
    ...(place.thread && { thread_ts: place.thread }),
  });
  db.update(slackNotices)
    .set({
      state: answer?.kind === "ok" ? "sent" : answer?.kind === "lost" ? "unknown" : "refused",
    })
    .where(eq(slackNotices.id, saved.id))
    .run();
  if (answer?.kind !== "ok")
    console.error(
      `Slack note to ${place.user} in ${place.channel} was not confirmed, and won't be sent again: ${answer?.kind === "refused" ? answer.error : (answer?.reason ?? "no bot token")}`,
    );
  return true;
}

const Ims = Schema.Struct({
  channels: Schema.Array(
    Schema.Struct({ id: Schema.String, user: Schema.optionalKey(Schema.String) }),
  ),
  response_metadata: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
  ),
});

/**
 * Finds people other than the owner who DM the shared app, and tells each once that it only
 * answers the owner. Nothing happens, not even a Slack call, until the owner turns it on with
 * `open-dot slack notices enable`. It lists every DM the bot has, page by page, and reads each one
 * whose sender it hasn't told from the time it was turned on, so DMs sent while the daemon was
 * stopped count, and older ones don't. Its failures never stop the chat or the feed.
 */
export function sharedNotices(db: Db, client: Slack) {
  const cursors = new Map<string, string>();
  let baseline: number | undefined;
  return async () => {
    const since = db
      .select({ since: slackConfig.noticesSince })
      .from(slackConfig)
      .where(eq(slackConfig.id, 1))
      .get()?.since;
    if (since === null || since === undefined) return;
    // Turned off and on again: read from the new time.
    if (since !== baseline) cursors.clear();
    baseline = since;
    const owner = await client.owner();
    const bot = owner && (await client.bot());
    if (!owner || !bot) return;
    const ims: (typeof Ims.Type)["channels"][number][] = [];
    for (let cursor = ""; ;) {
      const body = await client.read("bot", "conversations.list", {
        types: "im",
        limit: "200",
        ...(cursor && { cursor }),
      });
      if (!body) return;
      const page = Schema.decodeUnknownSync(Ims)(body);
      ims.push(...page.channels);
      cursor = page.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    for (const im of ims) {
      const user = im.user;
      if (!user || user === owner || user === bot || user === "USLACKBOT") continue;
      const told = db
        .select({ id: slackNotices.id })
        .from(slackNotices)
        .where(
          and(
            eq(slackNotices.bot, bot),
            eq(slackNotices.channel, im.id),
            eq(slackNotices.user, user),
          ),
        )
        .get();
      if (told) continue;
      const oldest = cursors.get(im.id) ?? (since / 1000).toFixed(6);
      const messages = await history(client, im.id, { oldest });
      if (!messages) return;
      const asked = messages.find(
        (message) => message.user === user && !message.subtype && !message.bot_id,
      );
      if (
        asked &&
        !(await notice(db, client, { channel: im.id, user }, onlyOwner("open-dot", owner)))
      )
        return;
      const newest = messages.reduce(
        (latest, message) => (after(message.ts, latest) ? message.ts : latest),
        oldest,
      );
      cursors.set(im.id, newest);
    }
  };
}

/** What someone other than the owner is told, once per conversation. */
export const onlyOwner = (who: string, owner: string) => `${who} only answers <@${owner}>.`;

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
