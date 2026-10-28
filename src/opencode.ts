import {
  AbsolutePath,
  OpenCode as Client,
  Form,
  Model,
  Permission,
  Session,
  SessionMessage,
} from "@opencode/client/effect";
import { Service } from "@opencode/client/service";
import { Context, Data, DateTime, Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { RequestAnswer, RequestDetail } from "./schema";

export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Shell commands that can destroy work or data. Dot and worker sessions ask before running them,
 * and may do anything else. This is best effort: no pattern list catches every destructive command.
 */
const destructive = [
  "rm *",
  "rmdir *",
  "unlink *",
  "shred *",
  "truncate *",
  "find * -delete*",
  "find * -exec rm *",
  "xargs rm *",
  "xargs * rm *",
  "git push --force*",
  "git push * --force*",
  "git push -f*",
  "git push * -f*",
  "git push --delete*",
  "git push * --delete*",
  "git push -d *",
  "git push * -d *",
  "git push * :?*",
  "git reset --hard*",
  "git reset * --hard*",
  "git clean *",
  "git checkout -- *",
  "git restore *",
  "git branch -D *",
  "git branch * -D*",
  "git stash drop*",
  "git stash clear*",
  "git worktree remove *",
  "git filter-branch*",
  "git filter-repo*",
  "gh repo delete *",
  "gh release delete *",
  "sudo *",
  "dd *",
  "mkfs*",
  "diskutil erase*",
  "kill *",
  "pkill *",
  "killall *",
  "launchctl unload *",
  "launchctl bootout *",
  "launchctl remove *",
  "crontab -r*",
  "shutdown *",
  "reboot*",
  "docker rm *",
  "docker rmi *",
  "docker volume rm *",
  "docker system prune*",
  "docker volume prune*",
  "kubectl delete *",
  "terraform apply*",
  "terraform destroy*",
  "terraform state rm *",
  "aws s3 rm *",
  "aws s3 rb *",
  "aws * delete-*",
  "opencode service *",
].map((resource) => ({ action: "shell", resource, effect: "ask" as const }));

/** The last assistant message that wrote any text, with that text. */
const lastWritten = (items: ReadonlyArray<SessionMessage.Info>) =>
  items
    .flatMap((item) =>
      item.type === "assistant"
        ? [
            {
              id: item.id,
              text: item.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n")
                .trim(),
            },
          ]
        : [],
    )
    .filter((written) => written.text !== "")
    .at(-1);

/** History items that bring a turn new input, as opposed to the assistant's own work or notices. */
const inputTypes: ReadonlySet<string> = new Set(["user", "synthetic", "shell"]);

/** The most history pages one walk reads, 200 items each, before it fails instead of looping. */
const historyPageLimit = 5_000;

/** A prompt's ended turn, from the history items after the prompt and the idle that ended it. */
const ended = (
  items: readonly SessionMessage.Info[],
  idle: Extract<SessionMessage.Info, { type: "idle" }>,
  inputs: readonly string[],
  complete: boolean,
): Turn => {
  const reply = lastWritten(items);
  return {
    outcome: idle.outcome,
    text: reply?.text,
    end: idle.id,
    endedAt: DateTime.toEpochMillis(idle.time.created),
    error: idle.error?.message,
    inputs,
    complete,
    reply,
  };
};

const failed = (message: string) => (cause: unknown) => new OpenCodeError({ message, cause });

/** A service `Service.discover()` found, which it only reads and never starts. */
export type Endpoint = NonNullable<Awaited<ReturnType<typeof Service.discover>>>;

/** The public client for a discovered service, sending its auth header with every request. */
export const connect = ({ url, auth }: Endpoint) =>
  Client.make({ baseUrl: url }).pipe(
    Effect.provide(
      Layer.effect(
        HttpClient.HttpClient,
        Effect.map(
          HttpClient.HttpClient,
          HttpClient.mapRequest(
            HttpClientRequest.setHeaders(Service.headers(auth ? { url, auth } : { url }) ?? {}),
          ),
        ),
      ).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  );

export interface SessionInput {
  readonly id: string;
  readonly directory: string;
  readonly title: string;
  /** Absent, the session uses OpenCode's default model. */
  readonly model?: Model.Ref | undefined;
}

export interface MessageRef {
  readonly sessionID: string;
  readonly messageID: string;
}

export type Delivery = "queue" | "steer";

/** An admitted input still waiting in the session's inbox. */
export interface Pending {
  readonly id: string;
  readonly delivery: Delivery;
}

/** An assistant message of a running turn, with its text parts in order: `ordinal` indexes them. */
export interface Written {
  readonly id: string;
  /** Each text part, empty until OpenCode 2.1.1 finishes it; only then does history hold its text. */
  readonly texts: readonly string[];
}

/**
 * A text part's live progress, from OpenCode's event stream: its start, each delta and its end.
 * The stream is live only, so a part started before a connection can't be pieced together.
 */
export type TextEvent =
  | {
      readonly type: "started";
      readonly sessionID: string;
      readonly messageID: string;
      readonly ordinal: number;
    }
  | {
      readonly type: "delta";
      readonly sessionID: string;
      readonly messageID: string;
      readonly ordinal: number;
      readonly delta: string;
    }
  | {
      readonly type: "ended";
      readonly sessionID: string;
      readonly messageID: string;
      readonly ordinal: number;
      readonly text: string;
    };

export interface Turn {
  readonly outcome: "succeeded" | "failed" | "interrupted";
  /** The text of the turn's last assistant message, if it wrote any. */
  readonly text: string | undefined;
  /** The idle that ended the turn. OpenCode folds a message sent mid-turn into that turn, so several messages can share one. */
  readonly end: string;
  /** When the idle was written. */
  readonly endedAt?: number;
  readonly error?: string | undefined;
  /**
   * Every input the history showed in the turn, in order, the prompt among them: user, synthetic
   * and shell messages since the idle before it. Absent when history didn't say, which is never
   * proof of one prompt.
   */
  readonly inputs?: readonly string[];
  /**
   * True only when the idle before the prompt was in the history and nothing in the turn was
   * compacted, so `inputs` is every input the turn had. Without it, a lone prompt in `inputs`
   * proves nothing: an earlier input may be out of sight.
   */
  readonly complete?: boolean;
  /** The turn's last assistant message that wrote any text. */
  readonly reply?: { readonly id: string; readonly text: string } | undefined;
}

/**
 * Where a prompt is in its session: in the inbox, which OpenCode admitted but hasn't delivered;
 * in a turn still running; in a turn that ended; or in neither the inbox nor the history.
 */
export type PromptTurn =
  | { readonly kind: "queued" }
  | { readonly kind: "running" }
  | { readonly kind: "ended"; readonly turn: Turn }
  | { readonly kind: "absent" };

/** A turn that ended in a supervised session, with the last text its assistant wrote. */
export interface TurnEnd {
  readonly id: string;
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly time: number;
  readonly text: string | undefined;
  readonly error: string | undefined;
}

/** A permission request or a question a session waits on its user for. */
export interface Waiting {
  readonly id: string;
  readonly kind: "permission" | "question";
  readonly summary: string;
  readonly detail: RequestDetail;
  /** A question that may ask for a secret, so only the owner answers it. */
  readonly sensitive: boolean;
}

/** A Threads worker, from the public `threads` RPC snapshot. */
export interface ThreadsWorker {
  readonly workerID: string;
  readonly coordinatorID: string;
  readonly title: string;
  readonly directory: string;
  readonly hidden: boolean;
}

const secretWords =
  /pass(word|phrase|code)|secret|token|api[\s_-]?key|credential|\botp\b|2fa|mfa|one[\s-]?time|private[\s_-]?key|ssh[\s_-]?key|cookie/i;

/**
 * A form may ask for a secret when any of its words or its metadata say so, or a field sends the
 * owner to an outside page. OpenCode 2.1.1 has no password field type, so this reads words; it
 * errs toward the owner.
 */
const sensitiveForm = (form: {
  readonly title: string;
  readonly metadata?: unknown;
  readonly fields: readonly Record<string, unknown>[];
}) =>
  form.fields.some((field) => field.type === "external") ||
  secretWords.test(JSON.stringify([form.title, form.metadata ?? null, form.fields]));

const permissionDetail = (request: {
  readonly action: string;
  readonly resources: readonly string[];
  readonly message?: string | undefined;
}): RequestDetail => ({
  kind: "permission",
  action: request.action,
  resources: [...request.resources],
  ...(request.message === undefined ? {} : { message: request.message }),
});

/** What open-dot keeps of a question that may ask for a secret: none of its own words. */
export const redactedQuestion = "A question that may ask for a secret (its words are not kept)";

/**
 * A form as open-dot keeps it. A form that may ask for a secret keeps only a fixed title, with
 * no fields, metadata or words of its own, so nothing of it reaches the database or a prompt.
 */
export const formWaiting = (form: {
  readonly id: string;
  readonly title: string;
  readonly metadata?: unknown;
  readonly fields: readonly Record<string, unknown>[];
}): Waiting =>
  sensitiveForm(form)
    ? {
        id: form.id,
        kind: "question",
        summary: redactedQuestion,
        detail: { kind: "question", title: redactedQuestion, fields: [] },
        sensitive: true,
      }
    : {
        id: form.id,
        kind: "question",
        summary: [form.title, ...form.fields.map((field) => field.description)]
          .filter((part): part is string => typeof part === "string" && part !== "")
          .join("\n"),
        detail: {
          kind: "question",
          title: form.title,
          fields: form.fields.map((field) => ({ ...field })),
        },
        sensitive: false,
      };

const ThreadsSnapshot = Schema.Struct({
  output: Schema.Struct({
    workers: Schema.Array(
      Schema.Struct({
        workerID: Schema.String,
        coordinatorID: Schema.String,
        title: Schema.String,
        directory: Schema.String,
        hidden: Schema.Boolean,
      }),
    ),
  }),
});

/** A file attached to a user message. OpenCode keeps its bytes inline, as base64. */
export interface Attachment {
  readonly mime: string;
  readonly name: string | undefined;
  readonly data: string;
}

/** A user or assistant message in a session's history. */
export interface Entry {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** Names of the tools an assistant message called. */
  readonly tools: readonly string[];
  /** A user message's attachments, in their original order. */
  readonly files: readonly Attachment[];
  readonly time: number;
}

/**
 * A history item as the archive reads it: a user message's own text, or an assistant message's
 * text parts, never reasoning, tool calls or attachments. Any other item is "other", except the
 * idle that ends a turn.
 */
export interface HistoryItem {
  readonly id: string;
  readonly type: "user" | "assistant" | "idle" | "compaction" | "other";
  readonly text: string;
  /**
   * False for an assistant message OpenCode hasn't finished, whose text may still grow, or a
   * compaction still running. A compaction's summary is never read.
   */
  readonly complete: boolean;
  readonly time: number;
  /** A completed compaction OpenCode kept as a provider's native window, not text. */
  readonly native?: boolean;
}

const historyItem = (item: SessionMessage.Info): HistoryItem => {
  const base = { id: item.id, time: DateTime.toEpochMillis(item.time.created), complete: true };
  if (item.type === "user") return { ...base, type: "user", text: item.text };
  if (item.type === "assistant")
    return {
      ...base,
      type: "assistant",
      text: item.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim(),
      complete: item.time.completed !== undefined,
    };
  if (item.type === "compaction")
    return {
      ...base,
      type: "compaction",
      text: "",
      complete: item.status === "completed",
      native: item.status === "completed" && item.native !== undefined,
    };
  return { ...base, type: item.type === "idle" ? "idle" : "other", text: "" };
};

const entry = (item: SessionMessage.Info): Entry[] =>
  item.type === "user"
    ? [
        {
          id: item.id,
          role: "user",
          text: item.text,
          tools: [],
          files: (item.files ?? []).map(({ mime, name, data }) => ({ mime, name, data })),
          time: DateTime.toEpochMillis(item.time.created),
        },
      ]
    : item.type === "assistant"
      ? [
          {
            id: item.id,
            role: "assistant",
            text: item.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n")
              .trim(),
            tools: item.content.flatMap((part) => (part.type === "tool" ? [part.name] : [])),
            files: [],
            time: DateTime.toEpochMillis(item.time.created),
          },
        ]
      : [];

/**
 * A session's token use, as OpenCode 2.1.1 records each assistant message's: uncached `input`,
 * visible `output`, `reasoning`, and `cacheRead` and `cacheWrite`, which don't overlap, so their
 * sum is OpenCode's own `TokenUsage.total`.
 */
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** False when a message hasn't finished, or reports no usage, so the sum may be short. */
  readonly complete: boolean;
}

/** The most usage pages `sumUsage` reads before it gives up rather than undercount. */
export const usagePageLimit = 50;

/**
 * Sums every assistant message's usage, following the public cursor page by page. A cursor given
 * twice, or more pages than `usagePageLimit`, fails: an undercount is never returned as complete.
 */
export const sumUsage = <E>(
  list: (cursor?: string) => Effect.Effect<
    {
      readonly items: readonly {
        tokens?:
          | {
              readonly input: number;
              readonly output: number;
              readonly reasoning: number;
              readonly cache: { readonly read: number; readonly write: number };
            }
          | undefined;
        complete: boolean;
      }[];
      readonly next: string | undefined;
    },
    E
  >,
) =>
  Effect.gen(function* () {
    const total = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    let complete = true;
    let any = false;
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; pages < usagePageLimit; pages++) {
      const page = yield* list(cursor);
      for (const item of page.items) {
        any = true;
        if (!item.complete || !item.tokens) complete = false;
        if (!item.tokens) continue;
        total.input += item.tokens.input;
        total.output += item.tokens.output;
        total.reasoning += item.tokens.reasoning;
        total.cacheRead += item.tokens.cache.read;
        total.cacheWrite += item.tokens.cache.write;
      }
      if (!page.next || !page.items.length) return any ? { ...total, complete } : undefined;
      if (seen.has(page.next))
        return yield* new OpenCodeError({ message: "OpenCode returned a usage page twice" });
      seen.add(page.next);
      cursor = page.next;
    }
    return yield* new OpenCodeError({ message: "Too many messages to sum the usage of" });
  });

