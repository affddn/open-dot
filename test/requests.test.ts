import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { api, type Run } from "../src/api";
import { homedir } from "node:os";
import { answerAll, enqueue, settleRequests, step, watchThreads } from "../src/daemon";
import { worktreeDirectory } from "../src/home";
import { formWaiting, redactedQuestion } from "../src/opencode";
import { type Db, openDatabase } from "../src/db";
import { graceMs, prohibited, queueAnswer, unseenLimitMs } from "../src/requests";
import { dots, outbox, requests, type RequestAnswer, workers } from "../src/schema";
import { saveBinding } from "../src/supervise";
import { fakeOpenCode, type FakeWaiting } from "./fake-opencode";

let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;
let runs: (readonly string[])[];

beforeEach(() => {
  db = openDatabase(":memory:");
  fake = fakeOpenCode();
  runs = [];
  for (const name of ["jojo", "dio"])
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

const run: Run = async (argv) => {
  runs.push(argv);
  return undefined;
};
const call = (path: string, method = "GET", token = "secret") =>
  api(
    db,
    "secret",
    fake.layer,
    run,
  )(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    }),
  );

/** One round of each loop `daemonLoops` runs: the work pass, local settling, then answers. */
const tick = () =>
  Effect.runPromise(
    Effect.provide(
      step(db).pipe(
        Effect.andThen(Effect.sync(() => settleRequests(db, Date.now()))),
        Effect.andThen(answerAll(db)),
      ),
      fake.layer,
    ),
  );
const threadsTick = () => Effect.runPromise(Effect.provide(watchThreads(db), fake.layer));

const running = (id = 1, dot = "jojo") => {
  const sessionID = `ses_w${id}`;
  db.insert(workers)
    .values({
      id,
      dot,
      task: `Task ${id}.`,
      directory: `/work/${id}`,
      sessionID,
      state: "running",
      promptID: `msg_task${id}`,
      createdAt: 0,
    })
    .run();
  fake.state.sessions.add(sessionID);
  fake.state.messages.add(`msg_task${id}`);
  fake.state.active.add(sessionID);
  return sessionID;
};

const permission = (summary = "shell: bun test", id = "per_1"): FakeWaiting => ({
  id,
  kind: "permission",
  summary,
});
const form: FakeWaiting = {
  id: "frm_1",
  kind: "question",
  summary: "Which branch?",
  detail: {
    kind: "question",
    title: "Which branch?",
    fields: [
      {
        key: "branch",
        type: "string",
        required: true,
        options: [
          { value: "main", label: "main" },
          { value: "dev", label: "dev" },
        ],
      },
    ],
  },
};

const request = (id = 1) => db.select().from(requests).where(eq(requests.id, id)).get();
const toDot = (dot = "jojo") =>
  fake.state.texts.filter((sent) => sent.sessionID === `ses_${dot}`).map((sent) => sent.text);
const queue = (answer: RequestAnswer, id = 1, dot = "jojo", actor = `ses_${dot}`) =>
  queueAnswer(db, {
    id,
    dot,
    actorSession: actor,
    kind: answer.decision === "reply" || answer.decision === "cancel" ? "question" : "permission",
    answer,
  });

test("the dot's once is sent exactly once after fresh checks, and the audit keeps who chose it", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission()]);
  await tick();
  expect(queue({ decision: "once" })).toMatchObject({ state: "queued", actorSession: "ses_jojo" });
  await tick();
  await tick();

  expect(fake.state.answers).toEqual([
    { sessionID: session, kind: "permission", requestID: "per_1", answer: { decision: "once" } },
  ]);
  expect(request()).toMatchObject({ state: "answered", actorSession: "ses_jojo" });
  expect(request()?.attemptedAt).toBeNumber();
  expect(request()?.confirmedAt).toBeNumber();
  const listed = ((await (await call("/dots")).json()) as { workers: unknown[] }[])[0]?.workers;
  expect(listed).toEqual([expect.objectContaining({ needs: [], answered: "Approved once" })]);

  // A second answer to the same request is refused: one attempt per request.
  expect(queue({ decision: "reject" })).toContain("already has an answer");
});

