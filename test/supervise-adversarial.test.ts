import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Service } from "@opencode/client/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { api } from "../src/api";
import { deliver, step, superviseAll } from "../src/daemon";
import { type Db, openDatabase } from "../src/db";
import { OpenCode } from "../src/opencode";
import { dots, outbox, supervisions } from "../src/schema";
import { endBinding, saveBinding, sentByDot } from "../src/supervise";
import { fakeOpenCode } from "./fake-opencode";

let db: Db;
let path: string;
let fake: ReturnType<typeof fakeOpenCode>;
const owner = "ses_owner1";

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "issue27-adversarial-")), "open-dot.db");
  db = openDatabase(path);
  db.insert(dots)
    .values({
      name: "jojo",
      directory: "/fake/dot",
      sessionID: "ses_jojo",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
  fake = fakeOpenCode();
  fake.state.directories.set(owner, "/fake/owner");
});

afterEach(() => db.$client.close());

const bind = (mode: "watch" | "send" = "watch", state: "active" | "requested" = "active") => {
  const row = saveBinding(
    db,
    { dot: "jojo", sessionID: owner, directory: "/fake/owner", mode, busyMinutes: 1 },
    state,
  );
  if (typeof row === "string") throw new Error(row);
  return row;
};
const end = (id: string, time: number) => ({
  id,
  time,
  outcome: "succeeded" as const,
  text: id,
  error: undefined,
});
const tick = () => Effect.runPromise(step(db).pipe(Effect.provide(fake.layer)));
const watch = () => Effect.runPromise(superviseAll(db).pipe(Effect.provide(fake.layer)));
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );
const rows = () => db.select().from(outbox).all();
const reopen = () => {
  db.$client.close();
  db = openDatabase(path);
};
const queue = (id: number) =>
  db
    .insert(outbox)
    .values({
      sessionID: owner,
      messageID: "msg_dotSend",
      text: sentByDot("jojo", "tests please"),
      fromDot: "jojo",
      supervision: id,
      state: "pending",
      createdAt: 0,
    })
    .returning()
    .get();

test("issue27: equal-time terminal IDs discovered on separate polls survive restart", async () => {
  const binding = bind();
  const time = (binding.activatedAt ?? binding.createdAt) + 100;
  fake.state.ends.set(owner, [end("msg_first", time)]);
  await tick();
  reopen();
  fake.state.ends.set(owner, [end("msg_first", time), end("msg_second", time)]);
  await tick();
  await tick();
  expect(rows()).toHaveLength(2);
  expect(
    rows()
      .map((row) => row.text)
      .join(),
  ).toContain("msg_second");
});

test("issue27: equal-time terminal IDs in one poll are distinct and are not replayed", async () => {
  const binding = bind();
  const time = (binding.activatedAt ?? binding.createdAt) + 100;
  fake.state.ends.set(owner, [end("msg_first", time), end("msg_second", time)]);
  await tick();
  reopen();
  await tick();
  expect(rows()).toHaveLength(2);
});

test("issue27: a waiting ID is never reported twice after absent poll and restart", async () => {
  bind();
  fake.state.waiting.set(owner, [{ id: "per_same", kind: "permission", summary: "shell" }]);
  await tick();
  fake.state.waiting.set(owner, []);
  await tick();
  reopen();
  fake.state.waiting.set(owner, [{ id: "per_same", kind: "permission", summary: "shell" }]);
  await tick();
  expect(rows()).toHaveLength(1);
});

test("issue27: concurrent waiting IDs and busy once-per-interval persist across reopen", async () => {
  const binding = bind();
  fake.state.active.add(owner);
  fake.state.waiting.set(owner, [
    { id: "per_a", kind: "permission", summary: "shell a" },
    { id: "per_b", kind: "permission", summary: "shell b" },
    { id: "frm_a", kind: "question", summary: "branch?" },
    { id: "frm_b", kind: "question", summary: "test?" },
  ]);
  await tick();
  db.update(supervisions)
    .set({ busySince: Date.now() - 61_000 })
    .where(eq(supervisions.id, binding.id))
    .run();
  reopen();
  await tick();
  reopen();
  await tick();
  expect(rows()).toHaveLength(5);
  fake.state.active.clear();
  await tick();
  fake.state.active.add(owner);
  await tick();
  db.update(supervisions)
    .set({ busySince: Date.now() - 61_000 })
    .where(eq(supervisions.id, binding.id))
    .run();
  await tick();
  expect(rows()).toHaveLength(6);
});

test("issue27: event cursor and notice insert roll back together", async () => {
  const binding = bind();
  fake.state.ends.set(owner, [end("msg_atomic", (binding.activatedAt ?? binding.createdAt) + 100)]);
  db.$client.exec(
    "CREATE TRIGGER fail_notice BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;",
  );
  expect(await rejection(watch())).toBeDefined();
  expect(db.select().from(supervisions).get()?.seenAt).toBe(binding.seenAt);
  expect(rows()).toHaveLength(0);
  db.$client.exec("DROP TRIGGER fail_notice");
  await tick();
  expect(rows()).toHaveLength(1);
});

