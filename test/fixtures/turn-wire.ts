import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { OpenCode } from "../../src/opencode";

// A subprocess with isolated XDG paths: never touch the user's service registration.
const home = process.env.OPEN_DOT_HOME;
assert(home !== undefined);
assert(home.startsWith(join(process.cwd(), ".research/turn-wire-")));
assert.equal(process.env.XDG_STATE_HOME, join(home, "state"));
const run = <A, E>(effect: Effect.Effect<A, E, OpenCode>) =>
  Effect.runPromise(Effect.provide(effect, OpenCode.layer));
const sessionID = "ses_wireTurn";
const prompt = "msg_wirePrompt";
const time = { created: 1_700_000_000_000 };
const model = { id: "fixture-model", providerID: "fixture" };
const assistant = (id: string, texts: string[]) => ({
  id,
  time,
  type: "assistant",
  agent: "build",
  model,
  content: texts.map((text) => ({ type: "text", text })),
});
let history: unknown[] = [];
const checks: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: "2.1.1", pid: process.pid });
    if (request.method === "GET" && url.pathname === `/api/session/${sessionID}/message`) {
      assert.equal(url.searchParams.get("order"), "asc");
      return Response.json({ data: history, cursor: {} });
    }
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
  const read = () =>
    run(
      Effect.flatMap(OpenCode, (client) =>
        Effect.all([
          client.turnAfter({ sessionID, messageID: prompt }),
          client.turnSoFar({ sessionID, messageID: prompt }),
        ]),
      ),
    );
  const user = (id: string) => ({ id, time, text: "hi", type: "user" });
  history = [user("msg_wireEarlier"), assistant("msg_wireOld", ["Before the prompt."])];
  assert.deepEqual(await read(), [undefined, undefined]);
  checks.push("a prompt not yet in the history has no turn and nothing so far");

  history.push(user(prompt));
  assert.deepEqual(await read(), [undefined, []]);
  history.push(
    assistant("msg_wireFirst", ["Let me look.", "Still looking."]),
    assistant("msg_wireEmpty", [""]),
    assistant("msg_wireLast", ["Found it."]),
  );
  assert.deepEqual(await read(), [
    undefined,
    [
      { id: "msg_wireFirst", texts: ["Let me look.", "Still looking."] },
      { id: "msg_wireEmpty", texts: [""] },
      { id: "msg_wireLast", texts: ["Found it."] },
    ],
  ]);
  checks.push("a running turn lists its assistant messages and their text parts in order");

  history.push({ id: "msg_wireIdle", time, type: "idle", outcome: "succeeded" });
  assert.deepEqual(await read(), [
    { outcome: "succeeded", text: "Found it.", end: "msg_wireIdle" },
    undefined,
  ]);
  checks.push("an ended turn keeps its last message's text and has nothing so far");
} finally {
  console.log(JSON.stringify({ checks }));
  globalThis.fetch = nativeFetch;
  await server.stop(true);
}
