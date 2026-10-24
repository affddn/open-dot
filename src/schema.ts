import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { Attachment } from "./opencode";
import type { Schedule } from "./schedule";

export const dots = sqliteTable("dots", {
  name: text().primaryKey(),
  directory: text().notNull(),
  sessionID: text("session_id").notNull(),
  // "creating" means the session ID is saved but OpenCode has not confirmed the session yet.
  sessionState: text("session_state", { enum: ["creating", "ready"] }).notNull(),
  // What the dot is for, as given at creation. Other dots see it. Older dots have none.
  purpose: text(),
  createdAt: integer("created_at").notNull(),
});

export type Dot = typeof dots.$inferSelect;

/**
 * Who last changed a note, responsibility or reminder: the dot, the owner in the notch, or the
 * daemon's schedule moving or sending a reminder.
 */
export const memoryActors = ["dot", "owner", "scheduler"] as const;

/**
 * Each note, responsibility and reminder carries a version for the owner's optimistic edits.
 * Only the owner's API and the daemon's schedule advance it themselves. A database trigger
 * (migration 0020) advances it, stamps the time and records the dot for any other update, so a
 * running plugin from before the migration still invalidates the owner's stale edits.
 * A null `updated_at` on a note or reminder means unchanged since `created_at`.
 */
const versioned = () => ({
  version: integer().notNull().default(1),
  updatedBy: text("updated_by", { enum: memoryActors }).notNull().default("dot"),
});

