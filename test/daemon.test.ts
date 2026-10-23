import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { claimDue, step } from "../src/daemon";
import { type Db, openDatabase } from "../src/db";
import { worktreeDirectory } from "../src/home";
import { editResponsibility } from "../src/memory";
import {
  dots,
  outbox,
  reminders,
  responsibilities,
  workers,
  slack,
  slackEvents,
  type Route,
} from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;

beforeEach(() => {
  db = openDatabase(":memory:");
  fake = fakeOpenCode();
  db.insert(dots)
    .values({
      name: "jojo",
      directory: "/dots/jojo",
      sessionID: "ses_jojo",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
});

const remind = (dueAt: number) =>
  db
    .insert(reminders)
    .values({ dot: "jojo", text: "Stretch.", dueAt, state: "scheduled", createdAt: 0 })
    .returning()
    .get();

const tick = (now: number) => {
  claimDue(db, now);
  return Effect.runPromise(Effect.provide(step(db), fake.layer));
};

const sharedRoute = (thread: string): Route => ({
  kind: "shared",
  dot: "jojo",
  sessionID: "ses_jojo",
  owner: "U1",
  team: "T1",
  bot: "B1",
  dm: true,
  channel: "D1",
  thread,
});

test("one gate serializes shared, per-dot and native destinations without same-route overtaking", async () => {
  const files = [{ mime: "image/png", name: "native.png", data: "iVBORw0KGgo=" }];
  const a = sharedRoute("1.1");
  const b: Route = { ...a, kind: "agent", app: "A2", bot: "B2", channel: "D2" };
  for (const [id, route] of [
    ["a", a],
    ["a2", a],
    ["b", b],
    ["a3", a],
    ["native", null],
  ] as const)
    db.insert(outbox)
      .values({
        sessionID: "ses_jojo",
        messageID: id,
        text: id,
        files: id === "native" ? files : null,
        route,
        state: "pending",
        createdAt: 0,
      })
      .run();
  await tick(0);
  expect(fake.state.prompted).toEqual(["a", "a2"]);
  expect(fake.state.files.size).toBe(0);
  fake.state.active.add("ses_jojo");
  await tick(0);
  expect(fake.state.prompted).toEqual(["a", "a2"]);
  for (const id of ["a", "a2"])
    fake.state.messageTurns.set(id, { end: "idle_A", outcome: "succeeded", text: undefined });
  fake.state.active.clear();
  await tick(0);
  expect(fake.state.prompted).toEqual(["a", "a2", "b"]);
  fake.state.readFailure = true;
  await tick(0);
  expect(fake.state.prompted).toHaveLength(3);
  fake.state.readFailure = false;
  fake.state.messageTurns.set("b", { end: "idle_B", outcome: "succeeded", text: undefined });
  await tick(0);
  expect(fake.state.prompted).toEqual(["a", "a2", "b", "a3"]);
  fake.state.messageTurns.set("a3", { end: "idle_A3", outcome: "succeeded", text: undefined });
  await tick(0);
  expect(fake.state.prompted).toEqual(["a", "a2", "b", "a3", "native"]);
  expect([...fake.state.files]).toEqual([["native", files]]);
  expect(fake.state.created).toEqual([]);
});

test("lost admission survives reopening and holds a competing thread until public completion", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "open-dot-gate-")), "gate.db");
  db.$client.close();
  db = openDatabase(path);
  for (const [id, route] of [
    ["a", sharedRoute("1.1")],
    ["b", sharedRoute("1.2")],
  ] as const)
    db.insert(outbox)
      .values({
        sessionID: "ses_jojo",
        messageID: id,
        text: id,
        route,
        state: "pending",
        createdAt: 0,
      })
      .run();
  fake.state.prompt = "lost";
  await tick(0);
  db.$client.close();
  db = openDatabase(path);
  fake.state.prompt = "ok";
  await tick(0);
  expect(fake.state.prompted).toEqual(["a"]);
  expect(messages()[0]?.state).toBe("sent");
  expect(messages()[0]?.turnEnd).toBeNull();
  fake.state.messageTurns.set("a", { end: "idle_A", outcome: "interrupted", text: undefined });
  await tick(0);
  expect(fake.state.prompted).toEqual(["a", "b"]);
  db.$client.close();
});