test("questions take a checked reply or a reject, and a question that may ask for a secret goes to the owner", async () => {
  const session = running();
  fake.state.waiting.set(session, [
    form,
    formWaiting({
      id: "frm_2",
      title: "Log in to Acme",
      metadata: { hint: "corp-sso" },
      fields: [
        {
          key: "password",
          type: "string",
          description: "Your Acme passphrase",
          default: "hunter2",
          options: [{ value: "opt-secret-value", label: "Saved" }],
        },
      ],
    }),
  ]);
  await tick();
  expect(queue({ decision: "reply", answer: { branch: "prod" } })).toContain("one of its options");
  expect(queue({ decision: "reply", answer: { other: "x" } })).toContain('no field "other"');
  expect(queue({ decision: "reply", answer: { password: "hunter2" } }, 2)).toContain(
    "with your owner",
  );
  expect(queue({ decision: "reply", answer: { branch: "dev" } })).toMatchObject({
    state: "queued",
  });
  await tick();
  expect(fake.state.answers.map((sent) => sent.answer)).toEqual([
    { decision: "reply", answer: { branch: "dev" } },
  ]);
  expect(request(2)).toMatchObject({
    state: "escalated",
    sensitive: true,
    detail: { kind: "question", title: redactedQuestion, fields: [] },
  });
  // None of the secret question's own words are kept or sent anywhere.
  const kept = JSON.stringify([db.select().from(requests).all(), db.select().from(outbox).all()]);
  for (const word of ["Acme", "corp-sso", "passphrase", "hunter2", "opt-secret-value", "password"])
    expect(kept).not.toContain(word);
  // The secret question reaches the dot only as one escalation, not a notice to answer.
  expect(toDot()).toEqual([
    expect.stringContaining("is waiting on question #1"),
    expect.stringContaining("Needs your owner: question #2"),
  ]);

  fake.state.waiting.set(session, [{ ...form, id: "frm_3" }]);
  await tick();
  expect(queue({ decision: "cancel" }, 3)).toMatchObject({ state: "queued" });
  await tick();
  expect(fake.state.answers.at(-1)).toMatchObject({
    requestID: "frm_3",
    answer: { decision: "cancel" },
  });
});

test("only the dot's own running worker can be answered, never another dot's or a supervised session", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission()]);
  await tick();
  expect(queue({ decision: "once" }, 1, "dio")).toContain(
    "You have no worker permission request #1",
  );
  expect(queue({ decision: "once" }, 1, "jojo", "ses_dio")).toContain("conversation changed");
  saveBinding(
    db,
    { dot: "dio", sessionID: session, directory: "/work/1", mode: "watch", busyMinutes: 30 },
    "requested",
  );
  expect(queue({ decision: "once" })).toContain("supervises");
  expect(request()?.state).toBe("open");
});

test("a binding replaced or a supervision requested while the daemon checks sends nothing", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission(), permission("shell: ls", "per_2")]);
  await tick();
  queue({ decision: "once" });
  fake.state.onWaiting = () => {
    db.update(dots).set({ sessionID: "ses_jojo2" }).where(eq(dots.name, "jojo")).run();
  };
  await tick();
  expect(fake.state.answers).toEqual([]);
  expect(request()).toMatchObject({
    state: "escalated",
    reason: "The dot's conversation changed.",
  });

  db.update(dots).set({ sessionID: "ses_jojo" }).where(eq(dots.name, "jojo")).run();
  queue({ decision: "once" }, 2);
  fake.state.onWaiting = () => {
    saveBinding(
      db,
      { dot: "dio", sessionID: session, directory: "/work/1", mode: "watch", busyMinutes: 30 },
      "requested",
    );
  };
  await tick();
  expect(fake.state.answers).toEqual([]);
  expect(request(2)?.state).toBe("escalated");
});

test("an answer to a request that's gone, or to a stopped worker, goes stale unsent", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission(), permission("shell: ls", "per_2")]);
  await tick();
  queue({ decision: "once" });
  fake.state.waiting.set(session, [permission("shell: ls", "per_2")]);
  await tick();
  expect(request()).toMatchObject({
    state: "stale",
    reason: "OpenCode no longer lists it as waiting.",
  });

  queue({ decision: "reject" }, 2);
  // The stop runs first, so the queued answer meets a stopped worker.
  expect((await call("/workers/1/stop", "POST")).status).toBe(200);
  await tick();
  expect(fake.state.answers).toEqual([]);
  expect(request(2)?.state).toBe("stale");
});

