import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDatabase } from "../src/db";
import { readMemory } from "../src/memory";
import {
  feed,
  hiddenMessages,
  notes,
  outbox,
  reactions,
  recentReactions,
  slack,
  slackApps,
  slackEvents,
  slackThreads,
  slackPolls,
  reminders,
  responsibilities,
  requests,
  supervisions,
  workers,
  routeKey,
  type Route,
  type QuoteSnapshot,
} from "../src/schema";

const repoMigrations = join(import.meta.dir, "..", "drizzle");

// 0024 and 0025 append columns to these, so earlier migrations' tests compare only their first columns.
const polished = ["slack_apps", "slack_events", "notes"];
// 0026 adds these tables, so earlier migrations' tests leave them out.
const later = ["feed_triggers", "trigger_occurrences"];

type LedgerRow = { seq: number; id: unknown; hash: string; created_at: number };

function ledgerOf(sqlite: Database) {
  return sqlite
    .query<LedgerRow, []>("select rowid as seq, * from __drizzle_migrations order by rowid")
    .all();
}

// Every repository migration from `tag` on, as drizzle's migrator records it in the ledger.
function ledgerFrom(tag: string) {
  const { entries } = JSON.parse(
    readFileSync(join(repoMigrations, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string; when: number }[] };
  const pending = entries.filter((entry) => entry.tag >= tag);
  assert(pending[0]?.tag.startsWith(tag), `Missing migration ${tag}`);
  return pending.map((entry) => ({
    hash: createHash("sha256")
      .update(readFileSync(join(repoMigrations, `${entry.tag}.sql`), "utf8"))
      .digest("hex"),
    created_at: entry.when,
  }));
}

// The old ledger stays byte-for-byte, followed by exactly the migrations from `tag` onward.
function expectLedger(sqlite: Database, old: LedgerRow[], tag: string) {
  const ledger = ledgerOf(sqlite);
  expect(ledger.slice(0, old.length)).toEqual(old);
  expect(ledger.slice(old.length).map(({ hash, created_at }) => ({ hash, created_at }))).toEqual(
    ledgerFrom(tag),
  );
}

function tableNames(sqlite: Database) {
  return sqlite
    .query<{ name: string }, []>(
      "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name != '__drizzle_migrations' order by name",
    )
    .all()
    .map((table) => table.name);
}

test("a database from before feed replies keeps its rows, and replies survive a restart", () => {
  // Build the database as the release before feed replies left it: every migration before 0012.
  const dir = mkdtempSync(join(tmpdir(), "open-dot-db-"));
  const migrations = join(dir, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  // Later migrations go too, since drizzle skips any migration older than the newest applied.
  journal.entries = journal.entries.filter((entry) => entry.tag < "0012");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(dir, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into feed (source, source_id, reason, title, context, updated_at, state, created_at) values ('github', 'PR_1', 'Mentioned', 'Old', 'acme/app', 10, 'unread', 0)",
  );
  old.run(
    "insert into outbox (session_id, message_id, text, state, created_at) values ('ses_jojo', 'msg_old', 'Hi', 'sent', 0)",
  );
  old.close();

  const db = openDatabase(path);
  expect(db.select().from(feed).all()).toMatchObject([
    { title: "Old", handedTo: [], state: "unread" },
  ]);
  expect(db.select().from(outbox).all()).toMatchObject([{ messageID: "msg_old", feed: null }]);

  const item = { id: 1, source: "github", sourceID: "PR_1", reason: "Mentioned", title: "Old" };
  const snapshot = {
    prompt: "Look.",
    item: { ...item, source: "github" as const, context: "acme/app", url: null, time: 10 },
  };
  db.update(feed)
    .set({ state: "handed-off", handedTo: ["jojo"] })
    .run();
  db.insert(outbox)
    .values({
      sessionID: "ses_jojo",
      messageID: "msg_new",
      text: "Look.",
      state: "pending",
      feed: snapshot,
      createdAt: 1,
    })
    .run();
  db.$client.close();

  const reopened = openDatabase(path);
  expect(reopened.select().from(feed).get()).toMatchObject({
    state: "handed-off",
    handedTo: ["jojo"],
  });
  expect(reopened.select().from(outbox).all().at(-1)?.feed).toEqual(snapshot);
  reopened.$client.close();
});

test("a database from before per-dot Slack apps keeps its Slack rows, and an app's state survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-dot-db-"));
  const migrations = join(dir, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0013");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(dir, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name, directory, session_id, session_state, created_at) values ('jojo', '/dots/jojo', 'ses_jojo', 'ready', 0)",
  );
  old.run(
    "insert into slack (ts, dot, channel, message_id, reply_id, state, created_at) values ('1.000001', 'jojo', 'D1', 'msg_1', 'r1', 'unknown', 0)",
  );
  old.close();

  const db = openDatabase(path);
  expect(db.select().from(slack).all()).toMatchObject([{ ts: "1.000001", state: "unknown" }]);
  db.insert(slackApps)
    .values({ dot: "jojo", state: "unknown", attemptID: "attempt-1", createdAt: 1, updatedAt: 1 })
    .run();
  const event = {
    app: "A1",
    dot: "jojo",
    kind: "dm" as const,
    eventID: "Ev1",
    channel: "D2",
    ts: "2.000001",
    state: "new" as const,
    createdAt: 1,
  };
  db.insert(slackEvents).values(event).run();
  // The same message under a new event ID is the same row.
  db.insert(slackEvents)
    .values({ ...event, eventID: "Ev2" })
    .onConflictDoNothing()
    .run();
  db.$client.close();

  const reopened = openDatabase(path);
  expect(reopened.select().from(slackApps).all()).toMatchObject([
    { dot: "jojo", state: "unknown", attemptID: "attempt-1" },
  ]);
  expect(reopened.select().from(slackEvents).all()).toMatchObject([{ eventID: "Ev1" }]);
  expect(reopened.select().from(slack).all()).toHaveLength(1);
  reopened.$client.close();
});

