import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { api } from "../src/api";
import { claimDue, step } from "../src/daemon";
import { type Db, openDatabase } from "../src/db";
import { OpenCode, OpenCodeError, type Turn } from "../src/opencode";
import { hasOpenRuns, listRuns, observeRuns } from "../src/runs";
import {
  dots,
  outbox,
  requests,
  responsibilities,
  responsibilityRuns,
  runWorkers,
  workers,
} from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

const minute = 60_000;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

let directory: string;
let path: string;
let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "open-dot-runs-"));
  path = join(directory, "open-dot.db");
  db = openDatabase(path);
  fake = fakeOpenCode();
  fake.state.sessions.add("ses_jojo");
  for (const name of ["jojo", "polnareff"])
    db.insert(dots)
      .values({
        name,
        directory: `/dots/${name}`,
        sessionID: `ses_${name}`,
        sessionState: "ready",
        createdAt: 0,
      })
      .run();
});

afterEach(() => {
  process.env.TZ = timeZone;
  db.$client.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Closes and reopens the database, as a daemon restart does. */
const restart = () => {
  db.$client.close();
  db = openDatabase(path);
};

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

/** One delivery pass, then one pass of the run loop. */
const pass = () =>
  Effect.runPromise(Effect.provide(Effect.andThen(step(db), observeRuns(db)), fake.layer));
const runs = () => db.select().from(responsibilityRuns).orderBy(asc(responsibilityRuns.id)).all();
const wakes = () => db.select().from(outbox).orderBy(asc(outbox.id)).all();
const shown = (responsibility: number) => listRuns(db, "jojo", responsibility).runs;
const latest = (responsibility: number) => shown(responsibility)[0];
/** OpenCode moves every admitted prompt from the inbox into a running turn. */
const deliver = () => {
  fake.state.inbox.length = 0;
};

test("a claim saves its run with the wake's ID in one transaction, and a failed save keeps neither", () => {
  const item = track();
  for (const table of ["responsibility_runs", "outbox"]) {
    db.$client.exec(`CREATE TRIGGER reject BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END`);
    expect(() => claimDue(db, 35 * minute)).toThrow("test persistence failure");
    db.$client.exec("DROP TRIGGER reject");
    expect(db.select().from(responsibilities).get()).toMatchObject({
      nextRunAt: minute,
      version: 1,
    });
    expect(wakes()).toEqual([]);
    expect(runs()).toEqual([]);
  }
  claimDue(db, 35 * minute);
  claimDue(db, 36 * minute);
  const [wake] = wakes();
  expect(wakes()).toHaveLength(1);
  expect(runs()).toEqual([
    {
      id: 1,
      dot: "jojo",
      responsibility: item.id,
      // The run keeps its own due time, though it was claimed after downtime.
      dueAt: minute,
      claimedAt: 35 * minute,
      snapshot: {
        goal: "Keep the inbox at zero",
        nextAction: "Triage new mail",
        schedule: { kind: "interval", everyMinutes: 10 },
        version: 1,
      },
      sessionID: "ses_jojo",
      messageID: wake?.messageID ?? "missing",
      turn: null,
      observedAt: null,
      waiting: false,
      outcome: null,
      error: null,
      turnEnd: null,
      endedAt: null,
      attribution: null,
      resultID: null,
      resultText: null,
    },
  ]);
  // Its snapshot stays as it was at the claim.
  db.update(responsibilities).set({ nextAction: "Archive newsletters" }).run();
  expect(latest(item.id)?.snapshot.nextAction).toBe("Triage new mail");
});

test("runs keep their DST-adjusted local due times, and catching up records one run", () => {
  process.env.TZ = "America/New_York";
  const item = track({
    schedule: { kind: "daily", time: "09:00" },
    nextRunAt: Date.UTC(2026, 2, 6, 14, 0),
  });
  // Down for a day: one catch-up run, then the next due after DST starts.
  claimDue(db, Date.UTC(2026, 2, 7, 15, 0));
  claimDue(db, Date.UTC(2026, 2, 7, 16, 0));
  claimDue(db, Date.UTC(2026, 2, 8, 13, 0));
  expect(runs().map((run) => [run.dueAt, run.claimedAt])).toEqual([
    [Date.UTC(2026, 2, 6, 14, 0), Date.UTC(2026, 2, 7, 15, 0)],
    [Date.UTC(2026, 2, 8, 13, 0), Date.UTC(2026, 2, 8, 13, 0)],
  ]);
  expect(db.select().from(responsibilities).get()?.nextRunAt).toBe(Date.UTC(2026, 2, 9, 13, 0));
  expect(shown(item.id).map((run) => run.id)).toEqual([2, 1]);
});

test("each transition survives a restart, and an idle turn is a finished turn, never success", async () => {
  const item = track();
  claimDue(db, 35 * minute);
  restart();
  expect(latest(item.id)).toMatchObject({ state: "queued", delivery: "queued" });
  fake.state.prompt = "lost";
  await pass();
  restart();
  expect(latest(item.id)).toMatchObject({ state: "queued", delivery: "sending" });
  fake.state.prompt = "ok";
  await pass();
  expect(fake.state.prompted).toHaveLength(1);
  expect(latest(item.id)).toMatchObject({ state: "admitted", delivery: "admitted" });
  expect(runs()[0]?.turn).toBe("queued");
  restart();
  expect(hasOpenRuns(db)).toBe(true);
  deliver();
  await pass();
  expect(latest(item.id)).toMatchObject({ state: "running", turn: null, result: null });
  fake.state.waiting.set("ses_jojo", [{ id: "per_1", kind: "permission", summary: "shell: rm x" }]);
  await pass();
  restart();
  expect(latest(item.id)).toMatchObject({ state: "needs-you", waiting: true });
  fake.state.waiting.clear();
  await pass();
  expect(latest(item.id)).toMatchObject({ state: "running", waiting: false });
  restart();
  const messageID = runs()[0]?.messageID ?? "missing";
  fake.state.messageTurns.set(messageID, {
    end: "idle_1",
    endedAt: 40 * minute,
    outcome: "succeeded",
    text: "Nothing new in the inbox.",
    inputs: [messageID],
    complete: true,
    reply: { id: "msg_reply", text: "Nothing new in the inbox." },
  });
  await pass();
  restart();
  expect(latest(item.id)).toMatchObject({
    state: "finished-turn",
    attribution: "exclusive",
    turn: { outcome: "succeeded", end: "idle_1", endedAt: 40 * minute, error: null },
    result: { messageID: "msg_reply", text: "Nothing new in the inbox." },
  });
  // Nothing is left to read, so a later failure changes nothing.
  expect(hasOpenRuns(db)).toBe(false);
  fake.state.readFailure = true;
  await pass();
  expect(latest(item.id)?.state).toBe("finished-turn");
});

test("a failed or interrupted turn is failed, and missing history or a deleted session is unknown", async () => {
  for (let index = 0; index < 4; index++) track({ goal: `Goal ${index}` });
  claimDue(db, 35 * minute);
  await pass();
  deliver();
  // The fourth stays running.
  const [failed, interrupted, vanished] = runs().map((run) => run.messageID);
  fake.state.messageTurns.set(failed ?? "", {
    end: "idle_f",
    outcome: "failed",
    error: "The provider is down",
    text: undefined,
    inputs: [failed ?? ""],
    complete: true,
  });
  fake.state.messageTurns.set(interrupted ?? "", {
    end: "idle_i",
    outcome: "interrupted",
    text: "Halfway.",
    inputs: [interrupted ?? ""],
    complete: true,
    reply: { id: "msg_half", text: "Halfway." },
  });
  // Admitted, then in neither the inbox nor the history.
  fake.state.messages.delete(vanished ?? "");
  await pass();
  const states = () => [1, 2, 3, 4].map((id) => latest(id));
  expect(states()).toMatchObject([
    { state: "failed", turn: { outcome: "failed", error: "The provider is down" }, result: null },
    { state: "failed", turn: { outcome: "interrupted" }, result: { text: "Halfway." } },
    { state: "unknown", turn: null, result: null },
    { state: "running" },
  ]);
  // A failed read while the session exists changes nothing; once OpenCode says it's gone, the
  // run's outcome can't be known.
  fake.state.readFailure = true;
  await pass();
  expect(latest(4)?.state).toBe("running");
  fake.state.sessions.delete("ses_jojo");
  await pass();
  expect(latest(4)?.state).toBe("unknown");
  restart();
  expect(states().map((run) => run?.state)).toEqual(["failed", "failed", "unknown", "unknown"]);
  expect(hasOpenRuns(db)).toBe(false);
});

test("concurrent runs that share a turn get no result, and each run gets only its own", async () => {
  const a = track();
  const b = track({ goal: "Ship the release", nextAction: "Tag it" });
  claimDue(db, 35 * minute);
  await pass();
  deliver();
  const [wakeA = "", wakeB = ""] = runs().map((run) => run.messageID);
  const shared = {
    end: "idle_ab",
    outcome: "succeeded" as const,
    text: "Both done.",
    inputs: [wakeA, wakeB],
    reply: { id: "msg_ab", text: "Both done." },
  };
  fake.state.messageTurns.set(wakeA, shared);
  fake.state.messageTurns.set(wakeB, shared);
  await pass();
  for (const id of [a.id, b.id])
    expect(latest(id)).toMatchObject({
      state: "finished-turn",
      attribution: "shared",
      result: null,
    });

  claimDue(db, 41 * minute);
  await pass();
  deliver();
  const [, , nextA = "", nextB = ""] = runs().map((run) => run.messageID);
  fake.state.messageTurns.set(nextA, {
    end: "idle_a",
    outcome: "succeeded",
    text: "A's answer.",
    inputs: [nextA],
    complete: true,
    reply: { id: "msg_a", text: "A's answer." },
  });
  // History that names no inputs proves nothing about whose turn it was.
  fake.state.messageTurns.set(nextB, {
    end: "idle_b",
    outcome: "succeeded",
    text: "B's answer.",
    reply: { id: "msg_b", text: "B's answer." },
  });
  await pass();
  expect(latest(a.id)).toMatchObject({ attribution: "exclusive", result: { messageID: "msg_a" } });
  expect(latest(b.id)).toMatchObject({ attribution: "unknown", result: null });
  expect(shown(a.id).every((run) => run.responsibility === a.id)).toBe(true);
  expect(shown(b.id).map((run) => run.result)).toEqual([null, null]);
});

test("a run shows its own delegated worker's delayed outcome and needs, and no other run does", async () => {
  const a = track();
  const b = track();
  claimDue(db, 35 * minute);
  await pass();
  deliver();
  for (const run of runs())
    fake.state.messageTurns.set(run.messageID, {
      end: `idle_${run.id}`,
      outcome: "succeeded",
      text: "Delegated it.",
      inputs: [run.messageID],
      complete: true,
    });
  await pass();
  const worker = db
    .insert(workers)
    .values({
      dot: "jojo",
      task: "Sort the inbox\nin detail",
      directory: "/work/jojo",
      sessionID: "ses_worker",
      state: "running",
      createdAt: 36 * minute,
    })
    .returning()
    .get();
  db.insert(runWorkers).values({ worker: worker.id, run: 1, assistantMessage: "msg_call" }).run();
  expect(latest(a.id)).toMatchObject({
    state: "finished-turn",
    workers: [
      {
        id: worker.id,
        state: "running",
        outcome: null,
        task: "Sort the inbox",
        needs: [],
        provisional: false,
      },
    ],
    withheldWorkers: 0,
  });
  db.insert(requests)
    .values({
      dot: "jojo",
      source: "worker",
      worker: worker.id,
      sessionID: "ses_worker",
      title: "Sort the inbox",
      directory: "/work/jojo",
      kind: "permission",
      requestID: "per_1",
      detail: { kind: "permission", action: "shell", resources: ["git push --force"] },
      state: "escalated",
      createdAt: 36 * minute,
    })
    .run();
  expect(latest(a.id)).toMatchObject({ state: "needs-you", workers: [{ needs: ["permission"] }] });
  expect(latest(b.id)).toMatchObject({ state: "finished-turn", workers: [] });
  // The worker finishes long after the run's turn ended. Its report is evidence, never acceptance.
  db.update(requests)
    .set({ goneAt: 50 * minute })
    .run();
  db.update(workers)
    .set({ state: "done", outcome: "succeeded", finishedAt: 90 * minute })
    .where(eq(workers.id, worker.id))
    .run();
  expect(latest(a.id)).toMatchObject({
    state: "finished-turn",
    workers: [{ state: "done", outcome: "succeeded", finishedAt: 90 * minute, needs: [] }],
  });
});

test("the owner pages a responsibility's runs with the token, and reading starts nothing", async () => {
  const item = track();
  for (let index = 0; index < 25; index++) claimDue(db, minute + index * 10 * minute);
  expect(runs()).toHaveLength(25);
  const before = { wakes: wakes(), runs: runs(), items: db.select().from(responsibilities).all() };
  const handler = api(
    db,
    "secret",
    Layer.effect(OpenCode, Effect.fail(new OpenCodeError({ message: "never connect" }))),
  );
  const call = (route: string, method = "GET", token = "secret") =>
    handler(
      new Request(`http://127.0.0.1${route}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  const route = `/dots/jojo/memory/responsibilities/${item.id}/runs`;
  const first = (await (await call(route)).json()) as {
    runs: { id: number; state: string; dueAt: number }[];
    next: number | null;
  };
  expect(first.runs.map((run) => run.id)).toEqual(
    Array.from({ length: 20 }, (_, index) => 25 - index),
  );
  expect(first.runs[0]).toMatchObject({ state: "queued", dueAt: 241 * minute });
  expect(first.next).toBe(6);
  const older = (await (await call(`${route}?before=6`)).json()) as typeof first;
  expect(older.runs.map((run) => run.id)).toEqual([5, 4, 3, 2, 1]);
  expect(older.next).toBeNull();
  expect((await call(route, "GET", "wrong")).status).toBe(401);
  // Another dot's path, an unknown responsibility and bad cursors are refused.
  expect((await call(`/dots/polnareff/memory/responsibilities/${item.id}/runs`)).status).toBe(404);
  expect((await call("/dots/jojo/memory/responsibilities/99/runs")).status).toBe(404);
  for (const query of ["?before=x", "?before=0", "?page=2", "?before=2&before=3"])
    expect((await call(`${route}${query}`)).status).toBe(400);
  for (const method of ["POST", "PATCH", "DELETE"])
    expect((await call(route, method)).status).toBe(404);
  expect((await call(`${route}/1`)).status).toBe(404);
  expect({
    wakes: wakes(),
    runs: runs(),
    items: db.select().from(responsibilities).all(),
  }).toEqual(before);
  expect(fake.state.prompted).toEqual([]);
});

const ended = (id: string, change: Partial<Turn>): Turn => ({
  end: `idle_${id}`,
  outcome: "succeeded",
  text: "An answer.",
  inputs: [id],
  reply: { id: `msg_reply_${id}`, text: "An answer." },
  ...change,
});

test("a lone wake proves a turn exclusive only when history showed the whole turn", async () => {
  for (let index = 0; index < 3; index++) track({ goal: `Goal ${index}` });
  claimDue(db, 35 * minute);
  await pass();
  deliver();
  const [bounded = "", truncated = "", shared = ""] = runs().map((run) => run.messageID);
  fake.state.messageTurns.set(bounded, ended(bounded, { complete: true }));
  // The idle before it was out of sight, or something in the turn was compacted.
  fake.state.messageTurns.set(truncated, ended(truncated, { complete: false }));
  // Another input in sight makes it shared, whatever else history showed.
  fake.state.messageTurns.set(
    shared,
    ended(shared, { complete: false, inputs: ["msg_x", shared] }),
  );
  await pass();
  expect([1, 2, 3].map((id) => latest(id))).toMatchObject([
    { attribution: "exclusive", result: { messageID: `msg_reply_${bounded}` } },
    { state: "finished-turn", attribution: "unknown", result: null },
    { state: "finished-turn", attribution: "shared", result: null },
  ]);
});

test("a worker linked while its run's turn runs is provisional, then withheld if the turn ends shared", async () => {
  const a = track();
  const b = track({ goal: "Ship the release" });
  claimDue(db, 35 * minute);
  await pass();
  deliver();
  await pass();
  const worker = (id: number) =>
    db
      .insert(workers)
      .values({
        dot: "jojo",
        task: `Task ${id}`,
        directory: "/work/jojo",
        sessionID: `ses_w${id}`,
        state: "running",
        createdAt: 36 * minute,
      })
      .returning()
      .get();
  const [runA, runB] = runs();
  const first = worker(1);
  const second = worker(2);
  db.insert(runWorkers)
    .values([
      { worker: first.id, run: runA?.id ?? 0, assistantMessage: "msg_call_a" },
      { worker: second.id, run: runB?.id ?? 0, assistantMessage: "msg_call_b" },
    ])
    .run();
  db.insert(requests)
    .values({
      dot: "jojo",
      source: "worker",
      worker: first.id,
      sessionID: first.sessionID,
      title: "Task 1",
      directory: "/work/jojo",
      kind: "question",
      requestID: "form_1",
      detail: { kind: "question", title: "Which?", fields: [] },
      state: "escalated",
      createdAt: 36 * minute,
    })
    .run();
  expect(latest(a.id)).toMatchObject({
    state: "needs-you",
    workers: [{ id: first.id, provisional: true, needs: ["question"] }],
    withheldWorkers: 0,
  });
  // After the invoking assistant message, the owner's message and the other run's wake joined
  // run A's turn; run B's turn showed only its wake but not the idle before it.
  const wakeA = runA?.messageID ?? "";
  const wakeB = runB?.messageID ?? "";
  fake.state.messageTurns.set(wakeA, {
    end: "idle_a",
    outcome: "succeeded",
    text: "Done.",
    inputs: [wakeA, "msg_owner_later", wakeB],
    complete: true,
    reply: { id: "msg_done", text: "Done." },
  });
  fake.state.messageTurns.set(wakeB, {
    end: "idle_b",
    outcome: "succeeded",
    text: "Done.",
    inputs: [wakeB],
    complete: false,
    reply: { id: "msg_done_b", text: "Done." },
  });
  await pass();
  restart();
  // No worker is presented as either run's, and the withheld worker's need moves no run.
  expect(latest(a.id)).toMatchObject({
    state: "finished-turn",
    attribution: "shared",
    workers: [],
    withheldWorkers: 1,
    result: null,
  });
  expect(latest(b.id)).toMatchObject({
    attribution: "unknown",
    workers: [],
    withheldWorkers: 1,
    result: null,
  });
});

test("a run whose wake went missing withholds its workers too", async () => {
  const item = track();
  claimDue(db, 35 * minute);
  await pass();
  deliver();
  const [run] = runs();
  const delegated = db
    .insert(workers)
    .values({
      dot: "jojo",
      task: "Task",
      directory: "/work/jojo",
      sessionID: "ses_w",
      state: "running",
      createdAt: 36 * minute,
    })
    .returning()
    .get();
  db.insert(runWorkers)
    .values({ worker: delegated.id, run: run?.id ?? 0, assistantMessage: "msg_call" })
    .run();
  fake.state.messages.delete(run?.messageID ?? "");
  await pass();
  expect(latest(item.id)).toMatchObject({ state: "unknown", workers: [], withheldWorkers: 1 });
});
