import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import { Effect } from "effect";
import { superviseAll } from "../src/daemon";
import { openDatabase } from "../src/db";
import { OpenCode } from "../src/opencode";
import { dots, outbox, supervisions } from "../src/schema";
import { saveBinding } from "../src/supervise";
import { fakeOpenCode } from "./fake-opencode";

const owner = "ses_reverify";
const idle = (id: string, created: number) => ({
  id,
  type: "idle",
  outcome: "succeeded",
  time: { created },
});
const assistant = (id: string, created: number, text: string) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "anthropic" },
  content: text ? [{ type: "text", text }] : [],
  time: { created },
});
const end = (id: string, time: number) => ({
  id,
  time,
  outcome: "succeeded" as const,
  text: id,
  error: undefined,
});

test("issue27 reverify: activation boundary, rolling seen IDs and dedupe transaction are durable", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "issue27-reverify-")), "test.db");
  let db = openDatabase(path);
  const fake = fakeOpenCode();
  fake.state.directories.set(owner, "/fake/session");
  const tick = () => Effect.runPromise(superviseAll(db).pipe(Effect.provide(fake.layer)));
  const reopen = () => {
    db.$client.close();
    db = openDatabase(path);
  };
  try {
    db.insert(dots)
      .values({
        name: "jojo",
        sessionID: "ses_jojo",
        directory: "/fake/dot",
        sessionState: "ready",
        createdAt: 0,
      })
      .run();
    const binding = saveBinding(
      db,
      { dot: "jojo", sessionID: owner, directory: "/fake/session", mode: "watch", busyMinutes: 1 },
      "active",
    );
    if (typeof binding === "string") throw new Error(binding);
    const start = binding.createdAt;
    fake.state.ends.set(owner, [end("msg_prebinding", start), end("msg_older", start - 1)]);
    await tick();
    expect(db.select().from(outbox).all()).toHaveLength(0);
    expect(db.select().from(supervisions).get()?.seenIDs).toEqual([]);
    fake.state.ends.set(owner, [end("msg_a", start + 1), end("msg_a", start + 1)]);
    fake.state.waiting.set(owner, [{ id: "per_atomic", kind: "permission", summary: "shell" }]);
    db.$client.exec(
      "CREATE TRIGGER fail_notice BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'reverify rollback'); END;",
    );
    const failed = await tick().then(
      () => false,
      () => true,
    );
    expect(failed).toBe(true);
    expect(db.select().from(supervisions).get()).toMatchObject({
      seenAt: start,
      seenIDs: [],
      waitingOn: [],
    });
    expect(db.select().from(outbox).all()).toHaveLength(0);
    db.$client.exec("DROP TRIGGER fail_notice");
    await tick();
    expect(db.select().from(supervisions).get()).toMatchObject({
      seenAt: start + 1,
      seenIDs: ["msg_a"],
      waitingOn: ["permission:per_atomic"],
    });
    reopen();
    fake.state.ends.set(owner, [end("msg_a", start + 1), end("msg_b", start + 1)]);
    await tick();
    expect(db.select().from(supervisions).get()?.seenIDs).toEqual(["msg_a", "msg_b"]);
    fake.state.ends.set(owner, [end("msg_c", start + 2)]);
    await tick();
    expect(db.select().from(supervisions).get()?.seenIDs).toEqual(["msg_c"]);
    reopen();
    fake.state.ends.set(owner, [
      end("msg_a", start + 1),
      end("msg_b", start + 1),
      end("msg_c", start + 2),
      end("msg_d", start + 2),
    ]);
    await tick();
    await tick();
    expect(db.select().from(supervisions).get()?.seenIDs).toEqual(["msg_c", "msg_d"]);
    expect(db.select().from(outbox).all()).toHaveLength(5);
  } finally {
    db.$client.close();
  }
});