test("0015 preserves pre-thread rows and null origins, then persists quotes and unfinished scans across reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-dot-threads-"));
  const migrations = join(dir, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0015");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(dir, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',0)",
  );
  old.run(
    "insert into outbox (session_id,message_id,text,state,from_owner,created_at) values ('ses_jojo','old','Keep','sent',1,7)",
  );
  old.run(
    "insert into reminders (dot,text,due_at,state,created_at) values ('jojo','Keep',100,'scheduled',0)",
  );
  old.run(
    "insert into workers (dot,task,directory,session_id,state,created_at) values ('jojo','Keep','/work','ses_worker','creating',0)",
  );
  old.run(
    "insert into slack (ts,dot,channel,message_id,state,created_at) values ('1.1','jojo','D1','old','unknown',0)",
  );
  old.run(
    "insert into slack_events (app,dot,kind,event_id,channel,ts,message_id,state,created_at) values ('A1','jojo','dm','E1','D2','2.1','old','unknown',0)",
  );
  old.run(
    "insert into reactions (dot,session_id,message_id,actor,emoji,excerpt,updated_at) values ('jojo','ses_jojo','old','dot',null,'Keep',1)",
  );
  old.run("insert into notes (dot,text,created_at) values ('jojo','Keep',0)");
  const tables = old
    .query<{ name: string }, []>(
      "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name != '__drizzle_migrations'",
    )
    .all();
  const columns = new Map(
    tables.map(({ name }) => [
      name,
      old
        .query<{ name: string }, []>(`pragma table_info("${name}")`)
        .all()
        .map((column) => `"${column.name}"`)
        .join(","),
    ]),
  );
  const rows = (sqlite: Database) =>
    tables.map(({ name }) => [
      name,
      sqlite.query(`select ${columns.get(name)} from "${name}"`).all(),
    ]);
  const before = rows(old);
  old.close();
  const db = openDatabase(path);
  expect(rows(db.$client)).toEqual(before);
  expect(db.select().from(outbox).get()).toMatchObject({
    route: null,
    quote: null,
    startedAt: 7,
    turnEnd: null,
  });
  expect(db.select().from(reminders).get()?.route).toBeNull();
  expect(db.select().from(workers).get()?.route).toBeNull();
  expect(db.select().from(slack).get()?.route).toBeNull();
  expect(db.select().from(slackEvents).get()).toMatchObject({ route: null, thread: null });
  const route: Route = {
    kind: "shared",
    dot: "jojo",
    sessionID: "ses_jojo",
    owner: "U1",
    team: "T1",
    bot: "B1",
    dm: true,
    channel: "D1",
    thread: "1.1",
  };
  const quote: QuoteSnapshot = {
    prompt: "Reply",
    parent: { source: "slack", id: "1.1", place: "D1", author: "owner", text: "Original" },
  };
  db.insert(outbox)
    .values({
      sessionID: "ses_jojo",
      messageID: "new",
      text: "framed",
      ownerText: "Reply",
      route,
      quote,
      state: "pending",
      fromOwner: true,
      createdAt: 10,
    })
    .run();
  db.insert(slackThreads)
    .values({
      key: routeKey(route),
      route,
      parent: quote.parent,
      oldest: "1.1",
      newest: "1.9",
      cursor: "next",
      activeAt: 10,
      polledAt: 11,
    })
    .run();
  db.insert(slackPolls)
    .values({ key: "identity", oldest: "1.0", newest: "1.9", cursor: "top-next" })
    .run();
  db.$client.close();
  const reopened = openDatabase(path);
  expect(
    reopened
      .select()
      .from(outbox)
      .all()
      .find((row) => row.messageID === "new"),
  ).toMatchObject({ route, quote, ownerText: "Reply" });
  expect(reopened.select().from(slackThreads).get()).toMatchObject({
    route,
    parent: quote.parent,
    oldest: "1.1",
    newest: "1.9",
    cursor: "next",
  });
  expect(reopened.select().from(slackPolls).get()?.cursor).toBe("top-next");
  expect(reopened.select().from(slack).get()?.route).toBeNull();
  reopened.$client.close();
});

test("reactions migrate additively and both actors and removal tombstones survive reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-dot-reactions-"));
  const migrations = join(dir, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0014");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(dir, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name, directory, session_id, session_state, created_at) values ('jojo', '/dots/jojo', 'ses_jojo', 'ready', 0)",
  );
  old.run("insert into notes (dot, text, created_at) values ('jojo', 'Keep this note', 1)");
  old.run(
    "insert into outbox (session_id, message_id, text, state, from_owner, created_at) values ('ses_jojo', 'msg_owner', 'Keep this prompt', 'sent', 1, 1)",
  );
  old.run(
    "insert into slack_apps (dot, state, attempt_id, created_at, updated_at) values ('jojo', 'unknown', 'keep-attempt', 1, 1)",
  );
  const tables = old
    .query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != '__drizzle_migrations'",
    )
    .all();
  const columns = new Map(
    tables.map(({ name }) => [
      name,
      old
        .query<{ name: string }, []>(`pragma table_info("${name}")`)
        .all()
        .map((column) => `"${column.name}"`)
        .join(","),
    ]),
  );
  const rows = (sqlite: Database) =>
    tables.map(({ name }) => [
      name,
      sqlite.query(`select ${columns.get(name)} from "${name}"`).all(),
    ]);
  const before = rows(old);
  old.close();

  const db = openDatabase(path);
  expect(rows(db.$client)).toEqual(before);
  db.insert(reactions)
    .values([
      {
        dot: "jojo",
        sessionID: "ses_jojo",
        messageID: "msg_answer",
        actor: "owner",
        emoji: null,
        excerpt: "Answer",
        updatedAt: 2,
      },
      {
        dot: "jojo",
        sessionID: "ses_jojo",
        messageID: "msg_owner",
        actor: "dot",
        emoji: "❤️",
        excerpt: "Keep this prompt",
        updatedAt: 3,
      },
    ])
    .run();
  const saved = db.select().from(reactions).all();
  db.$client.close();
  const reopened = openDatabase(path);
  expect(reopened.select().from(reactions).all()).toEqual(saved);
  expect(rows(reopened.$client)).toEqual(before);
  reopened.$client.close();
});

