import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { answerAll } from "../src/daemon";
import { openDatabase } from "../src/db";
import { OpenCode, type Waiting } from "../src/opencode";
import { dots, outbox, requests, workers } from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

for (const phase of ["pending", "snapshot", "send"] as const) {
  test(`a ${phase} timeout has an exact boundary and never replays the answer`, async () => {
    const db = openDatabase(":memory:");
    const fake = fakeOpenCode();
    const sessionID = `ses_timeout_${phase}`;
    const coordinatorID = `ses_dot_${phase}`;
    const detail = { kind: "permission" as const, action: "shell", resources: ["bun test"] };
    const pending: Waiting = {
      id: "per_timeout",
      kind: "permission",
      summary: "shell: bun test",
      detail,
      sensitive: false,
    };
    db.insert(dots)
      .values({
        name: "clock",
        directory: "/fixture/dot",
        sessionID: coordinatorID,
        sessionState: "ready",
        createdAt: 0,
      })
      .run();
    if (phase !== "snapshot") {
      db.insert(workers)
        .values({
          id: 1,
          dot: "clock",
          directory: "/fixture/worker",
          sessionID,
          state: "running",
          task: "Fake timeout",
          createdAt: 0,
        })
        .run();
    }
    db.insert(requests)
      .values({
        dot: "clock",
        source: phase === "snapshot" ? "threads" : "worker",
        worker: phase === "snapshot" ? null : 1,
        sessionID,
        title: "Fake timeout",
        directory: "/fixture/worker",
        kind: "permission",
        requestID: pending.id,
        detail,
        state: "queued",
        answer: { decision: "once" },
        actorSession: coordinatorID,
        queuedAt: Date.now(),
        createdAt: Date.now(),
      })
      .run();
    const row = () => {
      const found = db.select().from(requests).get();
      if (!found) throw new Error("Missing timeout fixture request");
      return found;
    };
    const calls: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* OpenCode;
        const bounded = answerAll(db).pipe(
          Effect.provideService(OpenCode, {
            ...service,
            waiting: () =>
              Effect.sync(() => calls.push("pending")).pipe(
                Effect.andThen(phase === "pending" ? Effect.never : Effect.succeed([pending])),
              ),
            threadsWorkers: () =>
              Effect.sync(() => calls.push("snapshot")).pipe(Effect.andThen(Effect.never)),
            answer: () => Effect.sync(() => calls.push("send")).pipe(Effect.andThen(Effect.never)),
          }),
        );
        const fiber = yield* bounded.pipe(Effect.forkChild);
        const limit = phase === "send" ? 30_000 : 10_000;
        yield* TestClock.adjust(limit - 1);
        expect(row().state).toBe(phase === "send" ? "answering" : "queued");
        expect(row().confirmedAt).toBeNull();
        expect(db.select().from(outbox).all()).toHaveLength(0);
        if (phase === "send") expect(row().attemptedAt).toBeNumber();
        else expect(row().attemptedAt).toBeNull();
        yield* TestClock.adjust(1);
        yield* Fiber.join(fiber);
        expect(row().state).toBe(phase === "send" ? "unknown" : "escalated");
        expect(row().confirmedAt).toBeNull();
        if (phase === "pending")
          expect(row().reason).toContain("couldn't read what the worker waits on");
        if (phase === "snapshot")
          expect(row().reason).toBe("Threads couldn't confirm it is the dot's worker.");
        if (phase === "send")
          expect(row().reason).toBe("OpenCode didn't confirm it got the dot's answer.");
        expect(db.select().from(outbox).all()).toHaveLength(1);
        expect(db.select().from(outbox).get()?.route).toBeNull();
        yield* bounded;
        yield* bounded;
        yield* TestClock.adjust("1 hour");
        expect(db.select().from(outbox).all()).toHaveLength(1);
        expect(calls).toEqual(phase === "pending" ? ["pending"] : ["pending", phase]);
        expect(row().state).toBe(phase === "send" ? "unknown" : "escalated");
      }).pipe(Effect.provide(fake.layer), Effect.provide(TestClock.layer())),
    );
  });
}