export const reminders = sqliteTable("reminders", {
  id: integer().primaryKey({ autoIncrement: true }),
  dot: text()
    .notNull()
    .references(() => dots.name),
  text: text().notNull(),
  dueAt: integer("due_at").notNull(),
  // A repeating reminder stays scheduled and moves to its next occurrence each time it is sent.
  everyMinutes: integer("every_minutes"),
  state: text({ enum: ["scheduled", "sent"] }).notNull(),
  // The original Slack destination for the persisted reminder notice.
  route: text({ mode: "json" }).$type<Route>(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
  ...versioned(),
});

export type Reminder = typeof reminders.$inferSelect;

/**
 * Where the dot's answer to a message goes in Slack: a thread in the owner's DM with the shared
 * app, or a DM or channel thread of the dot's own app, with the identities it was read under.
 * Only the daemon sets one, from what Slack showed it; a model never chooses it.
 */
export type Route =
  | {
      readonly kind: "shared";
      readonly dot: string;
      readonly sessionID: string;
      readonly owner: string;
      readonly team: string;
      readonly bot: string;
      readonly dm: true;
      readonly channel: string;
      readonly thread: string;
    }
  | {
      readonly kind: "agent";
      readonly dot: string;
      readonly sessionID: string;
      readonly app: string;
      readonly team: string;
      readonly owner: string;
      readonly bot: string;
      readonly channel: string;
      readonly thread: string;
      // A DM with the app, as opposed to a channel the owner mentioned it in.
      readonly dm: boolean;
    };

/** Messages with the same key may share a turn. Unrouted messages share the empty key. */
export const routeKey = (route: Route | null | undefined) =>
  route
    ? JSON.stringify([
        route.kind,
        route.dot,
        route.sessionID,
        route.kind === "agent" ? route.app : null,
        route.team,
        route.owner,
        route.bot,
        route.channel,
        route.thread,
        route.dm,
      ])
    : "";

/**
 * The message the owner replied to, as the daemon read it when the reply was sent: from the dot's
 * own conversation in the notch, or a Slack thread's first message. Never taken from the request.
 */
export interface QuoteSnapshot {
  // The owner's own words, shown without the framing the dot gets.
  readonly prompt: string;
  readonly parent: {
    readonly source: "notch" | "slack";
    // The message ID in the dot's session, or the Slack thread's ts.
    readonly id: string;
    // The session it was read from, or the Slack conversation.
    readonly place: string;
    readonly author: "owner" | "dot" | "other";
    readonly text: string;
  };
}

export const quoteLimit = 240;

/** Every message the daemon sends to a session. The message ID is saved before any OpenCode call. */
export const outbox = sqliteTable("outbox", {
  id: integer().primaryKey({ autoIncrement: true }),
  sessionID: text("session_id").notNull(),
  messageID: text("message_id").notNull().unique(),
  text: text().notNull(),
  files: text({ mode: "json" }).$type<readonly Attachment[]>(),
  // "held": queued for a worker the owner stopped, so it's never sent on its own. It stays held until
  // OpenCode confirms it, sent only while a later pending dot_send its owner still allows waits.
  state: text({ enum: ["pending", "sent", "cancelled", "held"] }).notNull(),
  // The dot that wrote a dot_message or dot_send. Null for reminders and worker reports.
  fromDot: text("from_dot"),
  // Typed by the owner in the notch app, as opposed to a notice from open-dot.
  fromOwner: integer("from_owner", { mode: "boolean" }).notNull().default(false),
  // A reply to a feed item: the owner's prompt and the item as the daemon read it from its own DB.
  // `text` holds both, with the item framed as data.
  feed: text({ mode: "json" }).$type<FeedSnapshot>(),
  route: text({ mode: "json" }).$type<Route>(),
  quote: text({ mode: "json" }).$type<QuoteSnapshot>(),
  ownerText: text("owner_text"),
  // How OpenCode gets the message. The owner's notch messages start as "auto", and the daemon saves
  // "steer" (into a running turn) or "queue" with startedAt, before its first call. Null is "queue":
  // Slack, notices and other dots never steer.
  delivery: text({ enum: ["auto", "queue", "steer"] }),
  startedAt: integer("started_at"),
  turnEnd: text("turn_end"),
  createdAt: integer("created_at").notNull(),
  // The supervision binding a dot_send needs. The daemon checks that it still allows sending just
  // before admission, and "cancelled" a row whose binding ended first: it's never sent.
  supervision: integer(),
});

/**
 * A dot's binding to an OpenCode session its owner started. Only the owner makes one active, with
 * `open-dot watch` or in the notch; a dot can only ask ("requested") or let its own go. The daemon
 * reports each turn end, permission or question and long busy spell once, after activation.
 */
export const supervisions = sqliteTable(
  "supervisions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    dot: text()
      .notNull()
      .references(() => dots.name),
    sessionID: text("session_id").notNull(),
    // The session's directory, as OpenCode reported it when the binding was made or requested.
    directory: text().notNull(),
    // "send" also lets the dot queue or steer messages into the session.
    mode: text({ enum: ["watch", "send"] }).notNull(),
    state: text({ enum: ["requested", "active", "ended"] }).notNull(),
    // The owner declined or revoked it, the dot let it go, or OpenCode deleted the session.
    endReason: text("end_reason", { enum: ["declined", "revoked", "unwatched", "deleted"] }),
    busyMinutes: integer("busy_minutes").notNull(),
    createdAt: integer("created_at").notNull(),
    activatedAt: integer("activated_at"),
    endedAt: integer("ended_at"),
    // The creation time of the newest turn end reported, and the IDs of those reported at exactly
    // that time, so another turn end at the same time is still reported once. Activation sets the
    // time with no IDs, and then only later turn ends count: earlier history is never reported,
    // and turns that end while the daemon is down are.
    seenAt: integer("seen_at"),
    seenIDs: text("seen_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    // Every permission and question already reported, as "permission:<id>" or "question:<id>".
    // Kept after they're answered, so none is ever reported twice.
    waitingOn: text("waiting_on", { mode: "json" }).$type<string[]>().notNull().default([]),
    // When the daemon first saw the current busy spell, and whether it reported it.
    busySince: integer("busy_since"),
    busyReported: integer("busy_reported", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("supervisions_open")
      .on(table.dot, table.sessionID)
      .where(sql`${table.state} != 'ended'`),
  ],
);

export type Supervision = typeof supervisions.$inferSelect;

export interface FeedSnapshot {
  readonly prompt: string;
  readonly item: {
    readonly id: number;
    readonly source: "github" | "linear" | "slack";
    readonly sourceID: string;
    readonly reason: string;
    readonly title: string;
    readonly context: string;
    readonly url: string | null;
    readonly time: number;
  };
}

/** The classic Tapbacks, in the order of the notch's first row. Any single emoji is allowed. */
export const reactionEmojis = ["❤️", "👍", "👎", "😂", "‼️", "❓"] as const;

/**
 * Each actor's current reaction to a message in a dot's conversation: the owner's to the dot's
 * messages, and the dot's to the owner's. The emoji is one RGI emoji, checked before saving.
 * A removal keeps its row with no emoji, so the dot's memory can say it's gone. Nothing here is
 * ever sent to a session.
 */
export const reactions = sqliteTable(
  "reactions",
  {
    dot: text()
      .notNull()
      .references(() => dots.name),
    sessionID: text("session_id").notNull(),
    messageID: text("message_id").notNull(),
    actor: text({ enum: ["owner", "dot"] }).notNull(),
    emoji: text(),
    // A short excerpt of the message, read from the session's history when the reaction was set.
    excerpt: text().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.dot, table.sessionID, table.messageID, table.actor] })],
);