test("due notices retain their original DM destinations and remain unrouted in the dot chat", () => {
  const a = sharedRoute("1.1");
  const b: Route = { ...a, kind: "agent", app: "A2", bot: "B2", channel: "D2", thread: "2.1" };
  for (const route of [a, b])
    db.insert(reminders)
      .values({ dot: "jojo", text: "Remember", dueAt: 1, state: "scheduled", route, createdAt: 0 })
      .run();
  db.update(dots).set({ sessionID: "ses_rebound" }).run();
  claimDue(db, 2);
  claimDue(db, 3);
  expect(db.select().from(slack).all()).toMatchObject([{ route: a, state: "posting" }]);
  expect(db.select().from(slackEvents).all()).toMatchObject([
    { app: "A2", route: b, channel: "D2", thread: "2.1", state: "posting" },
  ]);
  expect(messages()).toHaveLength(2);
  expect(messages().every((row) => row.route === null && row.sessionID === "ses_jojo")).toBe(true);
});

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", cwd, ...args])
    .stdout.toString()
    .trim();

const reminder = (id: number) => db.select().from(reminders).where(eq(reminders.id, id)).get();
const messages = () => db.select().from(outbox).all();

test("a due reminder is delivered once, with the message ID saved before the call", async () => {
  const due = remind(100);
  const later = remind(500);

  await tick(200);
  await tick(300);

  expect(reminder(due.id)?.state).toBe("sent");
  expect(reminder(later.id)?.state).toBe("scheduled");
  const [message] = messages();
  expect(message?.state).toBe("sent");
  expect(fake.state.prompted).toEqual([message?.messageID ?? "missing"]);
});

test("a repeating reminder skips missed occurrences instead of sending a burst", async () => {
  const minute = 60_000;
  const due = db
    .insert(reminders)
    .values({
      dot: "jojo",
      text: "Stand up.",
      dueAt: minute,
      everyMinutes: 10,
      state: "scheduled",
      createdAt: 0,
    })
    .returning()
    .get();

  await tick(35 * minute);
  await tick(36 * minute);

  expect(reminder(due.id)).toMatchObject({ state: "scheduled", dueAt: 41 * minute });
  expect(fake.state.prompted).toHaveLength(1);
});

test("a delivery whose response was lost is confirmed by ID, not sent again", async () => {
  remind(100);
  fake.state.prompt = "lost";

  await tick(200);
  expect(messages()[0]?.state).toBe("pending");

  fake.state.prompt = "ok";
  await tick(300);

  expect(messages()[0]?.state).toBe("sent");
  expect(fake.state.prompted).toHaveLength(1);
});

test("a delivery OpenCode never admitted is sent again with the same message ID", async () => {
  remind(100);
  fake.state.prompt = "fail";

  await tick(200);
  const saved = messages()[0]?.messageID;

  fake.state.prompt = "ok";
  await tick(300);

  expect(messages()).toHaveLength(1);
  expect(messages()[0]?.state).toBe("sent");
  expect(fake.state.prompted).toEqual([saved ?? "missing"]);
});

test("a worker gets one session and task, and its dot hears once per approval and once when it ends", async () => {
  db.insert(workers)
    .values({
      dot: "jojo",
      task: "Count the files.",
      directory: "/work/jojo",
      sessionID: "ses_worker",
      state: "creating",
      createdAt: 0,
    })
    .run();
  const sentTo = (sessionID: string) =>
    fake.state.texts.filter((sent) => sent.sessionID === sessionID).map((sent) => sent.text);

  await tick(1);
  await tick(2);
  expect(fake.state.created.map((session) => session.id)).toEqual(["ses_worker"]);
  expect(sentTo("ses_worker")).toEqual([expect.stringContaining("Count the files.")]);

  fake.state.active.add("ses_worker");
  fake.state.waiting.set("ses_worker", [
    { id: "per_1", kind: "permission", summary: "shell: rm -r x" },
  ]);
  await tick(3);
  await tick(4);
  expect(sentTo("ses_jojo")).toEqual([expect.stringContaining("rm -r x")]);

  fake.state.active.delete("ses_worker");
  fake.state.waiting.clear();
  fake.state.turns.set("ses_worker", { outcome: "succeeded", text: "There are 3 files." });
  await tick(5);
  await tick(6);
  expect(sentTo("ses_jojo")).toEqual([
    expect.stringContaining("rm -r x"),
    expect.stringContaining("There are 3 files."),
  ]);
  expect(db.select().from(workers).get()?.state).toBe("done");
});

