#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { Effect, Schedule } from "effect";
import { api } from "./api";
import { claimDue, hasWork, step } from "./daemon";
import { openDatabase } from "./db";
import { createDot, ensureSession, listDots, pickDot } from "./dots";
import { collect, github, linear } from "./feed";
import { apiPath, databasePath } from "./home";
import { OpenCode } from "./opencode";
import { slackChat, slackClient } from "./slack";

const usage = `Usage:
  open-dot create <name> [purpose]   Create a dot and its OpenCode session
  open-dot list                      List dots
  open-dot open [name]               Open a dot in OpenCode
  open-dot daemon                    Deliver reminders and run workers until stopped`;

const [command, ...args] = process.argv.slice(2);
const db = openDatabase(databasePath());

const create = (name: string, purpose: string) =>
  Effect.gen(function* () {
    const dot = yield* createDot(db, name, purpose || "Help your owner with whatever they need.");
    const ready = yield* ensureSession(db, dot);
    console.log(`Created ${ready.name} (${ready.sessionID}) in ${ready.directory}`);
  }).pipe(Effect.provide(OpenCode.layer));

const open = (name: string | undefined) =>
  Effect.gen(function* () {
    const dot = yield* ensureSession(db, yield* pickDot(db, name));
    const opencode = process.env.OPEN_DOT_OPENCODE ?? "opencode";
    const child = Bun.spawn([opencode, "--session", dot.sessionID, dot.directory], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    yield* Effect.promise(() => child.exited);
  }).pipe(Effect.provide(OpenCode.layer));

const list = Effect.sync(() => {
  const all = listDots(db);
  if (all.length === 0) return console.log("No dots yet. Run: open-dot create <name>");
  for (const dot of all)
    console.log(
      `${dot.name}\t${dot.sessionState}\t${dot.sessionID}\t${dot.directory}\t${dot.purpose ?? ""}`,
    );
});

const report = (error: { readonly message: string }) =>
  Effect.sync(() => console.error(error.message));

const tick = Effect.suspend(() => {
  claimDue(db, Date.now());
  if (!hasWork(db)) return Effect.void;
  return step(db).pipe(Effect.provide(OpenCode.layer), Effect.catch(report));
});

/** Serves the notch app's API on a fresh port and token, then saves both where only the owner can read them. */
const serve = Effect.sync(() => {
  const token = randomBytes(32).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: api(db, token, OpenCode.layer),
  });
  const temporary = `${apiPath()}.${process.pid}`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token }), {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, apiPath());
  console.log(`open-dot API on http://127.0.0.1:${server.port}`);
});

const slack = slackClient();
const sources = [github(), linear()];

/** One pass of the owner's chat with the dots in Slack. Problems are logged inside. */
const converse = slackChat(db, slack, OpenCode.layer);

/** Collects each source's feed. One failing source doesn't stop the others. */
const gather = Effect.promise(() =>
  Promise.all(
    sources.map((source) =>
      collect(db, source, Date.now()).catch((error: unknown) =>
        console.error(
          `Feed from ${source.name}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    ),
  ),
);

const daemon = Effect.sync(() => console.log(`open-dot daemon watching ${databasePath()}`)).pipe(
  Effect.andThen(serve),
  Effect.andThen(
    Effect.all(
      [
        Effect.repeat(tick, Schedule.spaced("1 second")),
        Effect.repeat(converse, Schedule.spaced("3 seconds")),
        // GitHub asks clients to poll notifications at most once a minute.
        Effect.repeat(gather, Schedule.spaced("1 minute")),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  ),
);

const program =
  command === "create" && args[0]
    ? create(args[0], args.slice(1).join(" "))
    : command === "list"
      ? list
      : command === "open"
        ? open(args[0])
        : command === "daemon"
          ? daemon
          : Effect.sync(() => console.log(usage));

await Effect.runPromise(
  program.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
);
