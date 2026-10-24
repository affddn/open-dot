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
let inbox: unknown[] = [];
// History pages by cursor, when a check needs more than the one page `history` gives.
let pages: ((cursor: string | null) => unknown) | undefined;
// History page requests since a check reset it. Past the ceiling the fixture refuses, so a
// looping walk fails the check instead of hanging it.
let listed = 0;
const ceiling = 10;
const checks: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: "2.1.1", pid: process.pid });
    if (request.method === "GET" && url.pathname === `/api/session/${sessionID}/message`) {
      const cursor = url.searchParams.get("cursor");
      assert.equal(url.searchParams.get("order"), cursor === null ? "asc" : null);
      if (++listed > ceiling) return new Response("fixture request ceiling", { status: 500 });
      return Response.json(pages ? pages(cursor) : { data: history, cursor: {} });
    }
    if (request.method === "GET" && url.pathname === `/api/session/${sessionID}/inbox`)
      return Response.json({ data: inbox });
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
  const read = () => {
    listed = 0;
    return run(
      Effect.flatMap(OpenCode, (client) =>
        Effect.all([
          client.turnAfter({ sessionID, messageID: prompt }),
          client.turnSoFar({ sessionID, messageID: prompt }),
          client.promptTurn({ sessionID, messageID: prompt }),
        ]),
      ),
    );
  };
  const user = (id: string) => ({ id, time, text: "hi", type: "user" });
  history = [user("msg_wireEarlier"), assistant("msg_wireOld", ["Before the prompt."])];
  inbox = [
    {
      id: prompt,
      sessionID,
      time,
      type: "user",
      payload: { text: "Scheduled run" },
      delivery: "queue",
    },
  ];
  assert.deepEqual(await read(), [undefined, undefined, { kind: "queued" }]);
  checks.push("a prompt still in the inbox has no turn and nothing so far");
  inbox = [];
  assert.deepEqual(await read(), [undefined, undefined, { kind: "absent" }]);
  checks.push("a prompt in neither the inbox nor the history is absent");

  history.push(user(prompt));
  assert.deepEqual(await read(), [undefined, [], { kind: "running" }]);
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
    { kind: "running" },
  ]);
  checks.push("a running turn lists its assistant messages and their text parts in order");

  history.push({ id: "msg_wireIdle", time, type: "idle", outcome: "succeeded" });
  // No idle came between the earlier prompt and this one, so they share the turn.
  const turn = {
    outcome: "succeeded",
    text: "Found it.",
    end: "msg_wireIdle",
    endedAt: time.created,
    error: undefined,
    inputs: ["msg_wireEarlier", prompt],
    // No idle before it is in sight, so nothing proves these are all its inputs.
    complete: false,
    reply: { id: "msg_wireLast", text: "Found it." },
  };
  assert.deepEqual(await read(), [turn, undefined, { kind: "ended", turn }]);
  checks.push("an ended turn keeps its last message's text and every input it shared");

  history = [
    user("msg_wireEarlier"),
    { id: "msg_wireIdleBefore", time, type: "idle", outcome: "succeeded" },
    user(prompt),
    assistant("msg_wireAlone", ["Done alone."]),
    {
      id: "msg_wireIdleAlone",
      time,
      type: "idle",
      outcome: "failed",
      error: { type: "provider", message: "boom" },
    },
  ];
  assert.deepEqual((await read())[0], {
    outcome: "failed",
    text: "Done alone.",
    end: "msg_wireIdleAlone",
    endedAt: time.created,
    error: "boom",
    inputs: [prompt],
    complete: true,
    reply: { id: "msg_wireAlone", text: "Done alone." },
  });
  checks.push("a turn after an idle has only its own prompt, and a failed one keeps its error");

  const idle = (id: string) => ({ id, time, type: "idle", outcome: "succeeded" });
  const compaction = (id: string) => ({
    id,
    time,
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "Earlier work, summarized.",
  });
  const ended = async () => {
    const [after, , where] = await read();
    assert.deepEqual(where, { kind: "ended", turn: after });
    return after;
  };
  // The input before the wake is gone, and a compaction stands where the turn began.
  history = [
    compaction("msg_wireCompact"),
    user(prompt),
    assistant("msg_wireMine", ["Mine?"]),
    idle("msg_wireEnd"),
  ];
  assert.deepEqual(await ended(), {
    outcome: "succeeded",
    text: "Mine?",
    end: "msg_wireEnd",
    endedAt: time.created,
    error: undefined,
    inputs: [prompt],
    complete: false,
    reply: { id: "msg_wireMine", text: "Mine?" },
  });
  // A compaction inside a turn whose idle before is in sight leaves it incomplete too.
  history = [
    idle("msg_wireBefore"),
    user(prompt),
    compaction("msg_wireMidCompact"),
    assistant("msg_wireMine", ["Mine?"]),
    idle("msg_wireEnd"),
  ];
  assert.equal((await ended())?.complete, false);
  checks.push("a turn with its idle before out of sight, or compacted, is never complete");

  const prompted = async () => {
    listed = 0;
    return run(
      Effect.flatMap(OpenCode, (client) => client.promptTurn({ sessionID, messageID: prompt })),
    ).then(
      (value) => ({ value, listed }),
      () => ({ failed: true, listed }),
    );
  };
  pages = (cursor) =>
    cursor === null
      ? { data: [idle("msg_wireBefore")], cursor: { next: "page2" } }
      : cursor === "page2"
        ? {
            data: [user(prompt), assistant("msg_wireNext", ["Next page."]), idle("msg_wireEnd")],
            cursor: { next: "page3" },
          }
        : { data: [], cursor: {} };
  const followed = await prompted();
  assert.equal(followed.listed, 2);
  const found = "value" in followed && followed.value.kind === "ended" ? followed.value.turn : {};
  assert.deepEqual(found, {
    outcome: "succeeded",
    text: "Next page.",
    end: "msg_wireEnd",
    endedAt: time.created,
    error: undefined,
    inputs: [prompt],
    complete: true,
    reply: { id: "msg_wireNext", text: "Next page." },
  });
  checks.push("a short page's next cursor is followed, and the turn on the next page is found");

  // As OpenCode 2.1.1 does, the last page with data still names a next one, which is empty.
  pages = (cursor) =>
    cursor === null
      ? { data: [idle("msg_wireBefore"), user(prompt)], cursor: { next: "page2" } }
      : { data: [], cursor: {} };
  assert.deepEqual(await prompted(), { value: { kind: "running" }, listed: 2 });
  checks.push("an empty page ends the walk");

  const padded = (count: number) =>
    Array.from({ length: count }, (_, index) => user(index === 0 ? prompt : `msg_wirePad${index}`));
  pages = () => ({ data: padded(200), cursor: {} });
  assert.deepEqual(await prompted(), { value: { kind: "running" }, listed: 1 });
  checks.push("a full page without a next cursor ends the walk instead of starting over");

  pages = () => ({ data: padded(200).slice(1), cursor: { next: "again" } });
  assert.deepEqual(await prompted(), { failed: true, listed: 2 });
  checks.push("a next cursor given twice fails rather than looping or reading as absent");
  pages = undefined;
} finally {
  console.log(JSON.stringify({ checks }));
  globalThis.fetch = nativeFetch;
  await server.stop(true);
}