test("a worker in a git repo gets its own worktree, and one that can't get a whole one fails once", async () => {
  const temp = mkdtempSync(join(tmpdir(), "open-dot-"));
  process.env.OPEN_DOT_HOME = join(temp, "home");
  const repo = join(temp, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.txt"), "a");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "init");
  git(repo, "branch", "dot/jojo-2");
  const worker = (id: number) => ({
    id,
    dot: "jojo",
    task: `Task ${id}.`,
    directory: join(worktreeDirectory("jojo", id), "src"),
    source: repo,
    branch: `dot/jojo-${id}`,
    sessionID: `ses_w${id}`,
    state: "creating" as const,
    createdAt: 0,
  });
  // Worker 3's worktree is still locked, as git leaves it when killed mid-checkout.
  git(repo, "worktree", "add", "-q", "-b", "dot/jojo-3", worktreeDirectory("jojo", 3), "HEAD");
  git(repo, "worktree", "lock", worktreeDirectory("jojo", 3));
  db.insert(workers)
    .values([worker(1), worker(2), worker(3)])
    .run();

  await tick(1);
  await tick(2);

  const root = worktreeDirectory("jojo", 1);
  expect(git(root, "branch", "--show-current")).toBe("dot/jojo-1");
  expect(fake.state.created.map((session) => session.directory)).toEqual([join(root, "src")]);
  expect(fake.state.texts.find((sent) => sent.sessionID === "ses_w1")?.text).toContain(
    "branch dot/jojo-1",
  );
  for (const id of [2, 3]) {
    expect(db.select().from(workers).where(eq(workers.id, id)).get()).toMatchObject({
      state: "done",
      outcome: "failed",
    });
  }
  expect(fake.state.texts.filter((sent) => sent.sessionID === "ses_jojo")).toEqual([
    { sessionID: "ses_jojo", text: expect.stringContaining("Worker #2 could not start") },
    { sessionID: "ses_jojo", text: expect.stringContaining("Worker #3 could not start") },
  ]);
  expect(git(repo, "status", "--porcelain")).toBe("");

  delete process.env.OPEN_DOT_HOME;
  rmSync(temp, { recursive: true, force: true });
});

const minute = 60_000;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
afterEach(() => {
  process.env.TZ = timeZone;
});

const track = (values: Partial<typeof responsibilities.$inferInsert> = {}) =>
  db
    .insert(responsibilities)
    .values({
      dot: "jojo",
      goal: "Keep the inbox at zero",
      nextAction: "Triage new mail",
      status: "active",
      schedule: { kind: "interval", everyMinutes: 10 },
      nextRunAt: minute,
      createdAt: 0,
      updatedAt: 0,
      ...values,
    })
    .returning()
    .get();
const job = (id: number) =>
  db.select().from(responsibilities).where(eq(responsibilities.id, id)).get();

test("a scheduled responsibility wakes its dot with its goal and next action, once after downtime", async () => {
  const item = track();
  await tick(35 * minute);
  await tick(36 * minute);
  expect(fake.state.texts).toEqual([
    {
      sessionID: "ses_jojo",
      text: expect.stringMatching(
        /^Scheduled run of responsibility #1 \(every 10 minutes\)[^]*Goal: Keep the inbox at zero\nNext action: Triage new mail/,
      ),
    },
  ]);
  expect(job(item.id)).toMatchObject({
    nextRunAt: 41 * minute,
    version: 2,
    updatedBy: "scheduler",
  });
  // The wake carries the next action as it is at that run.
  db.update(responsibilities).set({ nextAction: "Archive newsletters" }).run();
  await tick(41 * minute);
  expect(fake.state.texts.map((sent) => sent.text)[1]).toContain(
    "Next action: Archive newsletters",
  );
  expect(messages()).toHaveLength(2);
});

test("a restart between due and delivered, or a lost admission, sends each run once", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "open-dot-schedule-")), "schedule.db");
  db.$client.close();
  db = openDatabase(path);
  db.insert(dots)
    .values({
      name: "jojo",
      directory: "/dots/jojo",
      sessionID: "ses_jojo",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
  track();
  // The claim commits its next run and outbox row together, then the daemon stops.
  claimDue(db, 35 * minute);
  db.$client.close();
  db = openDatabase(path);
  claimDue(db, 35 * minute);
  expect(messages()).toHaveLength(1);
  const [saved] = messages();
  fake.state.prompt = "lost";
  await tick(35 * minute);
  db.$client.close();
  db = openDatabase(path);
  fake.state.prompt = "ok";
  await tick(36 * minute);
  expect(fake.state.prompted).toEqual([saved?.messageID ?? "missing"]);
  expect(messages()).toMatchObject([{ state: "sent" }]);
  db.$client.close();
});

