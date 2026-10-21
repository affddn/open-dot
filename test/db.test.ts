import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDatabase } from "../src/db";
import { feed, outbox } from "../src/schema";

test("a database from before feed replies keeps its rows, and replies survive a restart", () => {
  // Build the database as the previous release left it: every migration but the newest.
  const dir = mkdtempSync(join(tmpdir(), "open-dot-db-"));
  const migrations = join(dir, "drizzle");
  cpSync(join(import.meta.dir, "..", "drizzle"), migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag !== "0012_feed_handoff");
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
