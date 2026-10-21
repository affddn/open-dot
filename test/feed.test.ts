import { beforeEach, expect, test } from "bun:test";
import { type Db, openDatabase } from "../src/db";
import { collect, dismiss, github, type Item, linear, type Source, unreadFeed } from "../src/feed";
import { feed } from "../src/schema";

let db: Db;

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "",
    (error: unknown) => String(error),
  );

beforeEach(() => {
  db = openDatabase(":memory:");
});

const item = (sourceID: string, updatedAt: number): Item => ({
  sourceID,
  reason: "Mentioned",
  title: `Title ${sourceID}`,
  context: "acme/app",
  url: null,
  updatedAt,
});

function fakeSource(listed: Item[]) {
  const marked: string[] = [];
  const source: Source & { listed: Item[]; failing: boolean } = {
    name: "github",
    listed,
    failing: false,
    unread: async () => source.listed,
    markRead: async (id) => {
      if (source.failing) throw new Error("offline");
      marked.push(id);
    },
  };
  return { source, marked };
}

const shown = () => unreadFeed(db).map((row) => row.sourceID);
const state = (sourceID: string) =>
  db
    .select()
    .from(feed)
    .all()
    .find((row) => row.sourceID === sourceID)?.state;

test("the feed follows the source: new items appear, read ones leave, oldest first", async () => {
  const { source } = fakeSource([item("b", 20), item("a", 10)]);
  await collect(db, source, 100);
  expect(shown()).toEqual(["a", "b"]);

  source.listed = [item("b", 20), item("c", 30)];
  await collect(db, source, 200);
  expect(shown()).toEqual(["b", "c"]);
  expect(state("a")).toBe("read");

  source.listed = [item("a", 10), item("b", 20), item("c", 30)];
  await collect(db, source, 300);
  expect(shown()).toEqual(["a", "b", "c"]);
});

test("dismissing hides an item and marks it read at the source once", async () => {
  const { source, marked } = fakeSource([item("a", 10)]);
  await collect(db, source, 100);
  const id = unreadFeed(db)[0]?.id ?? 0;

  expect(dismiss(db, id)).toBe(true);
  expect(dismiss(db, id)).toBe(true);
  expect(dismiss(db, id + 1)).toBe(false);
  expect(shown()).toEqual([]);

  source.failing = true;
  await collect(db, source, 200);
  expect(state("a")).toBe("dismissed");

  source.failing = false;
  await collect(db, source, 300);
  await collect(db, source, 400);
  expect(marked).toEqual(["a"]);
  expect(shown()).toEqual([]);

  source.listed = [item("a", 50)];
  await collect(db, source, 500);
  expect(shown()).toEqual(["a"]);
});

test("activity after a dismissal brings the item back instead of marking it read", async () => {
  const { source, marked } = fakeSource([item("a", 10)]);
  await collect(db, source, 100);
  dismiss(db, unreadFeed(db)[0]?.id ?? 0);

  source.listed = [item("a", 20)];
  await collect(db, source, 200);
  expect(marked).toEqual([]);
  expect(shown()).toEqual(["a"]);
});

test("a source that isn't set up leaves the feed alone", async () => {
  const { source } = fakeSource([item("a", 10)]);
  await collect(db, source, 100);
  await collect(db, { ...source, unread: async () => undefined }, 200);
  expect(shown()).toEqual(["a"]);
});

const thread = (id: string, reason: string, url: string | null) => ({
  id,
  reason,
  updated_at: "2026-10-21T05:00:00Z",
  subject: { title: `Thread ${id}`, url, type: "PullRequest" },
  repository: { full_name: "acme/app", html_url: "https://github.com/acme/app" },
});

