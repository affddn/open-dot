#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { Effect, Schedule } from "effect";
import { api } from "./api";
import { claimDue, hasWork, step } from "./daemon";
import { openDatabase } from "./db";
import { createDot, ensureSession, findDot, listDots, pickDot } from "./dots";
import { collect, github, linear } from "./feed";
import { apiPath, databasePath } from "./home";
import { OpenCode } from "./opencode";
import { slackApps } from "./schema";
import { sharedNotices, slackChat, slackClient, slackFeed } from "./slack";
import { slackAgents } from "./slack-agents";
import {
  attachApp,
  configItem,
  configSaved,
  describe,
  noticesLine,
  provision,
  readHidden,
  requestApp,
  saveSecret,
  setNotices,
} from "./slack-setup";

const usage = `Usage:
  open-dot create <name> [purpose]   Create a dot and its OpenCode session
  open-dot list                      List dots
  open-dot open [name]               Open a dot in OpenCode
  open-dot daemon                    Deliver reminders and run workers until stopped
  open-dot slack config              Save your Slack app configuration tokens, typed without echo
  open-dot slack connect <name> [--retry]
                                     Ask the daemon to create the dot's own Slack app
  open-dot slack attach <name> <app ID>
                                     Adopt an app whose creation had no clear answer
  open-dot slack status [name]       Show each dot's Slack app and what to do next
  open-dot slack notices enable|disable
                                     Turn on or off the shared app's one note to others who DM it`;

const [command, ...args] = process.argv.slice(2);
const db = openDatabase(databasePath());

const create = (name: string, purpose: string) =>
  Effect.gen(function* () {
    const dot = yield* createDot(db, name, purpose || "Help your owner with whatever they need.");
    const ready = yield* ensureSession(db, dot);
    console.log(`Created ${ready.name} (${ready.sessionID}) in ${ready.directory}`);
    offerSlack(ready.name);
  }).pipe(Effect.provide(OpenCode.layer));

/** Asks in a terminal whether to give the new dot its own Slack app. No is the default. */
function offerSlack(name: string) {
  const later = `To give ${name} its own Slack app, run: open-dot slack connect ${name}`;
  if (!process.stdin.isTTY) return console.log(later);
  const answer = prompt(`Connect ${name} to Slack with its own app? [y/N]`);
  if (!/^y(es)?$/i.test(answer?.trim() ?? "")) return console.log(later);
  const app = requestApp(db, name);
  if (app) console.log(describe(db, app));
}

const fail = (message: string) =>
  Effect.sync(() => {
    console.error(message);
    process.exitCode = 1;
  });

/** Saves the owner's configuration token pair in one Keychain item. Nothing is echoed or logged. */
const saveConfig = Effect.suspend(() => {
  if (!process.stdin.isTTY) return fail("Run open-dot slack config in a terminal.");
  console.log(
    "Generate a token pair at https://api.slack.com/apps under Your App Configuration Tokens, then paste each token. Neither is shown.",
  );
  const hiddenFailure =
    "This terminal couldn't hide what you type, so nothing was read or saved. Run open-dot slack config in a normal terminal.";
  const token = readHidden("Access token (xoxe.xoxp-…):");
  if (token === undefined) return fail(hiddenFailure);
  const refresh = readHidden("Refresh token (xoxe-…):");
  if (refresh === undefined) return fail(hiddenFailure);
  if (!token.startsWith("xoxe.") || !refresh.startsWith("xoxe-"))
    return fail(
      "Those don't look like a configuration access token and refresh token. Nothing was saved.",
    );
  return Effect.promise(() =>
    saveSecret(configItem, JSON.stringify({ token, refresh_token: refresh })),
  ).pipe(
    Effect.andThen((saved) =>
      saved
        ? Effect.sync(() => {
            configSaved(db);
            console.log(
              `Saved in the Keychain item ${configItem}. The daemon rotates the pair before each use.`,
            );
          })
        : fail(`Couldn't save the Keychain item ${configItem}. Nothing was changed in open-dot.`),
    ),
  );
});

const slackCommand = (sub: string | undefined, name: string | undefined, rest: string[]) => {
  if (sub === "config") return saveConfig;
  if (sub === "notices" && (name === "enable" || name === "disable"))
    return Effect.sync(() => {
      setNotices(db, name === "enable");
      console.log(noticesLine(db));
    });
  if (sub === "status")
    return Effect.sync(() => {
      if (!name) console.log(noticesLine(db));
      const apps = db
        .select()
        .from(slackApps)
        .all()
        .filter((app) => !name || app.dot === name);
      if (apps.length === 0)
        return console.log(
          name
            ? `${name} has no Slack app of its own. Run: open-dot slack connect ${name}`
            : "No dot has its own Slack app. Run: open-dot slack connect <name>",
        );
      for (const app of apps) console.log(describe(db, app));
    });
  if (!name || !findDot(db, name)) return fail(name ? `No dot named "${name}".` : usage);
  if (sub === "connect")
    return Effect.sync(() => {
      const app = requestApp(db, name, rest.includes("--retry"));
      if (app) console.log(describe(db, app));
    });
  if (sub === "attach" && rest[0])
    return attachApp(db, name, rest[0])
      ? Effect.sync(() =>
          console.log(
            `The daemon checks ${rest[0]} with Slack before using it. Run: open-dot slack status ${name}`,
          ),
        )
      : fail(
          `Couldn't attach ${rest[0]}: it isn't an app ID like A0123ABCDEF, or ${name}'s app is already set up.`,
        );
  return fail(usage);
};

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
const sources = [github(), linear(), slackFeed(slack)];

/** One pass of the owner's chat with the dots in Slack. Problems are logged inside. */
const converse = slackChat(db, slack, OpenCode.layer);

/** Each dot's own Slack app: its connection, the owner's mentions and DMs, and the replies. */
const agents = slackAgents(db, OpenCode.layer);

const logged = (part: string, run: () => Promise<void>) =>
  Effect.promise(() =>
    run().catch((error: unknown) =>
      console.error(`${part}: ${error instanceof Error ? error.message : String(error)}`),
    ),
  );

const setUp = logged("Slack app setup", () => provision(db, slack));
const outsiders = sharedNotices(db, slack);
const tellOutsiders = logged("Slack notes", outsiders);

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
        Effect.repeat(agents.tick, Schedule.spaced("3 seconds")),
        Effect.repeat(setUp, Schedule.spaced("10 seconds")),
        Effect.repeat(tellOutsiders, Schedule.spaced("1 minute")),
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
          : command === "slack"
            ? slackCommand(args[0], args[1], args.slice(2))
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