export type Reaction = typeof reactions.$inferSelect;

/**
 * The non-classic emoji the owner last chose in the notch, newest with the highest `seq`, for the
 * menu's second row. Only the owner's choices are kept, never a dot's, and a choice stays here
 * after its reaction is replaced or removed. Only the latest five are kept.
 */
export const recentReactions = sqliteTable("recent_reactions", {
  emoji: text().primaryKey(),
  // One more than the largest when chosen, so same-millisecond choices keep their order.
  seq: integer().notNull(),
});

/**
 * Messages the owner deleted from the notch chat, in the session they were seen in. Only the notch
 * hides them: OpenCode history, the dot's context, reactions and delivery are unchanged.
 */
export const hiddenMessages = sqliteTable(
  "hidden_messages",
  {
    dot: text()
      .notNull()
      .references(() => dots.name),
    sessionID: text("session_id").notNull(),
    messageID: text("message_id").notNull(),
    hiddenAt: integer("hidden_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.dot, table.sessionID, table.messageID] })],
);

export const notes = sqliteTable("notes", {
  id: integer().primaryKey({ autoIncrement: true }),
  dot: text()
    .notNull()
    .references(() => dots.name),
  text: text().notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
  ...versioned(),
  // The dot's bound session and the assistant message whose dot_note saved it, as the plugin
  // confirmed them through OpenCode's public session.context. Null means unknown: older notes,
  // the owner's, and any whose call couldn't be confirmed. Edits never change them.
  sourceSession: text("source_session"),
  sourceMessage: text("source_message"),
});

export type Note = typeof notes.$inferSelect;

export const responsibilityStatuses = ["active", "done", "dropped"] as const;

/** Ongoing goals a dot owns, with the next thing it plans to do about each. */
export const responsibilities = sqliteTable("responsibilities", {
  id: integer().primaryKey({ autoIncrement: true }),
  dot: text()
    .notNull()
    .references(() => dots.name),
  goal: text().notNull(),
  nextAction: text("next_action").notNull(),
  status: text({ enum: responsibilityStatuses }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  ...versioned(),
  // When the daemon wakes the dot about it. Null means no schedule.
  schedule: text({ mode: "json" }).$type<Schedule>(),
  // The next due time of an active scheduled responsibility, null while it's done or dropped or
  // until the daemon arms it. A trigger (migration 0021) clears it whenever any writer, including
  // a plugin from before the migration, sets the status to done or dropped.
  nextRunAt: integer("next_run_at"),
});

export type Responsibility = typeof responsibilities.$inferSelect;

/** A responsibility as it was when the daemon claimed one of its scheduled runs. */
export interface RunSnapshot {
  readonly goal: string;
  readonly nextAction: string;
  readonly schedule: Schedule;
  // The version the claim read; the claim itself advanced it by one.
  readonly version: number;
}

/**
 * Each scheduled run the daemon claimed, saved in the same transaction as the claim and its wake,
 * so there is never a wake without its run or a run without its wake. Feed trigger wakes aren't
 * runs, and nothing is ever made up from `next_run_at`. The rest is what the daemon last saw in
 * OpenCode's public history for the wake's message: "queued" in the session's inbox, "running" in
 * a turn with no idle yet, "ended" with the turn's outcome, or "missing", admitted yet in neither
 * the inbox nor the history, so its outcome stays unknown. Null means not observed yet.
 */
export const responsibilityRuns = sqliteTable(
  "responsibility_runs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    dot: text()
      .notNull()
      .references(() => dots.name),
    responsibility: integer()
      .notNull()
      .references(() => responsibilities.id),
    // The run's own due time, which a catch-up after downtime keeps.
    dueAt: integer("due_at").notNull(),
    // When the daemon claimed it and queued its wake.
    claimedAt: integer("claimed_at").notNull(),
    snapshot: text({ mode: "json" }).$type<RunSnapshot>().notNull(),
    // The dot's session the wake went to, and the wake's outbox message ID.
    sessionID: text("session_id").notNull(),
    messageID: text("message_id").notNull().unique(),
    turn: text({ enum: ["queued", "running", "ended", "missing"] }),
    // When the daemon first saw `turn` and `waiting` as they are now.
    observedAt: integer("observed_at"),
    // The session waited on a permission or question while the turn ran.
    waiting: integer({ mode: "boolean" }).notNull().default(false),
    outcome: text({ enum: ["succeeded", "failed", "interrupted"] }),
    error: text(),
    // The idle that ended the turn, and when.
    turnEnd: text("turn_end"),
    endedAt: integer("ended_at"),
    // Whether the turn held only this wake ("exclusive"), other input too ("shared"), or history
    // didn't say ("unknown"). Only an exclusive turn's reply is kept as the run's result.
    attribution: text({ enum: ["exclusive", "shared", "unknown"] }),
    resultID: text("result_id"),
    resultText: text("result_text"),
  },
  (table) => [index("responsibility_runs_page").on(table.dot, table.responsibility, table.id)],
);

export type ResponsibilityRun = typeof responsibilityRuns.$inferSelect;

/** Work a dot handed to a separate OpenCode session. */
export const workers = sqliteTable("workers", {
  id: integer().primaryKey({ autoIncrement: true }),
  dot: text()
    .notNull()
    .references(() => dots.name),
  task: text().notNull(),
  directory: text().notNull(),
  // A worker in a git repo gets its own worktree of `source` on `branch`, created before its session.
  source: text(),
  branch: text(),
  sessionID: text("session_id").notNull(),
  // "creating" means the session ID is saved but OpenCode has not confirmed the session yet.
  // "stopping" means the owner asked to stop it and its queued messages are held, but OpenCode
  // hasn't confirmed the interrupt. A stopped worker is "done" with the outcome "stopped".
  state: text({ enum: ["creating", "running", "stopping", "done"] }).notNull(),
  promptID: text("prompt_id"),
  route: text({ mode: "json" }).$type<Route>(),
  outcome: text(),
  // Written only by daemons before migration 0023, which track requests in `requests` instead:
  // JSON {current, seen} of "permission:<id>" and "question:<id>" keys, or the bare ID of the last
  // permission told. Its seen keys are never told again. Read it with `readWaiting`.
  waitingOn: text("waiting_on"),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
});

export type Worker = typeof workers.$inferSelect;

/**
 * A worker that a scheduled run's own turn delegated: the plugin saves one only when public
 * `session.context` shows the invoking assistant message's turn had exactly one input, the run's
 * wake. A worker from any other turn, a shared one or one an older plugin made has no row.
 */
export const runWorkers = sqliteTable("run_workers", {
  worker: integer()
    .primaryKey()
    .references(() => workers.id),
  run: integer()
    .notNull()
    .references(() => responsibilityRuns.id),
  // The assistant message whose dot_delegate made the worker.
  assistantMessage: text("assistant_message").notNull(),
});

/** What a worker's permission request or question showed when open-dot first read it. */
export type RequestDetail =
  | {
      readonly kind: "permission";
      readonly action: string;
      readonly resources: readonly string[];
      readonly message?: string;
    }
  | {
      readonly kind: "question";
      readonly title: string;
      readonly fields: readonly Record<string, unknown>[];
    };

/** What the dot chose. Saved before the daemon makes the one call that sends it. */
export type RequestAnswer =
  | { readonly decision: "once" | "reject" }
  | {
      readonly decision: "reply";
      readonly answer: Record<string, string | number | boolean | readonly string[]>;
    }
  | { readonly decision: "cancel" };

export const requestStates = [
  "open",
  "queued",
  "answering",
  "answered",
  "unknown",
  "stale",
  "escalated",
] as const;

/**
 * Each permission request or question a dot's own worker waited on, and the dot's answer: the
 * ledger that tells the dot once and the owner's audit. Rows are never deleted. "open": the dot
 * may answer. "queued": the dot answered and the daemon will check and send it. "answering": the
 * daemon saved the attempt just before its one call. "answered": OpenCode confirmed it. "unknown":
 * the call's outcome was lost, so it's never sent again. "stale": the request or worker was gone
 * before the call. "escalated": only the owner answers it now.
 */
export const requests = sqliteTable(
  "requests",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    dot: text()
      .notNull()
      .references(() => dots.name),
    // An open-dot worker, or a Threads worker whose coordinator is the dot's session.
    source: text({ enum: ["worker", "threads"] }).notNull(),
    worker: integer(),
    sessionID: text("session_id").notNull(),
    title: text().notNull(),
    directory: text().notNull(),
    kind: text({ enum: ["permission", "question"] }).notNull(),
    requestID: text("request_id").notNull(),
    detail: text({ mode: "json" }).$type<RequestDetail>().notNull(),
    // A question that may ask for a secret. Only the owner answers it.
    sensitive: integer({ mode: "boolean" }).notNull().default(false),
    state: text({ enum: requestStates }).notNull(),
    // Why it was escalated or went stale, in open-dot's or the dot's words.
    reason: text(),
    answer: text({ mode: "json" }).$type<RequestAnswer>(),
    // The dot session that chose the answer.
    actorSession: text("actor_session"),
    // When open-dot first saw it waiting, which starts the owner's grace period.
    createdAt: integer("created_at").notNull(),
    // Null while OpenCode last listed it as waiting.
    goneAt: integer("gone_at"),
    queuedAt: integer("queued_at"),
    attemptedAt: integer("attempted_at"),
    confirmedAt: integer("confirmed_at"),
    escalatedAt: integer("escalated_at"),
  },
  (table) => [unique().on(table.sessionID, table.kind, table.requestID)],
);

export type WorkerRequest = typeof requests.$inferSelect;

export interface WorkerWaiting {
  readonly current: readonly string[];
  readonly seen: readonly string[];
}

const keys = (list: unknown) =>
  Array.isArray(list) ? list.filter((key): key is string => typeof key === "string") : [];

/** Reads `workers.waiting_on`, including a legacy bare permission ID or key array. */
export const readWaiting = (value: string | null): WorkerWaiting => {
  if (value === null) return { current: [], seen: [] };
  if (!value.startsWith("[") && !value.startsWith("{")) {
    const key = `permission:${value}`;
    return { current: [key], seen: [key] };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return { current: keys(parsed), seen: keys(parsed) };
    if (typeof parsed === "object" && parsed !== null && "seen" in parsed)
      return { current: "current" in parsed ? keys(parsed.current) : [], seen: keys(parsed.seen) };
  } catch {}
  return { current: [], seen: [] };
};

/** Recent GitHub, Linear and Slack notifications that need the owner's attention. */
export const feed = sqliteTable(
  "feed",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    source: text({ enum: ["github", "linear", "slack"] }).notNull(),
    // The notification's ID at its source, used to mark it read there.
    sourceID: text("source_id").notNull(),
    reason: text().notNull(),
    title: text().notNull(),
    // Where it happened, such as a repository or a Linear issue's identifier.
    context: text().notNull(),
    url: text(),
    updatedAt: integer("updated_at").notNull(),
    // "dismissed" waits to be marked read at the source, then becomes "cleared".
    // "read" means the source stopped listing it. "handed-off" means the owner sent it to dots,
    // which leaves it unread at its source.
    state: text({ enum: ["unread", "dismissed", "cleared", "read", "handed-off"] }).notNull(),
    // Every dot the owner has sent it to, each once. Kept when new activity makes it unread again.
    handedTo: text("handed_to", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [unique().on(table.source, table.sourceID)],
);

export type FeedItem = typeof feed.$inferSelect;

/** A GitHub feed event a trigger matched, as the daemon read it from its own feed table. */
export interface TriggerEvent {
  readonly feedID: number;
  readonly sourceID: string;
  readonly reason: string;
  readonly repository: string;
  readonly title: string;
  readonly url: string | null;
  readonly updatedAt: number;
}

/**
 * The owner's rule that wakes one dot about one active responsibility when its GitHub feed shows
 * new activity in one repository for one of the chosen reasons. Only the owner's API makes one,
 * as a "draft", and only the owner's confirmation of its exact `revision` makes it "active". Its
 * filter, task, dot, responsibility and session never change: to change one, revoke it and make
 * another. `epoch` counts enables; each enable or resume baselines existing activity and sets
 * `baseline_at`, and only later activity wakes the dot.
 */
export const feedTriggers = sqliteTable("feed_triggers", {
  id: integer().primaryKey({ autoIncrement: true }),
  dot: text()
    .notNull()
    .references(() => dots.name),
  responsibility: integer()
    .notNull()
    .references(() => responsibilities.id),
  // The dot's ready session when the owner made it. A wake goes only there.
  sessionID: text("session_id").notNull(),
  source: text({ enum: ["github"] }).notNull(),
  // owner/name, lowercased; matched exactly against the feed item's lowercased repository.
  repository: text().notNull(),
  // Feed reason labels, such as "Review requested", each once.
  reasons: text({ mode: "json" }).$type<string[]>().notNull(),
  // The owner's own instruction, sent unchanged with every wake.
  task: text().notNull(),
  // SHA-256 of the fixed configuration, which the owner's confirmation must name.
  revision: text().notNull(),
  state: text({ enum: ["draft", "active", "paused", "revoked"] }).notNull(),
  epoch: integer().notNull().default(0),
  baselineAt: integer("baseline_at"),
  createdAt: integer("created_at").notNull(),
  confirmedAt: integer("confirmed_at"),
  updatedAt: integer("updated_at").notNull(),
});

export type FeedTrigger = typeof feedTriggers.$inferSelect;

/**
 * Each distinct activity a trigger saw, keyed by the feed item's source ID and its activity time,
 * never by poll or title, so repeated polls and restarts add nothing. "baseline": it existed when
 * the trigger was enabled or resumed, and never wakes. "queued": a wake with `message_id` was put
 * in the outbox in the same transaction. "skipped": it never runs, for `reason`.
 */
export const triggerOccurrences = sqliteTable(
  "trigger_occurrences",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    triggerID: integer("trigger_id")
      .notNull()
      .references(() => feedTriggers.id),
    source: text({ enum: ["github"] }).notNull(),
    sourceID: text("source_id").notNull(),
    activityAt: integer("activity_at").notNull(),
    // The trigger's epoch when this was seen. A wake from an earlier epoch is never sent.
    epoch: integer().notNull(),
    state: text({ enum: ["baseline", "queued", "skipped"] }).notNull(),
    reason: text(),
    messageID: text("message_id"),
    event: text({ mode: "json" }).$type<TriggerEvent>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique().on(table.triggerID, table.source, table.sourceID, table.activityAt),
    index("trigger_occurrences_message").on(table.messageID),
  ],
);

/** Each message the owner sent a dot from Slack, and the dot's reply on its way back there. */
export const slack = sqliteTable("slack", {
  // The owner's Slack message, which also dedups polls.
  ts: text().primaryKey(),
  dot: text()
    .notNull()
    .references(() => dots.name),
  // The DM it was read from, where the reply goes even if the tokens change.
  channel: text().notNull(),
  route: text({ mode: "json" }).$type<Route>(),
  // The outbox message that carried it to the dot.
  messageID: text("message_id").notNull(),
  // Saved before the reply is posted, and tagged on the post so a lost outcome can be found.
  replyID: text("reply_id"),
  replyText: text("reply_text"),
  replyTS: text("reply_ts"),
  // "posting" means the reply is surely not posted yet. A row turns "unknown" just before the post,
  // and stays so if its outcome is lost; it's looked up by reply ID before any new post.
  // "answered" means OpenCode answered it in the same turn as a later message, which gets the reply.
  state: text({
    enum: ["waiting", "posting", "unknown", "posted", "failed", "answered"],
  }).notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * A dot's own Slack app, created from a manifest with the owner's configuration token, and the
 * identity its tokens must show before the daemon uses them. No secret is kept here.
 */
export const slackApps = sqliteTable("slack_apps", {
  dot: text()
    .primaryKey()
    .references(() => dots.name),
  // "requested": the owner asked for an app. "creating": an attempt is saved just before the
  // create call. "unknown": that call's outcome was lost, so nothing is created again until the
  // owner attaches the app or says there is none. "attaching": the owner named an app to check.
  // "failed": Slack refused. "created": waiting for the owner to install it and save its tokens.
  // "active": its tokens showed this app, workspace and bot.
  state: text({
    enum: ["requested", "creating", "unknown", "attaching", "failed", "created", "active"],
  }).notNull(),
  // The create or attach in progress, so a late answer about an earlier one changes nothing.
  attemptID: text("attempt_id"),
  appID: text("app_id"),
  teamID: text("team_id"),
  // The only Slack user who can instruct the dot through this app.
  ownerID: text("owner_id"),
  botID: text("bot_id"),
  botUser: text("bot_user"),
  // What the owner should know or do, as the daemon last saw it.
  problem: text(),
  // The owner's suggested prompts for the agent view. Null uses ones made from the dot's purpose.
  prompts: text({ mode: "json" }).$type<readonly SuggestedPrompt[]>(),
  // The manifest version open-dot knows the app has. Null is the first, from before version 2.
  manifestVersion: integer("manifest_version"),
  // The owner's last `open-dot slack update`. "updating" is saved just before apps.manifest.update,
  // and "unknown" means its answer was lost, so the next update checks the export, never resends.
  updateState: text("update_state", { enum: ["updating", "unknown", "failed"] }),
  updateAt: integer("update_at"),
  // What the owner should do after it, such as reinstalling to approve new events.
  updateNote: text("update_note"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** One suggested prompt in a dot's agent view. */
export interface SuggestedPrompt {
  readonly title: string;
  readonly message: string;
}

export type SlackApp = typeof slackApps.$inferSelect;

/**
 * Slack settings in one row: the configuration token's rotation, so a lost outcome is never
 * retried, and whether the shared app sends notes to others.
 */
export const slackConfig = sqliteTable("slack_config", {
  id: integer().primaryKey(),
  // "rotating": a rotation may be in flight. "blocked": its outcome or its save was lost, and the
  // owner saves a new token pair with `open-dot slack config`.
  state: text({ enum: ["idle", "rotating", "blocked"] }).notNull(),
  // When the saved pair was issued, so a recovered rotation can tell whether its pair was saved.
  fromIat: integer("from_iat"),
  problem: text(),
  // When the owner turned on notes to others who DM the shared app, which then reads DMs from
  // this time on, across restarts. Null means off: the shared app's DMs aren't read for notes.
  noticesSince: integer("notices_since"),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * What a dot's own app received, and each reply on its way back. An event is saved before Slack
 * gets its acknowledgement, with only the fields open-dot needs. A worker's report to the owner's
 * DM is a row too, with no event.
 */
export const slackEvents = sqliteTable(
  "slack_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    app: text().notNull(),
    route: text({ mode: "json" }).$type<Route>(),
    dot: text()
      .notNull()
      .references(() => dots.name),
    // "mention": the owner mentioned the dot in a channel. "dm": the owner wrote in its DM.
    // "outsider": someone else did either. "report": a worker's report for the owner's DM.
    // "prompts": the owner opened the agent view, so it gets the dot's suggested prompts.
    kind: text({ enum: ["mention", "dm", "outsider", "report", "prompts"] }).notNull(),
    eventID: text("event_id"),
    channel: text(),
    ts: text(),
    // The thread a reply goes in: a mention's thread, or a DM thread. Null for a top-level DM.
    thread: text(),
    user: text(),
    // The owner's words. Never saved for someone else's message.
    text: text(),
    // The newest thread message the dot was given, so the next mention starts after it.
    contextTS: text("context_ts"),
    messageID: text("message_id"),
    replyID: text("reply_id"),
    replyText: text("reply_text"),
    replyTS: text("reply_ts"),
    // When the "is thinking…" status was last set on the DM thread. Null once it's cleared.
    statusAt: integer("status_at"),
    // The reply streamed while the turn runs. "starting": the stream's marker ID is saved just
    // before chat.startStream, so a lost answer is only looked up by that marker. "open": Slack
    // confirmed it, and stream_text holds what it shows. "appending": an append may be in flight.
    // "broken": an append's outcome was lost, so nothing more is appended. "stopping" and "stopped":
    // the stream is being or was stopped, before the final text replaces it with chat.update.
    // "denied": Slack refused to start it, so the reply is posted the usual way.
    stream: text({
      enum: ["starting", "open", "appending", "broken", "stopping", "stopped", "denied"],
    }),
    streamID: text("stream_id"),
    streamTS: text("stream_ts"),
    streamText: text("stream_text"),
    // The agent view thread's title, saved before the one call that sets it. Empty for a thread
    // that never gets one, such as one from before titles.
    title: text(),
    // "new" waits to be queued to the dot. "waiting" waits for its turn to end. "posting" means
    // the reply is surely not posted yet, and "unknown" that a post may have happened, so it's only
    // looked up. "answered" shares a later DM's reply. "done" is an outsider's handled message.
    state: text({
      enum: ["new", "waiting", "posting", "unknown", "posted", "failed", "answered", "done"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique().on(table.app, table.eventID),
    // Slack can deliver a message again under a new event ID.
    unique().on(table.app, table.channel, table.ts),
  ],
);

export type SlackEvent = typeof slackEvents.$inferSelect;

export const slackThreads = sqliteTable("slack_threads", {
  key: text().primaryKey(),
  route: text({ mode: "json" }).$type<Route>().notNull(),
  parent: text({ mode: "json" }).$type<QuoteSnapshot["parent"]>(),
  oldest: text().notNull(),
  newest: text().notNull(),
  cursor: text().notNull().default(""),
  rescan: integer({ mode: "boolean" }).notNull().default(false),
  activeAt: integer("active_at").notNull(),
  polledAt: integer("polled_at").notNull().default(0),
});

export const slackPolls = sqliteTable("slack_polls", {
  key: text().primaryKey(),
  oldest: text().notNull(),
  newest: text().notNull(),
  // JSON continuation: Slack cursor and owner messages waiting for oldest-first routing.
  cursor: text().notNull().default(""),
});

/** The one note telling someone in a conversation that a bot only answers its owner. */
export const slackNotices = sqliteTable(
  "slack_notices",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    // The bot user that sent it, so each app tells each person once per conversation.
    bot: text().notNull(),
    channel: text().notNull(),
    user: text().notNull(),
    // Saved as "sending" before the call. Any other outcome is final: it's never sent again.
    state: text({ enum: ["sending", "sent", "refused", "unknown"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [unique().on(table.bot, table.channel, table.user)],
);