test("an answer in flight holds the session's gate, so a stop waits for it and nothing lands after the interrupt", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission()]);
  await tick();
  queue({ decision: "once" });
  const order: string[] = [];
  let stop: Promise<Response> | undefined;
  // The first read is the worker's pass; the second is the answer's fresh check, inside the gate.
  let reads = 0;
  fake.state.onWaiting = () => {
    if (++reads === 2) stop = call("/workers/1/stop", "POST");
  };
  fake.state.onAnswer = () => order.push("answer");
  fake.state.onInterrupt = () => order.push("interrupt");
  await tick();
  expect((await stop)?.status).toBe(200);
  expect(order).toEqual(["answer", "interrupt"]);
  expect(db.select().from(workers).get()).toMatchObject({ state: "done", outcome: "stopped" });
});

test("open-dot won't approve what it recognizes as off limits, but the dot may reject it", async () => {
  const off = [
    "shell: git push --force origin main",
    "shell: git reset --hard HEAD~1",
    "shell: rm -rf ~/Documents",
    "shell: rm -rf /Users/me/other",
    "edit: /Users/me/.config/opencode/opencode.json",
    "shell: gh pr merge 12",
    "shell: gh pr ready 12",
    "shell: npm publish",
    "shell: gh pr edit 3 --add-reviewer bob",
    "slack_send_message: hello",
    "shell: *",
  ];
  for (const summary of off) {
    const [action = "", resource = ""] = summary.split(": ");
    expect(
      prohibited({ kind: "permission", action, resources: [resource] }, "/work/1"),
    ).toBeString();
  }
  for (const resource of [
    "rm -rf build",
    "rm -rf /work/1/dist",
    "git push origin dot/jojo-1",
    "bun test",
  ])
    expect(
      prohibited({ kind: "permission", action: "shell", resources: [resource] }, "/work/1"),
    ).toBeUndefined();

  expect(
    prohibited(
      { kind: "permission", action: "edit", resources: ["/work/1/docs/deploy.md"] },
      "/work/1",
    ),
  ).toBeUndefined();

  const session = running();
  fake.state.waiting.set(session, [permission("shell: git push --force")]);
  await tick();
  expect(toDot()[0]).toContain("open-dot won't approve it");
  expect(queue({ decision: "once" })).toContain("won't approve");
  expect(queue({ decision: "reject" })).toMatchObject({ state: "queued" });
  await tick();
  expect(fake.state.answers.map((sent) => sent.answer)).toEqual([{ decision: "reject" }]);
});

const elsewhere = (resource: string) =>
  prohibited(
    { kind: "permission", action: "external_directory", resources: [resource] },
    "/work/1",
  );

test("open-dot leaves an ordinary external directory to the dot, but never the home or config directory", () => {
  expect(elsewhere("/Users/me/deploy-tools/*")).toBeUndefined();
  expect(elsewhere("/private/var/folders/x/T/opencode/*")).toBeUndefined();
  for (const resource of ["/*", `${homedir()}/*`, `${homedir()}/.config/opencode/*`])
    expect(elsewhere(resource)).toBeString();
});

test("a request notice steers ahead of queued input, and the grace starts once it's sent", async () => {
  const session = running();
  db.transaction((tx) => enqueue(tx, "ses_jojo", "Earlier message."));
  fake.state.waiting.set(session, [permission()]);
  const before = Date.now();
  await tick();
  const notice = request()?.noticeID;
  expect(notice).toBeString();
  expect(fake.state.prompted[0]).toBe(notice as string);
  expect(fake.state.deliveries.get(notice as string)).toBe("steer");
  expect(request()?.noticedAt).toBeGreaterThanOrEqual(before);
  expect(toDot()).toEqual([expect.stringContaining("Answer it now"), "Earlier message."]);
});

