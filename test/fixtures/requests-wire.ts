import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Effect, Exit, Schema } from "effect";
import { Permission } from "@opencode/client/effect";
import { api } from "../../src/api";
import { answerAll, watchThreads } from "../../src/daemon";
import { openDatabase } from "../../src/db";
import { OpenCode, redactedQuestion } from "../../src/opencode";
import { queueAnswer } from "../../src/requests";
import { dots, outbox, requests, type RequestAnswer } from "../../src/schema";

// A subprocess with isolated XDG paths: never touch the user's service registration.
const home = process.env.OPEN_DOT_HOME;
assert(home !== undefined);
assert(home.startsWith(join(process.cwd(), ".research/requests-wire-")));
assert.equal(process.env.XDG_STATE_HOME, join(home, "state"));
const run = <A, E>(effect: Effect.Effect<A, E, OpenCode>) =>
  Effect.runPromise(Effect.provide(effect, OpenCode.layer));
const coordinatorID = "ses_wireDot";
const sessionID = "ses_wireWorker";
const directory = "/fixture/dot";
const db = openDatabase(":memory:");
db.insert(dots)
  .values({
    name: "wire",
    directory,
    sessionID: coordinatorID,
    sessionState: "ready",
    createdAt: 0,
  })
  .run();
const checks: string[] = [];
const wire: { method: string; path: string; query: string; body: unknown }[] = [];
const permission = (id: string) => ({
  id,
  sessionID,
  action: "shell",
  resources: ["bun test", "bun run typecheck"],
  message: "Run the assigned checks",
});
let permissions = [permission("per_once"), permission("per_reject"), permission("per_lost")];
const fields = [
  {
    key: "branch",
    type: "string",
    title: "Branch",
    description: "Choose a branch",
    required: true,
    options: [
      { value: "main", label: "Main", description: "Stable" },
      { value: "dev", label: "Development" },
    ],
    custom: false,
  },
  { key: "count", type: "integer", minimum: 1, maximum: 5, default: 2 },
  { key: "confirm", type: "boolean", default: false },
  {
    key: "targets",
    type: "multiselect",
    options: [{ value: "mac", label: "Mac" }],
    minItems: 1,
    maxItems: 1,
  },
];
const question = (id: string) => ({ id, sessionID, title: "Build choices", fields });
const secretWords = [
  "fixture-sensitive-title",
  "fixture-sensitive-hint",
  "fixture-sensitive-value",
];
const sensitive = {
  id: "frm_secret",
  sessionID,
  title: secretWords[0],
  metadata: { token: secretWords[1] },
  fields: [{ key: "credential", type: "string", default: secretWords[2] }],
};
let forms = [question("frm_reply"), question("frm_cancel"), sensitive];
let malformed = false;
let badRoute = false;
let attempts = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const text = await request.text();
    const body: unknown = text ? JSON.parse(text) : null;
    wire.push({ method: request.method, path: url.pathname, query: url.search, body });
    assert.equal(
      request.headers.get("authorization"),
      `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`,
    );
    if (url.pathname === "/api/info") return Response.json({ version: "2.1.1", pid: process.pid });
    if (request.method === "GET" && url.pathname === `/api/session/${sessionID}/permission`)
      return Response.json({ data: permissions });
    if (request.method === "GET" && url.pathname === `/api/session/${sessionID}/form`)
      return Response.json({ data: forms });
    if (request.method === "GET" && url.pathname === "/api/session/active")
      return Response.json({});
    if (request.method === "POST" && url.pathname === "/api/rpc/threads/snapshot") {
      assert.deepEqual(body, { input: { coordinatorIDs: [coordinatorID] } });
      assert.equal(url.searchParams.get("location[directory]"), directory);
      return Response.json(
        malformed
          ? { output: { workers: [{ workerID: sessionID }] } }
          : {
              output: {
                workers: [
                  {
                    workerID: sessionID,
                    coordinatorID,
                    directory: "/fixture/worker",
                    title: "Wire worker",
                    hidden: false,
                  },
                ],
              },
            },
      );
    }
    const match = url.pathname.match(
      /^\/api\/session\/ses_wireWorker\/(permission|form)\/([^/]+)(\/reply)?$/,
    );
    if (match) {
      const id = match[2];
      assert(id !== undefined);
      const saved = db.select().from(requests).where(eq(requests.requestID, id)).get();
      assert.equal(saved?.state, "answering");
      assert.equal(typeof saved?.attemptedAt, "number");
      assert.equal(saved?.confirmedAt, null);
      attempts++;
      if (match[1] === "permission") {
        assert.equal(request.method, "POST");
        assert.equal(match[3], "/reply");
        // Installed @opencode/protocol/groups/permission.js:95-100 uses this payload schema.
        const payload = Schema.decodeUnknownSync(
          Schema.Struct({ decision: Permission.Reply, message: Schema.optional(Schema.String) }),
        )(body);
        assert.equal(payload.decision, id === "per_reject" ? "reject" : "once");
        permissions = permissions.filter((item) => item.id !== id);
        if (id === "per_lost") return new Response("lost confirmation", { status: 500 });
      } else if (id === "frm_reply") {
        assert.equal(request.method, "POST");
        assert.equal(match[3], "/reply");
        assert.deepEqual(body, {
          answer: { branch: "dev", count: 3, confirm: true, targets: ["mac"] },
        });
        forms = forms.filter((item) => item.id !== id);
      } else {
        assert.equal(id, "frm_cancel");
        assert.equal(request.method, "DELETE");
        assert.equal(match[3], undefined);
        assert.equal(body, null);
        forms = forms.filter((item) => item.id !== id);
      }
      return new Response(null, { status: 204 });
    }
    badRoute = true;
    return new Response("unexpected fake route", { status: 500 });
  },
});
const base = server.url.origin;
const nativeFetch = globalThis.fetch;
// Defense in depth: an accidental fallback can never access a live endpoint.
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, base, "non-fixture network access forbidden");
    return nativeFetch(input, init);
  },
  nativeFetch,
);
try {
  const stateDir = join(home, "state/opencode");
  await mkdir(stateDir, { recursive: true });
  await Bun.write(
    join(stateDir, "service.json"),
    JSON.stringify({
      id: "fixture",
      version: "2.1.1",
      pid: process.pid,
      url: base,
      password: "fixture-password",
    }),
  );
  const pending = await run(Effect.flatMap(OpenCode, (client) => client.waiting(sessionID)));
  assert.deepEqual(pending[0]?.detail, {
    kind: "permission",
    action: "shell",
    resources: permission("per_once").resources,
    message: permission("per_once").message,
  });
  assert.deepEqual(pending.find((item) => item.id === "frm_reply")?.detail, {
    kind: "question",
    title: "Build choices",
    fields,
  });
  assert.deepEqual(
    pending.find((item) => item.id === "frm_secret"),
    {
      id: "frm_secret",
      kind: "question",
      summary: redactedQuestion,
      detail: { kind: "question", title: redactedQuestion, fields: [] },
      sensitive: true,
    },
  );
  checks.push(
    "GET permission action/resources/message and complete form fields/options",
    "sensitive form fully redacted at installed client boundary",
  );

  await run(watchThreads(db));
  await run(watchThreads(db));
  assert.equal(db.select().from(requests).all().length, 6);
  assert.equal(db.select().from(outbox).all().length, 6);
  const kept = JSON.stringify([db.select().from(requests).all(), db.select().from(outbox).all()]);
  for (const word of secretWords) assert(!kept.includes(word));
  assert(!kept.includes("credential"));
  checks.push(
    "real generic RPC snapshot carries directory and exact coordinator input",
    "notice dedup and redaction in persisted audit and outbox",
  );

  const row = (id: string) => {
    const found = db.select().from(requests).where(eq(requests.requestID, id)).get();
    assert(found !== undefined);
    return found;
  };
  const queue = (id: string, answer: RequestAnswer) =>
    queueAnswer(db, {
      id: row(id).id,
      dot: "wire",
      actorSession: coordinatorID,
      kind: row(id).kind,
      answer,
    });
  assert.equal(
    typeof queue("per_once", { decision: "always" } as unknown as RequestAnswer),
    "string",
  );
  const before = wire.length;
  const invalid = await run(
    Effect.flatMap(OpenCode, (client) =>
      client.answer(sessionID, "permission", "per_once", {
        decision: "always",
      } as unknown as RequestAnswer),
    ).pipe(Effect.exit),
  );
  assert(Exit.isFailure(invalid));
  assert.equal(wire.length, before + 1); // discovery probe only; no answer request
  for (const [id, answer] of [
    ["per_once", { decision: "once" }],
    ["per_reject", { decision: "reject" }],
    ["per_lost", { decision: "once" }],
    [
      "frm_reply",
      { decision: "reply", answer: { branch: "dev", count: 3, confirm: true, targets: ["mac"] } },
    ],
    ["frm_cancel", { decision: "cancel" }],
  ] as const)
    assert.equal(typeof queue(id, answer), "object");
  await run(answerAll(db));
  assert.equal(attempts, 5);
  for (const id of ["per_once", "per_reject", "frm_reply", "frm_cancel"]) {
    assert.equal(row(id).state, "answered");
    assert.equal(typeof row(id).confirmedAt, "number");
    assert.equal(row(id).actorSession, coordinatorID);
  }
  assert.equal(row("per_lost").state, "unknown");
  assert.equal(row("per_lost").confirmedAt, null);
  checks.push(
    "permission once/reject NEVER always",
    "form answer map and DELETE cancel",
    "daemon attempts persisted before HTTP reply",
    "confirmed audit includes answering session and times",
  );

  await run(watchThreads(db)); // removes vanished requests, never settles an unknown answer
  const count = db.select().from(outbox).all().length;
  await run(answerAll(db));
  // A fresh layer discovers again, just as after daemon restart; no replay.
  await run(answerAll(db));
  assert.equal(attempts, 5);
  assert.equal(row("per_lost").state, "unknown");
  assert.equal(typeof row("per_lost").goneAt, "number");
  assert.equal(db.select().from(outbox).all().length, count);
  assert(
    db
      .select()
      .from(outbox)
      .all()
      .every((item) => item.route === null),
  );
  checks.push("unknown never replayed after disappearance and restart");

  const handler = api(db, "fixture-api-token", OpenCode.layer, async () => {
    throw new Error("native operation forbidden");
  });
  assert.equal((await handler(new Request("http://fixture/dots/wire/requests"))).status, 401);
  const result = await handler(
    new Request("http://fixture/dots/wire/requests", {
      headers: { authorization: "Bearer fixture-api-token" },
    }),
  );
  assert.equal(result.status, 200);
  const audit = (await result.json()) as {
    requests: { requestID: string; answerText: string; needsYou: boolean; actorSession: string }[];
  };
  const formReply = audit.requests.find((item) => item.requestID === "frm_reply");
  assert(formReply !== undefined);
  assert.deepEqual(JSON.parse(formReply.answerText), {
    decision: "reply",
    answer: { branch: "dev", count: 3, confirm: true, targets: ["mac"] },
  });
  assert.equal(audit.requests.find((item) => item.requestID === "per_lost")?.needsYou, true);
  checks.push("authenticated audit serves complete wire-confirmed form answer and unknown needs");

  malformed = true;
  const failed = await run(
    Effect.flatMap(OpenCode, (client) => client.threadsWorkers(directory, coordinatorID)).pipe(
      Effect.exit,
    ),
  );
  assert(Exit.isFailure(failed));
  const rowsBefore = JSON.stringify(db.select().from(requests).all());
  await run(watchThreads(db));
  assert.equal(JSON.stringify(db.select().from(requests).all()), rowsBefore);
  assert.equal(attempts, 5);
  assert.equal(badRoute, false);
  assert(wire.some((item) => item.path === "/api/info"));
  assert(!wire.some((item) => item.path.includes("restore")));
  checks.push(
    "malformed RPC fails closed with no detection mutation or answer",
    "actual isolated Service.discover health probe; no restore or live traffic",
  );
} finally {
  console.log(JSON.stringify({ checks, requests: wire }));
  globalThis.fetch = nativeFetch;
  await server.stop(true);
}
