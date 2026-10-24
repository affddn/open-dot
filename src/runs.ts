import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { Effect, Exit } from "effect";
import type { Db } from "./db";
import { OpenCode, type Turn } from "./opencode";
import { needsYou } from "./requests";
import {
  outbox,
  requests,
  type ResponsibilityRun,
  responsibilityRuns,
  runWorkers,
  workers,
} from "./schema";
import { deliveryOf } from "./triggers";

/** Runs per page of `GET …/responsibilities/<id>/runs`. */
export const runPage = 20;

/** How much of a run's result is kept. */
const resultLimit = 600;

/** A run whose wake OpenCode admitted, while the daemon hasn't seen its turn end or go missing. */
const open = and(
  or(isNull(responsibilityRuns.turn), inArray(responsibilityRuns.turn, ["queued", "running"])),
  eq(outbox.state, "sent"),
);

const openRuns = (db: Db) =>
  db
    .select({ run: responsibilityRuns })
    .from(responsibilityRuns)
    .innerJoin(outbox, eq(outbox.messageID, responsibilityRuns.messageID))
    .where(open)
    .orderBy(asc(responsibilityRuns.id));

export const hasOpenRuns = (db: Db) => openRuns(db).get() !== undefined;

/**
 * Whose an ended turn was. "shared" once history showed any other input in it; "exclusive" only
 * when history showed the whole turn, from the idle before it with nothing compacted, and its one
 * input was the run's own wake; otherwise "unknown", since an earlier input may be out of sight.
 */
const attributionOf = (run: ResponsibilityRun, turn: Turn) => {
  if (turn.inputs === undefined) return "unknown" as const;
  if (turn.inputs.some((id) => id !== run.messageID)) return "shared" as const;
  return turn.complete === true && turn.inputs.length === 1
    ? ("exclusive" as const)
    : ("unknown" as const);
};

/**
 * What an ended turn says about the run. Only an exclusive turn's reply is the run's result; any
 * other keeps its outcome but no result.
 */
const endOf = (run: ResponsibilityRun, turn: Turn) => {
  const attribution = attributionOf(run, turn);
  const reply = attribution === "exclusive" ? turn.reply : undefined;
  return {
    turn: "ended" as const,
    waiting: false,
    outcome: turn.outcome,
    error: turn.error ?? null,
    turnEnd: turn.end,
    endedAt: turn.endedAt ?? null,
    attribution,
    resultID: reply?.id ?? null,
    resultText: reply ? reply.text.slice(0, resultLimit).replace(/[\uD800-\uDBFF]$/, "") : null,
  };
};

const missing = { turn: "missing" as const, waiting: false };

/**
 * Where the run's wake is now. A read that fails says nothing, unless OpenCode then says the
 * session is gone, which, like an admitted wake in neither the inbox nor the history, leaves the
 * run missing.
 */
const sighting = (run: ResponsibilityRun) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode;
    const read = yield* opencode
      .promptTurn({ sessionID: run.sessionID, messageID: run.messageID })
      .pipe(Effect.exit);
    if (Exit.isFailure(read)) {
      if (yield* opencode.sessionExists(run.sessionID)) return yield* Effect.failCause(read.cause);
      return missing;
    }
    const found = read.value;
    if (found.kind === "ended") return endOf(run, found.turn);
    if (found.kind === "absent") return missing;
    const waiting = found.kind === "running" && (yield* opencode.waiting(run.sessionID)).length > 0;
    return { turn: found.kind, waiting };
  });

/** Saves what changed since the run was read, only while it is still open. */
const observe = (db: Db, run: ResponsibilityRun) =>
  sighting(run).pipe(
    Effect.map((change) => {
      if (change.turn !== run.turn || change.waiting !== run.waiting)
        db.update(responsibilityRuns)
          .set({ ...change, observedAt: Date.now() })
          .where(
            and(
              eq(responsibilityRuns.id, run.id),
              or(
                isNull(responsibilityRuns.turn),
                inArray(responsibilityRuns.turn, ["queued", "running"]),
              ),
            ),
          )
          .run();
    }),
  );

/** One pass over every open run. One failing read doesn't stop the rest. */
export const observeRuns = (db: Db) =>
  Effect.suspend(() =>
    Effect.forEach(
      openRuns(db).all(),
      ({ run }) =>
        observe(db, run).pipe(
          Effect.catch((error) =>
            Effect.sync(() => console.error(`Scheduled run #${run.id}: ${error.message}`)),
          ),
        ),
      { discard: true },
    ),
  );

