import type { Model } from "@opencode/client/effect";
import { Cause, Effect, Layer, Queue, Stream } from "effect";
import {
  type Attachment,
  type Delivery,
  type Entry,
  type HistoryItem,
  OpenCode,
  OpenCodeError,
  type PromptTurn,
  type SessionInput,
  type TextEvent,
  type Written,
  type Turn,
  type ThreadsWorker,
  type TurnEnd,
  type Usage,
  type Waiting,
} from "../src/opencode";
import type { RequestAnswer } from "../src/schema";

/** A waiting item as a test writes it: details default to what the summary says. */
export type FakeWaiting = Omit<Waiting, "detail" | "sensitive"> & Partial<Waiting>;

const filled = (item: FakeWaiting): Waiting => ({
  sensitive: false,
  detail:
    item.kind === "permission"
      ? {
          kind: "permission",
          action: item.summary.split(": ")[0] ?? item.summary,
          resources: [item.summary.split(": ").slice(1).join(": ")],
        }
      : { kind: "question", title: item.summary, fields: [{ key: "answer", type: "string" }] },
  ...item,
});

const broken = (message: string) => Effect.fail(new OpenCodeError({ message }));

/**
 * An in-memory OpenCode. "lost" admits the prompt but reports a failure, like a dropped response.
 * An admitted prompt waits in `inbox` until a test delivers it by removing it, as OpenCode does at
 * a step or turn boundary.
 */
