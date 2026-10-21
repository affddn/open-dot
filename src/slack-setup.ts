import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { Option, Schema } from "effect";
import type { Db } from "./db";
import { findDot } from "./dots";
import { type Fetch, output } from "./feed";
import { type SlackApp, slackApps, slackConfig } from "./schema";
import { isRecord, type Slack } from "./slack";

/** The Keychain item holding the owner's app configuration token pair, as JSON. */
export const configItem = "open-dot-slack-config";
export const botItem = (dot: string) => `open-dot-slack-${dot}-bot`;
export const appItem = (dot: string) => `open-dot-slack-${dot}-app`;

/** The bot scopes a dot's own app asks for. bots.info, which binds a bot token to its app, needs users:read. */
export const botScopes = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "chat:write",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "metadata.message:read",
  "users:read",
];

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** The dot's app: its own name and bot, the agent view, and events over Socket Mode. */
export const manifest = (dot: string, purpose: string | null) => {
  const about = purpose?.trim() || `${dot}, a durable personal agent.`;
  return {
    display_information: { name: clip(dot, 35), description: clip(about, 140) },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: dot, always_online: true },
      agent_view: { agent_description: clip(about, 300) },
    },
    oauth_config: { scopes: { bot: botScopes } },
    settings: {
      event_subscriptions: { bot_events: ["app_mention", "message.im"] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
};

const Pair = Schema.Struct({
  token: Schema.optionalKey(Schema.String),
  refresh_token: Schema.String,
  iat: Schema.optionalKey(Schema.Number),
});

const Rotated = Schema.Struct({
  token: Schema.String,
  refresh_token: Schema.String,
  team_id: Schema.String,
  user_id: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
});

/** Saves `secret` as a Keychain item. It goes through stdin as hex, never in argv or a log. */
export async function saveSecret(service: string, secret: string) {
  const hex = Buffer.from(secret, "utf8").toString("hex");
  const account = process.env.USER ?? "open-dot";
  if (!/^[\w.@-]+$/.test(account) || !/^[\w.-]+$/.test(service)) return false;
  try {
    const child = Bun.spawn(["security", "-i"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 10_000,
    });
    void child.stdin.write(`add-generic-password -U -a ${account} -s ${service} -X ${hex}\n`);
    await child.stdin.end();
    if ((await child.exited) !== 0) return false;
    // `security -i` can exit 0 after a failed command, so the item is read back.
    return (await output(["security", "find-generic-password", "-s", service, "-w"])) === secret;
  } catch {
    return false;
  }
}

/** The terminal, through `stty` on stdin and a line prompt. Tests pass a fake. */
export interface Terminal {
  readonly stty: (args: string[]) => { readonly ok: boolean; readonly out: string };
  readonly ask: (question: string) => string | null;
}

export const realTerminal: Terminal = {
  stty: (args) => {
    const run = Bun.spawnSync(["stty", ...args], {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "ignore",
    });
    return { ok: run.success, out: run.stdout.toString() };
  },
  ask: (question) => prompt(question),
};

/**
 * Reads a line without echoing it. Gives undefined without asking when echo can't be turned off
 * and shown to be off, so a secret is never typed into a terminal that shows it. The terminal's
 * earlier settings are put back either way.
 */
export function readHidden(question: string, terminal: Terminal = realTerminal) {
  const before = terminal.stty(["-g"]);
  const settings = before.out.trim();
  if (!before.ok || !settings) return undefined;
  let asked = false;
  try {
    if (!terminal.stty(["-echo"]).ok) return undefined;
    const now = terminal.stty(["-a"]);
    if (!now.ok || !/(^|\s)-echo(\s|$)/.test(now.out)) return undefined;
    asked = true;
    return terminal.ask(question)?.trim() ?? "";
  } finally {
    if (!terminal.stty([settings]).ok)
      console.error("Couldn't restore the terminal's settings. Run: stty sane");
    if (asked) process.stdout.write("\n");
  }
}

/** What provisioning needs from the outside world, so tests can pass fakes. */
export interface Setup {
  readonly fetch: Fetch;
  readonly read: (service: string) => Promise<string | undefined>;
  readonly save: (service: string, secret: string) => Promise<boolean>;
  readonly now: () => number;
}

export const realSetup: Setup = {
  fetch: globalThis.fetch,
  read: (service) => output(["security", "find-generic-password", "-s", service, "-w"]),
  save: saveSecret,
  now: Date.now,
};

type Answer =
  | { readonly kind: "ok"; readonly body: Record<string, unknown> }
  | { readonly kind: "refused"; readonly error: string; readonly body: Record<string, unknown> }
  | { readonly kind: "lost" };

/** One call to Slack's configuration API. Its answers can carry secrets, so none is logged. */
async function configCall(
  setup: Setup,
  method: string,
  params: Record<string, string>,
): Promise<Answer> {
  const base = process.env.OPEN_DOT_SLACK_URL ?? "https://slack.com/api";
  try {
    const response = await setup.fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) return { kind: "refused", error: "ratelimited", body: {} };
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status < 500 && isRecord(body)) {
      if (body.ok === true) return { kind: "ok", body };
      if (typeof body.error === "string") return { kind: "refused", error: body.error, body };
    }
  } catch {
    // Whatever went wrong, the call may have taken effect.
  }
  return { kind: "lost" };
}

