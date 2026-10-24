#!/usr/bin/env bun
/**
 * Offline recall measurement for issue #42. For each question it builds what a dot would see,
 * with the same functions the plugin uses (`composeTurn` for the checkpoint, notes and tail, and
 * `recallResults` for dot_recall), in four arms:
 *
 * - today: the fixture's frozen compaction summary and the verbatim tail after it;
 * - b: plus a dot_recall search for the question's three longest uncommon words;
 * - b+d1: plus automatic recall;
 * - b+d1+d3: plus the ledger and its frozen checkpoint.
 *
 * It scores retrieval: whether the answer or its source message is in that view. It calls no
 * model, no OpenCode and no network, and reads the fixture into an in-memory database.
 *
 *   bun measure/run.ts [--fixture <path>] [--private] [--import <scores.json>] [--details]
 *
 * A fixture must say `"synthetic": true` unless `--private` is given for an owner's own fixture of
 * real early facts, which is never committed. `--import` adds answer scores and provider token
 * counts measured elsewhere, per arm, question and step; there is no live mode here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autoRecallWords, saveArchiveSettings } from "../src/archive";
import { type ContextItem, composeTurn, recallResults } from "../src/compose";
import { openDatabase } from "../src/db";
import { settleHead } from "../src/ledger";
import { archive, dots, ledger } from "../src/schema";

export interface Fixture {
  readonly synthetic?: boolean;
  readonly dot: string;
  readonly sessionID: string;
  /** How many of the newest messages stay verbatim after compaction. */
  readonly visibleTail: number;
  /** The text compaction's summary the model sees today, frozen in the fixture. */
  readonly summary?: string;
  readonly messages: readonly { id: string; role: "owner" | "dot"; text: string; time: number }[];
  readonly questions: readonly {
    id: string;
    question: string;
    answer: string;
    source: string;
    paraphrase?: boolean;
  }[];
  /** Observed rows, as an observer might have written them, for the checkpoint arm. */
  readonly ledger: readonly {
    kind: "decision" | "preference" | "commitment" | "fact" | "question";
    topic: string;
    text: string;
    priority: number;
    sources: string[];
  }[];
}

export const arms = ["today", "b", "b+d1", "b+d1+d3"] as const;
type Arm = (typeof arms)[number];

const switches: Record<Arm, Parameters<typeof saveArchiveSettings>[2]> = {
  today: { archive: false, autoRecall: false, ledger: false, frozenHead: false },
  b: { archive: true, autoRecall: false, ledger: false, frozenHead: false },
  "b+d1": { archive: true, autoRecall: true, ledger: false, frozenHead: false },
  "b+d1+d3": { archive: true, autoRecall: true, ledger: true, frozenHead: true },
};

const compactionID = "msg_measure_compaction";

