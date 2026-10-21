import { and, asc, eq, inArray, lt, notInArray } from "drizzle-orm";
import { Schema } from "effect";
import type { Db } from "./db";
import { feed, type FeedItem } from "./schema";

/** The feed keeps only notifications updated this recently. Older ones drop off. */
export const window = 24 * 60 * 60 * 1000;

/** The part of fetch the sources use, so tests can pass a plain function. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type Item = Pick<
  FeedItem,
  "sourceID" | "reason" | "title" | "context" | "url" | "updatedAt"
>;

/** A service that notifies the owner. `unread` gives undefined while it isn't set up. */
export type Source = {
  name: FeedItem["source"];
  unread: (since: number) => Promise<Item[] | undefined>;
  markRead: (sourceID: string) => Promise<void>;
};

/**
 * Marks what the owner dismissed as read at its source, then saves the source's unread items.
 * An item the source no longer lists was read there or is too old, so it leaves the feed.
 * New activity on a dismissed item brings it back, as it does at the source.
 */
export async function collect(db: Db, source: Source, now: number) {
  const dismissed = db
    .select()
    .from(feed)
    .where(and(eq(feed.source, source.name), eq(feed.state, "dismissed")))
    .all();
  for (const row of dismissed) {
    try {
      await source.markRead(row.sourceID);
      db.update(feed)
        .set({ state: "read" })
        .where(and(eq(feed.id, row.id), eq(feed.state, "dismissed")))
        .run();
    } catch (error) {
      console.error(
        `Feed item ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const items = await source.unread(now - window);
  if (!items) return;
  db.transaction((tx) => {
    for (const item of items) {
      tx.insert(feed)
        .values({ ...item, source: source.name, state: "unread", createdAt: now })
        .onConflictDoUpdate({
          target: [feed.source, feed.sourceID],
          set: { ...item, state: "unread" },
          setWhere: lt(feed.updatedAt, item.updatedAt),
        })
        .run();
    }
    tx.update(feed)
      .set({ state: "read" })
      .where(
        and(
          eq(feed.source, source.name),
          inArray(feed.state, ["unread", "dismissed"]),
          notInArray(
            feed.sourceID,
            items.map((item) => item.sourceID),
          ),
        ),
      )
      .run();
  });
}

/** Unread items, oldest first, so the newest sit at the bottom like a chat. */
export const unreadFeed = (db: Db) =>
  db.select().from(feed).where(eq(feed.state, "unread")).orderBy(asc(feed.updatedAt)).all();

/**
 * Hides an item now, and the daemon marks it read at its source on its next pass.
 * False when there's no such item. Dismissing it again changes nothing.
 */
export function dismiss(db: Db, id: number) {
  db.update(feed)
    .set({ state: "dismissed" })
    .where(and(eq(feed.id, id), eq(feed.state, "unread")))
    .run();
  return db.select({ id: feed.id }).from(feed).where(eq(feed.id, id)).get() !== undefined;
}

/** A command's trimmed output, or undefined when it fails or isn't installed. */
function output(command: string[]) {
  try {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" });
    return (result.success && result.stdout.toString().trim()) || undefined;
  } catch {
    return undefined;
  }
}

const githubReasons: Record<string, string> = {
  review_requested: "Review requested",
  mention: "Mentioned",
  team_mention: "Team mentioned",
  assign: "Assigned",
};

const Thread = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
  updated_at: Schema.String,
  subject: Schema.Struct({ title: Schema.String, url: Schema.NullOr(Schema.String) }),
  repository: Schema.Struct({ full_name: Schema.String, html_url: Schema.String }),
});
const Threads = Schema.Array(Thread);

/** The subject's web page, from its API URL. */
const githubPage = (thread: typeof Thread.Type) =>
  thread.subject.url
    ?.replace("https://api.github.com/repos/", "https://github.com/")
    .replace(/\/pulls\/(\d+)$/, "/pull/$1") ?? thread.repository.html_url;

/** GitHub notifications, with the token of the `gh` login. The token stays in memory. */
export function github(
  fetch: Fetch = globalThis.fetch,
  token = () => output(["gh", "auth", "token"]),
): Source {
  let saved: string | undefined;
  const call = async (path: string, method = "GET") => {
    saved ??= token();
    if (!saved) return undefined;
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${saved}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status === 401) saved = undefined;
    if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${method} ${path}`);
    return response;
  };
  return {
    name: "github",
    unread: async (since) => {
      const threads: (typeof Thread.Type)[] = [];
      for (let page = 1; ; page++) {
        const response = await call(
          `/notifications?participating=true&per_page=50&page=${page}&since=${new Date(since).toISOString()}`,
        );
        if (!response) return undefined;
        const batch = Schema.decodeUnknownSync(Threads)(await response.json());
        threads.push(...batch);
        if (batch.length < 50) break;
      }
      return threads.flatMap((thread) => {
        const reason = githubReasons[thread.reason];
        if (!reason) return [];
        return [
          {
            sourceID: thread.id,
            reason,
            title: thread.subject.title,
            context: thread.repository.full_name,
            url: githubPage(thread),
            updatedAt: Date.parse(thread.updated_at),
          },
        ];
      });
    },
    markRead: async (id) => {
      if (!(await call(`/notifications/threads/${id}`, "PATCH")))
        throw new Error("gh gave no GitHub token");
    },
  };
}

const linearReasons: Record<string, string> = {
  issueAssignedToYou: "Assigned",
  issueMention: "Mentioned",
  issueCommentMention: "Mentioned in a comment",
};

const LinearErrors = Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String })));