// Errors after which Slack may have done the work anyway.
const maybeDone = new Set([
  "fatal_error",
  "internal_error",
  "service_unavailable",
  "request_timeout",
]);

class Blocked extends Error {}

const configRow = (db: Db, now: number) => {
  db.insert(slackConfig)
    .values({ id: 1, state: "idle", updatedAt: now })
    .onConflictDoNothing()
    .run();
  const row = db.select().from(slackConfig).where(eq(slackConfig.id, 1)).get();
  if (!row) throw new Error("open-dot couldn't read its Slack configuration state");
  return row;
};

type ConfigState = (typeof slackConfig.$inferSelect)["state"];

const setConfig = (db: Db, set: Partial<typeof slackConfig.$inferInsert>, from: ConfigState[]) =>
  db
    .update(slackConfig)
    .set(set)
    .where(and(eq(slackConfig.id, 1), inArray(slackConfig.state, from)))
    .returning({ id: slackConfig.id })
    .get() !== undefined;

const readPair = async (setup: Setup) => {
  const saved = await setup.read(configItem);
  if (!saved) return undefined;
  try {
    return Schema.decodeUnknownSync(Pair)(JSON.parse(saved));
  } catch {
    throw new Blocked(
      `the Keychain item ${configItem} doesn't hold a configuration token pair. Save one with: open-dot slack config`,
    );
  }
};

/**
 * A fresh app configuration token for the owner, rotated just now so Slack says whose it is.
 * The intent is saved before the rotation and the new pair goes straight to the Keychain. A
 * rotation whose outcome or save is lost blocks every later one until the owner saves a new pair,
 * because Slack may already have used up the old refresh token.
 */