/** The most compaction pages `latestCompleted` reads before it gives up rather than guess. */
export const compactionPageLimit = 100;

/**
 * The newest completed compaction, walking a session's compactions newest first, page by page,
 * past running or failed ones. Undefined only when the history ends with none completed. A cursor
 * given twice, or more pages than `compactionPageLimit`, fails: the mode is then unknown.
 */
export const latestCompleted = <E>(
  list: (cursor?: string) => Effect.Effect<
    {
      readonly items: readonly { id: string; completed: boolean; native: boolean }[];
      readonly next: string | undefined;
    },
    E
  >,
) =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; pages < compactionPageLimit; pages++) {
      const page = yield* list(cursor);
      const found = page.items.find((item) => item.completed);
      if (found) return { id: found.id, native: found.native };
      if (!page.next || !page.items.length) return undefined;
      if (seen.has(page.next))
        return yield* new OpenCodeError({ message: "OpenCode returned a compaction page twice" });
      seen.add(page.next);
      cursor = page.next;
    }
    return yield* new OpenCodeError({ message: "Too many compactions to find the latest" });
  });

/** The few OpenCode calls open-dot makes. Absence is a value, every other failure is an OpenCodeError. */
export class OpenCode extends Context.Service<
  OpenCode,
  {
    readonly sessionExists: (sessionID: string) => Effect.Effect<boolean, OpenCodeError>;
    readonly createSession: (input: SessionInput) => Effect.Effect<void, OpenCodeError>;
    /** True once OpenCode has admitted the message, whether it is still in the inbox or already in the history. */
    readonly messageExists: (ref: MessageRef) => Effect.Effect<boolean, OpenCodeError>;
    /** Input OpenCode has admitted but not yet delivered into the history, oldest first. */
    readonly inbox: (sessionID: string) => Effect.Effect<readonly Pending[], OpenCodeError>;
    /** Moves a queued inbox input to join the running turn at its next step. */
    readonly steerQueued: (ref: MessageRef) => Effect.Effect<void, OpenCodeError>;
    /** Withdraws an inbox input. OpenCode does nothing when it's no longer in the inbox. */
    readonly cancelQueued: (ref: MessageRef) => Effect.Effect<void, OpenCodeError>;
    /**
     * Admits the text as a user message with the caller's ID. "queue" waits for the running turn to
     * end; "steer" joins it at its next step, after the current step's tool calls finish.
     */
    readonly prompt: (
      ref: MessageRef & {
        readonly text: string;
        readonly files?: readonly Attachment[];
        readonly delivery: Delivery;
      },
    ) => Effect.Effect<void, OpenCodeError>;
    /** IDs of the sessions that are running a turn now. */
    readonly activeSessions: Effect.Effect<ReadonlySet<string>, OpenCodeError>;
    /** The first turn that ended after the message, or undefined while none has. */
    readonly turnAfter: (ref: MessageRef) => Effect.Effect<Turn | undefined, OpenCodeError>;
    /**
     * Where the prompt is now. The inbox is read before the history, and an admitted prompt only
     * moves from the inbox into the history, so "absent" means OpenCode has it in neither.
     */
    readonly promptTurn: (ref: MessageRef) => Effect.Effect<PromptTurn, OpenCodeError>;
    /**
     * The assistant messages of the turn after the message so far, while it runs, each with its text
     * parts. Undefined once it has ended, or while the message isn't in the history.
     */
    readonly turnSoFar: (
      ref: MessageRef,
    ) => Effect.Effect<readonly Written[] | undefined, OpenCodeError>;
    /** Every session's text parts as they're written, and nothing else: no reasoning or tools. */
    readonly textEvents: Stream.Stream<TextEvent, OpenCodeError>;
    /**
     * Stops the session's running turn without resuming anything. Queued input stays parked in its
     * inbox until something wakes the session again. False when nothing was running, or the
     * session doesn't exist.
     */
    readonly interrupt: (sessionID: string) => Effect.Effect<boolean, OpenCodeError>;
    /** User and assistant messages among the session's last `limit` history items, oldest first. */
    readonly recentMessages: (
      sessionID: string,
      limit: number,
    ) => Effect.Effect<readonly Entry[], OpenCodeError>;
    readonly message: (ref: MessageRef) => Effect.Effect<Entry | undefined, OpenCodeError>;
    readonly messagePage: (
      sessionID: string,
      limit: number,
      cursor?: string,
    ) => Effect.Effect<{ entries: readonly Entry[]; next: string | undefined }, OpenCodeError>;
    /**
     * One page of the session's history in processing order, oldest first: from the start, or
     * after the item an earlier page's `next` cursor names. `next` is absent for an empty page.
     */
    readonly historyPage: (
      sessionID: string,
      limit: number,
      cursor?: string,
    ) => Effect.Effect<{ items: readonly HistoryItem[]; next: string | undefined }, OpenCodeError>;
    /**
     * Creates an observer's scratch session with the caller's ID, in a directory that isn't a
     * dot's, with the owner's configured `provider/model`, and every tool denied.
     */
    readonly createScratch: (input: {
      readonly id: string;
      readonly directory: string;
      readonly title: string;
      readonly model: string;
    }) => Effect.Effect<void, OpenCodeError>;
    /** The session's latest completed compaction, or undefined when it has none. */
    readonly latestCompaction: (
      sessionID: string,
    ) => Effect.Effect<
      { readonly id: string; readonly native: boolean } | undefined,
      OpenCodeError
    >;
    /**
     * What all of a session's assistant messages report using, read page by page: OpenCode's
     * five disjoint counts, uncached input, visible output, reasoning, cache reads and cache
     * writes. `complete` is false when a message is unfinished or reports nothing. Undefined
     * when the session has no assistant message.
     */
    readonly usage: (sessionID: string) => Effect.Effect<Usage | undefined, OpenCodeError>;
    /** One history item by ID, or undefined once OpenCode doesn't have it. */
    readonly historyItem: (
      ref: MessageRef,
    ) => Effect.Effect<HistoryItem | undefined, OpenCodeError>;
    /** The session's directory, or undefined once OpenCode says the session doesn't exist. */
    readonly sessionDirectory: (
      sessionID: string,
    ) => Effect.Effect<string | undefined, OpenCodeError>;
    /** The model the session has chosen, or undefined while it uses OpenCode's default. */
    readonly sessionModel: (
      sessionID: string,
    ) => Effect.Effect<Model.Ref | undefined, OpenCodeError>;
    /**
     * Every turn that ended at or after `since`, in milliseconds, oldest first, read page by page
     * down to that time, however many there are.
     */
    readonly turnsSince: (
      sessionID: string,
      since: number,
    ) => Effect.Effect<readonly TurnEnd[], OpenCodeError>;
    /** Every permission request and question the session waits on. */
    readonly waiting: (sessionID: string) => Effect.Effect<readonly Waiting[], OpenCodeError>;
    /**
     * Sends one answer: a permission once or rejected, never always; a question's reply; or a
     * question cancelled. A failure may still have reached OpenCode.
     */
    readonly answer: (
      sessionID: string,
      kind: Waiting["kind"],
      requestID: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, OpenCodeError>;
    /**
     * The Threads workers of one coordinator session, from Threads' public `snapshot` RPC in that
     * directory, which delivers no follow-ups. Any other shape is an OpenCodeError.
     */
    readonly threadsWorkers: (
      directory: string,
      coordinatorID: string,
    ) => Effect.Effect<readonly ThreadsWorker[], OpenCodeError>;
  }
>()("open-dot/OpenCode") {
  static readonly layer = Layer.effect(
    OpenCode,
    Effect.gen(function* () {
      const endpoint = yield* Effect.tryPromise({
        try: () => Service.discover(),
        catch: (cause) =>
          new OpenCodeError({ message: "Could not read the OpenCode service registration", cause }),
      });
      if (!endpoint) {
        return yield* new OpenCodeError({
          message: "OpenCode is not running. Start OpenCode, then try again.",
        });
      }
      const client = yield* connect(endpoint);

      /**
       * Visits a session's items of one type newest first, page by page, until `visit` returns
       * false or the history ends. A cursor OpenCode hands back twice fails rather than loops.
       */
      const newestFirst = (
        sessionID: string,
        type: "idle" | "assistant",
        visit: (item: SessionMessage.Info) => boolean,
      ) =>
        Effect.gen(function* () {
          const id = Session.ID.make(sessionID);
          const limit = 50;
          const cursors = new Set<string>();
          let cursor: string | undefined;
          for (;;) {
            const page = yield* client.message.list(
              cursor
                ? { sessionID: id, cursor, limit, type }
                : { sessionID: id, order: "desc", limit, type },
            );
            for (const item of page.data) if (!visit(item)) return;
            const next = page.cursor.next;
            if (page.data.length < limit || next === undefined) return;
            // Failing ends the walk here.
            if (cursors.has(next))
              yield* new OpenCodeError({
                message: `OpenCode returned the same history page of ${sessionID} twice`,
              });
            cursors.add(next);
            cursor = next;
          }
        });

      /**
       * The history items after the prompt, up to the idle that ends its turn, if one has. The full
       * history in processing order: session.context would start at the latest compaction, which
       * can hide the prompt or its idle. Undefined while the prompt isn't in the history. Pages
       * follow OpenCode's `next` cursor while it gives one, whatever a page's length, and end when
       * it gives none or a page is empty; a cursor given twice, or a history past the page limit,
       * fails rather than looping or reading as absent.
       */
      const afterPrompt = ({ sessionID, messageID }: MessageRef) =>
        Effect.gen(function* () {
          const limit = 200;
          const items: SessionMessage.Info[] = [];
          // The turn's inputs so far: since the last idle before the prompt, then after it.
          let inputs: string[] = [];
          // Whether the idle before the prompt was seen, and anything since it was compacted.
          let bounded = false;
          let compacted = false;
          let prompted = false;
          let cursor: string | undefined;
          const cursors = new Set<string>();
          for (let pages = 0; ; pages++) {
            if (pages === historyPageLimit)
              return yield* new OpenCodeError({
                message: `The history of ${sessionID} is longer than open-dot reads`,
              });
            const page = yield* client.message.list(
              cursor
                ? { sessionID: Session.ID.make(sessionID), cursor, limit }
                : { sessionID: Session.ID.make(sessionID), order: "asc", limit },
            );
            for (const item of page.data) {
              if (prompted && item.type === "idle")
                return { items, idle: item, inputs, complete: bounded && !compacted };
              if (item.type === "idle") {
                inputs = [];
                bounded = true;
                compacted = false;
              } else if (inputTypes.has(item.type)) inputs.push(item.id);
              else if (item.type === "compaction") compacted = true;
              if (prompted) items.push(item);
              else prompted = item.id === messageID;
            }
            const next = page.cursor.next;
            if (!next || page.data.length === 0)
              return prompted
                ? { items, idle: undefined, inputs, complete: bounded && !compacted }
                : undefined;
            if (cursors.has(next))
              return yield* new OpenCodeError({
                message: `OpenCode returned the same history page of ${sessionID} twice`,
              });
            cursors.add(next);
            cursor = next;
          }
        });

      return {
        sessionExists: (sessionID) =>
          client.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(
            Effect.as(true),
            Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)),
            Effect.mapError(failed(`Could not look up session ${sessionID}`)),
          ),
        createSession: ({ id, directory, title, model }) =>
          client.session
            .create({
              id: Session.ID.make(id),
              title,
              model,
              location: { directory: AbsolutePath.make(directory) },
              permissions: destructive,
            })
            .pipe(Effect.asVoid, Effect.mapError(failed(`Could not create session ${id}`))),
        // Check the inbox first: an admitted message moves from the inbox into the history, never back.
        messageExists: (ref) => {
          const sessionID = Session.ID.make(ref.sessionID);
          const messageID = SessionMessage.ID.make(ref.messageID);
          return client.session.inbox.list({ sessionID }).pipe(
            Effect.flatMap((inbox) =>
              inbox.some((item) => item.id === messageID)
                ? Effect.succeed(true)
                : client.session.message.get({ sessionID, messageID }).pipe(
                    Effect.as(true),
                    Effect.catchTag("MessageNotFoundError", () => Effect.succeed(false)),
                  ),
            ),
            Effect.mapError(failed(`Could not look up message ${ref.messageID}`)),
          );
        },
        inbox: (sessionID) =>
          client.session.inbox.list({ sessionID: Session.ID.make(sessionID) }).pipe(
            Effect.map((inbox) => inbox.map(({ id, delivery }) => ({ id, delivery }))),
            Effect.mapError(failed(`Could not read the inbox of ${sessionID}`)),
          ),
        steerQueued: (ref) =>
          client.session.inbox
            .update({
              sessionID: Session.ID.make(ref.sessionID),
              inboxID: SessionMessage.ID.make(ref.messageID),
              delivery: "steer",
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError(failed(`Could not steer message ${ref.messageID}`)),
            ),
        cancelQueued: (ref) =>
          client.session.inbox
            .cancel({
              sessionID: Session.ID.make(ref.sessionID),
              inboxID: SessionMessage.ID.make(ref.messageID),
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError(failed(`Could not cancel message ${ref.messageID}`)),
            ),
        prompt: ({ sessionID, messageID, text, files, delivery }) =>
          client.session
            .prompt({
              sessionID: Session.ID.make(sessionID),
              id: SessionMessage.ID.make(messageID),
              text,
              files: files?.map(({ mime, name, data }) => ({
                uri: `data:${mime};base64,${data}`,
                name,
              })),
              delivery,
            })
            .pipe(Effect.asVoid, Effect.mapError(failed(`Could not send message ${messageID}`))),
        activeSessions: client.session.active().pipe(
          Effect.map((active) => new Set<string>(Object.keys(active))),
          Effect.mapError(failed("Could not list running sessions")),
        ),
        turnAfter: (ref) =>
          afterPrompt(ref).pipe(
            Effect.map((found) =>
              found?.idle
                ? ended(found.items, found.idle, found.inputs, found.complete)
                : undefined,
            ),
            Effect.mapError(failed(`Could not read session ${ref.sessionID}`)),
          ),
        promptTurn: (ref) =>
          client.session.inbox.list({ sessionID: Session.ID.make(ref.sessionID) }).pipe(
            Effect.flatMap((inbox) =>
              inbox.some((item) => item.id === ref.messageID)
                ? Effect.succeed<PromptTurn>({ kind: "queued" })
                : afterPrompt(ref).pipe(
                    Effect.map((found): PromptTurn =>
                      !found
                        ? { kind: "absent" }
                        : found.idle
                          ? {
                              kind: "ended",
                              turn: ended(found.items, found.idle, found.inputs, found.complete),
                            }
                          : { kind: "running" },
                    ),
                  ),
            ),
            Effect.mapError(failed(`Could not read session ${ref.sessionID}`)),
          ),
        turnSoFar: (ref) =>
          afterPrompt(ref).pipe(
            Effect.map((found) =>
              found && !found.idle
                ? found.items.flatMap((item) =>
                    item.type === "assistant"
                      ? [
                          {
                            id: item.id,
                            texts: item.content.flatMap((part) =>
                              part.type === "text" ? [part.text] : [],
                            ),
                          },
                        ]
                      : [],
                  )
                : undefined,
            ),
            Effect.mapError(failed(`Could not read session ${ref.sessionID}`)),
          ),
        textEvents: client.event.subscribe().pipe(
          Stream.map((event): TextEvent | undefined =>
            event.type === "session.text.started"
              ? {
                  type: "started",
                  sessionID: event.data.sessionID,
                  messageID: event.data.assistantMessageID,
                  ordinal: event.data.ordinal,
                }
              : event.type === "session.text.delta"
                ? {
                    type: "delta",
                    sessionID: event.data.sessionID,
                    messageID: event.data.assistantMessageID,
                    ordinal: event.data.ordinal,
                    delta: event.data.delta,
                  }
                : event.type === "session.text.ended"
                  ? {
                      type: "ended",
                      sessionID: event.data.sessionID,
                      messageID: event.data.assistantMessageID,
                      ordinal: event.data.ordinal,
                      text: event.data.text,
                    }
                  : undefined,
          ),
          Stream.filter((event): event is TextEvent => event !== undefined),
          Stream.mapError(failed("Could not follow OpenCode's text events")),
        ),
        interrupt: (sessionID) =>
          client.session.interrupt({ sessionID: Session.ID.make(sessionID), resume: false }).pipe(
            Effect.map((result) => result.interrupted),
            Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)),
            Effect.mapError(failed(`Could not interrupt session ${sessionID}`)),
          ),
        recentMessages: (sessionID, limit) =>
          client.message.list({ sessionID: Session.ID.make(sessionID), order: "desc", limit }).pipe(
            Effect.map((page) => page.data.flatMap(entry).toReversed()),
            Effect.mapError(failed(`Could not read session ${sessionID}`)),
          ),
        messagePage: (sessionID, limit, cursor) =>
          client.message
            .list({
              sessionID: Session.ID.make(sessionID),
              limit,
              ...(cursor ? { cursor } : { order: "desc" as const }),
            })
            .pipe(
              Effect.map((page) => ({
                entries: page.data.flatMap(entry).toReversed(),
                next: page.data.length === limit ? page.cursor?.next : undefined,
              })),
              Effect.mapError(failed(`Could not read session ${sessionID}`)),
            ),
        message: ({ sessionID, messageID }) =>
          client.session.message
            .get({
              sessionID: Session.ID.make(sessionID),
              messageID: SessionMessage.ID.make(messageID),
            })
            .pipe(
              Effect.map((item) => entry(item)[0]),
              Effect.catchTag("MessageNotFoundError", () => Effect.succeed(undefined)),
              Effect.mapError(failed(`Could not read message ${messageID}`)),
            ),
        historyPage: (sessionID, limit, cursor) =>
          client.message
            .list(
              cursor
                ? { sessionID: Session.ID.make(sessionID), cursor, limit }
                : { sessionID: Session.ID.make(sessionID), order: "asc", limit },
            )
            .pipe(
              Effect.map((page) => ({
                items: page.data.map(historyItem),
                next: page.data.length ? page.cursor.next : undefined,
              })),
              Effect.mapError(failed(`Could not read session ${sessionID}`)),
            ),
        createScratch: ({ id, directory, title, model }) =>
          Effect.try(() => Model.Ref.parse(model)).pipe(
            Effect.flatMap((ref) =>
              client.session.create({
                id: Session.ID.make(id),
                title,
                model: ref,
                location: { directory: AbsolutePath.make(directory) },
                permissions: [{ action: "*", resource: "*", effect: "deny" as const }],
              }),
            ),
            Effect.asVoid,
            Effect.mapError(failed(`Could not create session ${id}`)),
          ),
        latestCompaction: (sessionID) =>
          latestCompleted((cursor) =>
            client.message
              .list(
                cursor
                  ? { sessionID: Session.ID.make(sessionID), cursor, limit: 50, type: "compaction" }
                  : {
                      sessionID: Session.ID.make(sessionID),
                      order: "desc",
                      limit: 50,
                      type: "compaction",
                    },
              )
              .pipe(
                Effect.map((page) => ({
                  items: page.data.flatMap((item) =>
                    item.type === "compaction"
                      ? [
                          {
                            id: item.id,
                            completed: item.status === "completed",
                            native: item.status === "completed" && item.native !== undefined,
                          },
                        ]
                      : [],
                  ),
                  next: page.data.length ? page.cursor.next : undefined,
                })),
                Effect.mapError(failed(`Could not read session ${sessionID}`)),
              ),
          ),
        usage: (sessionID) =>
          sumUsage((cursor) =>
            client.message
              .list(
                cursor
                  ? { sessionID: Session.ID.make(sessionID), cursor, limit: 200, type: "assistant" }
                  : {
                      sessionID: Session.ID.make(sessionID),
                      order: "asc",
                      limit: 200,
                      type: "assistant",
                    },
              )
              .pipe(
                Effect.map((page) => ({
                  items: page.data.flatMap((item) =>
                    item.type === "assistant"
                      ? [{ tokens: item.tokens, complete: item.time.completed !== undefined }]
                      : [],
                  ),
                  next: page.data.length ? page.cursor.next : undefined,
                })),
                Effect.mapError(failed(`Could not read session ${sessionID}`)),
              ),
          ),
        historyItem: ({ sessionID, messageID }) =>
          client.session.message
            .get({
              sessionID: Session.ID.make(sessionID),
              messageID: SessionMessage.ID.make(messageID),
            })
            .pipe(
              Effect.map(historyItem),
              Effect.catchTag("MessageNotFoundError", () => Effect.succeed(undefined)),
              Effect.mapError(failed(`Could not read message ${messageID}`)),
            ),
        sessionDirectory: (sessionID) =>
          client.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(
            Effect.map((session): string | undefined => session.location.directory),
            Effect.catchTag("SessionNotFoundError", () => Effect.succeed(undefined)),
            Effect.mapError(failed(`Could not look up session ${sessionID}`)),
          ),
        sessionModel: (sessionID) =>
          client.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(
            Effect.map((session) => session.model),
            Effect.mapError(failed(`Could not look up session ${sessionID}`)),
          ),
        turnsSince: (sessionID, since) =>
          Effect.gen(function* () {
            // Every turn end at or after `since`, newest first, and the time of the one before them.
            const ends: Omit<TurnEnd, "text">[] = [];
            let before = Number.NEGATIVE_INFINITY;
            yield* newestFirst(sessionID, "idle", (item) => {
              if (item.type !== "idle") return true;
              const time = DateTime.toEpochMillis(item.time.created);
              if (time < since) {
                before = time;
                return false;
              }
              ends.push({ id: item.id, outcome: item.outcome, time, error: item.error?.message });
              return true;
            });
            const oldest = ends.at(-1);
            if (!oldest) return [];
            // Replies are matched to turns by time, and a reply in the same millisecond as a turn
            // end may belong to the turn before or after it. So a turn's reply is the newest text
            // strictly between its own end and the one before, and a turn with any text exactly at
            // its own end gets none, since that text may be its real final reply. A tie at the
            // lower end only matters when nothing lies strictly inside, which already gives none.
            const replies: Entry[] = [];
            yield* newestFirst(sessionID, "assistant", (item) => {
              const [reply] = entry(item);
              if (!reply?.text) return true;
              if (reply.time < before) return false;
              replies.push(reply);
              // The oldest turn's reply is settled, so nothing older is needed.
              return !(reply.time > before && reply.time < oldest.time);
            });
            const texts = new Map<string, string>();
            ends.forEach((end, index) => {
              const lower = ends[index + 1]?.time ?? before;
              if (replies.some((reply) => reply.time === end.time)) return;
              const reply = replies.find((item) => item.time > lower && item.time < end.time);
              if (reply) texts.set(end.id, reply.text);
            });
            return ends.map((end) => ({ ...end, text: texts.get(end.id) })).toReversed();
          }).pipe(Effect.mapError(failed(`Could not read session ${sessionID}`))),
        waiting: (sessionID) =>
          Effect.all([
            client.permission.list({ sessionID: Session.ID.make(sessionID) }),
            client.session.form.list({ sessionID }),
          ]).pipe(
            Effect.map(([permissions, forms]): Waiting[] => [
              ...permissions.map((request) => ({
                id: request.id,
                kind: "permission" as const,
                summary: `${request.action}: ${request.resources.join(", ")}`,
                detail: permissionDetail(request),
                sensitive: false,
              })),
              ...forms.map(formWaiting),
            ]),
            Effect.mapError(failed(`Could not list what ${sessionID} waits on`)),
          ),
        answer: (sessionID, kind, requestID, answer) =>
          (kind === "permission"
            ? answer.decision === "once" || answer.decision === "reject"
              ? client.permission.reply({
                  sessionID: Session.ID.make(sessionID),
                  requestID: Permission.ID.make(requestID),
                  decision: answer.decision,
                  // The 2.1.1 Effect client encodes an omitted optional message as invalid null.
                  message: "",
                })
              : Effect.fail(new OpenCodeError({ message: "Not a permission answer" }))
            : answer.decision === "reply"
              ? client.session.form.reply({
                  sessionID,
                  formID: Form.ID.make(requestID),
                  answer: answer.answer,
                })
              : answer.decision === "cancel"
                ? client.session.form.cancel({ sessionID, formID: Form.ID.make(requestID) })
                : Effect.fail(new OpenCodeError({ message: "Not a question answer" }))
          ).pipe(Effect.mapError(failed(`Could not answer ${kind} ${requestID}`))),
        threadsWorkers: (directory, coordinatorID) =>
          client.rpc
            .call({
              rpcID: "threads",
              method: "snapshot",
              location: { directory },
              input: { coordinatorIDs: [coordinatorID] },
            })
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ThreadsSnapshot)),
              Effect.map((result) => result.output.workers),
              Effect.mapError(failed(`Could not read the Threads workers of ${coordinatorID}`)),
            ),
      };
    }),
  );
}