test("a request notice waits out a Slack turn, and goes to the owner if it never reaches the dot", async () => {
  const session = running();
  const route = {
    kind: "shared",
    dot: "jojo",
    sessionID: "ses_jojo",
    owner: "U1",
    team: "T1",
    bot: "B1",
    dm: true,
    channel: "D1",
    thread: "1.0",
  } as const;
  db.insert(outbox)
    .values({
      sessionID: "ses_jojo",
      messageID: "msg_slack",
      text: "From Slack.",
      route,
      state: "sent",
      delivery: "queue",
      startedAt: 0,
      createdAt: 0,
    })
    .run();
  fake.state.waiting.set(session, [permission()]);
  await tick();
  expect(toDot()).toEqual([]);
  expect(request()).toMatchObject({ state: "open", noticedAt: null });
  const created = request()?.createdAt ?? 0;
  settleRequests(db, created + graceMs * 2);
  expect(request()?.state).toBe("open");
  settleRequests(db, created + unseenLimitMs);
  expect(request()).toMatchObject({
    state: "escalated",
    reason: "Its notice didn't reach the dot within fifteen minutes.",
  });
});

const needs = async () =>
  ((await (await call("/dots")).json()) as { workers: { needs: string[] }[] }[])[0]?.workers[0]
    ?.needs;

test("unanswered past the grace period, a request needs the owner once, and is no longer the dot's to answer", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission()]);
  await tick();
  expect(await needs()).toEqual([]);
  db.update(requests)
    .set({ noticedAt: Date.now() - graceMs })
    .run();
  expect(await needs()).toEqual(["permission"]);
  await tick();
  await tick();
  expect(request()).toMatchObject({
    state: "escalated",
    reason: "Nobody answered it within two minutes.",
  });
  expect(toDot().filter((text) => text.startsWith("Needs your owner"))).toHaveLength(1);
  expect(queue({ decision: "once" })).toContain("with your owner");
  // Once the owner answers it in OpenCode, it no longer needs them.
  fake.state.waiting.delete(session);
  await tick();
  expect(await needs()).toEqual([]);
});

test("a lost answer stays unknown, tells the owner once, and is never sent again, even after a restart", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission(), permission("shell: ls", "per_2")]);
  await tick();
  queue({ decision: "once" });
  fake.state.answer = "lost";
  await tick();
  await tick();
  expect(fake.state.answers).toHaveLength(1);
  expect(request()).toMatchObject({ state: "unknown" });
  expect(toDot().filter((text) => text.startsWith("Needs your owner"))).toHaveLength(1);

  // A daemon that stopped between saving the attempt and the call's answer.
  db.update(requests)
    .set({ state: "answering", attemptedAt: 1, answer: { decision: "once" } })
    .where(eq(requests.id, 2))
    .run();
  fake = fakeOpenCode();
  fake.state.sessions.add(session);
  fake.state.active.add(session);
  fake.state.waiting.set(session, [permission("shell: ls", "per_2")]);
  await tick();
  await tick();
  expect(fake.state.answers).toEqual([]);
  expect(request(2)).toMatchObject({ state: "unknown" });
  // Unknown, but not inferred done when it leaves OpenCode.
  fake.state.waiting.delete(session);
  await tick();
  expect(request(2)?.state).toBe("unknown");
  // Nothing about either request was told again after the restart.
  expect(toDot().filter((text) => text.includes("is waiting on"))).toEqual([]);
});

test("the dot's own escalation queues one message, and the audit is read-only, authenticated and outlives the worker", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission()]);
  await tick();
  db.update(workers).set({ state: "done", outcome: "succeeded" }).run();
  await tick();
  const audit = await call("/dots/jojo/requests");
  expect(audit.status).toBe(200);
  expect(await audit.json()).toEqual({
    requests: [
      expect.objectContaining({
        id: 1,
        source: "worker",
        worker: 1,
        sessionID: session,
        kind: "permission",
        requestID: "per_1",
        state: "open",
        needsYou: false,
        detail: { kind: "permission", action: "shell", resources: ["bun test"] },
        goneAt: expect.any(Number),
      }),
    ],
    next: null,
  });
  expect((await call("/dots/jojo/requests", "GET", "wrong")).status).toBe(401);
  expect((await call("/dots/jojo/requests", "POST")).status).toBe(404);
  expect((await call("/dots/nobody/requests")).status).toBe(404);
});

const threadsWorker = (coordinatorID = "ses_jojo") => ({
  workerID: "ses_t1",
  coordinatorID,
  title: "Research",
  directory: "/repo",
  hidden: false,
});

