import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { arms, type Fixture, fixtureHash, measure, summarizeImport } from "../measure/run";

const path = join(import.meta.dir, "..", "measure", "synthetic.json");
const text = readFileSync(path, "utf8");
const fixture = JSON.parse(text) as Fixture;
const hash = fixtureHash(text);

test("the shipped fixture is synthetic, with 30 to 50 questions that each name a source", () => {
  expect(fixture.synthetic).toBe(true);
  expect(fixture.questions.length).toBeGreaterThanOrEqual(30);
  expect(fixture.questions.length).toBeLessThanOrEqual(50);
  const ids = new Set(fixture.messages.map((message) => message.id));
  for (const question of fixture.questions) expect(ids.has(question.source)).toBe(true);
  expect(fixture.questions.some((question) => question.paraphrase)).toBe(true);
  expect(fixture.summary).toContain("synthetic");
});

test("the harness scores every arm with the plugin's own composition, and today counts the summary", () => {
  const report = measure(fixture);
  expect(report.questions).toBe(fixture.questions.length);
  const all = arms.map((arm) => report.scores[arm].all ?? 0);
  // Each arm adds to the one before, so it never scores lower.
  expect(all).toEqual(all.toSorted((a, b) => a - b));
  // Facts in the frozen summary are found today; nothing else old is.
  expect(report.scores.today.all).toBeGreaterThan(0);
  expect(report.scores.today.all).toBeLessThan(0.2);
  expect(report.scores["b+d1+d3"].all).toBeGreaterThan(report.scores["b+d1"].all ?? 1);
  expect(() => measure({ ...fixture, questions: fixture.questions.slice(0, 10) })).toThrow();
});

test("an import must match the fixture and its four arms, and missing metrics stay missing", () => {
  const step = { answerScore: 1, cachedTokens: 10, uncachedTokens: 90 };
  const full = Object.fromEntries(
    arms.map((arm) => [
      arm,
      Object.fromEntries(fixture.questions.map((q) => [q.id, { steps: [step] }])),
    ]),
  );
  const summary = summarizeImport(fixture, hash, { fixtureSHA256: hash, arms: full });
  expect(summary.today).toMatchObject({
    answerScore: 1,
    scoredSteps: fixture.questions.length,
    cachedTokens: 10 * fixture.questions.length,
    missingScores: 0,
  });
  // Only one question answered, without counters: the rest are missing, never invented.
  const sparse = Object.fromEntries(
    arms.map((arm) => [arm, { q01: { steps: [{ answerScore: 0.5 }] } }]),
  );
  expect(summarizeImport(fixture, hash, { fixtureSHA256: hash, arms: sparse }).b).toMatchObject({
    answerScore: 0.5,
    missingScores: fixture.questions.length - 1,
    cachedTokens: "unavailable",
    uncachedTokens: "unavailable",
    missingCounters: fixture.questions.length,
  });
  expect(() => summarizeImport(fixture, hash, { fixtureSHA256: "other", arms: full })).toThrow();
  const { today: _today, ...three } = full;
  expect(() => summarizeImport(fixture, hash, { fixtureSHA256: hash, arms: three })).toThrow();
  expect(() =>
    summarizeImport(fixture, hash, {
      fixtureSHA256: hash,
      arms: { ...full, b: { q99: { steps: [step] } } },
    }),
  ).toThrow();
  expect(() =>
    summarizeImport(fixture, hash, {
      fixtureSHA256: hash,
      arms: { ...full, b: { q01: { steps: [{ answerScore: 2 }] } } },
    }),
  ).toThrow();
});

test("the command refuses a live run and an unmarked fixture", async () => {
  const run = join(import.meta.dir, "..", "measure", "run.ts");
  expect(Bun.spawnSync(["bun", run, "--live"]).exitCode).toBe(2);
  const unmarked = join(
    process.env.TMPDIR ?? "/tmp",
    `open-dot-measure-${process.pid}-${Date.now()}.json`,
  );
  await Bun.write(unmarked, JSON.stringify({ ...fixture, synthetic: false }));
  expect(Bun.spawnSync(["bun", run, "--fixture", unmarked]).exitCode).toBe(2);
});

test("an import keeps every step's own counters and the plain change in cached tokens", () => {
  const steps = [
    { answerScore: 1, cachedTokens: 0, uncachedTokens: 1_000 },
    { cachedTokens: 1_000, uncachedTokens: 200 },
    { cachedTokens: 300, uncachedTokens: 1_100 },
    // No counters: kept as unavailable, and the next step has nothing to compare with.
    {},
    { cachedTokens: 50, uncachedTokens: 10 },
  ];
  const arm = { q01: { steps } };
  const summary = summarizeImport(fixture, hash, {
    fixtureSHA256: hash,
    arms: Object.fromEntries(arms.map((name) => [name, arm])),
  });
  expect(summary.today).toMatchObject({
    cachedTokens: 1_350,
    uncachedTokens: 2_310,
    // The step without counters, and every other question, which has no steps.
    missingCounters: fixture.questions.length,
    steps: [
      {
        question: "q01",
        step: 1,
        cachedTokens: 0,
        uncachedTokens: 1_000,
        cachedDelta: "unavailable",
      },
      { question: "q01", step: 2, cachedTokens: 1_000, uncachedTokens: 200, cachedDelta: 1_000 },
      { question: "q01", step: 3, cachedTokens: 300, uncachedTokens: 1_100, cachedDelta: -700 },
      {
        question: "q01",
        step: 4,
        cachedTokens: "unavailable",
        uncachedTokens: "unavailable",
        cachedDelta: "unavailable",
      },
      {
        question: "q01",
        step: 5,
        cachedTokens: 50,
        uncachedTokens: 10,
        cachedDelta: "unavailable",
      },
    ],
  });
  // Nothing classifies a step as a cache break.
  expect(JSON.stringify(summary)).not.toMatch(/break|shortfall/i);
});