/** The fixture's SHA-256, which an import must name, so scores can't be matched to another set. */
export const fixtureHash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Scores every question in every arm; `addedTokensEstimate` is each arm's added bytes over 4. */
export function measure(fixture: Fixture) {
  if (fixture.questions.length < 30 || fixture.questions.length > 50)
    throw new Error("A measurement set has 30 to 50 questions.");
  const db = openDatabase(":memory:");
  try {
    db.insert(dots)
      .values({
        name: fixture.dot,
        directory: `/measure/${fixture.dot}`,
        sessionID: fixture.sessionID,
        sessionState: "ready",
        createdAt: 0,
      })
      .run();
    for (const message of fixture.messages)
      db.insert(archive)
        .values({
          dot: fixture.dot,
          sessionID: fixture.sessionID,
          messageID: message.id,
          role: message.role,
          text: message.text,
          createdAt: message.time,
          archivedAt: 0,
        })
        .run();
    for (const row of fixture.ledger)
      db.insert(ledger)
        .values({
          dot: fixture.dot,
          sessionID: fixture.sessionID,
          ...row,
          validFrom: 0,
          updatedBy: "observer",
          createdAt: 0,
          updatedAt: 0,
        })
        .run();
    const dot = db.select().from(dots).get();
    if (!dot) throw new Error("No dot.");
    const tail = fixture.messages.slice(-fixture.visibleTail);
    const today = `${fixture.summary ?? ""}\n${tail.map((message) => message.text).join("\n")}`;
    const results = fixture.questions.map((question) => ({
      id: question.id,
      paraphrase: question.paraphrase === true,
      today: false,
      b: false,
      "b+d1": false,
      "b+d1+d3": false,
    }));
    const bytes: Record<Arm, number> = { today: 0, b: 0, "b+d1": 0, "b+d1+d3": 0 };
    for (const arm of arms) {
      saveArchiveSettings(db, fixture.dot, switches[arm], 0);
      // The checkpoint for the text compaction the context starts from, as the daemon sets it.
      // A new intent ID for each arm: only a newer intent sets a checkpoint.
      settleHead(db, {
        id: arms.indexOf(arm) + 1,
        dot: fixture.dot,
        sessionID: fixture.sessionID,
        trigger: compactionID,
        native: false,
      });
      fixture.questions.forEach((question, at) => {
        const items: ContextItem[] = [
          { id: compactionID, type: "compaction", status: "completed" },
          ...tail.map((message) => ({
            id: message.id,
            type: message.role === "owner" ? "user" : "assistant",
            text: message.text,
          })),
          { id: `msg_question_${question.id}`, type: "user", text: question.question },
        ];
        const composed = composeTurn(db, dot, items);
        const searched =
          arm === "today"
            ? undefined
            : recallResults(db, dot, autoRecallWords(question.question).slice(0, 3), 8, 0, true);
        const found = searched && !("invalid" in searched) ? JSON.stringify(searched.results) : "";
        const added = `${composed.head?.text ?? ""}\n${found}\n${composed.tail}`;
        const view = `${today}\n${added}`;
        bytes[arm] += Buffer.byteLength(added);
        const result = results[at];
        if (result)
          result[arm] =
            view.toLowerCase().includes(question.answer.toLowerCase()) ||
            view.includes(question.source);
      });
    }
    const score = (arm: Arm, paraphrases: boolean) => {
      const list = results.filter((result) => !paraphrases || result.paraphrase);
      return list.length ? list.filter((result) => result[arm]).length / list.length : null;
    };
    const summary = (arm: Arm) => ({
      all: score(arm, false),
      paraphrases: score(arm, true),
      addedTokensEstimate: Math.round(bytes[arm] / 4 / results.length),
    });
    return {
      synthetic: fixture.synthetic === true,
      questions: results.length,
      metric:
        "retrieval: the answer or its source message is in what the dot would see; not answer accuracy",
      scores: {
        today: summary("today"),
        b: summary("b"),
        "b+d1": summary("b+d1"),
        "b+d1+d3": summary("b+d1+d3"),
      },
      results,
    };
  } finally {
    db.$client.close();
  }
}

const whole = (value: unknown) =>
  value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

export interface Imported {
  readonly fixtureSHA256: string;
  readonly arms: Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          {
            readonly steps: readonly {
              readonly answerScore?: number;
              readonly cachedTokens?: number;
              readonly uncachedTokens?: number;
            }[];
          }
        >
      >
    >
  >;
}

/**
 * Summarizes imported per-step answer scores and provider token counts, measured by a live run
 * elsewhere, keeping every step's provider counters as given, and each step's change in cached
 * tokens from the step before. It doesn't say why a count changed: provider minimums, cache
 * boundaries, expiry and changed input all move it. The import must name this fixture's SHA-256, have exactly the four arms and only
 * this fixture's questions; scores are 0 to 1 and counts whole numbers. A question or metric it
 * lacks is counted as missing, never filled in.
 */
