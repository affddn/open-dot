import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Effect, Exit, Layer } from "effect";
import { archiveAll, saveArchiveSettings, settingsOf } from "../src/archive";
import { type Db, openDatabase } from "../src/db";
import { observerDirectory } from "../src/home";
import {
  applyJob,
  buildHead,
  editObservation,
  forgetObservation,
  headBytes,
  headFor,
  parseOps,
  sinceCheckpoint,
  stateOf,
} from "../src/ledger";
import {
  dayStart,
  maxCallsPerChunk,
  observePass,
  observerPrompt,
  observerStatus,
  observerWork,
  tokenJobChars,
} from "../src/observer";
import {
  compactionPageLimit,
  type HistoryItem,
  latestCompleted,
  OpenCode,
  OpenCodeError,
  sumUsage,
  type Usage,
  usagePageLimit,
} from "../src/opencode";

type Service = OpenCode["Service"];
import { archive, dots, ledger, ledgerState, type ObserverJob, observerJobs } from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;

const addDot = (name: string) =>
  db
    .insert(dots)
    .values({
      name,
      directory: `/dots/${name}`,
      sessionID: `ses_${name}`,
      sessionState: "ready",
      createdAt: 0,
    })
    .run();

beforeEach(() => {
  process.env.OPEN_DOT_HOME = mkdtempSync(join(tmpdir(), "open-dot-observer-"));
  db = openDatabase(":memory:");
  fake = fakeOpenCode();
  addDot("jojo");
});

const observerOn = (dot = "jojo", extra: Parameters<typeof saveArchiveSettings>[2] = {}) =>
  saveArchiveSettings(
    db,
    dot,
    {
      archive: true,
      observer: true,
      ledger: true,
      observerModel: "fake/observer-1",
      observerDailyTokens: 2_000_000,
      ...extra,
    },
    1,
  );

let counter = 0;
const message = (text: string, dot = "jojo", role: "owner" | "dot" = "owner") => {
  const messageID = `msg_${dot}_${++counter}`;
  db.insert(archive)
    .values({
      dot,
      sessionID: `ses_${dot}`,
      messageID,
      role,
      text,
      createdAt: 1_000 + counter,
      archivedAt: 1,
    })
    .run();
  return messageID;
};

/** Enough archived text to queue one token job. */
const enough = (dot = "jojo") => {
  const first = message(
    `We decided the Lisbon offsite budget is 40k. ${"x".repeat(tokenJobChars)}`,
    dot,
  );
  const second = message("Noted, 40k for Lisbon.", dot, "dot");
  return [first, second];
};

/** Answers each observer prompt with `answer` when its turn ends. */
const answering = (answer: () => string) => {
  fake.state.onPrompt = (messageID) =>
    fake.state.messageTurns.set(messageID, { outcome: "succeeded", text: answer(), end: "idle" });
};

const work = () => observerWork(db, Date.now());
const pass = () => Effect.runPromise(Effect.provide(observePass(db), fake.layer));
const jobs = () => db.select().from(observerJobs).orderBy(observerJobs.id).all();
const rows = () => db.select().from(ledger).orderBy(ledger.id).all();

test("with the observer off nothing is queued, read or sent, whatever the archive holds", async () => {
  saveArchiveSettings(db, "jojo", { archive: true, ledger: true, observerModel: "fake/m" }, 1);
  enough();
  expect(work()).toBe(false);
  expect(jobs()).toEqual([]);
  await pass();
  expect(fake.state.scratches).toEqual([]);
  expect(fake.state.prompted).toEqual([]);
  // Without a model the observer can't run either.
  saveArchiveSettings(db, "jojo", { observer: true, observerModel: null }, 2);
  expect(work()).toBe(false);
  expect(jobs()).toEqual([]);
});

test("a job saves its IDs before each call, runs in a scratch session, and adds, updates and supersedes rows", async () => {
  observerOn();
  const [first, second] = enough();
  expect(work()).toBe(true);
  // Queued jobs claim nothing until they start.
  expect(jobs()).toMatchObject([{ kind: "tokens", state: "queued", fromID: 0, toID: 0 }]);
  // The next growth needs another 20k tokens: nothing more is queued yet.
  work();
  expect(jobs()).toHaveLength(1);

  let savedFirst: unknown;
  fake.state.onScratch = () => {
    savedFirst = db.select().from(observerJobs).get();
  };
  answering(() =>
    JSON.stringify({
      ops: [
        {
          op: "add",
          kind: "decision",
          topic: "Lisbon offsite",
          text: "The Lisbon offsite budget is 40k.",
          priority: 1,
          sources: [first, second, "msg_made_up"],
        },
        { op: "add", kind: "fact", topic: "x", text: "No sources.", priority: 2, sources: [] },
        { op: "delete", id: 1 },
      ],
    }),
  );
  await pass();
  const [job] = jobs();
  const scratch = job?.scratchSession ?? "missing";
  expect(savedFirst).toMatchObject({
    state: "started",
    scratchSession: job?.scratchSession,
    promptMessage: job?.promptMessage,
    model: "fake/observer-1",
  });
  expect(fake.state.scratches).toEqual([
    {
      id: scratch,
      directory: observerDirectory("jojo"),
      title: expect.stringContaining("observer"),
      model: "fake/observer-1",
    },
  ]);
  // The prompt went only to the scratch session, never the dot's.
  expect(fake.state.texts.map((each) => each.sessionID)).toEqual([scratch]);
  expect(fake.state.texts[0]?.text).toContain("<archived-messages>");
  expect(job?.state).toBe("running");

  await pass();
  expect(jobs()[0]?.state).toBe("done");
  expect(rows()).toMatchObject([
    {
      kind: "decision",
      text: "The Lisbon offsite budget is 40k.",
      sources: [first, second],
      updatedBy: "observer",
      supersededBy: null,
    },
  ]);

  // A second job refines and then replaces the row.
  message(`Budget moved to 45k. ${"y".repeat(tokenJobChars)}`);
  work();
  answering(() =>
    JSON.stringify({
      ops: [
        { op: "update", id: 1, priority: 2 },
        {
          op: "supersede",
          id: 1,
          kind: "decision",
          topic: "Lisbon offsite",
          text: "The Lisbon offsite budget is 45k.",
          priority: 1,
          sources: [first],
        },
      ],
    }),
  );
  await pass();
  await pass();
  expect(
    rows().map(({ id, text, supersededBy, priority }) => ({ id, text, supersededBy, priority })),
  ).toEqual([
    { id: 1, text: "The Lisbon offsite budget is 40k.", supersededBy: 2, priority: 2 },
    { id: 2, text: "The Lisbon offsite budget is 45k.", supersededBy: null, priority: 1 },
  ]);
});