test("done or dropped pauses a schedule, and active resumes it after now without catching up", async () => {
  const now = Date.now();
  const item = track({ nextRunAt: now - minute });
  const done = editResponsibility(db, "jojo", item.id, 1, { status: "done" });
  expect(done).toMatchObject({ saved: { status: "done", nextRunAt: null, version: 2 } });
  await tick(now + 60 * minute);
  expect(messages()).toEqual([]);
  expect(job(item.id)?.nextRunAt).toBeNull();
  const resumed = editResponsibility(db, "jojo", item.id, 2, { status: "active" });
  expect(resumed).toMatchObject({ saved: { status: "active", version: 3, updatedBy: "owner" } });
  // The owner's change advanced the version once: the pause trigger did nothing more.
  expect(job(item.id)).toMatchObject({ version: 3, updatedBy: "owner" });
  const next = job(item.id)?.nextRunAt ?? 0;
  expect(next).toBeGreaterThan(now);
  expect(next).toBeLessThanOrEqual(Date.now() + 10 * minute);
  await tick(next - 1);
  expect(messages()).toEqual([]);

  // A plugin from before the schedule drops it and reopens it with plain SQL.
  db.$client.run("update responsibilities set status = 'dropped' where id = ?", [item.id]);
  expect(job(item.id)?.nextRunAt).toBeNull();
  await tick(next + 60 * minute);
  db.$client.run("update responsibilities set status = 'active' where id = ?", [item.id]);
  expect(job(item.id)?.nextRunAt).toBeNull();
  // The daemon arms it from now, and sends nothing for the paused time.
  await tick(next + 61 * minute);
  expect(job(item.id)).toMatchObject({ nextRunAt: next + 71 * minute, updatedBy: "scheduler" });
  expect(messages()).toEqual([]);
  await tick(next + 71 * minute);
  expect(messages()).toHaveLength(1);
});

test("only ready dots are woken, and a responsibility without a schedule never is", async () => {
  db.update(dots).set({ sessionState: "creating" }).run();
  const item = track();
  track({ schedule: null, nextRunAt: null });
  await tick(35 * minute);
  expect(messages()).toEqual([]);
  expect(job(item.id)?.nextRunAt).toBe(minute);
  db.update(dots).set({ sessionState: "ready" }).run();
  await tick(36 * minute);
  expect(messages()).toHaveLength(1);
  expect(job(item.id)?.nextRunAt).toBe(41 * minute);
});

test("a daily run keeps its local time across DST and follows a changed system time zone", async () => {
  process.env.TZ = "America/New_York";
  const item = track({
    schedule: { kind: "daily", time: "09:00" },
    nextRunAt: Date.UTC(2026, 2, 7, 14, 0),
  });
  await tick(Date.UTC(2026, 2, 7, 14, 0, 30));
  // Daylight time starts overnight, so 09:00 is an hour earlier in UTC.
  expect(job(item.id)?.nextRunAt).toBe(Date.UTC(2026, 2, 8, 13, 0));
  await tick(Date.UTC(2026, 2, 8, 12, 59));
  expect(messages()).toHaveLength(1);
  process.env.TZ = "Europe/London";
  await tick(Date.UTC(2026, 2, 8, 13, 0));
  expect(messages()).toHaveLength(2);
  // The next run is computed in the zone the system has now.
  expect(job(item.id)?.nextRunAt).toBe(Date.UTC(2026, 2, 9, 9, 0));
});

