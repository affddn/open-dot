import { Effect, Layer } from "effect";
import {
  type Attachment,
  type Delivery,
  type Entry,
  OpenCode,
  OpenCodeError,
  type SessionInput,
  type Turn,
  type ThreadsWorker,
  type TurnEnd,
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
    sessionDirectory: (sessionID) =>
      Effect.suspend(() =>
        state.superviseFailure
          ? broken("session lookup failed")
          : Effect.succeed(state.directories.get(sessionID)),
      ),
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