/**
 * What became of a run, from what open-dot saved: "queued" until OpenCode admits the wake,
 * "admitted", "running", "needs-you" when its turn waits on a permission or question or a worker it
 * delegated needs the owner, "finished-turn" when the turn ended, which never means the goal was
 * met, "failed" when it failed or was interrupted, and "unknown" when its outcome can't be known.
 */
const stateOf = (
  run: ResponsibilityRun,
  message: typeof outbox.$inferSelect | undefined,
  needs: boolean,
) => {
  if (!message || message.state === "cancelled") return "unknown";
  if (message.state !== "sent") return "queued";
  if (needs) return "needs-you";
  if (run.turn === "missing") return "unknown";
  if (run.turn === "ended") return run.outcome === "succeeded" ? "finished-turn" : "failed";
  return run.turn === "running" ? "running" : "admitted";
};

/**
 * How far the workers the plugin linked to the run can be trusted. A link is made only when the
 * invoking turn held nothing but the wake so far, but later input can still join that turn. So
 * links are "provisional" until the turn ends, "confirmed" once it ended exclusive, and "withheld"
 * once it ended shared or unknown, or went missing: then no worker is presented as the run's.
 */
const linkStateOf = (run: ResponsibilityRun) =>
  run.turn === "ended" && run.attribution === "exclusive"
    ? ("confirmed" as const)
    : run.turn === "ended" || run.turn === "missing"
      ? ("withheld" as const)
      : ("provisional" as const);

/** A run as the owner sees it, with the workers its own turn delegated. */
export function runView(db: Db, run: ResponsibilityRun, now = Date.now()) {
  const message = db.select().from(outbox).where(eq(outbox.messageID, run.messageID)).get();
  const links = linkStateOf(run);
  const linked = db
    .select({ worker: workers })
    .from(runWorkers)
    .innerJoin(workers, eq(workers.id, runWorkers.worker))
    .where(eq(runWorkers.run, run.id))
    .orderBy(asc(workers.id))
    .all()
    .map(({ worker }) => {
      const asked = db
        .select()
        .from(requests)
        .where(and(eq(requests.source, "worker"), eq(requests.worker, worker.id)))
        .all();
      return {
        id: worker.id,
        state: worker.state,
        outcome: worker.outcome,
        task: worker.task.split("\n")[0] ?? "",
        sessionID: worker.sessionID,
        directory: worker.directory,
        createdAt: worker.createdAt,
        finishedAt: worker.finishedAt,
        needs: [...new Set(asked.filter((row) => needsYou(row, now)).map((row) => row.kind))],
        provisional: links === "provisional",
      };
    });
  const delegated = links === "withheld" ? [] : linked;
  const needs = run.waiting || delegated.some((worker) => worker.needs.length > 0);
  return {
    id: run.id,
    responsibility: run.responsibility,
    dueAt: run.dueAt,
    claimedAt: run.claimedAt,
    snapshot: run.snapshot,
    sessionID: run.sessionID,
    messageID: run.messageID,
    state: stateOf(run, message, needs),
    delivery: deliveryOf(message),
    observedAt: run.observedAt,
    waiting: run.waiting,
    turn:
      run.turn === "ended"
        ? { outcome: run.outcome, error: run.error, end: run.turnEnd, endedAt: run.endedAt }
        : null,
    attribution: run.attribution,
    result: run.resultID === null ? null : { messageID: run.resultID, text: run.resultText ?? "" },
    workers: delegated,
    // Workers linked to the run whose turn turned out shared or unknown, so not shown as its own.
    withheldWorkers: links === "withheld" ? linked.length : 0,
  };
}

/**
 * A page of a responsibility's runs, newest first by ID, older than `before` when given. `next`,
 * when there may be more, is the `before` of the next older page. It only reads.
 */
export function listRuns(db: Db, dot: string, responsibility: number, before?: number) {
  const page = db
    .select()
    .from(responsibilityRuns)
    .where(
      and(
        eq(responsibilityRuns.dot, dot),
        eq(responsibilityRuns.responsibility, responsibility),
        before === undefined ? undefined : lt(responsibilityRuns.id, before),
      ),
    )
    .orderBy(desc(responsibilityRuns.id))
    .limit(runPage)
    .all();
  const now = Date.now();
  return {
    runs: page.map((run) => runView(db, run, now)),
    next: page.length === runPage ? (page.at(-1)?.id ?? null) : null,
  };
}