test("a schedule claim rolls back its next run if persisting the wake fails", () => {
  const item = track();
  db.$client.exec(`CREATE TRIGGER reject_schedule_wake BEFORE INSERT ON outbox
    BEGIN SELECT RAISE(ABORT, 'test wake persistence failure'); END`);
  expect(() => claimDue(db, 35 * minute)).toThrow("test wake persistence failure");
  expect(job(item.id)).toMatchObject({ nextRunAt: minute, version: 1, updatedBy: "dot" });
  expect(messages()).toEqual([]);
  db.$client.exec("DROP TRIGGER reject_schedule_wake");
  claimDue(db, 35 * minute);
  expect(job(item.id)).toMatchObject({ nextRunAt: 41 * minute, version: 2 });
  expect(messages()).toMatchObject([{ route: null, state: "pending" }]);
  const savedID = messages()[0]?.messageID ?? "missing";
  expect(savedID).toMatch(/^msg_/);
  claimDue(db, 35 * minute);
  expect(messages().map((row) => row.messageID)).toEqual([savedID]);
});

test("a schedule retries an absent admission with its saved ID, but not during a failed lookup", async () => {
  track();
  fake.state.prompt = "fail";
  await tick(35 * minute);
  const savedID = messages()[0]?.messageID ?? "missing";
  expect(savedID).toMatch(/^msg_/);
  expect(messages()).toMatchObject([{ state: "pending", route: null }]);
  expect(fake.state.prompted).toEqual([]);
  fake.state.prompt = "ok";
  fake.state.lookupFailure = true;
  await tick(36 * minute);
  expect(fake.state.prompted).toEqual([]);
  expect(messages()).toMatchObject([{ messageID: savedID, state: "pending" }]);
  fake.state.lookupFailure = false;
  await tick(37 * minute);
  await tick(38 * minute);
  expect(fake.state.prompted).toEqual([savedID]);
  expect(messages()).toMatchObject([{ messageID: savedID, state: "sent", route: null }]);
});

test("an owner edit between the due read and claim prevents a stale schedule wake", () => {
  const changed = track();
  const paused = track();
  const transaction = db.transaction.bind(db);
  let interleaved = false;
  const spy = spyOn(db, "transaction").mockImplementationOnce(((run: never) => {
    spy.mockRestore();
    expect(
      editResponsibility(db, "jojo", changed.id, 1, { nextAction: "Read the latest mail" }),
    ).toHaveProperty("saved");
    expect(editResponsibility(db, "jojo", paused.id, 1, { status: "done" })).toHaveProperty(
      "saved",
    );
    interleaved = true;
    return transaction(run);
  }) as never);
  try {
    claimDue(db, 35 * minute);
  } finally {
    spy.mockRestore();
  }
  expect(interleaved).toBe(true);
  expect(messages()).toEqual([]);
  expect(job(changed.id)).toMatchObject({ nextRunAt: minute, version: 2, updatedBy: "owner" });
  expect(job(paused.id)).toMatchObject({ nextRunAt: null, status: "done", version: 2 });
  claimDue(db, 35 * minute);
  expect(messages()).toHaveLength(1);
  expect(messages()[0]?.text).toContain("Next action: Read the latest mail");
  expect(job(changed.id)).toMatchObject({ nextRunAt: 41 * minute, version: 3 });
});

test("daily and weekly schedules catch up once after downtime, then wait until exactly due", async () => {
  process.env.TZ = "UTC";
  const oldDue = Date.UTC(2026, 9, 19, 9);
  const daily = track({ schedule: { kind: "daily", time: "09:00" }, nextRunAt: oldDue });
  const weekly = track({
    schedule: { kind: "weekly", days: [1], time: "09:00" },
    nextRunAt: oldDue,
  });
  const returned = Date.UTC(2026, 9, 23, 12);
  await tick(returned);
  await tick(returned + minute);
  expect(messages()).toHaveLength(2);
  expect(fake.state.prompted).toHaveLength(2);
  expect(new Set(fake.state.prompted).size).toBe(2);
  const dailyDue = Date.UTC(2026, 9, 24, 9);
  expect(job(daily.id)?.nextRunAt).toBe(dailyDue);
  expect(job(weekly.id)?.nextRunAt).toBe(Date.UTC(2026, 9, 26, 9));
  await tick(dailyDue - 1);
  expect(messages()).toHaveLength(2);
  await tick(dailyDue);
  expect(messages()).toHaveLength(3);
  expect(fake.state.prompted).toHaveLength(3);
  expect(new Set(fake.state.prompted).size).toBe(3);
  expect(job(daily.id)?.nextRunAt).toBe(Date.UTC(2026, 9, 25, 9));
});
