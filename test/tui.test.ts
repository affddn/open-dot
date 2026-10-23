import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databasePath } from "../src/home";
import { readSidebar, same } from "../src/tui";

let db: Database;
let directory: string;
let previousHome: string | undefined;
let now: number;

beforeEach(() => {
  previousHome = process.env.OPEN_DOT_HOME;
  directory = mkdtempSync(join(tmpdir(), "open-dot-sidebar-"));
  process.env.OPEN_DOT_HOME = directory;
  now = Date.now();
  db = new Database(databasePath());
  db.exec(`
    CREATE TABLE dots (name TEXT, session_id TEXT, session_state TEXT, created_at INTEGER);
    CREATE TABLE workers (
      id INTEGER PRIMARY KEY, dot TEXT, task TEXT, session_id TEXT, state TEXT,
      outcome TEXT, created_at INTEGER, finished_at INTEGER
    );
    INSERT INTO dots VALUES ('jotaro', 'ses_jotaro', 'ready', 1);
  `);
});

afterEach(() => {
  db.close();
  if (previousHome === undefined) delete process.env.OPEN_DOT_HOME;
  else process.env.OPEN_DOT_HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
});

function worker(
  id: number,
  state = "done",
  dot = "jotaro",
  createdAt = now - 1000 + id,
  finishedAt: number | null = state === "done" ? now - 1000 + id : null,
) {
  db.query("INSERT INTO workers VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    dot,
    `Task ${id}\nDetails`,
    `ses_worker_${id}`,
    state,
    state === "done" ? "succeeded" : null,
    createdAt,
    finishedAt,
  );
}

const ids = (dot = "jotaro") =>
  readSidebar().flatMap((line) => (line.dot.name === dot && line.worker ? [line.worker.id] : []));

test("a dot without workers keeps only its heading", () => {
  expect(readSidebar()).toEqual([{ dot: { name: "jotaro", sessionID: "ses_jotaro" } }]);
});

test("fewer than ten workers all show without overflow", () => {
  worker(1);
  worker(2, "running");
  worker(3);
  expect(ids()).toEqual([2, 3, 1]);
  expect(readSidebar().some((line) => line.more)).toBe(false);
});

test("exactly ten workers show without overflow", () => {
  for (let id = 1; id <= 10; id++) worker(id);
  expect(ids()).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  expect(readSidebar()).toHaveLength(11);
});

test("running workers precede the newest finished workers, capped per dot", () => {
  for (let id = 1; id <= 14; id++) worker(id, id <= 2 ? "running" : "done");
  expect(ids()).toEqual([2, 1, 14, 13, 12, 11, 10, 9, 8, 7]);
  expect(readSidebar().at(-1)).toEqual({
    dot: { name: "jotaro", sessionID: "ses_jotaro" },
    more: 4,
  });
});

test("more than ten running workers all show, with no finished workers", () => {
  for (let id = 1; id <= 12; id++) worker(id, "running");
  worker(13);
  worker(14);
  expect(ids()).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  expect(readSidebar().at(-1)?.more).toBe(2);
});

test("more than ten running workers alone do not create an overflow row", () => {
  for (let id = 1; id <= 12; id++) worker(id, "running");
  expect(ids()).toHaveLength(12);
  expect(readSidebar().some((line) => line.more)).toBe(false);
});

test("newest means creation time for running and finish time for done, then ID", () => {
  worker(1, "running", "jotaro", now - 10);
  worker(2, "running", "jotaro", now - 20);
  worker(3, "running", "jotaro", now - 10);
  worker(4, "done", "jotaro", now - 100, now - 1);
  worker(5, "done", "jotaro", now - 50, now - 2);
  worker(6, "done", "jotaro", now - 70, now - 1);
  expect(ids()).toEqual([3, 1, 2, 6, 4, 5]);
});

test("each dot has its own limit and overflow count", () => {
  db.query("INSERT INTO dots VALUES ('dio', 'ses_dio', 'ready', 2)").run();
  for (let id = 1; id <= 14; id++) worker(id);
  for (let id = 15; id <= 25; id++) worker(id, "done", "dio");
  expect(ids()).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  expect(ids("dio")).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
  expect(readSidebar().filter((line) => line.more)).toEqual([
    { dot: { name: "jotaro", sessionID: "ses_jotaro" }, more: 4 },
    { dot: { name: "dio", sessionID: "ses_dio" }, more: 1 },
  ]);
});

test("only running and workers finished within 24 hours qualify", () => {
  const cutoff = now - 24 * 60 * 60 * 1000;
  worker(1, "running", "jotaro", cutoff - 1000);
  worker(2, "done", "jotaro", cutoff - 1000, cutoff - 1000);
  worker(3, "done", "jotaro", cutoff - 1000, cutoff);
  worker(4, "done", "jotaro", cutoff - 1000, cutoff + 60_000);
  worker(5, "creating");
  worker(6, "stopping");
  worker(7, "done", "jotaro", now, null);
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    expect(ids()).toEqual([1, 4]);
  } finally {
    clock.mockRestore();
  }
});

test("same suppresses identical reads but detects visible and overflow changes", () => {
  for (let id = 1; id <= 11; id++) worker(id);
  const before = readSidebar();
  expect(same(before, readSidebar())).toBe(true);
  db.query("UPDATE workers SET task = 'Changed' WHERE id = 11").run();
  expect(same(before, readSidebar())).toBe(false);
  const changed = readSidebar();
  db.query("DELETE FROM workers WHERE id = 1").run();
  expect(same(changed, readSidebar())).toBe(false);
});
