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
import {
  feed,
  hiddenMessages,
  outbox,
  reactions,
  recentReactions,
  slack,
  slackApps,
  slackEvents,
  slackThreads,
  slackPolls,
  reminders,
  workers,
  routeKey,
  type Route,
  type QuoteSnapshot,
} from "../src/schema";

const repoMigrations = join(import.meta.dir, "..", "drizzle");

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
      } else expect(after).toEqual(stored);
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
  const rows = (sqlite: Database) =>
    tables.map((name) => [
      name,
      sqlite
        .query(`select * from "${name}"`)
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
      if (name !== "outbox") expect(after).toEqual(stored);
      else {
        expect(after.slice(0, -1)).toEqual(stored);
        expect(after.at(-1)).toMatchObject({
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
  const rows = (sqlite: Database) =>
    tables.map((name) => [name, sqlite.query(`select * from "${name}"`).all()]);
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
      expect(db.$client.query(`pragma table_info("${name}")`).all()).toEqual(stored);
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