async function withAdapter(
  handler: (url: URL) => Response,
  run: (service: OpenCode["Service"]) => Promise<void>,
) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => handler(new URL(request.url)),
  });
  const discover = spyOn(Service, "discover").mockResolvedValue({
    url: server.url.href,
    auth: undefined,
  });
  try {
    await run(await Effect.runPromise(OpenCode.pipe(Effect.provide(OpenCode.layer))));
  } finally {
    discover.mockRestore();
    await server.stop(true);
  }
}

test("issue27 reverify public adapter: timestamp ties span cursor pages without truncation", async () => {
  const history = [
    ...Array.from({ length: 60 }, (_, i) => idle(`msg_new${i}`, 200)),
    ...Array.from({ length: 60 }, (_, i) => idle(`msg_boundary${i}`, 100)),
    idle("msg_before", 99),
  ];
  let idlePages = 0;
  await withAdapter(
    (url) => {
      expect(url.pathname).toBe(`/api/session/${owner}/message`);
      if (url.searchParams.get("type") === "assistant")
        return Response.json({ data: [], cursor: {} });
      idlePages++;
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.has("order")).toBe(offset === 0);
      return Response.json({
        data: history.slice(offset, offset + 50),
        cursor: offset + 50 < history.length ? { next: String(offset + 50) } : {},
      });
    },
    async (service) => {
      const ends = await Effect.runPromise(service.turnsSince(owner, 100));
      expect(ends).toHaveLength(120);
      expect(new Set(ends.map((item) => item.id)).size).toBe(120);
      expect(ends.filter((item) => item.time === 100)).toHaveLength(60);
      expect(ends.some((item) => item.id === "msg_before")).toBe(false);
      expect(idlePages).toBe(3);
    },
  );
});

test("issue27 reverify public adapter: every paginated old turn retains its final assistant excerpt", async () => {
  const idles = [
    ...Array.from({ length: 80 }, (_, i) => idle(`msg_end${i}`, 100 + i * 10)).toReversed(),
    idle("msg_before", 80),
  ];
  const replies = [
    assistant("msg_current", 1000, "Still working"),
    ...Array.from({ length: 80 }, (_, i) =>
      assistant(`msg_reply${i}`, 99 + i * 10, `Final ${i}`),
    ).toReversed(),
    assistant("msg_ancient", 70, "Before binding"),
  ];
  let assistantPages = 0;
  await withAdapter(
    (url) => {
      expect(url.pathname).toBe(`/api/session/${owner}/message`);
      const isAssistant = url.searchParams.get("type") === "assistant";
      if (isAssistant) assistantPages++;
      const history = isAssistant ? replies : idles;
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      return Response.json({
        data: history.slice(offset, offset + 50),
        cursor: offset + 50 < history.length ? { next: String(offset + 50) } : {},
      });
    },
    async (service) => {
      const ends = await Effect.runPromise(service.turnsSince(owner, 90));
      expect(ends).toHaveLength(80);
      for (let i = 0; i < 80; i++)
        expect(ends[i]).toMatchObject({ id: `msg_end${i}`, text: `Final ${i}` });
      expect(assistantPages).toBe(2);
    },
  );
});

test("issue27 reverify public adapter: repeating an assistant cursor fails rather than publishes partial data", async () => {
  let assistantPages = 0;
  await withAdapter(
    (url) => {
      if (url.searchParams.get("type") === "idle")
        return Response.json({ data: [idle("msg_end", 1000)], cursor: {} });
      assistantPages++;
      return Response.json({
        data: Array.from({ length: 50 }, (_, i) => assistant(`msg_blank${i}`, 900 - i, "")),
        cursor: { next: "repeat" },
      });
    },
    async (service) => {
      const result = await Effect.runPromise(
        Effect.result(service.turnsSince(owner, 0)).pipe(Effect.timeout("2 seconds")),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          cause: { message: `OpenCode returned the same history page of ${owner} twice` },
        },
      });
      expect(assistantPages).toBe(2);
    },
  );
});
