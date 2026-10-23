import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import type { Attachment } from "./opencode";

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
  state: text({ enum: ["pending", "sent"] }).notNull(),
  // The dot that wrote a dot_message. Null for reminders and worker reports.
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
});

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
});

export type Responsibility = typeof responsibilities.$inferSelect;

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
  state: text({ enum: ["creating", "running", "done"] }).notNull(),
  promptID: text("prompt_id"),
  route: text({ mode: "json" }).$type<Route>(),
  outcome: text(),
  // The permission request the dot was last told about, so it is told only once.
  waitingOn: text("waiting_on"),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
});

export type Worker = typeof workers.$inferSelect;

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
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

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
    kind: text({ enum: ["mention", "dm", "outsider", "report"] }).notNull(),
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