test("issue27: lost notice admission reconciles saved message ID across reopen", async () => {
  const binding = bind();
  fake.state.ends.set(owner, [end("msg_notice", (binding.activatedAt ?? binding.createdAt) + 100)]);
  fake.state.prompt = "lost";
  await tick();
  const first = rows()[0];
  if (!first) throw new Error("Missing notice");
  expect(first.state).toBe("pending");
  expect(first.startedAt).not.toBeNull();
  reopen();
  fake.state.prompt = "ok";
  await tick();
  expect(rows()).toHaveLength(1);
  expect(rows()[0]?.state).toBe("sent");
  expect(fake.state.prompted).toEqual([first.messageID]);
});

test("issue27: lost send admission plus revoke and unavailable lookup remains conservative", async () => {
  const binding = bind("send");
  const item = queue(binding.id);
  fake.state.prompt = "lost";
  await tick();
  endBinding(db, binding.id, "owner");
  reopen();
  fake.state.lookupFailure = true;
  await tick();
  expect(rows().find((row) => row.id === item.id)?.state).toBe("pending");
  fake.state.lookupFailure = false;
  await tick();
  expect(rows().find((row) => row.id === item.id)?.state).toBe("sent");
  expect(fake.state.prompted).toEqual([item.messageID]);
});

test("issue27: revoke during a suspended history lookup prevents any new notice", async () => {
  const binding = bind();
  const pending = Promise.withResolvers<readonly ReturnType<typeof end>[]>();
  const entered = Promise.withResolvers<void>();
  const original = fake.layer;
  const patched = Effect.gen(function* () {
    const service = yield* OpenCode;
    return {
      ...service,
      turnsSince: () =>
        Effect.promise(() => {
          entered.resolve();
          return pending.promise;
        }),
    };
  }).pipe(Effect.provide(original));
  const service = await Effect.runPromise(patched);
  const running = Effect.runPromise(
    superviseAll(db).pipe(Effect.provideService(OpenCode, service), Effect.timeout("2 seconds")),
  );
  await Effect.runPromise(Effect.promise(() => entered.promise).pipe(Effect.timeout("1 second")));
  // Revoke before resolving the only suspended operation; no timer or live input.
  endBinding(db, binding.id, "owner");
  pending.resolve([end("msg_revoked", (binding.activatedAt ?? binding.createdAt) + 100)]);
  await running;
  expect(rows()).toHaveLength(0);
});

