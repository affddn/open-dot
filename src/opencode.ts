import { AbsolutePath, OpenCode as Client, Session, SessionMessage } from "@opencode/client/effect";
import { Service } from "@opencode/client/service";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

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

/** The text of the last assistant message that wrote any. */
const lastText = (items: ReadonlyArray<SessionMessage.Info>) =>
  items
    .flatMap((item) =>
      item.type === "assistant"
        ? [
            item.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n")
              .trim(),
          ]
        : [],
    )
    .filter((written) => written !== "")
    .at(-1);

const failed = (message: string) => (cause: unknown) => new OpenCodeError({ message, cause });

export interface SessionInput {
  readonly id: string;
  readonly directory: string;
  readonly title: string;
}

export interface MessageRef {
  readonly sessionID: string;
  readonly messageID: string;
}

export interface Turn {
  readonly outcome: "succeeded" | "failed" | "interrupted";
  /** The text of the turn's last assistant message, if it wrote any. */
  readonly text: string | undefined;
  /** The idle that ended the turn. OpenCode folds a message sent mid-turn into that turn, so several messages can share one. */
  readonly end: string;
}

export interface Approval {
  readonly id: string;
  readonly action: string;
  readonly resources: readonly string[];
}

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

/** The few OpenCode calls open-dot makes. Absence is a value, every other failure is an OpenCodeError. */
export class OpenCode extends Context.Service<
  OpenCode,
  {
    readonly sessionExists: (sessionID: string) => Effect.Effect<boolean, OpenCodeError>;
    readonly createSession: (input: SessionInput) => Effect.Effect<void, OpenCodeError>;
    /** True once OpenCode has admitted the message, whether it is still queued or already in the history. */
    readonly messageExists: (ref: MessageRef) => Effect.Effect<boolean, OpenCodeError>;
    /** Queues the text as a user message with the caller's ID. */
    readonly queuePrompt: (
      ref: MessageRef & { readonly text: string },
    ) => Effect.Effect<void, OpenCodeError>;
    /** IDs of the sessions that are running a turn now. */
    readonly activeSessions: Effect.Effect<ReadonlySet<string>, OpenCodeError>;
    /** The first turn that ended after the message, or undefined while none has. */
    readonly turnAfter: (ref: MessageRef) => Effect.Effect<Turn | undefined, OpenCodeError>;
    /** The oldest permission request the session is waiting on. */
    readonly pendingApproval: (
      sessionID: string,
    ) => Effect.Effect<Approval | undefined, OpenCodeError>;
    /** User and assistant messages among the session's last `limit` history items, oldest first. */
    readonly recentMessages: (
      sessionID: string,
      limit: number,
    ) => Effect.Effect<readonly Entry[], OpenCodeError>;
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
      const { url, auth } = endpoint;
      const headers = Service.headers(auth ? { url, auth } : { url }) ?? {};
      const client = yield* Client.make({ baseUrl: url }).pipe(
        Effect.provide(
          Layer.effect(
            HttpClient.HttpClient,
            Effect.map(
              HttpClient.HttpClient,
              HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)),
            ),
          ).pipe(Layer.provide(FetchHttpClient.layer)),
        ),
      );

      return {
        sessionExists: (sessionID) =>
          client.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(
            Effect.as(true),
            Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)),
            Effect.mapError(failed(`Could not look up session ${sessionID}`)),
          ),
        createSession: ({ id, directory, title }) =>
          client.session
            .create({
              id: Session.ID.make(id),
              title,
              location: { directory: AbsolutePath.make(directory) },
              permissions: destructive,
            })
            .pipe(Effect.asVoid, Effect.mapError(failed(`Could not create session ${id}`))),
        // Check the inbox first: a queued message moves from the inbox into the history, never back.
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
        queuePrompt: ({ sessionID, messageID, text }) =>
          client.session
            .prompt({
              sessionID: Session.ID.make(sessionID),
              id: SessionMessage.ID.make(messageID),
              text,
              delivery: "queue",
            })
            .pipe(Effect.asVoid, Effect.mapError(failed(`Could not send message ${messageID}`))),
        activeSessions: client.session.active().pipe(
          Effect.map((active) => new Set<string>(Object.keys(active))),
          Effect.mapError(failed("Could not list running sessions")),
        ),
        turnAfter: ({ sessionID, messageID }) =>
          Effect.gen(function* () {
            // The full history in processing order. session.context would start at the latest
            // compaction, which can hide the prompt or its idle.
            const limit = 200;
            const turn: SessionMessage.Info[] = [];
            let prompted = false;
            let cursor: string | undefined;
            for (;;) {
              const page = yield* client.message.list(
                cursor
                  ? { sessionID: Session.ID.make(sessionID), cursor, limit }
                  : { sessionID: Session.ID.make(sessionID), order: "asc", limit },
              );
              for (const item of page.data) {
                if (!prompted) prompted = item.id === messageID;
                else if (item.type === "idle")
                  return { outcome: item.outcome, text: lastText(turn), end: item.id };
                else turn.push(item);
              }
              if (page.data.length < limit) return undefined;
              cursor = page.cursor.next;
            }
          }).pipe(Effect.mapError(failed(`Could not read session ${sessionID}`))),
        pendingApproval: (sessionID) =>
          client.permission.list({ sessionID: Session.ID.make(sessionID) }).pipe(
            Effect.map(([request]) =>
              request
                ? { id: request.id, action: request.action, resources: request.resources }
                : undefined,
            ),
            Effect.mapError(failed(`Could not list permission requests for ${sessionID}`)),
          ),
        recentMessages: (sessionID, limit) =>
          client.message.list({ sessionID: Session.ID.make(sessionID), order: "desc", limit }).pipe(
            Effect.map((page) => page.data.flatMap(entry).toReversed()),
            Effect.mapError(failed(`Could not read session ${sessionID}`)),
          ),
      };
    }),
  );
}