test("lost outcomes are looked up by ID and never sent again", async () => {
  observerOn();
  enough();
  work();
  // Creation failed and the session isn't there: failed, no prompt.
  fake.state.scratch = "fail";
  await pass();
  expect(jobs()[0]).toMatchObject({ state: "failed" });
  expect(fake.state.prompted).toEqual([]);

  // A lost prompt that OpenCode has is running; one it can't confirm is unknown.
  for (const [mode, lookup, expected] of [
    ["lost", false, "running"],
    ["fail", false, "failed"],
    ["fail", true, "unknown"],
  ] as const) {
    fake.state.scratch = "ok";
    fake.state.prompt = mode;
    fake.state.lookupFailure = lookup;
    message(`More. ${"z".repeat(tokenJobChars)}`);
    work();
    await pass();
    expect(jobs().at(-1)?.state).toBe(expected);
    // The dot runs one job at a time; let the next one start.
    db.update(observerJobs).set({ state: "done" }).where(eq(observerJobs.state, "running")).run();
  }
  fake.state.lookupFailure = false;
  fake.state.prompt = "ok";
  const sent = fake.state.prompted.length;
  await pass();
  await pass();
  expect(fake.state.prompted).toHaveLength(sent);
});

test("a job a stopped daemon left started is unknown unless OpenCode has its prompt", async () => {
  observerOn();
  const now = Date.now();
  for (const prompt of ["msg_never", "msg_there"])
    db.insert(observerJobs)
      .values({
        dot: "jojo",
        sessionID: "ses_jojo",
        kind: "tokens",
        trigger: prompt,
        fromID: 1,
        toID: 1,
        state: "started",
        epoch: 0,
        generation: settingsOf(db, "jojo").generation,
        model: "fake/observer-1",
        scratchSession: "ses_scratch",
        promptMessage: prompt,
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .run();
  fake.state.messages.add("msg_there");
  await pass();
  expect(jobs().map((job) => job.state)).toEqual(["unknown", "running"]);
  expect(fake.state.prompted).toEqual([]);
});

test("the daily budget holds a job queued, and only two run at once, one per dot", async () => {
  observerOn("jojo", { observerDailyTokens: 1_000 });
  enough();
  work();
  await pass();
  expect(jobs()[0]).toMatchObject({
    state: "queued",
    error: "This job doesn't fit in what's left of today's budget; it waits until tomorrow.",
  });
  expect(fake.state.scratches).toEqual([]);

  saveArchiveSettings(db, "jojo", { observerDailyTokens: 2_000_000 }, 2);
  for (const name of ["polnareff", "kakyoin"]) {
    addDot(name);
    observerOn(name);
    enough(name);
  }
  work();
  await pass();
  expect(jobs().filter((job) => job.state === "running")).toHaveLength(2);
  expect(jobs().filter((job) => job.state === "queued")).toHaveLength(1);
});

test("an owner's forget or edit during a job saves nothing of it, and turning the observer off cancels it", async () => {
  observerOn();
  const [first] = enough();
  const row = db
    .insert(ledger)
    .values({
      dot: "jojo",
      sessionID: "ses_jojo",
      kind: "fact",
      topic: "Lisbon",
      text: "Old Lisbon fact.",
      priority: 2,
      validFrom: 1,
      sources: [first ?? ""],
      updatedBy: "observer",
      createdAt: 1,
      updatedAt: 1,
    })
    .returning()
    .get();
  work();
  const resurrect = () =>
    JSON.stringify({
      ops: [
        { op: "update", id: row.id, text: "Old Lisbon fact, again." },
        {
          op: "add",
          kind: "fact",
          topic: "Lisbon",
          text: "Old Lisbon fact.",
          priority: 2,
          sources: [first],
        },
      ],
    });
  fake.state.onPrompt = () => {};
  await pass();
  expect(jobs()[0]?.state).toBe("running");
  expect(forgetObservation(db, "jojo", row.id, 1)).toEqual({ deleted: true });
  const prompt = jobs()[0]?.promptMessage ?? "";
  fake.state.messageTurns.set(prompt, { outcome: "succeeded", text: resurrect(), end: "idle" });
  await pass();
  expect(jobs()[0]).toMatchObject({ state: "cancelled" });
  expect(rows()).toEqual([]);

  // A switch turned off while a call is awaited stops the job before its prompt.
  message(`Again. ${"q".repeat(tokenJobChars)}`);
  work();
  fake.state.onScratch = () => saveArchiveSettings(db, "jojo", { observer: false }, 3);
  const before = fake.state.prompted.length;
  await pass();
  expect(jobs().at(-1)?.state).toBe("cancelled");
  expect(fake.state.prompted).toHaveLength(before);
  // With it off, a pass needs no OpenCode at all.
  expect(work()).toBe(false);
});

test("a running job's answer is never read once the observer is off", () => {
  observerOn();
  enough();
  work();
  db.update(observerJobs)
    .set({ state: "running", promptMessage: "msg_p", scratchSession: "ses_s" })
    .run();
  saveArchiveSettings(db, "jojo", { observer: false }, 2);
  expect(work()).toBe(false);
  expect(jobs()[0]).toMatchObject({ state: "cancelled" });
});

test("parseOps keeps only well-formed operations", () => {
  expect(parseOps("not json")).toHaveProperty("invalid");
  expect(parseOps('{"nope":1}')).toHaveProperty("invalid");
  const parsed = parseOps(
    `Sure! {"ops":[${[
      '{"op":"add","kind":"preference","topic":"tea","text":"Prefers tea.","priority":3,"sources":["msg_1"]}',
      '{"op":"add","kind":"opinion","topic":"t","text":"Bad kind.","priority":1,"sources":["msg_1"]}',
      '{"op":"add","kind":"fact","topic":"t","text":"Bad priority.","priority":7,"sources":["msg_1"]}',
      '{"op":"update","id":3,"text":""}',
      '{"op":"update","id":3}',
      '{"op":"update","id":3,"priority":1}',
      '{"op":"supersede","id":0,"kind":"fact","topic":"t","text":"x","priority":1,"sources":["msg_1"]}',
      `{"op":"add","kind":"fact","topic":"t","text":"${"long ".repeat(200)}","priority":1,"sources":["msg_1"]}`,
    ].join(",")}]}`,
  );
  expect(parsed).toEqual([
    {
      op: "add",
      kind: "preference",
      topic: "tea",
      text: "Prefers tea.",
      priority: 3,
      sources: ["msg_1"],
    },
    { op: "update", id: 3, priority: 1 },
  ]);
});

const compaction = (id: string, native = false): HistoryItem => ({
  id,
  type: "compaction",
  text: "",
  time: 5_000,
  complete: true,
  native,
});

test("a compaction in history queues its intent; a text one gets a capped checkpoint, a native one none", async () => {
  saveArchiveSettings(
    db,
    "jojo",
    { archive: true, backfill: true, ledger: true, frozenHead: true },
    1,
  );
  const source = message("Use Postgres for the analytics store.");
  for (let at = 0; at < 400; at++)
    db.insert(ledger)
      .values({
        dot: "jojo",
        sessionID: "ses_jojo",
        kind: "decision",
        topic: `topic ${at % 7}`,
        text: `Decision ${at}: ${"detail ".repeat(10)}`,
        priority: (at % 3) + 1,
        validFrom: 1,
        sources: [source],
        updatedBy: "observer",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  fake.state.items.set("ses_jojo", [
    { id: "msg_u", type: "user", text: "hi", time: 4_000, complete: true },
    compaction("msg_compact_1"),
  ]);
  await Effect.runPromise(Effect.provide(archiveAll(db), fake.layer));
  // Without the observer the intent needs no model: it's settled at once.
  expect(jobs()).toMatchObject([{ kind: "compaction", trigger: "msg_compact_1", state: "queued" }]);
  expect(work()).toBe(false);
  expect(jobs()[0]?.state).toBe("done");
  const dot = db.select().from(dots).get();
  if (!dot) throw new Error("no dot");
  const head = headFor(db, dot, { id: "msg_compact_1", native: false });
  expect(head).toBeDefined();
  expect(Buffer.byteLength(head?.text ?? "")).toBeLessThanOrEqual(headBytes);
  expect(head?.text).toContain('"topic": "topic 0"');
  expect(head?.rows.length).toBeLessThan(400);
  // Only for the latest compaction, never a native one, never with a switch off.
  expect(headFor(db, dot, { id: "msg_other", native: false })).toBeUndefined();
  expect(headFor(db, dot, { id: "msg_compact_1", native: true })).toBeUndefined();

  // The same bytes until something changes; forgetting a shown row takes the checkpoint away
  // until the next compaction, rather than rebuilding it on later turns.
  expect(headFor(db, dot, { id: "msg_compact_1", native: false })?.text).toBe(head?.text);
  const shown = head?.rows[0] ?? 0;
  const forgotten = db.select().from(ledger).where(eq(ledger.id, shown)).get();
  expect(forgetObservation(db, "jojo", shown, forgotten?.version ?? 0)).toEqual({ deleted: true });
  expect(headFor(db, dot, { id: "msg_compact_1", native: false })).toBeUndefined();

  // A row changed since a checkpoint shows in the tail list instead.
  const next = db.select().from(ledger).get()?.id ?? 0;
  expect(editObservation(db, "jojo", next, 1, "Edited by the owner.")).toHaveProperty("saved");
  const since = sinceCheckpoint(db, "jojo", { at: 0 });
  expect(since.text).toContain("Edited by the owner.");

  // A native compaction later clears the checkpoint.
  fake.state.items.get("ses_jojo")?.push(compaction("msg_compact_2", true));
  await Effect.runPromise(Effect.provide(archiveAll(db), fake.layer));
  work();
  expect(headFor(db, dot, { id: "msg_compact_2", native: true })).toBeUndefined();
  expect(db.select().from(ledgerState).get()).toMatchObject({
    headCompaction: "msg_compact_2",
    headText: null,
  });
  expect(buildHead(db, "jojo", "x").text.length).toBeGreaterThan(0);
});

test("the owner's API sets the observer switches and edits or forgets observed rows", async () => {
  const { api } = await import("../src/api");
  const handler = api(db, "secret", fake.layer);
  const call = (method: string, path: string, body?: unknown) =>
    handler(
      new Request(`http://127.0.0.1/dots/jojo/memory${path}`, {
        method,
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const status = await (await call("GET", "/archive")).json();
  expect(status).toMatchObject({
    observer: false,
    ledger: false,
    frozenHead: false,
    rankNotes: false,
    observerModel: null,
    observerDailyTokens: 50_000,
    observerStatus: { jobs: [], spentToday: 0, head: null },
  });
  for (const bad of [
    { observer: "yes" },
    { observerModel: "no slash" },
    { observerModel: "a/b c" },
    { observerDailyTokens: 10 },
    { observerDailyTokens: 1.5 },
    { observer: true, other: 1 },
  ])
    expect((await call("PUT", "/archive", bad)).status).toBe(400);
  const on = await call("PUT", "/archive", {
    observer: true,
    ledger: true,
    observerModel: "anthropic/claude-haiku-4-5",
    observerDailyTokens: 20_000,
  });
  expect(await on.json()).toMatchObject({
    observer: true,
    ledger: true,
    observerModel: "anthropic/claude-haiku-4-5",
    observerDailyTokens: 20_000,
  });

  const source = message("Tea, not coffee.");
  const row = db
    .insert(ledger)
    .values({
      dot: "jojo",
      sessionID: "ses_jojo",
      kind: "preference",
      topic: "drinks",
      text: "Prefers tea.",
      priority: 2,
      validFrom: 1,
      sources: [source],
      updatedBy: "observer",
      createdAt: 1,
      updatedAt: 1,
    })
    .returning()
    .get();
  const memory = (await (await call("GET", "")).json()) as {
    observations: { id: number; sources: { excerpt?: string }[] }[];
  };
  expect(memory.observations).toMatchObject([
    {
      id: row.id,
      text: "Prefers tea.",
      sources: [{ messageID: source, excerpt: "Tea, not coffee." }],
    },
  ]);
  const epoch = () => db.select().from(ledgerState).get()?.epoch ?? 0;
  expect(
    (await call("PATCH", `/observations/${row.id}`, { version: 1, text: "x".repeat(501) })).status,
  ).toBe(400);
  const edited = await call("PATCH", `/observations/${row.id}`, {
    version: 1,
    text: "Prefers green tea.",
  });
  expect(await edited.json()).toMatchObject({ observation: { version: 2, updatedBy: "owner" } });
  expect(epoch()).toBe(1);
  expect(
    (await call("PATCH", `/observations/${row.id}`, { version: 1, text: "Stale." })).status,
  ).toBe(409);
  expect((await call("DELETE", `/observations/${row.id}?version=1`)).status).toBe(409);
  expect((await call("DELETE", `/observations/${row.id}?version=2`)).status).toBe(204);
  expect(epoch()).toBe(2);
  expect(rows()).toEqual([]);
  // The archived message it came from stays.
  expect(db.select().from(archive).all()).toHaveLength(1);
  expect((await call("DELETE", `/observations/${row.id}?version=2`)).status).toBe(404);
});

test("with the observer on, token jobs drain through a compaction before its checkpoint is set", async () => {
  observerOn("jojo", { backfill: true, frozenHead: true });
  fake.state.items.set("ses_jojo", [
    {
      id: "msg_said",
      type: "user",
      text: "Ship Orchard on the 14th of March.",
      time: 4_000,
      complete: true,
    },
    compaction("msg_compact"),
  ]);
  answering(() =>
    JSON.stringify({
      ops: [
        {
          op: "add",
          kind: "commitment",
          topic: "Orchard launch",
          text: "Orchard ships on the 14th of March.",
          priority: 1,
          sources: ["msg_said"],
        },
      ],
    }),
  );
  await Effect.runPromise(Effect.provide(archiveAll(db), fake.layer));
  expect(jobs()).toMatchObject([{ kind: "compaction", trigger: "msg_compact", state: "queued" }]);
  // Far less than 20k tokens, but the compaction waits on it, so a token job takes it.
  expect(work()).toBe(true);
  await pass();
  await pass();
  work();
  expect(jobs().map(({ kind, state }) => ({ kind, state }))).toEqual([
    { kind: "compaction", state: "done" },
    { kind: "tokens", state: "done" },
  ]);
  const dot = db.select().from(dots).get();
  if (!dot) throw new Error("no dot");
  expect(headFor(db, dot, { id: "msg_compact", native: false })?.text).toContain(
    "Orchard ships on the 14th of March.",
  );
});

test("a compaction queued first drains 250k characters to the last 10k, with no later input", async () => {
  observerOn("jojo", { backfill: true, frozenHead: true });
  const said = Array.from({ length: 5 }, (_, at) => ({
    id: `msg_long_${at}`,
    type: "user" as const,
    text: `${at}`.repeat(50_000),
    time: 4_000 + at,
    complete: true,
  }));
  fake.state.items.set("ses_jojo", [...said, compaction("msg_compact")]);
  await Effect.runPromise(Effect.provide(archiveAll(db), fake.layer));
  answering(() => '{"ops":[]}');
  for (let passes = 0; passes < 10; passes++) {
    work();
    await pass();
  }
  work();
  const tokens = jobs().filter((job) => job.kind === "tokens");
  expect(tokens.map((job) => job.state)).toEqual(["done", "done", "done", "done"]);
  const claimed = tokens.map((job) => {
    const from = said[job.fromID - 1]?.text.length ?? 0;
    return job.toID === job.fromID
      ? job.toOffset - job.fromOffset
      : from - job.fromOffset + (job.toID - job.fromID - 1) * 50_000 + job.toOffset;
  });
  expect(claimed).toEqual([tokenJobChars, tokenJobChars, tokenJobChars, 10_000]);
  expect(stateOf(db, "jojo")).toMatchObject({ observedThrough: 5, observedOffset: 50_000 });
  expect(jobs().find((job) => job.kind === "compaction")?.state).toBe("done");
  expect(stateOf(db, "jojo").headCompaction).toBe("msg_compact");
  // Nothing more is queued once it's all claimed.
  const count = jobs().length;
  work();
  await pass();
  expect(jobs()).toHaveLength(count);
});

/** Inserts a current row of the dot's ledger and returns it. */
const row = (text: string, sources: string[], sessionID = "ses_jojo") =>
  db
    .insert(ledger)
    .values({
      dot: "jojo",
      sessionID,
      kind: "fact",
      topic: "t",
      text,
      priority: 2,
      validFrom: 1,
      sources,
      updatedBy: "observer",
      createdAt: 1,
      updatedAt: 1,
    })
    .returning()
    .get();

test("every archived character is claimed exactly once, a long message in parts, and a chunk no call could spend comes back", async () => {
  observerOn();
  const long = `${"a".repeat(tokenJobChars)}${"b".repeat(tokenJobChars)}${"c".repeat(10_000)}`;
  const first = message(long);
  message(`tail ${"d".repeat(tokenJobChars)}`);
  const seen: { message: string; part: { start: number; end: number; length: number } }[] = [];
  const read = (text: string) => {
    const json = text.slice(
      text.indexOf("<archived-messages>\n") + 20,
      text.lastIndexOf("\n</archived-messages>"),
    );
    seen.push(...JSON.parse(json));
  };
  // The first prompt isn't admitted: its chunk is given back and claimed again.
  fake.state.prompt = "fail";
  work();
  await pass();
  expect(jobs()[0]).toMatchObject({ state: "failed", fromID: 0, toID: 1, toOffset: tokenJobChars });
  expect(db.select().from(ledgerState).get()).toMatchObject({
    observedThrough: 0,
    observedOffset: 0,
  });
  fake.state.prompt = "ok";
  answering(() => '{"ops":[]}');
  for (let passes = 0; passes < 12; passes++) {
    work();
    await pass();
  }
  for (const text of fake.state.texts.map((each) => each.text)) read(text);
  // Each part of each message once, in order, nothing skipped.
  const parts = seen.filter((each) => each.message === first).map((each) => each.part);
  expect(parts).toEqual([
    { start: 0, end: tokenJobChars, length: long.length },
    { start: tokenJobChars, end: 2 * tokenJobChars, length: long.length },
    { start: 2 * tokenJobChars, end: long.length, length: long.length },
  ]);
  const done = jobs().filter((job) => job.state === "done");
  expect(done.length).toBeGreaterThanOrEqual(3);
  // A remainder under 20k tokens waits for more, or for a compaction, rather than being dropped.
  expect(db.select().from(ledgerState).get()?.observedThrough).toBeGreaterThan(0);
});

test("a changed model, a disable and re-enable, or a change while it runs cancel the job", async () => {
  observerOn();
  enough();
  work();
  saveArchiveSettings(db, "jojo", { observerModel: "fake/other" }, 2);
  expect(work()).toBe(false);
  expect(jobs()[0]?.state).toBe("cancelled");

  message(`more ${"m".repeat(tokenJobChars)}`);
  work();
  fake.state.onPrompt = () => {};
  await pass();
  expect(jobs().at(-1)?.state).toBe("running");
  saveArchiveSettings(db, "jojo", { observer: false }, 3);
  saveArchiveSettings(db, "jojo", { observer: true }, 4);
  // Re-enabled, but under a new generation: its answer is never read.
  expect(work()).toBe(false);
  expect(jobs().at(-1)?.state).toBe("cancelled");

  // The apply itself checks again, atomically.
  const before = jobs().length;
  work();
  await pass();
  const job = jobs().at(-1);
  expect(jobs().length).toBe(before + 1);
  const prompt = job?.promptMessage ?? "";
  fake.state.messageTurns.set(prompt, {
    outcome: "succeeded",
    text: '{"ops":[{"op":"add","kind":"fact","topic":"t","text":"x.","priority":1,"sources":["msg_jojo_1"]}]}',
    end: "idle",
  });
  fake.state.onPage = () => {};
  saveArchiveSettings(db, "jojo", { archive: false }, 5);
  if (!job) throw new Error("no job");
  expect(applyJob(db, job, [])).toBe("cancelled");
  expect(rows()).toEqual([]);
});

test("an older compaction completing late never replaces a newer checkpoint, text or native", async () => {
  saveArchiveSettings(
    db,
    "jojo",
    { archive: true, backfill: true, ledger: true, frozenHead: true },
    1,
  );
  row("Kept in the checkpoint.", ["msg_x"]);
  const walk = () => Effect.runPromise(Effect.provide(archiveAll(db), fake.layer));
  const head = () => db.select().from(ledgerState).get();
  // The older compaction is still running when the walk meets it; a newer one has completed.
  fake.state.items.set("ses_jojo", [
    { ...compaction("msg_c1"), complete: false },
    compaction("msg_c2"),
  ]);
  await walk();
  expect(jobs().map(({ trigger, complete }) => ({ trigger, complete }))).toEqual([
    { trigger: "msg_c1", complete: false },
    { trigger: "msg_c2", complete: true },
  ]);
  work();
  expect(head()).toMatchObject({ headCompaction: "msg_c2" });
  expect(head()?.headText).toContain("Kept in the checkpoint.");
  const newest = head()?.headText;
  // The older one completes only now, after the newer one settled: the newer head stays.
  fake.state.items.set("ses_jojo", [compaction("msg_c1"), compaction("msg_c2")]);
  await walk();
  expect(jobs()[0]).toMatchObject({ trigger: "msg_c1", complete: true });
  work();
  expect(jobs()[0]?.state).toBe("done");
  expect(head()).toMatchObject({ headCompaction: "msg_c2", headText: newest });

  // A newer native compaction clears it; another older one completing late leaves it clear.
  fake.state.items
    .get("ses_jojo")
    ?.push({ ...compaction("msg_c3"), complete: false }, compaction("msg_c4", true));
  await walk();
  work();
  expect(head()).toMatchObject({ headCompaction: "msg_c4", headText: null });
  const items = fake.state.items.get("ses_jojo") ?? [];
  items[2] = compaction("msg_c3");
  await walk();
  work();
  expect(jobs().find((job) => job.trigger === "msg_c3")?.state).toBe("done");
  expect(head()).toMatchObject({ headCompaction: "msg_c4", headText: null });

  // One that never completes is dropped once a turn end passes it.
  items.push({ ...compaction("msg_c5"), complete: false });
  await walk();
  items.push({ id: "msg_idle_after", type: "idle", text: "", time: 9_000, complete: true });
  await walk();
  await walk();
  expect(jobs().find((job) => job.trigger === "msg_c5")?.state).toBe("cancelled");
  expect(head()).toMatchObject({ headCompaction: "msg_c4" });
});

test("while the latest compaction is native, the observer waits and claims nothing", async () => {
  observerOn();
  enough();
  fake.state.items.set("ses_jojo", [compaction("msg_native", true)]);
  work();
  await pass();
  expect(jobs()[0]).toMatchObject({
    state: "queued",
    error: "The latest compaction is native, so the observer waits.",
  });
  expect(fake.state.scratches).toEqual([]);
  expect(db.select().from(ledgerState).get()).toMatchObject({ observedThrough: 0 });
});

test("updates keep at most ten sources and never touch another session's row", () => {
  observerOn();
  const ids = Array.from({ length: 12 }, (_, at) => message(`m${at}`));
  const mine = row("Mine.", ids.slice(0, 8));
  const other = row("Other session.", ["msg_old"], "ses_old");
  const now = Date.now();
  const job = db
    .insert(observerJobs)
    .values({
      dot: "jojo",
      sessionID: "ses_jojo",
      kind: "tokens",
      trigger: "t",
      state: "running",
      epoch: 0,
      generation: settingsOf(db, "jojo").generation,
      model: "fake/observer-1",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  expect(
    applyJob(db, job, [
      { op: "update", id: mine.id, sources: ids.slice(6, 12) },
      { op: "update", id: other.id, text: "Rewritten." },
      {
        op: "supersede",
        id: other.id,
        kind: "fact",
        topic: "t",
        text: "Replaced.",
        priority: 1,
        sources: [ids[0] ?? ""],
      },
    ]),
  ).toBe("done");
  const after = rows();
  expect(after.find((each) => each.id === mine.id)?.sources).toEqual(ids.slice(2, 12));
  expect(after.find((each) => each.id === other.id)).toMatchObject({
    text: "Other session.",
    supersededBy: null,
  });
});

/** What a provider might report for a job, in OpenCode's five counts. */
const reported = (total: number, complete = true): Usage => ({
  // Five disjoint counts adding up to `total`.
  input: total - 300,
  output: 100,
  reasoning: 50,
  cacheRead: 100,
  cacheWrite: 50,
  complete,
});

test("each call is charged twice its estimate first, then what the provider reported in full", async () => {
  const job = await runningJob();
  // Before any answer, the call already counts twice its estimate.
  expect(jobs()[0]).toMatchObject({ charged: 2 * job.estimate, used: null });
  fake.state.messageTurns.set(job.promptMessage ?? "", succeeded);
  fake.state.usage.set(job.scratchSession ?? "", reported(1_000));
  await pass();
  // All five counts, none twice: 650 uncached input, 100 output, 50 reasoning, 100 read, 50 written.
  expect(jobs()[0]).toMatchObject({ state: "done", used: 900, cached: 100, charged: 1_000 });

  // A sum that may be short (an unfinished or silent message) keeps the charge on top.
  message(`more ${"m".repeat(tokenJobChars)}`);
  work();
  await pass();
  const second = jobs().at(-1);
  fake.state.messageTurns.set(second?.promptMessage ?? "", succeeded);
  fake.state.usage.set(second?.scratchSession ?? "", reported(1_000, false));
  await pass();
  expect(jobs().at(-1)).toMatchObject({ charged: 1_000 + 2 * (second?.estimate ?? 0) });

  // No usage reported at all: twice the estimate stays.
  message(`again ${"n".repeat(tokenJobChars)}`);
  work();
  await pass();
  const third = jobs().at(-1);
  fake.state.messageTurns.set(third?.promptMessage ?? "", succeeded);
  await pass();
  expect(jobs().at(-1)).toMatchObject({ state: "done", charged: 2 * (third?.estimate ?? 0) });
});

test("a call that doesn't fit what's left of today waits, and none is sent once today's record reaches the budget, whatever the settings, until tomorrow", async () => {
  const job = await runningJob();
  fake.state.messageTurns.set(job.promptMessage ?? "", succeeded);
  // The provider reports more than the whole day's budget: one in-flight job can overshoot it.
  fake.state.usage.set(job.scratchSession ?? "", reported(2_500_000));
  await pass();
  const dot = db.select().from(dots).get();
  if (!dot) throw new Error("no dot");
  expect(observerStatus(db, dot)).toMatchObject({
    spentToday: 2_500_000,
    stoppedToday: true,
    budgetNote:
      "Daily budget. One in-flight job can overshoot it, and then the observer stops until tomorrow.",
  });
  message(`more ${"o".repeat(tokenJobChars)}`);
  work();
  const calls = fake.state.prompted.length;
  await pass();
  expect(jobs().at(-1)).toMatchObject({
    state: "queued",
    error: "Today's budget is used up; the observer stops until tomorrow.",
  });
  // Neither raising the budget, nor a model change, nor turning it off and on lifts the stop.
  saveArchiveSettings(db, "jojo", { observerDailyTokens: 2_000_000 }, 8);
  saveArchiveSettings(db, "jojo", { observerModel: "fake/observer-2" }, 9);
  saveArchiveSettings(db, "jojo", { observer: false }, 10);
  saveArchiveSettings(db, "jojo", { observer: true }, 11);
  work();
  await pass();
  expect(fake.state.prompted).toHaveLength(calls);
  expect(observerStatus(db, dot)).toMatchObject({ stoppedToday: true });
  // Tomorrow, after local midnight, it goes on.
  const clock = Date.now;
  try {
    const tomorrow = dayStart(clock()) + 24 * 60 * 60_000 + 60_000;
    Date.now = () => tomorrow;
    expect(observerStatus(db, dot)).toMatchObject({ stoppedToday: false, spentToday: 0 });
    work();
    await pass();
    expect(fake.state.prompted).toHaveLength(calls + 1);
  } finally {
    Date.now = clock;
  }
});

test("a stop reached by the charge made before a call holds the rest of the day, even with a raised budget", async () => {
  observerOn();
  enough();
  work();
  const estimate = () => observerPrompt(db, jobs()[0] as ObserverJob).estimate;
  // Exactly twice the estimate fits: the call goes, and its charge reaches the budget.
  saveArchiveSettings(db, "jojo", { observerDailyTokens: 2 * estimate() }, 2);
  fake.state.onPrompt = () => {};
  await pass();
  expect(jobs()[0]?.state).toBe("running");
  expect(stateOf(db, "jojo").stoppedDay).toBe(dayStart(Date.now()));
  // The provider reports far less, and the budget is raised: still stopped today.
  fake.state.messageTurns.set(jobs()[0]?.promptMessage ?? "", succeeded);
  fake.state.usage.set(jobs()[0]?.scratchSession ?? "", reported(1_000));
  await pass();
  saveArchiveSettings(db, "jojo", { observerDailyTokens: 2_000_000 }, 3);
  message(`more ${"r".repeat(tokenJobChars)}`);
  work();
  await pass();
  expect(fake.state.prompted).toHaveLength(1);
  expect(jobs().at(-1)?.error).toBe(
    "Today's budget is used up; the observer stops until tomorrow.",
  );
});

test("retries are charged too, and a chunk gets at most three calls a day", async () => {
  observerOn();
  enough();
  fake.state.prompt = "fail";
  for (let attempt = 0; attempt < 5; attempt++) {
    work();
    await pass();
  }
  // Each attempt's prompt was refused and its chunk given back, but every call was charged.
  const sent = jobs().filter((job) => job.charged !== null);
  expect(sent).toHaveLength(maxCallsPerChunk);
  for (const job of sent) expect(job).toMatchObject({ state: "failed", charged: 2 * job.estimate });
  expect(jobs().at(-1)).toMatchObject({
    state: "queued",
    error: "This part of the conversation was sent 3 times today; it waits until tomorrow.",
  });
  expect(fake.state.prompted).toHaveLength(0);
  // A lost outcome stays charged and is never sent again.
  fake.state.prompt = "ok";
  expect(stateOf(db, "jojo")).toMatchObject({ observedThrough: 0, observedOffset: 0 });
});

test("lookups that keep failing end after 30 minutes", async () => {
  observerOn();
  const now = Date.now();
  const stuck = db
    .insert(observerJobs)
    .values({
      dot: "jojo",
      sessionID: "ses_jojo",
      kind: "tokens",
      trigger: "stuck",
      state: "running",
      epoch: 0,
      generation: settingsOf(db, "jojo").generation,
      model: "fake/observer-1",
      scratchSession: "ses_s",
      promptMessage: "msg_p",
      charged: 100,
      createdAt: now - 31 * 60_000,
      startedAt: now - 31 * 60_000,
      updatedAt: now,
    })
    .returning()
    .get();
  fake.state.readFailure = true;
  await pass();
  expect(db.select().from(observerJobs).where(eq(observerJobs.id, stuck.id)).get()).toMatchObject({
    state: "unknown",
    charged: 100,
  });
});

test("the owner pages every current row and opens a source from the archive, bounded", async () => {
  const { api } = await import("../src/api");
  const handler = api(db, "secret", fake.layer);
  const get = (path: string) =>
    handler(
      new Request(`http://127.0.0.1/dots/jojo/memory${path}`, {
        headers: { authorization: "Bearer secret" },
      }),
    );
  const source = message(`Long source ${"z".repeat(6_000)}`);
  for (let at = 0; at < 120; at++) row(`Row ${at}.`, [source]);
  const first = (await (await get("")).json()) as {
    observations: { id: number }[];
    observationsNext: number | null;
  };
  expect(first.observations).toHaveLength(50);
  const seen = new Set(first.observations.map((each) => each.id));
  let next = first.observationsNext;
  while (next !== null) {
    const page = (await (await get(`/observations?before=${next}`)).json()) as {
      observations: { id: number }[];
      next: number | null;
    };
    for (const each of page.observations) seen.add(each.id);
    next = page.next;
  }
  expect(seen.size).toBe(120);
  expect((await get("/observations?before=x")).status).toBe(400);
  const opened = (await (await get(`/observations/1/sources/${source}`)).json()) as {
    state: string;
    text: string;
    truncated: boolean;
  };
  expect(opened).toMatchObject({ state: "found", truncated: true });
  expect(opened.text.length).toBe(4000);
  expect((await get("/observations/1/sources/msg_not_its_source")).status).toBe(404);
});

/** The fake OpenCode with some calls replaced, counting every call by name. */
const counted = async (change: (calls: Record<string, number>) => Partial<Service>) => {
  const base = await Effect.runPromise(Effect.provide(OpenCode, fake.layer));
  const calls: Record<string, number> = {};
  const wrap = Object.fromEntries(
    Object.entries(base).map(([name, call]) => [
      name,
      typeof call === "function"
        ? (...args: unknown[]) => {
            calls[name] = (calls[name] ?? 0) + 1;
            return (call as (...each: unknown[]) => unknown)(...args);
          }
        : call,
    ]),
  ) as unknown as Service;
  const layer = Layer.succeed(OpenCode, { ...wrap, ...change(calls) });
  return { calls, pass: () => Effect.runPromise(Effect.provide(observePass(db), layer)) };
};

/** A running job: started and admitted by an ordinary pass. */
const runningJob = async () => {
  observerOn();
  enough();
  work();
  fake.state.onPrompt = () => {};
  await pass();
  const job = jobs()[0];
  if (job?.state !== "running") throw new Error("not running");
  return job;
};

const succeeded = { outcome: "succeeded" as const, text: '{"ops":[]}', end: "idle" };

test("a poll reads nothing more, and records no reported use, once its job is unwanted", async () => {
  // Off during the turn read: no usage call, cancelled, still charged twice its estimate.
  const job = await runningJob();
  const off = await counted((calls) => ({
    turnAfter: () =>
      Effect.sync(() => {
        calls.turnAfter = (calls.turnAfter ?? 0) + 1;
        saveArchiveSettings(db, "jojo", { observer: false }, 2);
        return succeeded;
      }),
  }));
  await off.pass();
  expect(off.calls.usage).toBeUndefined();
  expect(jobs()[0]).toMatchObject({
    id: job.id,
    state: "cancelled",
    used: null,
    charged: 2 * job.estimate,
  });
});

test("a cost already reported is recorded whatever changed meanwhile, and stops the next call", async () => {
  for (const change of ["model", "off", "forget"] as const) {
    db.$client.close();
    db = openDatabase(":memory:");
    fake = fakeOpenCode();
    addDot("jojo");
    const job = await runningJob();
    const source = db.select().from(archive).get()?.messageID ?? "";
    const forgettable = row("Forget me.", [source]);
    const budget = settingsOf(db, "jojo").observerDailyTokens;
    const during = await counted(() => ({
      turnAfter: () => Effect.succeed(succeeded),
      usage: () =>
        Effect.sync(() => {
          if (change === "model") saveArchiveSettings(db, "jojo", { observerModel: "fake/two" }, 2);
          if (change === "off") saveArchiveSettings(db, "jojo", { observer: false }, 2);
          if (change === "forget") forgetObservation(db, "jojo", forgettable.id, 1);
          return reported(budget + 10_000);
        }),
    }));
    await during.pass();
    // The known cost is recorded, but the answer isn't used.
    expect(jobs()[0]).toMatchObject({
      id: job.id,
      state: "cancelled",
      charged: budget + 10_000,
      cached: 100,
    });
    expect(rows().filter((each) => each.text !== "Forget me.")).toEqual([]);
    if (change === "off") saveArchiveSettings(db, "jojo", { observer: true }, 3);
    message(`more ${"s".repeat(tokenJobChars)}`);
    work();
    const sent = fake.state.prompted.length;
    await pass();
    expect([change, fake.state.prompted.length]).toEqual([change, sent]);
    expect(stateOf(db, "jojo").stoppedDay).toBe(dayStart(Date.now()));
  }
});

test("a call is charged on the local day it's made, not the day its job claimed its text", async () => {
  const clock = Date.now;
  const midnight = dayStart(clock()) + 24 * 60 * 60_000;
  try {
    Date.now = () => midnight - 100;
    observerOn();
    enough();
    work();
    // The scratch session is made just before midnight; the prompt goes just after.
    fake.state.onScratch = () => {
      Date.now = () => midnight + 100;
    };
    fake.state.onPrompt = () => {};
    await pass();
    const job = jobs()[0];
    expect(job?.startedAt).toBe(midnight - 100);
    expect(job).toMatchObject({ state: "running", chargedAt: midnight + 100 });
    const dot = db.select().from(dots).get();
    if (!dot) throw new Error("no dot");
    expect(observerStatus(db, dot)).toMatchObject({ spentToday: job?.charged });
    // The recent jobs show what each was charged.
    expect(observerStatus(db, dot).jobs[0]).toMatchObject({
      charged: job?.charged,
      chargedAt: midnight + 100,
    });
    Date.now = () => midnight - 100;
    expect(observerStatus(db, dot)).toMatchObject({ spentToday: 0 });
  } finally {
    Date.now = clock;
  }
});

test("a settings change during the turn read means no usage call", async () => {
  await runningJob();
  const after = await counted(() => ({
    turnAfter: () =>
      Effect.sync(() => {
        saveArchiveSettings(db, "jojo", { observerModel: "fake/two" }, 2);
        return succeeded;
      }),
  }));
  await after.pass();
  expect(after.calls.usage).toBeUndefined();
});

test("usage is summed across every page of assistant messages, and an unreadable sum fails", async () => {
  const tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } };
  const pages =
    (count: number, loop = false) =>
    (cursor?: string) =>
      Effect.sync(() => {
        const at = cursor ? Number(cursor) : 0;
        return {
          items: Array.from({ length: 200 }, () => ({ tokens, complete: true })),
          next: at + 1 < count ? (loop ? "1" : String(at + 1)) : undefined,
        };
      });
  const summed = await Effect.runPromise(sumUsage(pages(3)));
  expect(summed).toEqual({
    input: 6_000,
    output: 3_000,
    reasoning: 1_200,
    cacheRead: 1_800,
    cacheWrite: 600,
    complete: true,
  });
  const partial = await Effect.runPromise(
    sumUsage(() =>
      Effect.succeed({
        items: [{ tokens, complete: true }, { complete: true }, { tokens, complete: false }],
        next: undefined,
      }),
    ),
  );
  expect(partial).toMatchObject({ input: 20, complete: false });
  expect(
    await Effect.runPromise(sumUsage(() => Effect.succeed({ items: [], next: undefined }))),
  ).toBeUndefined();
  expect(Exit.isFailure(await Effect.runPromiseExit(sumUsage(pages(3, true))))).toBe(true);
  expect(Exit.isFailure(await Effect.runPromiseExit(sumUsage(pages(usagePageLimit + 1))))).toBe(
    true,
  );
});

test("a rebind before the poll reads nothing at all", async () => {
  await runningJob();
  db.update(dots).set({ sessionID: "ses_new" }).run();
  const idle = await counted(() => ({}));
  await idle.pass();
  expect(idle.calls.turnAfter).toBeUndefined();
  expect(idle.calls.usage).toBeUndefined();
  expect(jobs()[0]?.state).toBe("cancelled");
});

test("a failed call whose job became unwanted meanwhile is never looked up", async () => {
  // The scratch session fails while the observer is turned off: no session lookup, nothing sent,
  // and the chunk comes back.
  observerOn();
  enough();
  work();
  const scratch = await counted(() => ({
    createScratch: () =>
      Effect.suspend(() => {
        saveArchiveSettings(db, "jojo", { observer: false }, 2);
        return Effect.fail(new OpenCodeError({ message: "reset" }));
      }),
  }));
  await scratch.pass();
  expect(scratch.calls.sessionExists).toBeUndefined();
  expect(scratch.calls.prompt).toBeUndefined();
  expect(jobs()[0]?.state).toBe("cancelled");
  expect(stateOf(db, "jojo")).toMatchObject({ observedThrough: 0, observedOffset: 0 });

  // The prompt fails while the binding changes: no message lookup, and its outcome is unknown,
  // so its chunk isn't given back.
  saveArchiveSettings(db, "jojo", { observer: true }, 3);
  work();
  const prompt = await counted(() => ({
    prompt: () =>
      Effect.suspend(() => {
        db.update(dots).set({ sessionID: "ses_new" }).run();
        return Effect.fail(new OpenCodeError({ message: "reset" }));
      }),
  }));
  await prompt.pass();
  expect(prompt.calls.messageExists).toBeUndefined();
  expect(jobs().at(-1)?.state).toBe("unknown");
  expect(stateOf(db, "jojo").observedThrough).toBeGreaterThan(0);
});

test("a started job left behind is unknown without a lookup once it's unwanted", async () => {
  observerOn();
  const now = Date.now();
  db.insert(observerJobs)
    .values({
      dot: "jojo",
      sessionID: "ses_jojo",
      kind: "tokens",
      trigger: "left",
      state: "started",
      epoch: 0,
      generation: settingsOf(db, "jojo").generation,
      model: "fake/observer-1",
      scratchSession: "ses_scratch",
      promptMessage: "msg_left",
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    })
    .run();
  db.update(dots).set({ sessionID: "ses_new" }).run();
  const left = await counted(() => ({}));
  await left.pass();
  expect(left.calls.messageExists).toBeUndefined();
  expect(jobs()[0]?.state).toBe("unknown");
  // Settings changed instead: the database-only pass marks it unknown too, never cancelled.
  db.update(dots).set({ sessionID: "ses_jojo" }).run();
  db.update(observerJobs).set({ state: "started" }).run();
  saveArchiveSettings(db, "jojo", { observerModel: "fake/two" }, 4);
  work();
  expect(jobs()[0]?.state).toBe("unknown");
});

/** A page of compactions that never completed, for `latestCompleted`. */
const notCompleted = (count: number, from = 0) =>
  Array.from({ length: count }, (_, at) => ({
    id: `msg_f${from + at}`,
    completed: false,
    native: false,
  }));

/** Runs latestCompleted over pages of compactions, newest first; `loop` repeats a cursor. */
const compactions = async (
  pages: { id: string; completed: boolean; native: boolean }[][],
  loop = false,
) => {
  let reads = 0;
  const exit = await Effect.runPromiseExit(
    latestCompleted((cursor) =>
      Effect.sync(() => {
        reads++;
        const at = cursor ? Number(cursor) : 0;
        return {
          items: pages[at] ?? [],
          next: at + 1 < pages.length ? (loop ? "1" : String(at + 1)) : undefined,
        };
      }),
    ),
  );
  return { found: Exit.isSuccess(exit) ? exit.value : "failed", reads };
};

test("the latest completed compaction is found past any number of running or failed ones, or the read fails", async () => {
  // 65 not completed across three pages, then a completed native one.
  const native = await compactions([
    notCompleted(50),
    notCompleted(10, 50),
    [...notCompleted(5, 60), { id: "msg_native", completed: true, native: true }],
  ]);
  expect(native).toEqual({ found: { id: "msg_native", native: true }, reads: 3 });
  // None completed in all of history: no compaction, so text mode.
  expect((await compactions([notCompleted(30), notCompleted(30)])).found).toBeUndefined();
  // A cursor handed back twice, or more pages than the limit, fails rather than guessing.
  expect(
    (await compactions([notCompleted(50), notCompleted(50), notCompleted(50)], true)).found,
  ).toBe("failed");
  const many = Array.from({ length: compactionPageLimit + 1 }, (_, at) => notCompleted(1, at));
  expect((await compactions(many)).found).toBe("failed");
  // So does a failed read; the observer then waits.
  const broken = await Effect.runPromiseExit(
    latestCompleted(() => Effect.fail(new OpenCodeError({ message: "down" }))),
  );
  expect(Exit.isFailure(broken)).toBe(true);
});