test("issue27: memory binding API authenticates, scopes IDs, rejects bad IDs and serializes revoke", async () => {
  const binding = bind("send", "requested");
  let handler = api(db, "fake-secret", fake.layer);
  const call = (route: string, method: string, token = "fake-secret") =>
    handler(
      new Request(`http://127.0.0.1${route}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  const route = `/dots/jojo/memory/supervisions/${binding.id}`;
  expect((await call(`${route}/approve`, "POST", "wrong")).status).toBe(401);
  expect((await call(route, "DELETE", "")).status).toBe(401);
  expect(db.select().from(supervisions).get()?.state).toBe("requested");
  for (const id of ["0", "-1", "1.5", "9007199254740992", "abc"]) {
    expect((await call(`/dots/jojo/memory/supervisions/${id}/approve`, "POST")).status).toBe(404);
  }
  expect(
    (await call(`/dots/absent/memory/supervisions/${binding.id}/approve`, "POST")).status,
  ).toBe(404);
  expect((await call(`${route}/approve`, "POST")).status).toBe(200);
  expect((await call(`${route}/approve`, "POST")).status).toBe(409);
  reopen();
  handler = api(db, "fake-secret", fake.layer);
  expect(db.select().from(supervisions).get()).toMatchObject({
    sessionID: owner,
    directory: "/fake/owner",
    mode: "send",
    state: "active",
    createdAt: binding.createdAt,
  });
  const results = await Promise.all([call(route, "DELETE"), call(route, "DELETE")]);
  expect(results.map((result) => result.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
  const memory = (await (await call("/dots/jojo/memory", "GET")).json()) as {
    supervisions: unknown[];
  };
  expect(memory.supervisions).toEqual([]);
  expect(fake.state.prompted).toEqual([]);
});

test("issue27: owner CLI refuses model-style non-TTY activation without contacting OpenCode", () => {
  const binding = bind("send", "requested");
  const child = Bun.spawnSync(
    [process.execPath, "src/cli.ts", "watch", "approve", String(binding.id)],
    {
      env: { ...process.env, OPEN_DOT_HOME: dirname(path) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    },
  );
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("Run this in a terminal");
  expect(db.select().from(supervisions).get()?.state).toBe("requested");
});

test("issue27: revoke while message existence request is awaited cancels before prompt", async () => {
  const binding = bind("send");
  const item = queue(binding.id);
  const entered = Promise.withResolvers<void>();
  const absent = Promise.withResolvers<boolean>();
  const service = await Effect.runPromise(OpenCode.pipe(Effect.provide(fake.layer)));
  const running = Effect.runPromise(
    deliver(db, item).pipe(
      Effect.provideService(OpenCode, {
        ...service,
        messageExists: () =>
          Effect.promise(() => {
            entered.resolve();
            return absent.promise;
          }),
      }),
      Effect.timeout("2 seconds"),
    ),
  );
  await Effect.runPromise(Effect.promise(() => entered.promise).pipe(Effect.timeout("1 second")));
  endBinding(db, binding.id, "owner");
  absent.resolve(false);
  await running;
  expect(rows()[0]?.state).toBe("cancelled");
  expect(fake.state.prompted).toEqual([]);
});

test("issue27 public adapter: only a typed SessionNotFoundError means deletion", async () => {
  let typed = true;
  await withPublicAdapter(
    () =>
      typed
        ? Response.json(
            { _tag: "SessionNotFoundError", sessionID: owner, message: "gone" },
            { status: 404 },
          )
        : new Response("not found", { status: 404 }),
    async (service) => {
      expect(await Effect.runPromise(service.sessionDirectory(owner))).toBeUndefined();
      typed = false;
      expect(await rejection(Effect.runPromise(service.sessionDirectory(owner)))).toMatchObject({
        _tag: "OpenCodeError",
      });
    },
  );
});

type RawIdle = { id: string; type: string; outcome: string; time: { created: number } };

async function withPublicAdapter<T>(
  handler: (request: Request) => Response,
  run: (service: OpenCode["Service"]) => Promise<T>,
) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const discover = spyOn(Service, "discover").mockResolvedValue({
    url: server.url.href,
    auth: undefined,
  });
  try {
    const service = await Effect.runPromise(OpenCode.pipe(Effect.provide(OpenCode.layer)));
    return await run(service);
  } finally {
    discover.mockRestore();
    await server.stop(true);
  }
}

test("issue27 public adapter: 501 terminal events during downtime are all retained", async () => {
  const binding = bind();
  const start = binding.activatedAt ?? binding.createdAt;
  const history: RawIdle[] = Array.from({ length: 501 }, (_, i) => ({
    id: `msg_idle${i}`,
    type: "idle",
    outcome: "succeeded",
    time: { created: start + i + 1 },
  })).toReversed();
  const calls: string[] = [];
  await withPublicAdapter(
    (request) => {
      const url = new URL(request.url);
      calls.push(url.pathname + url.search);
      if (!url.pathname.endsWith("/message")) throw new Error("Unexpected endpoint");
      if (url.searchParams.get("type") === "assistant")
        return Response.json({ data: [], cursor: {} });
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit"));
      return Response.json({
        data: history.slice(offset, offset + limit),
        cursor: offset + limit < history.length ? { next: String(offset + limit) } : {},
      });
    },
    async (service) => {
      fake.state.ends.set(owner, [...(await Effect.runPromise(service.turnsSince(owner, start)))]);
      await tick();
      reopen();
      const since = db.select().from(supervisions).get()?.seenAt;
      if (since === undefined || since === null) throw new Error("Missing cursor");
      fake.state.ends.set(owner, [...(await Effect.runPromise(service.turnsSince(owner, since)))]);
      await tick();
      console.log(
        "issue27 adapter 501: notice count",
        rows().length,
        "idle page requests",
        calls.filter((call) => call.includes("type=idle")).length,
        "oldest retained",
        rows()[0]?.text,
      );
      expect(rows()).toHaveLength(501);
    },
  );
});

test("issue27 public adapter: multiple permissions/forms are observed without answering", async () => {
  const calls: string[] = [];
  await withPublicAdapter(
    (request) => {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname.endsWith("/permission"))
        return Response.json({
          data: ["per_a", "per_b"].map((id) => ({
            id,
            sessionID: owner,
            action: "shell",
            resources: ["test"],
          })),
        });
      if (url.pathname.endsWith("/form"))
        return Response.json({
          data: ["frm_a", "frm_b"].map((id) => ({
            id,
            sessionID: owner,
            title: "Choose",
            fields: [{ key: "branch", type: "string", description: "Which?" }],
          })),
        });
      throw new Error("Unexpected endpoint");
    },
    async (service) => {
      const waiting = await Effect.runPromise(service.waiting(owner));
      expect(waiting.map((item) => item.id)).toEqual(["per_a", "per_b", "frm_a", "frm_b"]);
      expect(waiting[2]?.summary).toBe("Choose\nWhich?");
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
    },
  );
});

test("issue27 public adapter: transport failures are not authoritative deletion", async () => {
  await withPublicAdapter(
    () => new Response("unavailable", { status: 503 }),
    async (service) => {
      expect(await rejection(Effect.runPromise(service.sessionDirectory(owner)))).toMatchObject({
        _tag: "OpenCodeError",
      });
      expect(await rejection(Effect.runPromise(service.turnsSince(owner, 0)))).toMatchObject({
        _tag: "OpenCodeError",
      });
    },
  );
});
