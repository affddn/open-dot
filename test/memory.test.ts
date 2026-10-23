import { beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { api } from "../src/api";
import { claimDue } from "../src/daemon";
import { type Db, openDatabase } from "../src/db";
import { cancelReminder, editReminder } from "../src/memory";
import { OpenCode, OpenCodeError } from "../src/opencode";
import { dots, notes, outbox, reminders, responsibilities } from "../src/schema";

let db: Db;

// Memory needs no OpenCode, so every call runs as if it were down.
const down = Layer.effect(OpenCode, Effect.fail(new OpenCodeError({ message: "Not running" })));

beforeEach(() => {
  db = openDatabase(":memory:");
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

const call = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  api(
    db,
    "secret",
    down,
  )(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${init.token ?? "secret"}` },
      ...(init.body === undefined
        ? {}
        : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    }),
  );

const json = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
});

const note = (dot: string, text: string) =>
  db.insert(notes).values({ dot, text, createdAt: 1 }).returning().get();
const responsibility = (dot: string) =>
  db
    .insert(responsibilities)
    .values({
      dot,
      goal: "Ship",
      nextAction: "Write",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    })
    .returning()
    .get();
const reminder = (dot: string, dueAt: number, everyMinutes?: number) =>
  db
    .insert(reminders)
    .values({
      dot,
      text: "Stretch",
      dueAt,
      everyMinutes: everyMinutes ?? null,
      state: "scheduled",
      createdAt: 1,
    })
    .returning()
    .get();

const nothingQueued = () => expect(db.select().from(outbox).all()).toEqual([]);

test("memory lists each dot's own items with who changed them, while OpenCode is down", async () => {
  note("jojo", "Likes tea");
  note("polnareff", "Not jojo's");
  responsibility("jojo");
  reminder("jojo", Date.now() + 60_000);
  const { status, body } = await json(await call("/dots/jojo/memory"));
  expect(status).toBe(200);
  expect(body).toMatchObject({
    notes: [{ text: "Likes tea", version: 1, updatedAt: 1, updatedBy: "dot" }],
    responsibilities: [{ goal: "Ship", nextAction: "Write", status: "active", version: 1 }],
    reminders: [{ text: "Stretch", everyMinutes: null, state: "scheduled", updatedBy: "dot" }],
  });
  expect(body.notes).toHaveLength(1);
  expect((await call("/dots/nobody/memory")).status).toBe(404);
  expect((await call("/dots/jojo/memory", { token: "wrong" })).status).toBe(401);
  expect((await call("/dots/jojo/memory", { method: "POST" })).status).toBe(404);
});

test("the owner adds, edits and deletes notes at the version seen, starting no turn", async () => {
  const added = await json(
    await call("/dots/jojo/memory/notes", { method: "POST", body: { text: "  Prefers tea  " } }),
  );
  expect(added.status).toBe(201);
  expect(added.body.note).toMatchObject({ text: "Prefers tea", version: 1, updatedBy: "owner" });
  const id = (added.body.note as { id: number }).id;
  const edited = await json(
    await call(`/dots/jojo/memory/notes/${id}`, {
      method: "PATCH",
      body: { version: 1, text: "Prefers green tea" },
    }),
  );
  expect(edited).toMatchObject({
    status: 200,
    body: { note: { id, text: "Prefers green tea", version: 2, updatedBy: "owner" } },
  });
  // A stale delete is refused with the current value, and deletes nothing.
  const stale = await json(
    await call(`/dots/jojo/memory/notes/${id}?version=1`, { method: "DELETE" }),
  );
  expect(stale).toMatchObject({ status: 409, body: { current: { text: "Prefers green tea" } } });
  expect((await call(`/dots/jojo/memory/notes/${id}?version=2`, { method: "DELETE" })).status).toBe(
    204,
  );
  expect(db.select().from(notes).all()).toEqual([]);
  // Repeating it finds nothing, rather than deleting something else.
  expect((await call(`/dots/jojo/memory/notes/${id}?version=2`, { method: "DELETE" })).status).toBe(
    404,
  );
  nothingQueued();
});

test("a dot's change since the view loaded, even from a plugin older than versions, is a 409", async () => {
  const item = responsibility("jojo");
  const path = `/dots/jojo/memory/responsibilities/${item.id}`;
  const owner = await json(
    await call(path, { method: "PATCH", body: { version: 1, nextAction: "Review" } }),
  );
  expect(owner.body.responsibility).toMatchObject({ version: 2, updatedBy: "owner" });
  // What a running plugin from before the migration does for dot_update: no version at all.
  db.$client.run("update responsibilities set next_action = 'Merge', updated_at = 5 where id = ?", [
    item.id,
  ]);
  const saved = db.select().from(responsibilities).get();
  expect(saved).toMatchObject({ nextAction: "Merge", version: 3, updatedBy: "dot" });
  expect(saved?.updatedAt).toBeGreaterThan(5);
  const stale = await json(
    await call(path, { method: "PATCH", body: { version: 2, status: "done" } }),
  );
  expect(stale).toMatchObject({
    status: 409,
    body: { current: { nextAction: "Merge", status: "active", version: 3, updatedBy: "dot" } },
  });
  expect(db.select().from(responsibilities).get()?.status).toBe("active");
  const done = await json(
    await call(path, { method: "PATCH", body: { version: 3, goal: "Ship v2", status: "done" } }),
  );
  expect(done.body.responsibility).toMatchObject({
    goal: "Ship v2",
    nextAction: "Merge",
    status: "done",
    version: 4,
  });
  nothingQueued();
});

test("items are scoped to the named dot, and unknown items are 404", async () => {
  const theirs = note("polnareff", "Private");
  const job = responsibility("polnareff");
  const alarm = reminder("polnareff", Date.now() + 60_000);
  for (const [method, path, body] of [
    ["PATCH", `/dots/jojo/memory/notes/${theirs.id}`, { version: 1, text: "Mine now" }],
    ["DELETE", `/dots/jojo/memory/notes/${theirs.id}?version=1`, undefined],
    ["PATCH", `/dots/jojo/memory/responsibilities/${job.id}`, { version: 1, status: "dropped" }],
    ["PATCH", `/dots/jojo/memory/reminders/${alarm.id}`, { version: 1, everyMinutes: 5 }],
    ["DELETE", `/dots/jojo/memory/reminders/${alarm.id}?version=1`, undefined],
    ["PATCH", "/dots/jojo/memory/notes/999", { version: 1, text: "x" }],
    ["PATCH", "/dots/jojo/memory/notes/01", { version: 1, text: "x" }],
    ["DELETE", `/dots/polnareff/memory/responsibilities/${job.id}?version=1`, undefined],
  ] as const)
    expect((await call(path, { method, body })).status).toBe(404);
  expect(db.select().from(notes).get()?.text).toBe("Private");
  expect(db.select().from(responsibilities).get()?.status).toBe("active");
  expect(db.select().from(reminders).get()).toMatchObject({ everyMinutes: null, version: 1 });
});

test("bodies are checked strictly before anything is saved", async () => {
  const item = note("jojo", "Keep");
  const job = responsibility("jojo");
  const alarm = reminder("jojo", Date.now() + 60_000);
  const soon = Date.now() + 60_000;
  const add = "/dots/jojo/memory/notes";
  const n = `/dots/jojo/memory/notes/${item.id}`;
  const j = `/dots/jojo/memory/responsibilities/${job.id}`;
  const r = `/dots/jojo/memory/reminders/${alarm.id}`;
  const cases: [string, string, unknown, number][] = [
    ["POST", add, "{", 400],
    ["POST", add, {}, 400],
    ["POST", add, { text: "  " }, 400],
    ["POST", add, { text: 1 }, 400],
    ["POST", add, { text: "a\u0000b" }, 400],
    ["POST", add, { text: "a\u0080b" }, 400],
    ["POST", add, { text: "x".repeat(2001) }, 400],
    ["POST", add, { text: "ok", extra: true }, 400],
    ["POST", add, { text: "x".repeat(70_000) }, 413],
    ["PATCH", n, { text: "no version" }, 400],
    ["PATCH", n, { version: 0, text: "x" }, 400],
    ["PATCH", n, { version: 1.5, text: "x" }, 400],
    ["PATCH", n, { version: "1", text: "x" }, 400],
    ["DELETE", n, undefined, 400],
    ["DELETE", `${n}?version=0`, undefined, 400],
    ["DELETE", `${n}?version=1&x=1`, undefined, 400],
    ["PATCH", j, { version: 1 }, 400],
    ["PATCH", j, { version: 1, status: "paused" }, 400],
    ["PATCH", j, { version: 1, goal: "" }, 400],
    ["PATCH", j, { version: 1, text: "x" }, 400],
    ["PATCH", r, { version: 1 }, 400],
    ["PATCH", r, { version: 1, dueAt: Date.now() - 1 }, 400],
    ["PATCH", r, { version: 1, dueAt: soon + 0.5 }, 400],
    ["PATCH", r, { version: 1, dueAt: 9e15 }, 400],
    ["PATCH", r, { version: 1, everyMinutes: 0 }, 400],
    ["PATCH", r, { version: 1, everyMinutes: 525_601 }, 400],
    ["PATCH", r, { version: 1, everyMinutes: "5" }, 400],
    ["PATCH", r, { version: 1, text: "x" }, 400],
    ["DELETE", `${j}?version=1`, undefined, 404],
  ];
  for (const [method, path, body, status] of cases)
    expect([method, path, body, (await call(path, { method, body })).status]).toEqual([
      method,
      path,
      body,
      status,
    ]);
  expect(db.select().from(notes).all()).toMatchObject([{ text: "Keep", version: 1 }]);
  expect(db.select().from(responsibilities).all()).toMatchObject([{ version: 1 }]);
  expect(db.select().from(reminders).all()).toMatchObject([{ version: 1, everyMinutes: null }]);
});

test("a changed or cancelled reminder never fires from a stale scheduler read", async () => {
  const minute = 60_000;
  const now = Date.now();
  const moved = reminder("jojo", now - minute, 10);
  const cancelled = reminder("jojo", now - minute);
  const path = `/dots/jojo/memory/reminders/${moved.id}`;
  // The owner's changes land after the scheduler read both as due, but before its transactions.
  const transaction = db.transaction.bind(db);
  let interleaved = false;
  const spy = spyOn(db, "transaction").mockImplementationOnce(((run: never) => {
    spy.mockRestore();
    expect(editReminder(db, "jojo", moved.id, 1, { dueAt: now + 60 * minute })).toHaveProperty(
      "saved",
    );
    expect(cancelReminder(db, "jojo", cancelled.id, 1)).toEqual({ deleted: true });
    interleaved = true;
    return transaction(run);
  }) as never);
  claimDue(db, now);
  expect(interleaved).toBe(true);
  nothingQueued();
  expect(db.select().from(reminders).all()).toMatchObject([
    { id: moved.id, dueAt: now + 60 * minute, everyMinutes: 10, version: 2, updatedBy: "owner" },
  ]);
  // Once due again, the schedule sends it and advances it as its own change.
  claimDue(db, now + 61 * minute);
  expect(db.select().from(outbox).all()).toHaveLength(1);
  const advanced = db.select().from(reminders).where(eq(reminders.id, moved.id)).get();
  expect(advanced).toMatchObject({ version: 3, updatedBy: "scheduler" });
  // An edit from the view loaded before that is refused with the current value.
  const stale = await json(
    await call(path, { method: "PATCH", body: { version: 2, everyMinutes: null } }),
  );
  expect(stale).toMatchObject({ status: 409, body: { current: { version: 3, everyMinutes: 10 } } });
  const cancel = await call(`${path}?version=3`, { method: "DELETE" });
  expect(cancel.status).toBe(204);
  claimDue(db, now + 1000 * minute);
  expect(db.select().from(outbox).all()).toHaveLength(1);
});

test("a one-off reminder that already went off can't be changed or cancelled", async () => {
  const sent = reminder("jojo", Date.now() - 1);
  claimDue(db, Date.now());
  const path = `/dots/jojo/memory/reminders/${sent.id}`;
  const changed = await json(
    await call(path, { method: "PATCH", body: { version: 2, dueAt: Date.now() + 60_000 } }),
  );
  expect(changed).toMatchObject({ status: 409, body: { current: { state: "sent" } } });
  expect((await call(`${path}?version=2`, { method: "DELETE" })).status).toBe(409);
  expect((await json(await call("/dots/jojo/memory"))).body.reminders).toEqual([]);
});

test("all memory writes require authentication and reminder API edits preserve their origin", async () => {
  const item = note("jojo", "Keep");
  const job = responsibility("jojo");
  const alarm = reminder("jojo", Date.now() + 60_000, 10);
  const paths = [
    ["POST", "/dots/jojo/memory/notes", { text: "No" }],
    ["PATCH", `/dots/jojo/memory/notes/${item.id}`, { version: 1, text: "No" }],
    ["DELETE", `/dots/jojo/memory/notes/${item.id}?version=1`, undefined],
    ["PATCH", `/dots/jojo/memory/responsibilities/${job.id}`, { version: 1, status: "done" }],
    ["PATCH", `/dots/jojo/memory/reminders/${alarm.id}`, { version: 1, everyMinutes: 5 }],
    ["DELETE", `/dots/jojo/memory/reminders/${alarm.id}?version=1`, undefined],
  ] as const;
  for (const [method, path, body] of paths)
    expect((await call(path, { method, body, token: "wrong" })).status).toBe(401);
  const path = `/dots/jojo/memory/reminders/${alarm.id}`;
  const dueAt = Date.now() + 120_000;
  const saved = await json(
    await call(path, { method: "PATCH", body: { version: 1, dueAt, everyMinutes: 5 } }),
  );
  expect(saved).toMatchObject({
    status: 200,
    body: { reminder: { version: 2, dueAt, everyMinutes: 5, updatedBy: "owner" } },
  });
  const once = await json(
    await call(path, { method: "PATCH", body: { version: 2, everyMinutes: null } }),
  );
  expect(once).toMatchObject({
    status: 200,
    body: { reminder: { version: 3, dueAt, everyMinutes: null } },
  });
  expect(db.select().from(reminders).get()?.route).toBeNull();
  const dropped = await json(
    await call(`/dots/jojo/memory/responsibilities/${job.id}`, {
      method: "PATCH",
      body: { version: 1, status: "dropped" },
    }),
  );
  expect(dropped).toMatchObject({ status: 200, body: { responsibility: { status: "dropped" } } });
  const active = await json(
    await call(`/dots/jojo/memory/responsibilities/${job.id}`, {
      method: "PATCH",
      body: { version: 2, status: "active" },
    }),
  );
  expect(active).toMatchObject({ status: 200, body: { responsibility: { status: "active" } } });
  nothingQueued();
});

test("memory shows each schedule and next run, and the owner's status edits pause and resume it", async () => {
  const schedule = { kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" } as const;
  const due = Date.now() - 60_000;
  const job = db
    .insert(responsibilities)
    .values({
      dot: "jojo",
      goal: "Inbox zero",
      nextAction: "Triage",
      status: "active",
      schedule,
      nextRunAt: due,
      createdAt: 1,
      updatedAt: 1,
    })
    .returning()
    .get();
  responsibility("jojo");
  expect((await json(await call("/dots/jojo/memory"))).body.responsibilities).toMatchObject([
    { goal: "Inbox zero", schedule, nextRunAt: due },
    { goal: "Ship", schedule: null, nextRunAt: null },
  ]);
  const path = `/dots/jojo/memory/responsibilities/${job.id}`;
  // The owner's API doesn't edit schedules.
  expect((await call(path, { method: "PATCH", body: { version: 1, schedule: null } })).status).toBe(
    400,
  );
  // The daemon's run since the owner loaded it makes the owner's edit a conflict.
  claimDue(db, Date.now());
  const conflict = await json(
    await call(path, { method: "PATCH", body: { version: 1, status: "done" } }),
  );
  expect(conflict).toMatchObject({
    status: 409,
    body: { current: { status: "active", version: 2, updatedBy: "scheduler" } },
  });
  expect(db.select().from(outbox).all()).toHaveLength(1);
  const paused = await json(
    await call(path, { method: "PATCH", body: { version: 2, status: "dropped" } }),
  );
  expect(paused).toMatchObject({
    status: 200,
    body: { responsibility: { status: "dropped", nextRunAt: null, schedule, version: 3 } },
  });
  const before = Date.now();
  const resumed = await json(
    await call(path, { method: "PATCH", body: { version: 3, status: "active" } }),
  );
  const view = resumed.body.responsibility as { nextRunAt: number; version: number };
  expect(view.nextRunAt).toBeGreaterThan(before);
  // What the owner got back is what's saved, so the next edit isn't a false conflict.
  expect(
    db.select().from(responsibilities).where(eq(responsibilities.id, job.id)).get(),
  ).toMatchObject({ version: view.version, nextRunAt: view.nextRunAt, updatedBy: "owner" });
  claimDue(db, Date.now());
  expect(db.select().from(outbox).all()).toHaveLength(1);
});