export async function freshConfig(db: Db, setup: Setup, owner: { id: string; team: string }) {
  const now = setup.now();
  let row = configRow(db, now);
  if (row.state === "rotating" && now - row.updatedAt > 60_000) {
    // A daemon stopped mid-rotation. Only a saved newer pair shows that it finished.
    const pair = await readPair(setup).catch(() => undefined);
    const finished = (pair?.iat ?? 0) > (row.fromIat ?? 0);
    setConfig(
      db,
      finished
        ? { state: "idle", problem: null, updatedAt: now }
        : {
            state: "blocked",
            problem:
              "a configuration token rotation was interrupted, so its new tokens may be lost. Generate a new configuration token pair and save it with: open-dot slack config",
            updatedAt: now,
          },
      ["rotating"],
    );
    row = configRow(db, now);
  }
  if (row.state !== "idle") throw new Blocked(row.problem ?? "a token rotation is in progress");
  const pair = await readPair(setup);
  if (!pair)
    throw new Blocked(`save your app configuration tokens first, with: open-dot slack config`);
  if (
    !setConfig(db, { state: "rotating", fromIat: pair.iat ?? 0, problem: null, updatedAt: now }, [
      "idle",
    ])
  )
    throw new Blocked("another rotation started");
  const answer = await configCall(setup, "tooling.tokens.rotate", {
    refresh_token: pair.refresh_token,
  });
  const block = (problem: string) => {
    setConfig(db, { state: "blocked", problem, updatedAt: setup.now() }, ["rotating"]);
    return new Blocked(problem);
  };
  if (answer.kind === "refused" && answer.error === "ratelimited") {
    setConfig(db, { state: "idle", updatedAt: setup.now() }, ["rotating"]);
    throw new Blocked("Slack is rate limiting token rotation; trying again later");
  }
  if (answer.kind === "refused" && !maybeDone.has(answer.error))
    throw block(
      `Slack refused to rotate the configuration token (${answer.error}). Generate a new configuration token pair and save it with: open-dot slack config`,
    );
  if (answer.kind !== "ok")
    throw block(
      "a configuration token rotation got no clear answer, so its new tokens may be lost. Generate a new configuration token pair and save it with: open-dot slack config",
    );
  const rotated = Schema.decodeUnknownOption(Rotated)(answer.body);
  if (Option.isNone(rotated))
    throw block("Slack's rotation answer was unreadable. Generate and save a new pair.");
  const fresh = rotated.value;
  const savedPair = await setup
    .save(
      configItem,
      JSON.stringify({
        token: fresh.token,
        refresh_token: fresh.refresh_token,
        iat: fresh.iat,
        exp: fresh.exp,
        team_id: fresh.team_id,
        user_id: fresh.user_id,
      }),
    )
    .catch(() => false);
  if (!savedPair)
    throw block(
      `the rotated configuration tokens couldn't be saved to the Keychain item ${configItem}. Generate a new configuration token pair and save it with: open-dot slack config`,
    );
  // The pair is saved, so a later recovery finds it. A pair of someone else's creates nothing.
  if (fresh.user_id !== owner.id || fresh.team_id !== owner.team)
    throw block(
      `the configuration token belongs to ${fresh.user_id} in ${fresh.team_id}, not the owner ${owner.id} in ${owner.team} from open-dot-slack-user. Save the owner's own pair with: open-dot slack config`,
    );
  setConfig(db, { state: "idle", fromIat: fresh.iat, updatedAt: setup.now() }, ["rotating"]);
  return { token: fresh.token, team: fresh.team_id, user: fresh.user_id };
}

const setApp = (db: Db, dot: string, from: SlackApp["state"][], set: Partial<SlackApp>) =>
  db
    .update(slackApps)
    .set({ ...set, updatedAt: Date.now() })
    .where(and(eq(slackApps.dot, dot), inArray(slackApps.state, from)))
    .returning({ dot: slackApps.dot })
    .get() !== undefined;

/**
 * Moves the app on only if it's still the very attempt `seen` was read in: the same state, app ID
 * and attempt ID. A late answer about an earlier create or attach never touches a newer one.
 */
const setSeen = (db: Db, seen: SlackApp, from: SlackApp["state"][], set: Partial<SlackApp>) =>
  db
    .update(slackApps)
    .set({ ...set, updatedAt: Date.now() })
    .where(
      and(
        eq(slackApps.dot, seen.dot),
        inArray(slackApps.state, from),
        seen.appID === null ? isNull(slackApps.appID) : eq(slackApps.appID, seen.appID),
        seen.attemptID === null
          ? isNull(slackApps.attemptID)
          : eq(slackApps.attemptID, seen.attemptID),
      ),
    )
    .returning({ dot: slackApps.dot })
    .get() !== undefined;

const errorsOf = (body: Record<string, unknown>) =>
  Array.isArray(body.errors)
    ? body.errors
        .flatMap((error) =>
          isRecord(error) && typeof error.message === "string" ? [error.message] : [],
        )
        .join("; ")
    : "";

/** Creates one requested app. The attempt is saved before the call, which is never repeated blindly. */
async function create(db: Db, setup: Setup, app: SlackApp, owner: { id: string; team: string }) {
  const dot = findDot(db, app.dot);
  if (!dot) return;
  const config = await freshConfig(db, setup, owner);
  const attemptID = crypto.randomUUID();
  if (!setSeen(db, app, ["requested"], { state: "creating", attemptID, problem: null })) return;
  const claimed: SlackApp = { ...app, state: "creating", attemptID };
  const answer = await configCall(setup, "apps.manifest.create", {
    token: config.token,
    manifest: JSON.stringify(manifest(dot.name, dot.purpose)),
  });
  // Only the public app ID is kept. The client secret and signing secrets aren't needed.
  if (answer.kind === "ok" && typeof answer.body.app_id === "string") {
    setSeen(db, claimed, ["creating"], {
      state: "created",
      appID: answer.body.app_id,
      teamID: config.team,
      ownerID: config.user,
    });
    console.log(`Slack: created the app ${answer.body.app_id} for ${app.dot}`);
    return;
  }
  if (answer.kind === "refused" && answer.error === "ratelimited") {
    setSeen(db, claimed, ["creating"], { state: "requested", attemptID: null });
    return;
  }
  if (answer.kind === "refused" && !maybeDone.has(answer.error)) {
    const details = errorsOf(answer.body);
    setSeen(db, claimed, ["creating"], {
      state: "failed",
      problem: `Slack refused to create the app: ${answer.error}${details ? ` (${details})` : ""}`,
    });
    return;
  }
  setSeen(db, claimed, ["creating"], {
    state: "unknown",
    problem: "creating the app got no clear answer, so it may exist",
  });
}