export function fakeOpenCode() {
  const state = {
    sessions: new Set<string>(),
    messages: new Set<string>(),
    created: [] as SessionInput[],
    prompted: [] as string[],
    texts: [] as { sessionID: string; text: string }[],
    files: new Map<string, readonly Attachment[]>(),
    deliveries: new Map<string, Delivery>(),
    inbox: [] as { sessionID: string; id: string; delivery: Delivery }[],
    active: new Set<string>(),
    turns: new Map<string, Omit<Turn, "end"> & { end?: string }>(),
    messageTurns: new Map<string, Turn>(),
    // What each message's running turn has written so far, until its turn ends: as its assistant
    // messages' text parts, or as one finished part of one message.
    written: new Map<string, Written[]>(),
    soFar: new Map<string, string>(),
    // Each text event connection, in order: a test emits into it, ends it or fails it.
    subscribers: [] as {
      open: boolean;
      emit: (event: TextEvent) => void;
      end: () => void;
      fail: () => void;
    }[],
    readFailure: false,
    lookupFailure: false,
    onMessage: () => {},
    onRecent: () => {},
    onPrompt: (_messageID: string) => {},
    // Runs as a by-ID lookup begins, before its answer.
    onLookup: (_messageID: string) => {},
    // Each interrupt, in order. "lost" stops the run but reports a failure, like a dropped response.
    interrupted: [] as string[],
    interrupt: "ok" as "ok" | "fail" | "lost",
    onInterrupt: (_sessionID: string) => {},
    // Supervised sessions: each one's directory, turn ends and what it waits on.
    directories: new Map<string, string>(),
    // Each session's chosen model; absent, it uses OpenCode's default.
    models: new Map<string, Model.Ref>(),
    ends: new Map<string, TurnEnd[]>(),
    waiting: new Map<string, FakeWaiting[]>(),
    onWaiting: (_sessionID: string) => {},
    // Each answer sent. "lost" sends it but reports a failure, like a dropped response.
    answers: [] as { sessionID: string; kind: string; requestID: string; answer: RequestAnswer }[],
    answer: "ok" as "ok" | "fail" | "lost",
    onAnswer: (_requestID: string) => {},
    // Each coordinator's Threads snapshot, or "unavailable" when its RPC fails.
    threads: new Map<string, readonly ThreadsWorker[] | "unavailable">(),
    threadsCalls: [] as { directory: string; coordinatorID: string }[],
    superviseFailure: false,
    history: new Map<string, Entry[]>(),
    // Each session's full history as the archive pages it, in processing order.
    items: new Map<string, HistoryItem[]>(),
    // Every archive page read, by its cursor. With `repeatCursor` a page hands back its own cursor.
    pages: [] as (string | undefined)[],
    repeatCursor: false,
    onPage: () => {},
    // Observer scratch sessions, in order; "lost" creates one but reports a failure.
    scratches: [] as { id: string; directory: string; title: string; model: string }[],
    scratch: "ok" as "ok" | "fail" | "lost",
    // What each scratch session's assistant messages report using.
    usage: new Map<string, Usage>(),
    onScratch: () => {},
    create: "ok" as "ok" | "fail",
    prompt: "ok" as "ok" | "fail" | "lost",
  };
  const layer = Layer.succeed(OpenCode, {
    sessionExists: (sessionID) => Effect.sync(() => state.sessions.has(sessionID)),
    createSession: (input) =>
      state.create === "fail"
        ? broken("connection reset")
        : Effect.sync(() => {
            state.created.push(input);
            state.sessions.add(input.id);
          }),
    messageExists: ({ messageID }) =>
      Effect.suspend(() => {
        state.onLookup(messageID);
        return state.lookupFailure
          ? broken("inbox unavailable")
          : Effect.succeed(state.messages.has(messageID));
      }),
    inbox: (sessionID) =>
      Effect.suspend(() =>
        state.lookupFailure
          ? broken("inbox unavailable")
          : Effect.succeed(state.inbox.filter((item) => item.sessionID === sessionID)),
      ),
    steerQueued: ({ messageID }) =>
      Effect.suspend(() => {
        if (state.lookupFailure) return broken("inbox unavailable");
        for (const item of state.inbox) if (item.id === messageID) item.delivery = "steer";
        return Effect.void;
      }),
    cancelQueued: ({ messageID }) =>
      Effect.suspend(() => {
        if (state.lookupFailure) return broken("inbox unavailable");
        if (state.inbox.some((item) => item.id === messageID)) {
          state.inbox = state.inbox.filter((item) => item.id !== messageID);
          state.messages.delete(messageID);
        }
        return Effect.void;
      }),
    prompt: ({ sessionID, messageID, text, files, delivery }) => {
      if (state.prompt === "fail") return broken("connection refused");
      state.onPrompt(messageID);
      state.prompted.push(messageID);
      state.texts.push({ sessionID, text });
      state.deliveries.set(messageID, delivery);
      if (files) state.files.set(messageID, files);
      state.messages.add(messageID);
      state.inbox.push({ sessionID, id: messageID, delivery });
      return state.prompt === "lost" ? broken("connection reset") : Effect.void;
    },
    activeSessions: Effect.sync(() => new Set(state.active)),
    // Each message's turn ends at its own idle unless the test names a shared one.
    turnAfter: ({ sessionID, messageID }) =>
      Effect.suspend(() =>
        state.readFailure
          ? broken("history unavailable")
          : Effect.sync(() => {
              if (state.messageTurns.has(messageID)) return state.messageTurns.get(messageID);
              const turn = state.turns.get(sessionID);
              return turn && { end: `idle_${messageID}`, ...turn };
            }),
      ),
    // An ended turn as turnAfter has it; else the inbox, then the history of admitted prompts.
    promptTurn: ({ sessionID, messageID }) =>
      Effect.suspend((): Effect.Effect<PromptTurn, OpenCodeError> => {
        if (state.readFailure || state.lookupFailure) return broken("history unavailable");
        const sessionTurn = state.turns.get(sessionID);
        const turn =
          state.messageTurns.get(messageID) ??
          (sessionTurn && state.messages.has(messageID)
            ? { end: `idle_${messageID}`, ...sessionTurn }
            : undefined);
        if (turn) return Effect.succeed({ kind: "ended" as const, turn });
        if (state.inbox.some((item) => item.id === messageID))
          return Effect.succeed({ kind: "queued" as const });
        return Effect.succeed(
          state.messages.has(messageID)
            ? { kind: "running" as const }
            : { kind: "absent" as const },
        );
      }),
    turnSoFar: ({ sessionID, messageID }) =>
      Effect.suspend(() =>
        state.readFailure
          ? broken("history unavailable")
          : Effect.sync(() => {
              if (state.messageTurns.has(messageID) || state.turns.has(sessionID)) return undefined;
              if (!state.messages.has(messageID)) return undefined;
              const written = state.written.get(messageID);
              if (written) return written;
              const soFar = state.soFar.get(messageID);
              return soFar === undefined ? [] : [{ id: `msg_reply_${messageID}`, texts: [soFar] }];
            }),
      ),
    textEvents: Stream.callback<TextEvent, OpenCodeError>((queue) =>
      Effect.gen(function* () {
        const subscriber = {
          open: true,
          emit: (event: TextEvent) => void Queue.offerUnsafe(queue, event),
          end: () => void Queue.endUnsafe(queue),
          fail: () =>
            void Queue.failCauseUnsafe(queue, Cause.fail(new OpenCodeError({ message: "reset" }))),
        };
        state.subscribers.push(subscriber);
        yield* Effect.addFinalizer(() => Effect.sync(() => (subscriber.open = false)));
      }),
    ),
    interrupt: (sessionID) =>
      Effect.suspend(() => {
        if (state.interrupt === "fail") return broken("connection refused");
        state.onInterrupt(sessionID);
        state.interrupted.push(sessionID);
        const running = state.active.delete(sessionID);
        return state.interrupt === "lost" ? broken("connection reset") : Effect.succeed(running);
      }),
    recentMessages: (sessionID, limit) =>
      Effect.sync(() => {
        const items = (state.history.get(sessionID) ?? []).slice(-limit);
        state.onRecent();
        return items;
      }),
    messagePage: (sessionID, limit, cursor) =>
      Effect.sync(() => {
        const history = state.history.get(sessionID) ?? [];
        const end = cursor ? Number(cursor) : history.length;
        const start = Math.max(0, end - limit);
        const entries = history.slice(start, end);
        state.onRecent();
        return { entries, next: start > 0 ? String(start) : undefined };
      }),
    message: ({ sessionID, messageID }) =>
      Effect.suspend(() =>
        state.readFailure
          ? broken("history unavailable")
          : Effect.sync(() => {
              const item = state.history.get(sessionID)?.find((entry) => entry.id === messageID);
              state.onMessage();
              return item;
            }),
      ),
    // Like OpenCode, a cursor names the last item read, and one whose item is gone reads nothing.
    historyPage: (sessionID, limit, cursor) =>
      Effect.suspend(() => {
        state.pages.push(cursor);
        state.onPage();
        if (state.readFailure) return broken("history unavailable");
        const items = state.items.get(sessionID) ?? [];
        const start = cursor ? items.findIndex((item) => `after:${item.id}` === cursor) + 1 : 0;
        const page = cursor && start === 0 ? [] : items.slice(start, start + limit);
        const last = page.at(-1);
        return Effect.succeed({
          items: page,
          next: last ? (state.repeatCursor && cursor ? cursor : `after:${last.id}`) : undefined,
        });
      }),
    createScratch: (input) =>
      Effect.suspend(() => {
        state.onScratch();
        if (state.scratch === "fail") return broken("connection refused");
        state.scratches.push(input);
        state.sessions.add(input.id);
        return state.scratch === "lost" ? broken("connection reset") : Effect.void;
      }),
    latestCompaction: (sessionID) =>
      Effect.suspend(() => {
        if (state.readFailure) return broken("history unavailable");
        const found = (state.items.get(sessionID) ?? []).findLast(
          (item) => item.type === "compaction" && item.complete,
        );
        return Effect.succeed(found && { id: found.id, native: found.native === true });
      }),
    usage: (sessionID) => Effect.sync(() => state.usage.get(sessionID)),
    historyItem: ({ sessionID, messageID }) =>
      Effect.suspend(() =>
        state.readFailure
          ? broken("history unavailable")
          : Effect.succeed(state.items.get(sessionID)?.find((item) => item.id === messageID)),
      ),
    sessionDirectory: (sessionID) =>
      Effect.suspend(() =>
        state.superviseFailure
          ? broken("session lookup failed")
          : Effect.succeed(state.directories.get(sessionID)),
      ),
    sessionModel: (sessionID) => Effect.sync(() => state.models.get(sessionID)),
    turnsSince: (sessionID, since) =>
      Effect.suspend(() =>
        state.superviseFailure
          ? broken("history unavailable")
          : Effect.succeed((state.ends.get(sessionID) ?? []).filter((end) => end.time >= since)),
      ),
    waiting: (sessionID) =>
      Effect.suspend(() => {
        state.onWaiting(sessionID);
        return state.superviseFailure
          ? broken("requests unavailable")
          : Effect.succeed((state.waiting.get(sessionID) ?? []).map(filled));
      }),
    answer: (sessionID, kind, requestID, answer) =>
      Effect.suspend(() => {
        if (state.answer === "fail") return broken("connection refused");
        state.onAnswer(requestID);
        state.answers.push({ sessionID, kind, requestID, answer });
        state.waiting.set(
          sessionID,
          (state.waiting.get(sessionID) ?? []).filter((item) => item.id !== requestID),
        );
        return state.answer === "lost" ? broken("connection reset") : Effect.void;
      }),
    threadsWorkers: (directory, coordinatorID) =>
      Effect.suspend(() => {
        state.threadsCalls.push({ directory, coordinatorID });
        const listed = state.threads.get(coordinatorID);
        return listed === "unavailable" ? broken("no threads RPC") : Effect.succeed(listed ?? []);
      }),
  });

  return { state, layer };
}
