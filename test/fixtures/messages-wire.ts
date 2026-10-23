import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { OpenCode } from "../../src/opencode";

const home = process.env.OPEN_DOT_HOME;
assert(home && home.startsWith(join(process.cwd(), ".research/messages-wire-")));
assert.equal(process.env.XDG_STATE_HOME, join(home, "state"));
const sessionID = "ses_wireMessages";
const history = Array.from({ length: 45 }, (_, i) => ({
  id: `msg_${45 - i}`,
  time: { created: 1_700_000_000_000 },
  type: "user",
  text: `Message ${i}`,
}));
const requests: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: "2.1.1", pid: process.pid });
    assert.equal(url.pathname, `/api/session/${sessionID}/message`);
    requests.push(url.search);
    const cursor = url.searchParams.get("cursor");
    assert.equal(url.searchParams.get("order"), cursor ? null : "desc");
    const offset = cursor ? Number(cursor.replace("opaque/", "")) : 0;
    const limit = Number(url.searchParams.get("limit"));
    assert.equal(limit, 20);
    const data = history.toReversed().slice(offset, offset + limit);
    return Response.json({
      data,
      cursor: { next: data.length ? `opaque/${offset + data.length}` : undefined },
    });
  },
});
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, server.url.origin, "non-fixture network access forbidden");
    return nativeFetch(input, init);
  },
  nativeFetch,
);
try {
  await mkdir(join(home, "state/opencode"), { recursive: true });
  await Bun.write(
    join(home, "state/opencode/service.json"),
    JSON.stringify({ id: "fixture", version: "2.1.1", pid: process.pid, url: server.url.origin }),
  );
  const items = await Effect.runPromise(
    Effect.gen(function* () {
      const code = yield* OpenCode;
      const first = yield* code.messagePage(sessionID, 20);
      assert.equal(first.next, "opaque/20");
      const middle = yield* code.messagePage(sessionID, 20, first.next);
      assert.equal(middle.next, "opaque/40");
      const last = yield* code.messagePage(sessionID, 20, middle.next);
      assert.equal(last.next, undefined);
      return [...last.entries, ...middle.entries, ...first.entries];
    }).pipe(Effect.provide(OpenCode.layer)),
  );
  assert.deepEqual(
    items.map((item) => item.id),
    history.map((item) => item.id),
  );
  assert.equal(requests.length, 3);
  console.log(
    JSON.stringify({
      checks: [
        "opaque cursors forwarded without order",
        "projection order retained across three pages",
        "short final page ends pagination",
      ],
    }),
  );
} finally {
  await server.stop(true);
}