const Exported = Schema.Struct({
  manifest: Schema.Struct({
    features: Schema.Struct({
      bot_user: Schema.Struct({ display_name: Schema.String }),
    }),
    settings: Schema.Struct({ socket_mode_enabled: Schema.optionalKey(Schema.Boolean) }),
  }),
});

/** Checks the app the owner named against Slack's configuration API before adopting it. */
async function attach(db: Db, setup: Setup, app: SlackApp, owner: { id: string; team: string }) {
  if (!app.appID) return;
  const config = await freshConfig(db, setup, owner);
  const answer = await configCall(setup, "apps.manifest.export", {
    token: config.token,
    app_id: app.appID,
  });
  // Export only reads, so anything but a clear answer is asked again later.
  if (
    answer.kind === "lost" ||
    (answer.kind === "refused" && (answer.error === "ratelimited" || maybeDone.has(answer.error)))
  )
    return;
  const exported =
    answer.kind === "ok" ? Schema.decodeUnknownOption(Exported)(answer.body) : undefined;
  const fits =
    exported !== undefined &&
    Option.isSome(exported) &&
    exported.value.manifest.features.bot_user.display_name === app.dot &&
    exported.value.manifest.settings.socket_mode_enabled === true;
  if (fits) {
    setSeen(db, app, ["attaching"], {
      state: "created",
      teamID: config.team,
      ownerID: config.user,
      problem: null,
    });
    return;
  }
  setSeen(db, app, ["attaching"], {
    state: "unknown",
    appID: null,
    problem:
      answer.kind === "refused"
        ? `Slack wouldn't show the app ${app.appID} to your configuration token: ${answer.error}`
        : `the app ${app.appID} isn't ${app.dot}'s: its bot isn't named ${app.dot} or it doesn't use Socket Mode`,
  });
}

/**
 * One pass of app setup: creates each requested app and checks each app the owner named. Only
 * an app the owner asked for is created. An attempt left "creating" by a stopped daemon becomes
 * "unknown", never created again on its own.
 */
export async function provision(db: Db, shared: Slack, setup: Setup = realSetup) {
  db.update(slackApps)
    .set({
      state: "unknown",
      problem: "the daemon stopped while creating the app, so it may exist",
    })
    .where(and(eq(slackApps.state, "creating"), lt(slackApps.updatedAt, setup.now() - 60_000)))
    .run();
  const pending = db
    .select()
    .from(slackApps)
    .where(inArray(slackApps.state, ["requested", "attaching"]))
    .all();
  if (pending.length === 0) return;
  const id = await shared.owner();
  const team = shared.team();
  if (!id || !team) return;
  // Rotations are serialized: one app at a time, in one loop.
  for (const app of pending) {
    try {
      if (app.state === "requested") await create(db, setup, app, { id, team });
      else await attach(db, setup, app, { id, team });
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      if (problem !== app.problem) console.error(`Slack app for ${app.dot}: ${problem}`);
      setSeen(db, app, [app.state], { problem });
      if (error instanceof Blocked) return;
      throw error;
    }
  }
}

