import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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
  createdAt: integer("created_at").notNull(),
});

/** Every message the daemon sends to a session. The message ID is saved before any OpenCode call. */
export const outbox = sqliteTable("outbox", {
  id: integer().primaryKey({ autoIncrement: true }),
  sessionID: text("session_id").notNull(),
  messageID: text("message_id").notNull().unique(),
  text: text().notNull(),
  state: text({ enum: ["pending", "sent"] }).notNull(),
  // The dot that wrote a dot_message. Null for reminders and worker reports.
  fromDot: text("from_dot"),
  // Typed by the owner in the notch app, as opposed to a notice from open-dot.
  fromOwner: integer("from_owner", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
});

export const notes = sqliteTable("notes", {
  id: integer().primaryKey({ autoIncrement: true }),
  dot: text()
    .notNull()
    .references(() => dots.name),
  text: text().notNull(),
  createdAt: integer("created_at").notNull(),
});

/** Ongoing goals a dot owns, with the next thing it plans to do about each. */
export const responsibilities = sqliteTable("responsibilities", {
  id: integer().primaryKey({ autoIncrement: true }),
  dot: text()
    .notNull()
    .references(() => dots.name),
  goal: text().notNull(),
  nextAction: text("next_action").notNull(),
  status: text({ enum: ["active", "done", "dropped"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

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
    // "read" means the source stopped listing it.
    state: text({ enum: ["unread", "dismissed", "cleared", "read"] }).notNull(),
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
  // The outbox message that carried it to the dot.
  messageID: text("message_id").notNull(),
  // Saved before the reply is posted, and tagged on the post so a lost outcome can be found.
  replyID: text("reply_id"),
  replyText: text("reply_text"),
  replyTS: text("reply_ts"),
  // "unknown" means the post's outcome was lost; it's looked up by reply ID before any new post.
  state: text({ enum: ["waiting", "posting", "unknown", "posted", "failed"] }).notNull(),
  createdAt: integer("created_at").notNull(),
});
