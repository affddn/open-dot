import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { OpenCode } from "../../src/opencode";

// A subprocess with isolated XDG paths: never touch the user's service registration.
const home = process.env.OPEN_DOT_HOME;
assert(home !== undefined);
assert(home.startsWith(join(process.cwd(), ".research/events-wire-")));
assert.equal(process.env.XDG_STATE_HOME, join(home, "state"));
const sessionID = "ses_wireTurn";
const messageID = "msg_wireReply";
let seq = 0;
const event = (type: string, data: Record<string, unknown>, durable = false) => ({
  id: `evt_wire${++seq}`,
  created: 1_700_000_000_000 + seq,
  type,
  ...(durable && { durable: { aggregateID: sessionID, seq, version: 1 } }),
  data: { sessionID, assistantMessageID: messageID, ...data },
});
const sent = [
  event("session.text.started", { ordinal: 0 }, true),
  event("session.text.delta", { ordinal: 0, delta: "Hel" }),
  event("session.reasoning.delta", { ordinal: 0, delta: "secret thoughts" }),
  event("session.text.delta", { ordinal: 0, delta: "lo" }),
  event("session.text.ended", { ordinal: 0, text: "Hello" }, true),
];
const checks: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: "2.1.1", pid: process.pid });
    if (request.method === "GET" && url.pathname === "/api/event")
      return new Response(sent.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
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
    JSON.stringify({ id: "fixture", version: "2.1.1", pid: process.pid, url: base }),
  );
  const received = await Effect.runPromise(
    Effect.provide(
      Effect.flatMap(OpenCode, (client) => Stream.runCollect(client.textEvents)),
      OpenCode.layer,
    ),
  );
  assert.deepEqual(Array.from(received), [
    { type: "started", sessionID, messageID, ordinal: 0 },
    { type: "delta", sessionID, messageID, ordinal: 0, delta: "Hel" },
    { type: "delta", sessionID, messageID, ordinal: 0, delta: "lo" },
    { type: "ended", sessionID, messageID, ordinal: 0, text: "Hello" },
  ]);
  checks.push("the installed client's text events arrive in order, with no reasoning");
} finally {
  console.log(JSON.stringify({ checks }));
  globalThis.fetch = nativeFetch;
  await server.stop(true);
}