test("0016 adds only nullable outbox files and preserves every 0015 column, row and migration ledger entry", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-image-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0016");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  old.run(
    "insert into outbox (session_id,message_id,text,state,from_owner,started_at,turn_end,owner_text,quote,created_at) values ('ses_jojo','old','Keep','sent',1,7,'idle_old','Keep','{}',1)",
  );
  old.run(
    "insert into feed (source,source_id,reason,title,context,updated_at,state,handed_to,created_at) values ('github','PR_1','Mentioned','Keep','repo',1,'handed-off','[\"jojo\"]',1)",
  );
  old.run("insert into notes (dot,text,created_at) values ('jojo','Keep',1)");
  old.run(
    "insert into reactions (dot,session_id,message_id,actor,emoji,excerpt,updated_at) values ('jojo','ses_jojo','old','dot',null,'Keep',1)",
  );
  old.run(
    "insert into slack_threads (key,route,oldest,newest,cursor,rescan,active_at,polled_at) values ('thread','{}','1','2','',1,1,4)",
  );
  old.run("insert into slack_polls (key,oldest,newest,cursor) values ('poll','1','2','saved')");
  const tables = old
    .query<{ name: string }, []>(
      "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name != '__drizzle_migrations' order by name",
    )
    .all();
  type Column = {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  };
  const columns = new Map(
    tables.map(({ name }) => [name, old.query<Column, []>(`pragma table_info("${name}")`).all()]),
  );
  const rows = (sqlite: Database) =>
    tables.map(({ name }) => [
      name,
      sqlite
        .query(
          `select ${columns
            .get(name)
            ?.map((column) => `"${column.name}"`)
            .join(",")} from "${name}"`,
        )
        .all(),
    ]);
  const before = rows(old);
  const ledger = ledgerOf(old);
  old.close();
  let db = openDatabase(path);
  try {
    expect(rows(db.$client)).toEqual(before);
    expectLedger(db.$client, ledger, "0016");
    for (const { name } of tables) {
      const after = db.$client.query<Column, []>(`pragma table_info("${name}")`).all();
      const stored = columns.get(name);
      assert(stored, `Missing stored columns for ${name}`);
      // Later migrations may add outbox columns after files.
      if (name === "outbox") {
        expect(after.slice(0, stored.length)).toEqual(stored);
        expect(after[stored.length]).toMatchObject({
          name: "files",
          type: "TEXT",
          notnull: 0,
          dflt_value: null,
          pk: 0,
        });
      } else expect(after.slice(0, stored.length)).toEqual(stored);
      // Only 0020 adds columns elsewhere.
      if (!["outbox", "notes", "reminders", "responsibilities", ...polished].includes(name))
        expect(after).toHaveLength(stored.length);
    }
    expect(db.select().from(outbox).get()?.files).toBeNull();
    const files = [{ mime: "image/png", name: "kept.png", data: "iVBORw0KGgo=" }];
    db.insert(outbox)
      .values({
        sessionID: "ses_jojo",
        messageID: "image",
        text: "",
        files,
        state: "pending",
        fromOwner: true,
        createdAt: 2,
      })
      .run();
    db.$client.close();
    db = openDatabase(path);
    expect(db.select().from(outbox).all().at(-1)?.files).toEqual(files);
    expect(db.select().from(slackThreads).get()?.rescan).toBe(true);
    expectLedger(db.$client, ledger, "0016");
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0017 adds only hidden_messages and preserves every 0016 table, column, row and ledger entry", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-hidden-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0017");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  old.run(
    "insert into outbox (session_id,message_id,text,files,state,from_owner,quote,created_at) values ('ses_jojo','old','Keep','[]','sent',1,'{}',1)",
  );
  old.run(
    "insert into reactions (dot,session_id,message_id,actor,emoji,excerpt,updated_at) values ('jojo','ses_jojo','old','dot',null,'Keep',1)",
  );
  old.run("insert into notes (dot,text,created_at) values ('jojo','Keep',1)");
  old.run(
    "insert into slack_threads (key,route,oldest,newest,cursor,rescan,active_at,polled_at) values ('thread','{}','1','2','',1,1,4)",
  );
  const tables = tableNames(old);
  const columns = new Map(
    tables.map((name) => [
      name,
      old.query<{ name: string }, []>(`pragma table_info("${name}")`).all(),
    ]),
  );
  // Only the columns 0016 had: later migrations may add more.
  const rows = (sqlite: Database) =>
    tables.map((name) => [
      name,
      sqlite
        .query(
          `select ${columns
            .get(name)
            ?.map((column) => `"${column.name}"`)
            .join(",")} from "${name}"`,
        )
        .all(),
    ]);
  const before = rows(old);
  const ledger = ledgerOf(old);
  old.close();
  let db = openDatabase(path);
  try {
    expect(rows(db.$client)).toEqual(before);
    for (const name of tables) {
      const stored = columns.get(name);
      assert(stored, `Missing stored columns for ${name}`);
      expect(
        db.$client.query(`pragma table_info("${name}")`).all().slice(0, stored.length),
      ).toEqual(stored);
    }
    const added = tableNames(db.$client).filter((name) => !tables.includes(name));
    // Later migrations may add tables; 0017 itself is one CREATE TABLE.
    expect(added).toContain("hidden_messages");
    const statements = readFileSync(join(repoMigrations, "0017_hidden_messages.sql"), "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toStartWith("CREATE TABLE `hidden_messages` (");
    expect(db.$client.query('pragma table_info("hidden_messages")').all()).toMatchObject([
      { name: "dot", type: expect.stringMatching(/^text$/i), notnull: 1, pk: 1 },
      { name: "session_id", type: expect.stringMatching(/^text$/i), notnull: 1, pk: 2 },
      { name: "message_id", type: expect.stringMatching(/^text$/i), notnull: 1, pk: 3 },
      { name: "hidden_at", type: expect.stringMatching(/^integer$/i), notnull: 1, pk: 0 },
    ]);
    expect(db.$client.query('pragma foreign_key_list("hidden_messages")').all()).toMatchObject([
      { table: "dots", from: "dot", to: "name" },
    ]);
    expectLedger(db.$client, ledger, "0017");
    const marker = { dot: "jojo", sessionID: "ses_jojo", messageID: "old", hiddenAt: 2 };
    db.insert(hiddenMessages).values(marker).run();
    db.$client.close();
    db = openDatabase(path);
    expect(db.select().from(hiddenMessages).all()).toEqual([marker]);
    expect(rows(db.$client)).toEqual(before);
    expectLedger(db.$client, ledger, "0017");
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0018 adds only nullable outbox delivery and preserves every 0017 table, column, row and ledger entry", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-delivery-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0018");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  // An owner's message saved but not yet admitted, and one whose outcome is unknown.
  old.run(
    "insert into outbox (session_id,message_id,text,files,state,from_owner,quote,created_at) values ('ses_jojo','waiting','Keep','[]','pending',1,'{}',1)",
  );
  old.run(
    "insert into outbox (session_id,message_id,text,state,from_owner,started_at,created_at) values ('ses_jojo','unknown','Keep','pending',1,7,1)",
  );
  old.run(
    "insert into hidden_messages (dot,session_id,message_id,hidden_at) values ('jojo','ses_jojo','old',1)",
  );
  old.run("insert into notes (dot,text,created_at) values ('jojo','Keep',1)");
  const tables = tableNames(old);
  const columns = new Map(
    tables.map((name) => [name, old.query(`pragma table_info("${name}")`).all()]),
  );
  // Only the columns 0017 had: 0020 adds memory columns.
  const rows = (sqlite: Database) =>
    tables.map((name) => [
      name,
      sqlite
        .query(
          `select ${(columns.get(name) as { name: string }[])
            .map((column) => `"${column.name}"`)
            .join(",")} from "${name}"`,
        )
        .all()
        .map((row) => {
          if (name !== "outbox" || typeof row !== "object" || row === null) return row;
          const { delivery, ...rest } = row as { delivery?: unknown };
          expect(delivery ?? null).toBeNull();
          return rest;
        }),
    ]);
  const before = rows(old);
  const ledger = ledgerOf(old);
  old.close();
  let db = openDatabase(path);
  try {
    expect(rows(db.$client)).toEqual(before);
    // Later migrations may add tables; 0018 itself adds none.
    expect(tableNames(db.$client).filter((name) => tables.includes(name))).toEqual(tables);
    for (const name of tables) {
      const stored = columns.get(name);
      assert(stored, `Missing stored columns for ${name}`);
      const after = db.$client.query(`pragma table_info("${name}")`).all();
      if (["notes", "reminders", "responsibilities", ...polished].includes(name))
        expect(after.slice(0, stored.length)).toEqual(stored);
      else if (name !== "outbox") expect(after).toEqual(stored);
      else {
        // 0022 then adds the supervision.
        expect(after.slice(0, stored.length)).toEqual(stored);
        expect(after[stored.length]).toMatchObject({
          name: "delivery",
          type: expect.stringMatching(/^text$/i),
          notnull: 0,
          dflt_value: null,
          pk: 0,
        });
      }
    }
    expect(readFileSync(join(repoMigrations, "0018_steer_delivery.sql"), "utf8").trim()).toBe(
      "ALTER TABLE `outbox` ADD `delivery` text;",
    );
    expectLedger(db.$client, ledger, "0018");
    // Old rows stay queued: none of them ever steers.
    expect(
      db
        .select()
        .from(outbox)
        .all()
        .map((row) => row.delivery),
    ).toEqual([null, null]);
    db.$client.close();
    db = openDatabase(path);
    expect(rows(db.$client)).toEqual(before);
    expectLedger(db.$client, ledger, "0018");
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0019 adds only recent_reactions and preserves every 0018 table, column, row and ledger entry", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-recent-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0019");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  old.run(
    "insert into outbox (session_id,message_id,text,state,from_owner,delivery,created_at) values ('ses_jojo','old','Keep','sent',1,'auto',1)",
  );
  // Stored classic reactions and a removal tombstone, from both actors.
  old.run(
    "insert into reactions (dot,session_id,message_id,actor,emoji,excerpt,updated_at) values ('jojo','ses_jojo','answer','owner','‼️','Keep',1),('jojo','ses_jojo','old','dot',null,'Keep',2)",
  );
  old.run(
    "insert into hidden_messages (dot,session_id,message_id,hidden_at) values ('jojo','ses_jojo','old',1)",
  );
  const tables = tableNames(old);
  const columns = new Map(
    tables.map((name) => [name, old.query(`pragma table_info("${name}")`).all()]),
  );
  // Only the columns 0018 had: 0020 adds memory columns.
  const rows = (sqlite: Database) =>
    tables.map((name) => [
      name,
      sqlite
        .query(
          `select ${(columns.get(name) as { name: string }[])
            .map((column) => `"${column.name}"`)
            .join(",")} from "${name}"`,
        )
        .all(),
    ]);
  const before = rows(old);
  const ledger = ledgerOf(old);
  old.close();
  let db = openDatabase(path);
  try {
    expect(rows(db.$client)).toEqual(before);
    // Later migrations may add tables; 0019 itself is one CREATE TABLE.
    const added = tableNames(db.$client).filter((name) => !tables.includes(name));
    expect(added).toContain("recent_reactions");
    for (const name of tables) {
      const stored = columns.get(name);
      assert(stored, `Missing stored columns for ${name}`);
      const after = db.$client.query(`pragma table_info("${name}")`).all();
      // 0020 to 0022 append columns to these.
      if (["notes", "reminders", "responsibilities", "outbox", ...polished].includes(name))
        expect(after.slice(0, stored.length)).toEqual(stored);
      else expect(after).toEqual(stored);
    }
    const statements = readFileSync(join(repoMigrations, "0019_recent_reactions.sql"), "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toStartWith("CREATE TABLE `recent_reactions` (");
    expect(db.$client.query('pragma table_info("recent_reactions")').all()).toMatchObject([
      { name: "emoji", type: expect.stringMatching(/^text$/i), notnull: 1, pk: 1 },
      { name: "seq", type: expect.stringMatching(/^integer$/i), notnull: 1, pk: 0 },
    ]);
    expectLedger(db.$client, ledger, "0019");
    // Old classic rows read back unchanged through the widened column type.
    expect(
      db
        .select()
        .from(reactions)
        .all()
        .map((row) => row.emoji),
    ).toEqual(["‼️", null]);
    db.insert(recentReactions).values({ emoji: "🇯🇵", seq: 1 }).run();
    db.$client.close();
    db = openDatabase(path);
    expect(db.select().from(recentReactions).all()).toEqual([{ emoji: "🇯🇵", seq: 1 }]);
    expect(rows(db.$client)).toEqual(before);
    expectLedger(db.$client, ledger, "0019");
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0020 adds memory versions that legacy writers still advance, and keeps every 0019 row", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-memory-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0020");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  old.run("insert into notes (dot,text,created_at) values ('jojo','Keep',2)");
  old.run(
    "insert into reminders (dot,text,due_at,every_minutes,state,created_at) values ('jojo','Keep',100,5,'scheduled',3)",
  );
  old.run(
    "insert into responsibilities (dot,goal,next_action,status,created_at,updated_at) values ('jojo','Keep','Next','active',4,5)",
  );
  const tables = tableNames(old);
  const columns = new Map(
    tables.map((name) => [
      name,
      old.query<{ name: string }, []>(`pragma table_info("${name}")`).all(),
    ]),
  );
  const rows = (sqlite: Database) =>
    tables.map((name) => [
      name,
      sqlite
        .query(
          `select ${columns
            .get(name)
            ?.map((column) => `"${column.name}"`)
            .join(",")} from "${name}"`,
        )
        .all(),
    ]);
  const before = rows(old);
  const ledger = ledgerOf(old);
  const legacyUpdate = old.prepare("update notes set text = ? where id = 1");
  let db = openDatabase(path);
  try {
    expect(rows(db.$client)).toEqual(before);
    // 0022 and 0023 then add supervisions and requests.
    expect(
      tableNames(db.$client).filter(
        (name) => name !== "supervisions" && name !== "requests" && !later.includes(name),
      ),
    ).toEqual(tables);
    const added = (name: string) =>
      db.$client
        .query<{ name: string }, []>(`pragma table_info("${name}")`)
        .all()
        .slice(columns.get(name)?.length);
    expect(added("notes")).toMatchObject([
      { name: "updated_at", notnull: 0, dflt_value: null },
      { name: "version", notnull: 1, dflt_value: "1" },
      { name: "updated_by", notnull: 1, dflt_value: "'dot'" },
      // 0025 then adds where a note was saved from.
      { name: "source_session" },
      { name: "source_message" },
    ]);
    expect(added("reminders").map((column) => column.name)).toEqual([
      "updated_at",
      "version",
      "updated_by",
    ]);
    // 0021 then adds the schedule.
    expect(added("responsibilities").map((column) => column.name)).toEqual([
      "version",
      "updated_by",
      "schedule",
      "next_run_at",
    ]);
    expect(added("outbox").map((column) => column.name)).toEqual(["supervision"]);
    for (const name of tables.filter(
      (table) => !["notes", "reminders", "responsibilities", "outbox", ...polished].includes(table),
    ))
      expect(db.$client.query(`pragma table_info("${name}")`).all()).toEqual(
        columns.get(name) ?? [],
      );
    const triggers = db.$client
      .query<{ name: string }, []>(
        "select name from sqlite_master where type='trigger' order by name",
      )
      .all();
    expect(triggers.map((trigger) => trigger.name)).toEqual([
      "notes_version",
      "reminders_version",
      "responsibilities_pause",
      "responsibilities_version",
    ]);
    expectLedger(db.$client, ledger, "0020");
    // Old rows start at version 1, by the dot, unchanged since they were created.
    expect(db.select().from(notes).get()).toMatchObject({
      version: 1,
      updatedBy: "dot",
      updatedAt: null,
    });
    expect(db.select().from(reminders).get()).toMatchObject({ version: 1, updatedBy: "dot" });
    expect(db.select().from(responsibilities).get()).toMatchObject({ version: 1, updatedAt: 5 });

    // A plugin or daemon from before 0020 writes the old columns only.
    old.run("insert into notes (dot,text,created_at) values ('jojo','Legacy',6)");
    expect(db.select().from(notes).all().at(-1)).toMatchObject({
      text: "Legacy",
      version: 1,
      updatedBy: "dot",
      updatedAt: null,
    });
    old.run("update responsibilities set next_action = 'Later', updated_at = 7");
    old.run("update reminders set due_at = 400");
    legacyUpdate.run("Changed");
    expect(db.select().from(responsibilities).get()).toMatchObject({
      nextAction: "Later",
      version: 2,
      updatedBy: "dot",
    });
    expect(db.select().from(reminders).get()).toMatchObject({
      dueAt: 400,
      version: 2,
      updatedBy: "scheduler",
    });
    const changed = db.select().from(notes).get();
    expect(changed).toMatchObject({ text: "Changed", version: 2, updatedBy: "dot" });
    expect(changed?.updatedAt).toBeGreaterThan(Date.now() - 60_000);
    // A writer that advances the version itself is left as it wrote.
    db.$client.run(
      "update notes set text = 'Owner', version = version + 1, updated_by = 'owner', updated_at = 9 where text = 'Changed'",
    );
    expect(db.select().from(notes).get()).toMatchObject({
      version: 3,
      updatedBy: "owner",
      updatedAt: 9,
    });
    legacyUpdate.run("Dot after owner");
    expect(db.select().from(notes).get()).toMatchObject({
      text: "Dot after owner",
      version: 4,
      updatedBy: "dot",
    });

    // Code from before 0020 finds nothing to migrate in the migrated file.
    migrate(drizzle({ client: db.$client }), { migrationsFolder: migrations });
    expectLedger(db.$client, ledger, "0020");
    db.$client.close();
    db = openDatabase(path);
    expect(db.select().from(notes).get()).toMatchObject({ text: "Dot after owner", version: 4 });
    expectLedger(db.$client, ledger, "0020");
  } finally {
    old.close();
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const triggerSQL = (sqlite: Database) =>
  sqlite
    .query<{ name: string; sql: string }, []>(
      "select name, sql from sqlite_master where type='trigger' order by name",
    )
    .all();

test("0021 adds a nullable schedule that legacy status writers pause, and keeps every 0020 row and trigger", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-schedule-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0021");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  old.run(
    "insert into responsibilities (dot,goal,next_action,status,created_at,updated_at) values ('jojo','Keep','Next','active',4,5)",
  );
  old.run(
    "insert into responsibilities (dot,goal,next_action,status,created_at,updated_at,version,updated_by) values ('jojo','Old','Done','done',4,5,3,'owner')",
  );
  const tables = tableNames(old);
  const columns = new Map(
    tables.map((name) => [
      name,
      old.query<{ name: string }, []>(`pragma table_info("${name}")`).all(),
    ]),
  );
  const rows = (sqlite: Database) =>
    tables.map((name) => [
      name,
      sqlite
        .query(
          `select ${columns
            .get(name)
            ?.map((column) => `"${column.name}"`)
            .join(",")} from "${name}"`,
        )
        .all(),
    ]);
  const before = rows(old);
  const ledger = ledgerOf(old);
  const oldTriggers = triggerSQL(old);
  let db = openDatabase(path);
  try {
    expect(rows(db.$client)).toEqual(before);
    // 0022 then adds supervisions and outbox.supervision, and 0023 requests.
    expect(
      tableNames(db.$client).filter(
        (name) => name !== "supervisions" && name !== "requests" && !later.includes(name),
      ),
    ).toEqual(tables);
    expect(
      db.$client
        .query<{ name: string }, []>(`pragma table_info("responsibilities")`)
        .all()
        .slice(columns.get("responsibilities")?.length),
    ).toMatchObject([
      { name: "schedule", notnull: 0, dflt_value: null },
      { name: "next_run_at", notnull: 0, dflt_value: null },
    ]);
    for (const name of tables.filter((table) => table !== "responsibilities"))
      expect(
        db.$client.query(`pragma table_info("${name}")`).all().slice(0, columns.get(name)?.length),
      ).toEqual(columns.get(name) ?? []);
    // 0020's version triggers stay exactly as they were, beside the new pause trigger.
    expect(
      triggerSQL(db.$client).filter((trigger) => trigger.name !== "responsibilities_pause"),
    ).toEqual(oldTriggers);
    expectLedger(db.$client, ledger, "0021");
    expect(db.select().from(responsibilities).all()).toMatchObject([
      { goal: "Keep", schedule: null, nextRunAt: null, version: 1 },
      { goal: "Old", schedule: null, nextRunAt: null, version: 3, updatedBy: "owner" },
    ]);

    // A plugin from before 0021 marks a scheduled responsibility done, then active again.
    db.$client.run(
      `update responsibilities set schedule = '{"kind":"interval","everyMinutes":5}', next_run_at = 1000 where id = 1`,
    );
    const armed = db.select().from(responsibilities).get();
    old.run("update responsibilities set status = 'done', updated_at = 7 where id = 1");
    const paused = db.select().from(responsibilities).get();
    expect(paused).toMatchObject({ status: "done", nextRunAt: null, updatedBy: "dot" });
    expect(paused?.version).toBeGreaterThan(armed?.version ?? Infinity);
    old.run("update responsibilities set status = 'active', updated_at = 8 where id = 1");
    expect(db.select().from(responsibilities).get()).toMatchObject({
      status: "active",
      nextRunAt: null,
      schedule: { kind: "interval", everyMinutes: 5 },
    });
    // An unrelated legacy edit of a done row leaves the schedule alone.
    old.run("update responsibilities set next_action = 'Later' where id = 2");
    expect(db.select().from(responsibilities).all()[1]).toMatchObject({ nextAction: "Later" });

    db.$client.close();
    db = openDatabase(path);
    expectLedger(db.$client, ledger, "0021");
  } finally {
    old.close();
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0022 adds supervisions and a nullable outbox.supervision, and keeps every 0021 row", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-supervision-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0022");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  old.run(
    "insert into outbox (session_id,message_id,text,state,created_at,started_at) values ('ses_jojo','msg_1','Hi','sent',2,3)",
  );
  const tables = tableNames(old);
  const columns = new Map(
    tables.map((name) => [name, old.query(`pragma table_info("${name}")`).all()]),
  );
  const rows = (sqlite: Database) =>
    tables.map((name) => [name, sqlite.query(`select * from "${name}"`).all()]);
  const before = rows(old);
  const ledger = ledgerOf(old);
  const triggers = triggerSQL(old);
  old.close();
  let db = openDatabase(path);
  try {
    expect(tableNames(db.$client).filter((name) => !later.includes(name))).toEqual(
      [...tables, "requests", "supervisions"].toSorted(),
    );
    for (const name of tables) {
      const after = db.$client.query(`pragma table_info("${name}")`).all();
      expect(after.slice(0, columns.get(name)?.length)).toEqual(columns.get(name) ?? []);
      if (name !== "outbox" && !polished.includes(name))
        expect(after).toHaveLength(columns.get(name)?.length ?? 0);
    }
    expect(
      db.$client.query(`pragma table_info("outbox")`).all().slice(columns.get("outbox")?.length),
    ).toMatchObject([{ name: "supervision", notnull: 0, dflt_value: null }]);
    expect(
      rows(db.$client).map(([name, items]) =>
        name === "outbox"
          ? [
              name,
              (items as Record<string, unknown>[]).map(({ supervision: _added, ...rest }) => rest),
            ]
          : [name, items],
      ),
    ).toEqual(before);
    expect(db.select().from(outbox).get()).toMatchObject({ messageID: "msg_1", supervision: null });
    expect(triggerSQL(db.$client)).toEqual(triggers);
    expectLedger(db.$client, ledger, "0022");

    // At most one open binding per dot and session; ended ones don't count.
    const insert = (state: string) =>
      db.$client.run(
        `insert into supervisions (dot,session_id,directory,mode,state,busy_minutes,created_at) values ('jojo','ses_owner','/w','watch','${state}',30,1)`,
      );
    insert("ended");
    insert("active");
    insert("ended");
    expect(() => insert("requested")).toThrow();
    expect(db.select().from(supervisions).all()).toMatchObject([
      { state: "ended", waitingOn: [], busyReported: false },
      { state: "active" },
      { state: "ended" },
    ]);
    db.$client.close();
    db = openDatabase(path);
    expectLedger(db.$client, ledger, "0022");
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0023 adds only requests, one row per session, kind and request, and keeps every 0022 row", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-requests-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0023");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  old.run(
    `insert into workers (dot,task,directory,session_id,state,waiting_on,created_at) values ('jojo','Task','/w','ses_w1','running','{"current":["permission:per_1"],"seen":["permission:per_1"]}',1)`,
  );
  const tables = tableNames(old);
  const columns = new Map(
    tables.map((name) => [name, old.query(`pragma table_info("${name}")`).all()]),
  );
  const rows = (sqlite: Database) =>
    tables.map((name) => [name, sqlite.query(`select * from "${name}"`).all()]);
  const before = rows(old);
  const ledger = ledgerOf(old);
  const triggers = triggerSQL(old);
  old.close();
  let db = openDatabase(path);
  try {
    expect(tableNames(db.$client).filter((name) => !later.includes(name))).toEqual(
      [...tables, "requests"].toSorted(),
    );
    for (const name of tables) {
      const after = db.$client.query(`pragma table_info("${name}")`).all();
      if (polished.includes(name))
        expect(after.slice(0, columns.get(name)?.length)).toEqual(columns.get(name) ?? []);
      else expect(after).toEqual(columns.get(name) ?? []);
    }
    expect(rows(db.$client)).toEqual(before);
    expect(triggerSQL(db.$client)).toEqual(triggers);
    expectLedger(db.$client, ledger, "0023");
    const insert = (kind: string) =>
      db.$client.run(
        `insert into requests (dot,source,worker,session_id,title,directory,kind,request_id,detail,state,created_at) values ('jojo','worker',1,'ses_w1','Task','/w','${kind}','per_1','{}','open',1)`,
      );
    insert("permission");
    insert("question");
    expect(() => insert("permission")).toThrow();
    expect(db.select().from(requests).all()).toMatchObject([
      { kind: "permission", sensitive: false, answer: null, goneAt: null },
      { kind: "question" },
    ]);
    db.$client.close();
    db = openDatabase(path);
    expectLedger(db.$client, ledger, "0023");
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0024 appends nullable Slack polish columns, keeps every 0023 row, and leaves old DM threads untitled", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-slack-polish-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0024");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  old.run(
    "insert into slack_apps (dot,state,app_id,team_id,owner_id,created_at,updated_at) values ('jojo','active','AJOJO','T1','UOWNER',1,1)",
  );
  for (const [kind, ts, state] of [
    ["dm", "1.000001", "posted"],
    ["dm", "1.000002", "waiting"],
    ["mention", "1.000003", "posted"],
  ])
    old.run(
      `insert into slack_events (app,dot,kind,channel,ts,thread,state,created_at) values ('AJOJO','jojo','${kind}','DJ','${ts}','${ts}','${state}',1)`,
    );
  const tables = tableNames(old);
  const columns = new Map(
    tables.map((name) => [name, old.query(`pragma table_info("${name}")`).all()]),
  );
  const rows = (sqlite: Database, name: string) =>
    sqlite
      .query(
        `select ${(columns.get(name) as { name: string }[]).map((c) => `"${c.name}"`).join(",")} from "${name}"`,
      )
      .all();
  const before = tables.map((name) => [name, rows(old, name)]);
  const ledger = ledgerOf(old);
  const triggers = triggerSQL(old);
  old.close();
  let db = openDatabase(path);
  try {
    expect(tableNames(db.$client).filter((name) => !later.includes(name))).toEqual(tables);
    for (const name of tables) {
      const after = db.$client.query<{ name: string }, []>(`pragma table_info("${name}")`).all();
      const stored = columns.get(name) ?? [];
      expect(after.slice(0, stored.length)).toEqual(stored as { name: string }[]);
      const added = after.slice(stored.length).map((column) => column.name);
      expect(added).toEqual(
        name === "slack_apps"
          ? ["prompts", "manifest_version", "update_state", "update_at", "update_note"]
          : name === "slack_events"
            ? ["status_at", "stream", "stream_id", "stream_ts", "stream_text", "title"]
            : // 0025 then adds where a note was saved from.
              name === "notes"
              ? ["source_session", "source_message"]
              : [],
      );
    }
    expect(tables.map((name) => [name, rows(db.$client, name)])).toEqual(before);
    expect(triggerSQL(db.$client)).toEqual(triggers);
    expectLedger(db.$client, ledger, "0024");
    expect(db.select().from(slackApps).get()).toMatchObject({
      prompts: null,
      manifestVersion: null,
      updateState: null,
      updateNote: null,
    });
    expect(
      db
        .select()
        .from(slackEvents)
        .all()
        .map((row) => [row.kind, row.title, row.stream, row.statusAt]),
    ).toEqual([
      ["dm", "", null, null],
      ["dm", "", null, null],
      ["mention", null, null, null],
    ]);
    db.$client.close();
    db = openDatabase(path);
    expectLedger(db.$client, ledger, "0024");
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0025 appends nullable note sources, keeps every 0024 row and trigger, and old notes stay unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-note-sources-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0025");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  old.run("insert into notes (dot,text,created_at) values ('jojo','Old decision',2)");
  old.run(
    "insert into notes (dot,text,created_at,updated_at,version,updated_by) values ('jojo','Owner note',3,4,2,'owner')",
  );
  const tables = tableNames(old);
  const columns = new Map(
    tables.map((name) => [name, old.query(`pragma table_info("${name}")`).all()]),
  );
  const rows = (sqlite: Database, name: string) =>
    sqlite
      .query(
        `select ${(columns.get(name) as { name: string }[]).map((c) => `"${c.name}"`).join(",")} from "${name}"`,
      )
      .all();
  const before = tables.map((name) => [name, rows(old, name)]);
  const ledger = ledgerOf(old);
  const triggers = triggerSQL(old);
  old.close();
  let db = openDatabase(path);
  try {
    expect(tableNames(db.$client).filter((name) => !later.includes(name))).toEqual(tables);
    for (const name of tables) {
      const after = db.$client.query<{ name: string }, []>(`pragma table_info("${name}")`).all();
      const stored = columns.get(name) ?? [];
      expect(after.slice(0, stored.length)).toEqual(stored as { name: string }[]);
      expect(after.slice(stored.length)).toMatchObject(
        name === "notes"
          ? [
              { name: "source_session", notnull: 0, dflt_value: null, pk: 0 },
              { name: "source_message", notnull: 0, dflt_value: null, pk: 0 },
            ]
          : [],
      );
    }
    expect(tables.map((name) => [name, rows(db.$client, name)])).toEqual(before);
    expect(triggerSQL(db.$client)).toEqual(triggers);
    expectLedger(db.$client, ledger, "0025");
    expect(readMemory(db, "jojo").notes.map((note) => [note.text, note.source])).toEqual([
      ["Old decision", null],
      ["Owner note", null],
    ]);
    // The version trigger still advances a legacy edit and leaves the source alone.
    db.$client.run(
      "update notes set source_session = 'ses_jojo', source_message = 'msg_1' where id = 1",
    );
    db.$client.run("update notes set text = 'Legacy edit' where id = 1");
    expect(db.select().from(notes).get()).toMatchObject({
      text: "Legacy edit",
      version: 3,
      sourceSession: "ses_jojo",
      sourceMessage: "msg_1",
    });
    expect(readMemory(db, "jojo").notes[0]?.source).toEqual({
      sessionID: "ses_jojo",
      messageID: "msg_1",
      edited: true,
    });
    db.$client.close();
    db = openDatabase(path);
    expectLedger(db.$client, ledger, "0025");
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0026 adds only the feed trigger tables, keeps every 0025 table, row and trigger, and keys occurrences once", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-dot-feed-triggers-migration-"));
  const migrations = join(directory, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0026");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "open-dot.db");
  const old = new Database(path);
  migrate(drizzle({ client: old }), { migrationsFolder: migrations });
  old.run(
    "insert into dots (name,directory,session_id,session_state,created_at) values ('jojo','/dots/jojo','ses_jojo','ready',1)",
  );
  old.run(
    "insert into responsibilities (dot,goal,next_action,status,created_at,updated_at) values ('jojo','Reviews','Read','active',1,1)",
  );
  old.run(
    "insert into outbox (session_id,message_id,text,state,created_at) values ('ses_jojo','msg_old','Hi','pending',1)",
  );
  old.run(
    "insert into feed (source,source_id,reason,title,context,updated_at,state,created_at) values ('github','T1','Review requested','Old','opzero1/open-dot',5,'unread',1)",
  );
  const tables = tableNames(old);
  const columns = new Map(
    tables.map((name) => [name, old.query(`pragma table_info("${name}")`).all()]),
  );
  const rows = (sqlite: Database) =>
    tables.map((name) => [name, sqlite.query(`select * from "${name}"`).all()]);
  const before = rows(old);
  const ledger = ledgerOf(old);
  const triggers = triggerSQL(old);
  old.close();
  let db = openDatabase(path);
  try {
    expect(tableNames(db.$client)).toEqual([...tables, ...later].toSorted());
    for (const name of tables)
      expect(db.$client.query(`pragma table_info("${name}")`).all()).toEqual(
        columns.get(name) ?? [],
      );
    expect(rows(db.$client)).toEqual(before);
    expect(triggerSQL(db.$client)).toEqual(triggers);
    expectLedger(db.$client, ledger, "0026");
    db.$client.run(
      "insert into feed_triggers (dot,responsibility,session_id,source,repository,reasons,task,revision,state,created_at,updated_at) values ('jojo',1,'ses_jojo','github','opzero1/open-dot','[\"Review requested\"]','Review it','r','draft',1,1)",
    );
    const occurrence = (sourceID: string, at: number) =>
      db.$client.run(
        `insert into trigger_occurrences (trigger_id,source,source_id,activity_at,epoch,state,event,created_at) values (1,'github','${sourceID}',${at},1,'baseline','{}',1)`,
      );
    occurrence("T1", 5);
    // Later activity on the same item is a new occurrence; the same activity is refused.
    occurrence("T1", 6);
    expect(() => occurrence("T1", 5)).toThrow();
    expect(db.$client.query("select epoch, baseline_at from feed_triggers").get()).toEqual({
      epoch: 0,
      baseline_at: null,
    });
    db.$client.close();
    db = openDatabase(path);
    expectLedger(db.$client, ledger, "0026");
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