test("GitHub lists the notifications that need the owner, with web links", async () => {
  const requests: Request[] = [];
  let tokens = 0;
  const source = github(
    async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.headers.get("authorization") === "Bearer expired")
        return new Response("", { status: 401 });
      return Response.json([
        thread("1", "review_requested", "https://api.github.com/repos/acme/app/pulls/12"),
        thread("2", "mention", "https://api.github.com/repos/acme/app/issues/7"),
        thread("3", "comment", "https://api.github.com/repos/acme/app/issues/8"),
        thread("4", "assign", null),
        thread("5", "mention", "https://api.github.com/repos/acme/app/commits/0a1b2c"),
        thread("6", "author", "https://api.github.com/repos/acme/app/pulls/13"),
        thread("7", "ci_activity", null),
      ]);
    },
    async () => (tokens++ === 0 ? "expired" : "fresh"),
  );

  expect(await failure(source.unread(Date.parse("2026-10-20T05:00:00Z")))).toContain("401");
  const items = await source.unread(Date.parse("2026-10-20T05:00:00Z"));
  expect(items?.map((listed) => [listed.reason, listed.url])).toEqual([
    ["Review requested", "https://github.com/acme/app/pull/12"],
    ["Mentioned", "https://github.com/acme/app/issues/7"],
    ["Comment", "https://github.com/acme/app/issues/8"],
    ["Assigned", "https://github.com/acme/app"],
    ["Mentioned", "https://github.com/acme/app/commit/0a1b2c"],
    ["Author", "https://github.com/acme/app/pull/13"],
  ]);
  const url = new URL(requests.at(-1)?.url ?? "");
  expect(url.searchParams.get("since")).toBe("2026-10-20T05:00:00.000Z");
  expect(url.searchParams.get("participating")).toBe("true");

  await source.markRead("1");
  expect(requests.at(-1)?.method).toBe("PATCH");
  expect(requests.at(-1)?.url).toBe("https://api.github.com/notifications/threads/1");
  expect(await github(fetch, async () => undefined).unread(0)).toBeUndefined();
});

const notification = (id: string, type: string, readAt: string | null, issue?: string) => ({
  id,
  type,
  readAt,
  updatedAt: "2026-10-21T05:00:00Z",
  ...(issue && {
    issue: { identifier: issue, title: "Fix it", url: `https://linear.app/x/${issue}` },
  }),
});

const page = (endCursor: string | null, nodes: unknown[]) => ({
  data: { notifications: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
});

test("Linear lists unread issue notifications across pages and reports its errors", async () => {
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  let replies: unknown[] = [
    page("c1", [
      notification("n1", "issueAssignedToYou", null, "ABC-1"),
      notification("n2", "issueMention", "2026-10-21T06:00:00Z", "ABC-2"),
    ]),
    page(null, [
      notification("n3", "issueMention", null),
      notification("n4", "issueCommentMention", null, "ABC-4"),
    ]),
  ];
  const source = linear(
    async (_input, init) => {
      bodies.push(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
      expect(new Headers(init.headers).get("authorization")).toBe("lin_api_key");
      return Response.json(replies.shift());
    },
    async () => "lin_api_key",
  );

  const items = await source.unread(0);
  expect(items).toMatchObject([
    { sourceID: "n1", reason: "Assigned", context: "ABC-1", url: "https://linear.app/x/ABC-1" },
    { sourceID: "n4", reason: "Mentioned in a comment", context: "ABC-4" },
  ]);
  expect(bodies.map((body) => body.variables.after)).toEqual([null, "c1"]);
  expect(bodies[0]?.variables.since).toBe("1970-01-01T00:00:00.000Z");

  replies = [{ data: { notificationUpdate: { success: false } } }];
  expect(await failure(source.markRead("n1"))).toContain("didn't mark n1 read");
  replies = [1, 2].map(() => ({ errors: [{ message: "Authentication required" }] }));
  expect(await failure(source.unread(0))).toContain("Authentication required");
  expect(await failure(source.markRead("n1"))).toContain("Authentication required");
  expect(await linear(fetch, async () => undefined).unread(0)).toBeUndefined();
});