test("a Threads worker of the dot's exact session is detected and answered after a fresh snapshot", async () => {
  fake.state.threads.set("ses_jojo", [threadsWorker()]);
  fake.state.waiting.set("ses_t1", [permission()]);
  await threadsTick();
  await threadsTick();
  expect(toDot()).toHaveLength(0);
  await tick();
  expect(toDot()).toEqual([
    expect.stringContaining("Your Threads worker session ses_t1 is waiting on"),
  ]);
  const listed = (await (await call("/dots")).json()) as { sessions: unknown[] }[];
  expect(listed[0]?.sessions).toEqual([
    expect.objectContaining({
      request: 1,
      sessionID: "ses_t1",
      title: "Research",
      waiting: ["permission"],
    }),
  ]);

  queue({ decision: "once" });
  fake.state.threadsCalls = [];
  await tick();
  expect(fake.state.threadsCalls).toEqual([{ directory: "/dots/jojo", coordinatorID: "ses_jojo" }]);
  expect(fake.state.answers).toHaveLength(1);
  expect(request()?.state).toBe("answered");

  // The Threads row opens its session; stopping stays in Threads.
  expect((await call("/requests/1/open", "POST")).status).toBe(200);
  expect(runs[0]?.at(-1)).toContain("-s 'ses_t1'");
  expect((await call("/requests/1/stop", "POST")).status).toBe(404);
});

test("a Threads worker of another coordinator, or an unavailable snapshot, is never the dot's", async () => {
  fake.state.threads.set("ses_jojo", [threadsWorker("ses_someone")]);
  fake.state.waiting.set("ses_t1", [permission()]);
  await threadsTick();
  expect(db.select().from(requests).all()).toEqual([]);

  fake.state.threads.set("ses_jojo", [threadsWorker()]);
  await threadsTick();
  expect(request()?.source).toBe("threads");

  // Unavailable while the answer waits: refused, never sent.
  queue({ decision: "once" });
  fake.state.threads.set("ses_jojo", "unavailable");
  await tick();
  expect(fake.state.answers).toEqual([]);
  expect(request()).toMatchObject({ state: "escalated" });

  // Unavailable detection changes nothing it already knew.
  await threadsTick();
  expect(request()?.goneAt).toBeNull();
});

test("a Threads worker whose coordinator changes before the answer is sent gets nothing", async () => {
  fake.state.threads.set("ses_jojo", [threadsWorker()]);
  fake.state.waiting.set("ses_t1", [permission(), permission("shell: ls", "per_2")]);
  await threadsTick();
  queue({ decision: "once" });
  fake.state.threads.set("ses_jojo", [threadsWorker("ses_dio")]);
  await tick();
  expect(fake.state.answers).toEqual([]);
  expect(request()).toMatchObject({
    state: "escalated",
    reason: "Threads doesn't list it as the dot's worker.",
  });

  // The dot's binding replaced after the snapshot, before the call.
  fake.state.threads.set("ses_jojo", [threadsWorker()]);
  queue({ decision: "once" }, 2);
  fake.state.onWaiting = () => {
    db.update(dots).set({ sessionID: "ses_jojo2" }).where(eq(dots.name, "jojo")).run();
  };
  await tick();
  expect(fake.state.answers).toEqual([]);
  expect(request(2)?.state).toBe("escalated");
  expect(db.select().from(outbox).all().length).toBeGreaterThan(0);
});

test("a form that may ask for a secret keeps only a fixed title, and one sending the owner elsewhere counts too", () => {
  const external = formWaiting({
    id: "frm_x",
    title: "Authorize the app",
    fields: [{ key: "auth", type: "external", url: "https://example.com/oauth?code=abc" }],
  });
  expect(external).toEqual({
    id: "frm_x",
    kind: "question",
    summary: redactedQuestion,
    detail: { kind: "question", title: redactedQuestion, fields: [] },
    sensitive: true,
  });
  const plain = formWaiting({
    id: "frm_y",
    title: "Which branch?",
    fields: [{ key: "branch", type: "string", options: [{ value: "main", label: "main" }] }],
  });
  expect(plain).toMatchObject({ sensitive: false, detail: { title: "Which branch?" } });
});

test("a pending list that can't be read sends nothing and asks the owner once", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission()]);
  await tick();
  queue({ decision: "once" });
  fake.state.superviseFailure = true;
  await tick();
  await tick();
  expect(fake.state.answers).toEqual([]);
  expect(request()).toMatchObject({ state: "escalated", attemptedAt: null });
  expect(request()?.reason).toContain("couldn't read what the worker waits on");
  expect(toDot().filter((text) => text.startsWith("Needs your owner"))).toHaveLength(1);
});