/** Asks the daemon to create the dot's app. Safe to repeat; an app's progress is never reset. */
export function requestApp(db: Db, dot: string, retry = false) {
  const now = Date.now();
  db.insert(slackApps)
    .values({ dot, state: "requested", createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  // A refused attempt can run again. One with a lost outcome needs the owner to say there's no app.
  setApp(db, dot, retry ? ["failed", "unknown"] : ["failed"], {
    state: "requested",
    attemptID: null,
    appID: null,
    problem: null,
  });
  return db.select().from(slackApps).where(eq(slackApps.dot, dot)).get();
}

/** Asks the daemon to check and adopt an app the owner found, such as one whose creation was lost. */
export function attachApp(db: Db, dot: string, appID: string) {
  if (!/^A[A-Z0-9]{6,}$/.test(appID)) return false;
  const now = Date.now();
  // Each attach gets its own attempt ID, so an answer about an earlier one is never applied to it.
  const attemptID = crypto.randomUUID();
  db.insert(slackApps)
    .values({ dot, state: "attaching", appID, attemptID, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  return setApp(db, dot, ["requested", "unknown", "failed", "attaching"], {
    state: "attaching",
    appID,
    attemptID,
    problem: null,
  });
}

/**
 * Turns notes to others who DM the shared app on, reading DMs from now, or off. Turning them on
 * again keeps the first time, so nothing between is skipped. Gives the time they're on since.
 */
export function setNotices(db: Db, on: boolean, now = Date.now()) {
  configRow(db, now);
  db.update(slackConfig)
    .set({ noticesSince: on ? now : null })
    .where(
      on ? and(eq(slackConfig.id, 1), isNull(slackConfig.noticesSince)) : eq(slackConfig.id, 1),
    )
    .run();
  return configRow(db, now).noticesSince;
}

/** Whether the shared app sends notes, and how to change it. */
export function noticesLine(db: Db) {
  const since = db.select().from(slackConfig).where(eq(slackConfig.id, 1)).get()?.noticesSince;
  return since === null || since === undefined
    ? "Shared open-dot app: notes to others who DM it are off. Turn them on with: open-dot slack notices enable"
    : `Shared open-dot app: notes to others who DM it are on, for DMs since ${new Date(since).toISOString()}. Turn them off with: open-dot slack notices disable`;
}

/** Marks a newly saved configuration pair, which ends a blocked rotation. */
export function configSaved(db: Db) {
  const now = Date.now();
  configRow(db, now);
  db.update(slackConfig)
    .set({ state: "idle", fromIat: 0, problem: null, updatedAt: now })
    .where(eq(slackConfig.id, 1))
    .run();
}

const save = (item: string) => `security add-generic-password -U -a "$USER" -s ${item} -w`;

const appURL = (id: string) => `https://api.slack.com/apps/${id}`;

/** The app's state and the owner's next step, without any secret. */
export function describe(db: Db, app: SlackApp) {
  const config = db.select().from(slackConfig).where(eq(slackConfig.id, 1)).get();
  const lines = [`${app.dot}: ${app.state}${app.appID ? ` (app ${app.appID})` : ""}`];
  if (app.problem) lines.push(`  Problem: ${app.problem}`);
  if (config?.state === "blocked" && ["requested", "attaching"].includes(app.state))
    lines.push(`  Configuration token: ${config.problem ?? "blocked"}`);
  switch (app.state) {
    case "requested":
      lines.push(
        "  The daemon creates the app with your app configuration token. Generate a token pair at https://api.slack.com/apps (Your App Configuration Tokens), then save it with: open-dot slack config",
      );
      break;
    case "creating":
      lines.push("  The daemon is creating the app now.");
      break;
    case "unknown":
      lines.push(
        `  Look for an app named ${app.dot} at https://api.slack.com/apps. If it's there, run: open-dot slack attach ${app.dot} <app ID>`,
        `  If there's none, create it again with: open-dot slack connect ${app.dot} --retry`,
      );
      break;
    case "attaching":
      lines.push("  The daemon is checking that app with Slack.");
      break;
    case "failed":
      lines.push(`  Try again with: open-dot slack connect ${app.dot}`);
      break;
    case "created":
      if (!app.appID) break;
      lines.push(
        `  1. Install it: open ${appURL(app.appID)}/install-on-team, click Install, then Allow.`,
        `  2. Optionally set its icon under Display Information at ${appURL(app.appID)}/general.`,
        `  3. Under App-Level Tokens at ${appURL(app.appID)}/general, generate a token with the connections:write scope.`,
        `  4. Save the Bot User OAuth Token (xoxb-…, from ${appURL(app.appID)}/oauth) and the app-level token (xapp-…). Each command asks for the token without echoing it:`,
        `     ${save(botItem(app.dot))}`,
        `     ${save(appItem(app.dot))}`,
        "  The daemon reads them within a minute, checks they belong to this app, and connects.",
      );
      break;
    case "active":
      lines.push(
        `  Connected as <@${app.botUser ?? "?"}>. Invite it to a channel with /invite @${app.dot}, then mention it there, or DM it.`,
      );
      break;
  }
  return lines.join("\n");
}