const FeedReply = Schema.Struct({
  data: Schema.optionalKey(
    Schema.Struct({
      notifications: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            type: Schema.String,
            readAt: Schema.NullOr(Schema.String),
            updatedAt: Schema.String,
            // Only issue notifications have an issue.
            issue: Schema.optionalKey(
              Schema.Struct({
                identifier: Schema.String,
                title: Schema.String,
                url: Schema.String,
              }),
            ),
          }),
        ),
      }),
    }),
  ),
  errors: LinearErrors,
});

const ReadReply = Schema.Struct({
  data: Schema.optionalKey(
    Schema.Struct({ notificationUpdate: Schema.Struct({ success: Schema.Boolean }) }),
  ),
  errors: LinearErrors,
});

/** The reply's data, or an error with Linear's messages. */
function linearData<D>(
  status: number,
  reply: { data?: D; errors?: readonly { message: string }[] },
) {
  if (status === 200 && reply.data && !reply.errors) return reply.data;
  const messages = reply.errors?.map((error) => error.message).join("; ") ?? "no data";
  throw new Error(`Linear answered ${status}: ${messages}`);
}

const linearQuery = `query Feed($since: DateTimeOrDuration!, $types: [String!]!) {
  notifications(first: 100, orderBy: updatedAt, filter: { updatedAt: { gt: $since }, type: { in: $types } }) {
    nodes { id type readAt updatedAt ... on IssueNotification { issue { identifier title url } } }
  }
}`;

const linearRead = `mutation Read($id: String!, $readAt: DateTime!) {
  notificationUpdate(id: $id, input: { readAt: $readAt }) { success }
}`;

/** Linear notifications, with the personal API key saved in the Keychain as `open-dot-linear`. */
export function linear(
  fetch: Fetch = globalThis.fetch,
  key = () => output(["security", "find-generic-password", "-s", "open-dot-linear", "-w"]),
): Source {
  const call = async (query: string, variables: Record<string, unknown>) => {
    const secret = key();
    if (!secret) return undefined;
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: secret, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body: unknown = await response.json().catch(() => ({}));
    return { status: response.status, body };
  };
  return {
    name: "linear",
    unread: async (since) => {
      const reply = await call(linearQuery, {
        since: new Date(since).toISOString(),
        types: Object.keys(linearReasons),
      });
      if (!reply) return undefined;
      const data = linearData(reply.status, Schema.decodeUnknownSync(FeedReply)(reply.body));
      return data.notifications.nodes.flatMap((notification) => {
        const reason = linearReasons[notification.type];
        if (!reason || notification.readAt || !notification.issue) return [];
        return [
          {
            sourceID: notification.id,
            reason,
            title: notification.issue.title,
            context: notification.issue.identifier,
            url: notification.issue.url,
            updatedAt: Date.parse(notification.updatedAt),
          },
        ];
      });
    },
    markRead: async (id) => {
      const reply = await call(linearRead, { id, readAt: new Date().toISOString() });
      if (!reply) throw new Error("There's no Linear key in the Keychain");
      linearData(reply.status, Schema.decodeUnknownSync(ReadReply)(reply.body));
    },
  };
}