test("an answer that isn't once, reject, a reply or a cancel never reaches OpenCode", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission(), permission("shell: ls", "per_2")]);
  await tick();
  const always = { decision: "always" } as unknown as RequestAnswer;
  expect(queue(always)).toContain("never always");
  expect(queue({ decision: "once", extra: 1 } as unknown as RequestAnswer)).toContain(
    "never always",
  );
  // A row written around the tools, as an older or broken writer might.
  db.update(requests)
    .set({ state: "queued", answer: always, actorSession: "ses_jojo", queuedAt: 1 })
    .where(eq(requests.id, 2))
    .run();
  await tick();
  expect(fake.state.answers).toEqual([]);
  expect(request(2)?.state).toBe("escalated");
});

test("an unknown answer keeps needing the owner after the request leaves and the worker finishes, without more notices", async () => {
  const session = running();
  fake.state.waiting.set(session, [permission()]);
  await tick();
  queue({ decision: "once" });
  fake.state.answer = "lost";
  await tick();
  expect(request()?.state).toBe("unknown");
  const queuedToDot = () =>
    db.select().from(outbox).where(eq(outbox.sessionID, "ses_jojo")).all().length;
  const notices = queuedToDot();
  fake.state.waiting.delete(session);
  await tick();
  db.update(workers).set({ state: "done", outcome: "succeeded" }).run();
  await tick();
  await tick();
  const [jojo] = (await (await call("/dots")).json()) as {
    workers: unknown[];
    sessions: { source: string; worker: number; needs: string[]; answered: string }[];
  }[];
  expect(jojo?.workers).toEqual([]);
  expect(jojo?.sessions).toEqual([
    expect.objectContaining({
      source: "worker",
      worker: 1,
      needs: ["permission"],
      answered: "Approved once (outcome unknown)",
    }),
  ]);
  expect(request()).toMatchObject({ state: "unknown", goneAt: expect.any(Number) });
  expect(queuedToDot()).toBe(notices);
});

test("a Threads answer whose outcome is lost stays visible after Threads stops listing it", async () => {
  fake.state.threads.set("ses_jojo", [threadsWorker()]);
  fake.state.waiting.set("ses_t1", [permission()]);
  await threadsTick();
  queue({ decision: "once" });
  fake.state.answer = "lost";
  await tick();
  fake.state.threads.set("ses_jojo", []);
  await threadsTick();
  const [jojo] = (await (await call("/dots")).json()) as { sessions: unknown[] }[];
  expect(jojo?.sessions).toEqual([
    expect.objectContaining({ source: "threads", sessionID: "ses_t1", needs: ["permission"] }),
  ]);
});

const shell = (resource: string, at: string | null) =>
  prohibited({ kind: "permission", action: "shell", resources: [resource] }, at);

test("deletions are approved only inside the worktree open-dot made for the worker", async () => {
  const root = "/home/.opendot/worktrees/jojo/1";
  for (const inside of ["rm -rf build", `rm -rf ${root}/dist`, "git rm old.ts", "bun test"])
    expect(shell(inside, root)).toBeUndefined();
  for (const outside of [
    "rm -rf /home/.opendot/worktrees/jojo/10",
    "rm -rf ../shared",
    "rm -rf ~/x",
    "cd /tmp && rm -rf x",
    "git -C /repo clean -fdx",
    "mv build /tmp/elsewhere",
  ])
    expect(shell(outside, root)).toBeString();
  // Without a worktree of its own, nothing that deletes is approved, even a relative path.
  expect(shell("rm -rf build", null)).toContain("no worktree of its own");
  expect(shell("bun test", null)).toBeUndefined();
  expect(shell("git merge main", root)).toBe("merges branches");
  expect(shell("git branch -D other", root)).toBeString();

  // A worker with its own worktree may delete inside it; one in a scratch directory may not.
  running(1);
  running(2);
  db.update(workers)
    .set({ source: "/repo", branch: "dot/jojo-1", directory: worktreeDirectory("jojo", 1) })
    .where(eq(workers.id, 1))
    .run();
  fake.state.waiting.set("ses_w1", [permission("shell: rm -rf build")]);
  fake.state.waiting.set("ses_w2", [permission("shell: rm -rf build", "per_2")]);
  await tick();
  expect(queue({ decision: "once" }, 1)).toMatchObject({ state: "queued" });
  expect(queue({ decision: "once" }, 2)).toContain("no worktree of its own");
  // A Threads worker has no worktree open-dot can vouch for.
  fake.state.threads.set("ses_jojo", [threadsWorker()]);
  fake.state.waiting.set("ses_t1", [permission("shell: rm -rf build", "per_3")]);
  await threadsTick();
  expect(queue({ decision: "once" }, 3)).toContain("no worktree of its own");
});

