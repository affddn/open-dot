import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { daemonLoops, queuedLimitMs } from "../src/daemon";
import { type Db, openDatabase } from "../src/db";
import { OpenCode, OpenCodeError } from "../src/opencode";
import { graceMs } from "../src/requests";
import { dots, outbox, requests, workers } from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;
let sent: string[];

const detail = { kind: "permission" as const, action: "shell", resources: ["bun test"] };

beforeEach(() => {
  db = openDatabase(":memory:");
  fake = fakeOpenCode();
  sent = [];
  db.insert(dots)
    .values({
      name: "jojo",
      directory: "/dots/jojo",
      sessionID: "ses_jojo",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
  for (const id of [1, 2])
    db.insert(workers)
      .values({
        id,
        dot: "jojo",
        task: `Task ${id}`,
        directory: `/work/${id}`,
        sessionID: `ses_w${id}`,
        state: "running",
        promptID: `msg_task${id}`,
        createdAt: 0,
      })
      .run();
  // Worker 1 has an answer queued; worker 2 a request nobody answered for over two minutes.
  const base = {
    dot: "jojo",
    source: "worker" as const,
    title: "Task",
    kind: "permission" as const,
    detail,
  };
  db.insert(requests)
    .values([
      {
        ...base,
        worker: 1,
        sessionID: "ses_w1",
        directory: "/work/1",
        requestID: "per_1",
        state: "queued",
        answer: { decision: "once" },
        actorSession: "ses_jojo",
        queuedAt: Date.now(),
        createdAt: Date.now(),
      },
      {
        ...base,
        worker: 2,
        sessionID: "ses_w2",
        directory: "/work/2",
        requestID: "per_2",
        state: "open",
        createdAt: Date.now() - graceMs - 1,
      },
    ])
    .run();
  fake.state.waiting.set("ses_w1", [
    { id: "per_1", kind: "permission", summary: "shell: bun test" },
  ]);
  fake.state.waiting.set("ses_w2", [
    { id: "per_2", kind: "permission", summary: "shell: bun test" },
  ]);
});

const service = () =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* OpenCode;
    }).pipe(Effect.provide(fake.layer)),
  );

/** The fake OpenCode with some calls replaced; every answer it's asked to send is recorded. */
const opencode = (change: Partial<ReturnType<typeof service>>) => {
  const base = service();
  return Layer.succeed(OpenCode, {
    ...base,
    answer: (...args) =>
      Effect.sync(() => sent.push(args[2])).pipe(Effect.andThen(base.answer(...args))),
    ...change,
  });
};

const row = (id: number) => db.select().from(requests).where(eq(requests.id, id)).get();
const ownerMessages = () =>
  db
    .select()
    .from(outbox)
    .all()
    .filter((message) => message.text.startsWith("Needs your owner"));

/** Runs the daemon's real loops under a test clock for `seconds`, then stops them. */
const runFor = (
  layer: Layer.Layer<OpenCode, OpenCodeError>,
  seconds: number,
  between?: () => void,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const loops = yield* daemonLoops(db, layer).pipe(Effect.forkChild);
      for (let second = 0; second < seconds; second++) {
        yield* TestClock.adjust("1 second");
        between?.();
      }
      yield* Fiber.interrupt(loops);
    }).pipe(Effect.provide(TestClock.layer())),
  );

test("a worker pass stuck on running sessions holds up neither answers nor the owner's grace", async () => {
  await runFor(opencode({ activeSessions: Effect.never }), 3);
  expect(sent).toEqual(["per_1"]);
  expect(row(1)).toMatchObject({ state: "answered" });
  expect(row(2)).toMatchObject({ state: "escalated" });
  expect(ownerMessages()).toHaveLength(1);
});

test("running sessions failing every pass and a pending list that never answers end with the owner, once, and nothing sent", async () => {
  await runFor(
    opencode({
      activeSessions: Effect.fail(new OpenCodeError({ message: "down" })),
      waiting: () => Effect.never,
    }),
    15,
  );
  expect(sent).toEqual([]);
  expect(row(1)).toMatchObject({ state: "escalated", attemptedAt: null });
  expect(row(1)?.reason).toContain("couldn't read what the worker waits on");
  expect(row(2)?.state).toBe("escalated");
  expect(ownerMessages()).toHaveLength(2);
  await runFor(opencode({ waiting: () => Effect.never }), 60);
  expect(sent).toEqual([]);
  expect(ownerMessages()).toHaveLength(2);
});

test("with OpenCode not found at all, the grace period, a stale queue and a lost attempt still reach the owner", async () => {
  db.update(requests)
    .set({ queuedAt: Date.now() - queuedLimitMs - 1 })
    .where(eq(requests.id, 1))
    .run();
  db.insert(requests)
    .values({
      dot: "jojo",
      source: "worker",
      worker: 1,
      sessionID: "ses_w1",
      title: "Task",
      directory: "/work/1",
      kind: "question",
      requestID: "frm_1",
      detail: { kind: "question", title: "Which?", fields: [] },
      state: "answering",
      answer: { decision: "cancel" },
      actorSession: "ses_jojo",
      attemptedAt: 1,
      createdAt: 1,
    })
    .run();
  const missing = Layer.effect(
    OpenCode,
    Effect.fail(new OpenCodeError({ message: "OpenCode is not running." })),
  );
  await runFor(missing, 2);
  expect(row(1)).toMatchObject({ state: "escalated", attemptedAt: null });
  expect(row(2)?.state).toBe("escalated");
  expect(row(3)?.state).toBe("unknown");
  expect(ownerMessages()).toHaveLength(3);
  await runFor(missing, 5);
  expect(ownerMessages()).toHaveLength(3);
});

test("an admission hanging inside the session's gate makes the answer wait, then go to the owner unsent", async () => {
  db.insert(outbox)
    .values({
      sessionID: "ses_w1",
      messageID: "msg_hung",
      text: "Hi",
      state: "pending",
      createdAt: 1,
    })
    .run();
  const layer = opencode({ prompt: () => Effect.never });
  await runFor(layer, 5, () => {});
  expect(sent).toEqual([]);
  expect(row(1)?.state).toBe("queued");
  db.update(requests)
    .set({ queuedAt: Date.now() - queuedLimitMs - 1 })
    .where(eq(requests.id, 1))
    .run();
  await runFor(layer, 3);
  expect(sent).toEqual([]);
  expect(row(1)).toMatchObject({ state: "escalated", attemptedAt: null });
});

test("an answer still being sent is never marked unknown by the settling loop", async () => {
  const base = service();
  const slow = opencode({
    answer: (...args) =>
      Effect.sync(() => sent.push(args[2])).pipe(
        Effect.andThen(Effect.sleep("20 seconds")),
        Effect.andThen(base.answer(...args)),
      ),
  });
  await runFor(slow, 25, () => {
    const state = row(1)?.state;
    if (state === "unknown") throw new Error("marked unknown while in flight");
  });
  expect(sent).toEqual(["per_1"]);
  expect(row(1)?.state).toBe("answered");
});