export function summarizeImport(fixture: Fixture, hash: string, imported: Imported) {
  if (imported.fixtureSHA256 !== hash) throw new Error("The import is for another fixture.");
  const names = Object.keys(imported.arms ?? {});
  if (names.length !== arms.length || !arms.every((arm) => names.includes(arm)))
    throw new Error(`The import must have exactly the arms ${arms.join(", ")}.`);
  const ids = new Set(fixture.questions.map((question) => question.id));
  return Object.fromEntries(
    arms.map((arm) => {
      const byQuestion = imported.arms[arm] ?? {};
      const unknown = Object.keys(byQuestion).filter((id) => !ids.has(id));
      if (unknown.length)
        throw new Error(`${arm} has questions not in the fixture: ${unknown.join(", ")}.`);
      const scores: number[] = [];
      let cached: number | undefined;
      let uncached: number | undefined;
      let missingScores = 0;
      let missingCounters = 0;
      // Every step's own counters, as imported, and how its cached tokens moved from the step
      // before: a plain difference, not a diagnosis of why.
      const perStep: {
        question: string;
        step: number;
        cachedTokens: number | "unavailable";
        uncachedTokens: number | "unavailable";
        cachedDelta: number | "unavailable";
      }[] = [];
      for (const id of ids) {
        const steps = byQuestion[id]?.steps;
        if (!Array.isArray(steps) || !steps.length) {
          missingScores++;
          missingCounters++;
          continue;
        }
        let previous: { cached: number; uncached: number } | undefined;
        for (const [at, step] of steps.entries()) {
          const { answerScore, cachedTokens, uncachedTokens } = step;
          if (
            answerScore !== undefined &&
            !(typeof answerScore === "number" && answerScore >= 0 && answerScore <= 1)
          )
            throw new Error(`${arm} ${id} has an answer score outside 0 to 1.`);
          if (!whole(cachedTokens) || !whole(uncachedTokens))
            throw new Error(`${arm} ${id} has a token count that isn't a whole number.`);
          if (answerScore === undefined) missingScores++;
          else scores.push(answerScore);
          const counted = cachedTokens !== undefined && uncachedTokens !== undefined;
          perStep.push({
            question: id,
            step: at + 1,
            cachedTokens: cachedTokens ?? "unavailable",
            uncachedTokens: uncachedTokens ?? "unavailable",
            cachedDelta: counted && previous ? cachedTokens - previous.cached : "unavailable",
          });
          if (!counted) {
            missingCounters++;
            previous = undefined;
          } else {
            cached = (cached ?? 0) + cachedTokens;
            uncached = (uncached ?? 0) + uncachedTokens;
            previous = { cached: cachedTokens, uncached: uncachedTokens };
          }
        }
      }
      return [
        arm,
        {
          answerScore: scores.length
            ? scores.reduce((total, each) => total + each, 0) / scores.length
            : "unavailable",
          scoredSteps: scores.length,
          missingScores,
          cachedTokens: cached ?? "unavailable",
          uncachedTokens: uncached ?? "unavailable",
          missingCounters,
          steps: perStep,
        },
      ];
    }),
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--live")) {
    console.error(
      "There is no live mode. Measure live elsewhere and pass the results with --import.",
    );
    process.exit(2);
  }
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const path = option("--fixture") ?? join(import.meta.dir, "synthetic.json");
  const text = readFileSync(path, "utf8");
  const fixture: Fixture = JSON.parse(text);
  if (fixture.synthetic !== true && !args.includes("--private")) {
    console.error(
      "This fixture isn't marked synthetic. Pass --private for your own private fixture.",
    );
    process.exit(2);
  }
  const { results, ...summary } = measure(fixture);
  const hash = fixtureHash(text);
  const scores = option("--import");
  const report = {
    ...summary,
    fixtureSHA256: hash,
    imported: scores
      ? summarizeImport(fixture, hash, JSON.parse(readFileSync(scores, "utf8")))
      : "none: answer scores and provider cached/uncached tokens are unavailable without --import",
  };
  console.log(
    JSON.stringify(args.includes("--details") ? { ...report, results } : report, null, 2),
  );
}