test("a Threads answer is authorized by a snapshot read after the pending list, in the directory first seen", async () => {
  fake.state.threads.set("ses_jojo", [threadsWorker()]);
  fake.state.waiting.set("ses_t1", [permission(), permission("shell: ls", "per_2")]);
  await threadsTick();
  const order: string[] = [];
  fake.state.onWaiting = () => {
    order.push("waiting");
    // Threads hands the worker to another coordinator while the pending list is read.
    fake.state.threads.set("ses_jojo", [threadsWorker("ses_dio")]);
  };
  queue({ decision: "once" });
  fake.state.threadsCalls = [];
  await tick();
  expect(order).toEqual(["waiting"]);
  expect(fake.state.threadsCalls).toHaveLength(1);
  expect(fake.state.answers).toEqual([]);
  expect(request()?.reason).toBe("Threads doesn't list it as the dot's worker.");

  fake.state.onWaiting = () => {
    fake.state.threads.set("ses_jojo", [{ ...threadsWorker(), directory: "/elsewhere" }]);
  };
  queue({ decision: "once" }, 2);
  await tick();
  expect(fake.state.answers).toEqual([]);
  expect(request(2)?.reason).toBe("Threads lists it in another directory now.");
});

test("Threads detection writes nothing once the dot's binding changed during its reads", async () => {
  fake.state.threads.set("ses_jojo", [threadsWorker()]);
  fake.state.waiting.set("ses_t1", [permission()]);
  fake.state.onWaiting = () => {
    db.update(dots).set({ sessionState: "creating" }).where(eq(dots.name, "jojo")).run();
  };
  await threadsTick();
  expect(db.select().from(requests).all()).toEqual([]);
  expect(db.select().from(outbox).all()).toEqual([]);
});

test("the audit pages back by ID, so an old request and its complete answer stay reachable", async () => {
  running();
  const base = {
    dot: "jojo",
    source: "worker" as const,
    worker: 1,
    sessionID: "ses_w1",
    title: "Task 1.",
    directory: "/work/1",
    kind: "question" as const,
    detail: {
      kind: "question" as const,
      title: "Notes?",
      fields: [{ key: "notes", type: "string", options: [{ value: "a", label: "A" }] }],
    },
    state: "open" as const,
    createdAt: 1,
    goneAt: 2,
  };
  db.insert(requests)
    .values(Array.from({ length: 150 }, (_, index) => ({ ...base, requestID: `frm_${index + 1}` })))
    .run();
  const long = "x".repeat(500);
  db.update(requests)
    .set({ state: "answered", answer: { decision: "reply", answer: { notes: long } }, queuedAt: 3 })
    .where(eq(requests.id, 1))
    .run();
  type Page = {
    requests: { id: number; requestID: string; answerText: string | null; detailText: string }[];
    next: number | null;
  };
  const first = (await (await call("/dots/jojo/requests")).json()) as Page;
  expect(first.requests).toHaveLength(100);
  expect(first.requests[0]?.id).toBe(150);
  expect(first.next).toBe(51);
  const older = (await (await call(`/dots/jojo/requests?before=${first.next}`)).json()) as Page;
  expect(older.requests.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, i) => 50 - i));
  expect(older.next).toBeNull();
  const oldest = older.requests.at(-1);
  expect(oldest?.requestID).toBe("frm_1");
  expect(JSON.parse(oldest?.answerText ?? "null")).toEqual({
    decision: "reply",
    answer: { notes: long },
  });
  expect(oldest?.detailText).toContain('"value": "a"');
  expect((await call("/dots/jojo/requests?before=0")).status).toBe(400);
  expect((await call("/dots/jojo/requests?before=abc")).status).toBe(400);
  expect((await call("/dots/jojo/requests?limit=5")).status).toBe(400);
});
