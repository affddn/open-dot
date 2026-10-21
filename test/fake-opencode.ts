import { Effect, Layer } from "effect";
import {
  type Approval,
  type Entry,
  OpenCode,
  OpenCodeError,
  type SessionInput,
  type Turn,
} from "../src/opencode";

const broken = (message: string) => Effect.fail(new OpenCodeError({ message }));

/** An in-memory OpenCode. "lost" admits the prompt but reports a failure, like a dropped response. */
export function fakeOpenCode() {
  const state = {
    sessions: new Set<string>(),
    messages: new Set<string>(),
    created: [] as SessionInput[],
    prompted: [] as string[],
    texts: [] as { sessionID: string; text: string }[],
    active: new Set<string>(),
    turns: new Map<string, Omit<Turn, "end"> & { end?: string }>(),
    approvals: new Map<string, Approval>(),
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
    messageExists: ({ messageID }) => Effect.sync(() => state.messages.has(messageID)),
    queuePrompt: ({ sessionID, messageID, text }) => {
      if (state.prompt === "fail") return broken("connection refused");
      state.prompted.push(messageID);
      state.texts.push({ sessionID, text });
      state.messages.add(messageID);
      return state.prompt === "lost" ? broken("connection reset") : Effect.void;
    },
    activeSessions: Effect.sync(() => new Set(state.active)),
    // Each message's turn ends at its own idle unless the test names a shared one.
    turnAfter: ({ sessionID, messageID }) =>
      Effect.sync(() => {
        const turn = state.turns.get(sessionID);
        return turn && { end: `idle_${messageID}`, ...turn };
      }),
    pendingApproval: (sessionID) => Effect.sync(() => state.approvals.get(sessionID)),
    recentMessages: (sessionID, limit) =>
      Effect.sync(() => (state.history.get(sessionID) ?? []).slice(-limit)),
  });

  return { state, layer };
}
