import { and, asc, eq, gte, inArray, isNotNull, isNull, like, lt } from "drizzle-orm";
import { Option, Schema } from "effect";
import { avatarPath, avatarRevision, readAvatar } from "./avatar";
import type { Db } from "./db";
import { findDot } from "./dots";
import { type Fetch, output } from "./feed";
import { type SlackApp, type SuggestedPrompt, slackApps, slackConfig, slackEvents } from "./schema";
import { isRecord, type Slack, slackClient, slackCode, slackIDs } from "./slack";

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

/**
 * The bot events a dot's app subscribes to. The agent view's thread events, added in manifest
 * version 2, let the dot set its suggested prompts when the owner opens a thread or its DM.
 */
export const botEvents = [
  "app_mention",
  "message.im",
  "assistant_thread_started",
  "assistant_thread_context_changed",
  "app_home_opened",
];

/** The version of the manifest below. An app with an older one needs `open-dot slack update`. */
export const manifestVersion = 2;

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
      event_subscriptions: { bot_events: botEvents },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
};

export const promptTitleLimit = 75;
export const promptMessageLimit = 1000;

/** Prompts the agent view suggests when the owner hasn't chosen their own: two plain ones, and the purpose. */
export const defaultPrompts = (purpose: string | null): SuggestedPrompt[] => {
  const about = purpose?.replace(/\s+/g, " ").trim();
  return [
    { title: "What needs me today?", message: "What needs my attention today?" },
    {
      title: "Catch me up",
      message: "Catch me up on what you're keeping track of for me, and what's next.",
    },
    ...(about
      ? [
          {
            title: clip(about, promptTitleLimit),
            message: clip(`Help me with this: ${about}`, promptMessageLimit),
          },
        ]
      : []),
  ];
};

/** The owner's prompts as given in a file, checked, or what's wrong with them. */
export function checkPrompts(value: unknown): SuggestedPrompt[] | string {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4)
    return 'Give 2 to 4 prompts, as a JSON array of { "title": …, "message": … }.';
  const prompts: SuggestedPrompt[] = [];
  for (const [index, item] of value.entries()) {
    const keys = isRecord(item) ? Object.keys(item).toSorted() : [];
    if (!isRecord(item) || keys.join() !== "message,title")
      return `Prompt ${index + 1} needs exactly a "title" and a "message".`;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const message = typeof item.message === "string" ? item.message.trim() : "";
    if (!title || title.length > promptTitleLimit || /[\n\r]/.test(title))
      return `Prompt ${index + 1}'s title must be one line of 1 to ${promptTitleLimit} characters.`;
    if (!message || message.length > promptMessageLimit)
      return `Prompt ${index + 1}'s message must be 1 to ${promptMessageLimit} characters.`;
    prompts.push({ title, message });
  }
  return prompts;
}

/** Saves the owner's prompts for the dot's agent view, or with null goes back to the purpose's. */
export const setPrompts = (db: Db, dot: string, prompts: readonly SuggestedPrompt[] | null) =>
  db
    .update(slackApps)
    .set({ prompts, updatedAt: Date.now() })
    .where(eq(slackApps.dot, dot))
    .returning({ dot: slackApps.dot })
    .get() !== undefined;

/** The prompts the dot's agent view shows now. */
export const promptsOf = (app: SlackApp, purpose: string | null) =>
  app.prompts ?? defaultPrompts(purpose);

const union = (have: unknown, want: readonly string[]) => {
  const list = Array.isArray(have) ? have.filter((item) => typeof item === "string") : [];
  return [...list, ...want.filter((item) => !list.includes(item))];
};

const nested = (parent: Record<string, unknown>, key: string) => {
  const value = parent[key];
  if (isRecord(value)) return value;
  const made: Record<string, unknown> = {};
  parent[key] = made;
  return made;
};

/**
 * An exported manifest with what this version needs added: its bot scopes and events. Everything
 * else is kept as Slack gave it, since apps.manifest.update replaces the whole manifest.
 */
export const upgraded = (exported: Record<string, unknown>) => {
  const copy = structuredClone(exported);
  const scopes = nested(nested(copy, "oauth_config"), "scopes");
  scopes.bot = union(scopes.bot, botScopes);
  const events = nested(nested(copy, "settings"), "event_subscriptions");
  events.bot_events = union(events.bot_events, botEvents);
  return copy;
};

const Pair = Schema.Struct({
  token: Schema.optionalKey(Schema.String),
  refresh_token: Schema.String,
  iat: Schema.optionalKey(Schema.Number),
  // The claim time of the owner's save that wrote this pair, which proves that save finished.
  saved: Schema.optionalKey(Schema.Number),
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
  | {
      readonly kind: "refused";
      // One of `slackErrors`, or "slack_error": never Slack's own words.
      readonly error: string;
      // Seconds, from Slack's Retry-After header on a rate limit.
      readonly retryAfter?: number;
    }
  | { readonly kind: "lost" };

/** An ID to print in a message: itself when it has Slack's form, else fixed words. */
const shownID = (id: string, form: RegExp) => (form.test(id) ? id : "an unrecognized ID");

/** An image to send as the multipart `file` field. */
interface Upload {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Buffer;
}

/**
 * One call to Slack's configuration API. Its answers can carry secrets, so none is logged. With
 * a file, the call is multipart and the token goes in the Authorization header instead.
 */
function configCall(
  setup: Setup,
  method: string,
  params: Record<string, string>,
  file?: Upload,
): Promise<Answer> {
  if (!file)
    return slackPost(setup, method, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  const { token, ...fields } = params;
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
  return slackPost(setup, method, {
    headers: { authorization: `Bearer ${token ?? ""}` },
    body: form,
  });
}

/**
 * One JSON call with the owner's Slack CLI token in the Authorization header, the way the Slack
 * CLI calls apps.manifest.create and apps.developerInstall. Its answers can carry tokens, so
 * none is logged.
 */
const cliCall = (setup: Setup, method: string, token: string, body: Record<string, unknown>) =>
  slackPost(setup, method, {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

async function slackPost(setup: Setup, method: string, request: RequestInit): Promise<Answer> {
  const base = process.env.OPEN_DOT_SLACK_URL ?? "https://slack.com/api";
  try {
    const response = await setup.fetch(`${base}/${method}`, {
      method: "POST",
      ...request,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) {
      const after = Number(response.headers.get("retry-after"));
      return {
        kind: "refused",
        error: "ratelimited",
        ...(Number.isFinite(after) && after > 0 ? { retryAfter: after } : {}),
      };
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status < 500 && isRecord(body)) {
      if (body.ok === true) return { kind: "ok", body };
      if (typeof body.error === "string") return { kind: "refused", error: slackCode(body.error) };
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

/** A configuration token problem the owner has to fix, or a wait. Its words carry no secret. */
export class Blocked extends Error {}

const configRow = (db: Db, now: number) => {
  db.insert(slackConfig)
    .values({ id: 1, state: "idle", updatedAt: now })
    .onConflictDoNothing()
    .run();
  const row = db.select().from(slackConfig).where(eq(slackConfig.id, 1)).get();
  if (!row) throw new Error("open-dot couldn't read its Slack configuration state");
  return row;
};

type ConfigRow = typeof slackConfig.$inferSelect;

/**
 * Moves the configuration row on only from the very state, time and `from_iat` it was read
 * with, so an answer about an older rotation or save never touches a newer claim.
 */
const setConfigFrom = (db: Db, seen: ConfigRow, set: Partial<typeof slackConfig.$inferInsert>) =>
  db
    .update(slackConfig)
    .set(set)
    .where(
      and(
        eq(slackConfig.id, 1),
        eq(slackConfig.state, seen.state),
        eq(slackConfig.updatedAt, seen.updatedAt),
        seen.fromIat === null ? isNull(slackConfig.fromIat) : eq(slackConfig.fromIat, seen.fromIat),
      ),
    )
    .returning({ id: slackConfig.id })
    .get() !== undefined;

/** How long a claim on the configuration item holds before another may take it over. */
const claimStale = 60_000;

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

const superseded =
  "the configuration tokens changed while they were being rotated, so this rotation's tokens weren't used. Trying again later.";

const noPair = "save your app configuration tokens first, with: open-dot slack config";

/** What a dot's app waits for when there's neither a Slack login nor a configuration pair. */
const loginFirst =
  "log in to Slack once in the notch's Slack view (Connectors → Slack → Log in to Slack), or create the app yourself from the prefilled link there. A configuration token pair saved with open-dot slack config works too.";

/**
 * A fresh app configuration token for the owner, rotated just now so Slack says whose it is.
 * The intent is saved before the rotation and the new pair goes straight to the Keychain. A
 * rotation whose outcome or save is lost blocks every later one until the owner saves a new pair,
 * because Slack may already have used up the old refresh token. Every move is conditional on the
 * claim this rotation made, renewed just before its pair is saved, so a rotation that outlived
 * its claim, which the owner's save may have taken over, saves nothing and returns no token. This
 * guards against open-dot's own processes, within the Keychain calls' time limits, not against a
 * process suspended past a minute or another program writing the item.
 */
export async function freshConfig(db: Db, setup: Setup, owner: { id: string; team: string }) {
  const now = setup.now();
  let row = configRow(db, now);
  if (row.state === "rotating" && now - row.updatedAt > claimStale) {
    // A process stopped mid-rotation or mid-save. Only the pair it meant to save shows that it
    // finished: a newer rotated one, or the owner's marked with that save's claim time.
    const pair = await readPair(setup).catch(() => undefined);
    const finished =
      row.fromIat === -1 ? pair?.saved === row.updatedAt : (pair?.iat ?? 0) > (row.fromIat ?? 0);
    setConfigFrom(
      db,
      row,
      finished
        ? { state: "idle", problem: null, updatedAt: Math.max(now, row.updatedAt + 1) }
        : {
            state: "blocked",
            problem:
              row.fromIat === -1
                ? "saving a configuration token pair was interrupted, so the Keychain item may hold either pair. Save the pair again with: open-dot slack config"
                : "a configuration token rotation was interrupted, so its new tokens may be lost. Generate a new configuration token pair and save it with: open-dot slack config",
            updatedAt: Math.max(now, row.updatedAt + 1),
          },
    );
    row = configRow(db, now);
  }
  if (row.state !== "idle") throw new Blocked(row.problem ?? "a token rotation is in progress");
  const pair = await readPair(setup);
  if (!pair) throw new Blocked(noPair);
  // Claimed only if nothing moved since the row was read, before the pair was.
  let mine: ConfigRow = {
    ...row,
    state: "rotating",
    fromIat: pair.iat ?? 0,
    problem: null,
    updatedAt: Math.max(now, row.updatedAt + 1),
  };
  const { state, fromIat, problem, updatedAt } = mine;
  if (!setConfigFrom(db, row, { state, fromIat, problem, updatedAt }))
    throw new Blocked("another rotation or save started");
  const answer = await configCall(setup, "tooling.tokens.rotate", {
    refresh_token: pair.refresh_token,
  });
  const block = (reason: string) => {
    setConfigFrom(db, mine, { state: "blocked", problem: reason, updatedAt: setup.now() });
    return new Blocked(reason);
  };
  if (answer.kind === "refused" && answer.error === "ratelimited") {
    setConfigFrom(db, mine, {
      state: "idle",
      updatedAt: Math.max(setup.now(), mine.updatedAt + 1),
    });
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
  // Renewed just before the save, so a takeover can start only a minute after, while the save is
  // limited to 10 seconds. A process suspended for longer isn't fenced off.
  const renewed: ConfigRow = { ...mine, updatedAt: Math.max(setup.now(), mine.updatedAt + 1) };
  if (!setConfigFrom(db, mine, { updatedAt: renewed.updatedAt })) throw new Blocked(superseded);
  mine = renewed;
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
  if (
    fresh.user_id !== owner.id ||
    fresh.team_id !== owner.team ||
    !slackIDs.user.test(fresh.user_id) ||
    !slackIDs.team.test(fresh.team_id)
  )
    throw block(
      `the configuration token belongs to ${shownID(fresh.user_id, slackIDs.user)} in ${shownID(fresh.team_id, slackIDs.team)}, not the owner ${shownID(owner.id, slackIDs.user)} in ${shownID(owner.team, slackIDs.team)} from open-dot-slack-user. Save the owner's own pair with: open-dot slack config`,
    );
  // A claim lost meanwhile means the outcome isn't this rotation's to settle: no token is used.
  if (
    !setConfigFrom(db, mine, {
      state: "idle",
      fromIat: fresh.iat,
      updatedAt: Math.max(setup.now(), mine.updatedAt + 1),
    })
  )
    throw new Blocked(superseded);
  return { token: fresh.token, team: fresh.team_id, user: fresh.user_id };
}

/** The owner and workspace of `open-dot-slack-user`, whom every dot's app answers. */
export interface Owner {
  readonly id: string;
  readonly team: string;
}

/** A workspace's ID. An org-wide (E…) login or install isn't supported. */
const workspaceID = /^T[A-Z0-9]{1,31}$/;

/** The Keychain item holding the owner's Slack CLI-style login for one workspace, as JSON. */
export const cliItem = (team: string) => `open-dot-slack-cli-${team}`;

/** The Slack CLI's latest release (v4.11.0). A ticket asks with major.minor, an exchange with all. */
const cliTicketVersion = "v4.11";
const cliVersion = "v4.11.0";
/** How long a login's slash command waits for its challenge code, in open-dot's memory only. */
export const ticketLife = 10 * 60_000;
/** A CLI token is used until this close to its expiry, then refreshed first, as the CLI does. */
const refreshMargin = 5 * 60_000;

/** An expiry in seconds that `Date` can show: finite, positive, and at most 8.64e12. */
const saneExp = (exp: number) => Number.isFinite(exp) && exp > 0 && exp <= 8.64e12;

const CliRecord = Schema.Struct({
  token: Schema.String,
  refresh_token: Schema.String,
  team_id: Schema.String,
  user_id: Schema.String,
  exp: Schema.Number,
  // "rotating" is saved before tooling.tokens.rotate, so one whose outcome was lost is never retried.
  state: Schema.Literals(["ready", "rotating"]),
});

const Exchanged = Schema.Struct({
  token: Schema.String,
  refresh_token: Schema.String,
  team_id: Schema.String,
  user_id: Schema.String,
  exp: Schema.Number,
  is_ready: Schema.optionalKey(Schema.Boolean),
  is_enterprise_install: Schema.optionalKey(Schema.Boolean),
});

/** What the notch shows of the Slack login: never a token, a refresh token or a ticket. */
export interface LoginView {
  // "unknown": not read since the daemon started. "relogin": it can't be used; log in again.
  readonly state: "unknown" | "none" | "ready" | "relogin";
  readonly team: string | null;
  readonly user: string | null;
  readonly problem: string | null;
  /** A login waiting for its challenge code. */
  readonly pending: { readonly attempt: string; readonly expiresAt: number } | null;
}

/** One answer of a route's work: why not, with the status to send. */
export interface Refusal {
  readonly status: number;
  readonly problem: string;
}

/**
 * Runs one Keychain-writing step at a time in this process: a login's save, a CLI token's
 * refresh and the saves of a dot's tokens. Only the daemon runs them.
 */
const gates = new WeakMap<Setup, { last: Promise<unknown> }>();
function serial<T>(setup: Setup, run: () => Promise<T>) {
  const gate = gates.get(setup) ?? { last: Promise.resolve() };
  gates.set(setup, gate);
  const next = gate.last.then(run, run);
  gate.last = next.catch(() => {});
  return next;
}

/**
 * The owner's Slack CLI-style login, in the daemon's memory: the login waiting for its challenge
 * code, and what the Keychain item last showed. The ticket lives only here, is used once and
 * expires; the challenge code is never kept. Tokens live only in the Keychain item `cliItem`,
 * never in `~/.slack`, the database, a log or an answer.
 */
function makeLogin(setup: Setup) {
  let known: Omit<LoginView, "pending"> = {
    state: "unknown",
    team: null,
    user: null,
    problem: null,
  };
  let pending: { attempt: string; ticket: string; expiresAt: number } | undefined;
  const set = (state: LoginView["state"], owner: Owner, problem: string | null = null) => {
    known = { state, team: owner.team, user: owner.id, problem };
  };
  const relogin = (owner: Owner, problem: string) => {
    set("relogin", owner, problem);
    return new Blocked(problem);
  };
  const live = () => (pending && setup.now() < pending.expiresAt ? pending : undefined);

  /** The saved login of the owner's workspace, or undefined with none. Throws when it can't be used. */
  const read = async (owner: Owner) => {
    if (!workspaceID.test(owner.team)) {
      set("none", owner);
      return undefined;
    }
    const item = cliItem(owner.team);
    const saved = await setup.read(item);
    if (!saved) {
      set("none", owner);
      return undefined;
    }
    let record: typeof CliRecord.Type;
    try {
      record = Schema.decodeUnknownSync(CliRecord)(JSON.parse(saved));
    } catch {
      throw relogin(owner, `the Keychain item ${item} doesn't hold a Slack login. Log in again.`);
    }
    // An expired token is fine, since its refresh token renews it; a malformed one is never used.
    if (
      !looksLike(record.token, "xoxe.") ||
      !looksLike(record.refresh_token, "xoxe-") ||
      !saneExp(record.exp)
    )
      throw relogin(
        owner,
        `the Keychain item ${item} doesn't hold a usable Slack login. Log in again.`,
      );
    if (record.team_id !== owner.team || record.user_id !== owner.id)
      throw relogin(owner, `the Slack login in ${item} isn't yours. Log in again as yourself.`);
    if (record.state === "rotating")
      throw relogin(
        owner,
        "refreshing the Slack login was interrupted, so its tokens may be used up. Log in again.",
      );
    return record;
  };

  return {
    view: (): LoginView => {
      const waiting = live();
      return {
        ...known,
        pending: waiting ? { attempt: waiting.attempt, expiresAt: waiting.expiresAt } : null,
      };
    },

    /** Reads what the Keychain holds for the owner, without refreshing anything. */
    check: (owner: Owner) =>
      serial(setup, async () => {
        if ((await read(owner)) !== undefined) set("ready", owner);
      }),

    /**
     * Starts a login: Slack's ticket for the `/slackauthticket` command, kept in memory for
     * `ticketLife`. A new start forgets any earlier one. Without no_rotation, as the CLI asks.
     */
    start: async (): Promise<Refusal | { attempt: string; command: string; expiresAt: number }> => {
      const answer = await configCall(setup, "apps.hosted.generateAuthTicket", {
        slack_cli_version: cliTicketVersion,
      });
      const ticket = answer.kind === "ok" ? answer.body.ticket : undefined;
      if (typeof ticket !== "string" || !/^[A-Za-z0-9+/=_-]{8,512}$/.test(ticket))
        return {
          status: 502,
          problem:
            answer.kind === "refused"
              ? `Slack wouldn't start a login (${answer.error}). Try again.`
              : "Slack didn't start a login. Try again.",
        };
      pending = { attempt: crypto.randomUUID(), ticket, expiresAt: setup.now() + ticketLife };
      return {
        attempt: pending.attempt,
        command: `/slackauthticket ${ticket}`,
        expiresAt: pending.expiresAt,
      };
    },

    /**
     * Exchanges the waiting login's ticket and the owner's challenge code, once: the login is
     * used up before the call, whatever its outcome. Only a complete, ready answer for the owner's
     * own workspace and user is saved, straight to the Keychain.
     */
    finish: async (attempt: string, challenge: string, owner: Owner) => {
      const mine = live();
      if (!mine || mine.attempt !== attempt)
        return {
          status: 409,
          problem: "That login isn't the one waiting, or it expired. Start the login again.",
        } satisfies Refusal;
      pending = undefined;
      return serial(setup, async (): Promise<Refusal | undefined> => {
        const answer = await configCall(setup, "apps.hosted.exchangeAuthTicket", {
          ticket: mine.ticket,
          challenge,
          slack_cli_version: cliVersion,
        });
        if (answer.kind !== "ok")
          return {
            status: 502,
            problem:
              answer.kind === "refused"
                ? `Slack refused the login (${answer.error}). Nothing was saved. Start it again.`
                : "The login got no clear answer from Slack, so nothing was saved. Start it again.",
          };
        const decoded = Schema.decodeUnknownOption(Exchanged)(answer.body);
        const got = Option.isSome(decoded) ? decoded.value : undefined;
        if (
          !got ||
          got.is_ready !== true ||
          !looksLike(got.token, "xoxe.") ||
          !looksLike(got.refresh_token, "xoxe-") ||
          !slackIDs.user.test(got.user_id) ||
          !saneExp(got.exp) ||
          !(got.exp * 1000 > setup.now())
        )
          return {
            status: 502,
            problem: "Slack's login answer wasn't complete, so nothing was saved. Start it again.",
          };
        if (got.is_enterprise_install === true || !workspaceID.test(got.team_id))
          return {
            status: 409,
            problem:
              "That login is for a whole Enterprise organization. Log in to your workspace instead. Nothing was saved.",
          };
        if (got.user_id !== owner.id || got.team_id !== owner.team)
          return {
            status: 409,
            problem: `That login is ${shownID(got.user_id, slackIDs.user)} in ${shownID(got.team_id, slackIDs.team)}, not you (${shownID(owner.id, slackIDs.user)} in ${shownID(owner.team, slackIDs.team)}, from open-dot-slack-user). Nothing was saved. Log in as yourself.`,
          };
        const item = cliItem(got.team_id);
        const saved = await setup
          .save(
            item,
            JSON.stringify({
              token: got.token,
              refresh_token: got.refresh_token,
              team_id: got.team_id,
              user_id: got.user_id,
              exp: got.exp,
              state: "ready",
            }),
          )
          .catch(() => false);
        if (!saved) {
          const problem = `Couldn't confirm the login was saved in the Keychain item ${item}. Log in again.`;
          set("relogin", owner, problem);
          return { status: 500, problem };
        }
        set("ready", owner);
        return undefined;
      });
    },

    /**
     * The owner's CLI token, or undefined without a login. Near its expiry it's refreshed first
     * with tooling.tokens.rotate: "rotating" is saved before the call, so a refresh whose answer
     * or save is lost leaves it, and the next use asks the owner to log in again instead of
     * sending a refresh token Slack may have used up. The answer must name the same owner.
     */
    token: (owner: Owner) =>
      serial(setup, async () => {
        const record = await read(owner);
        if (!record) return undefined;
        if (record.exp * 1000 - setup.now() > refreshMargin) {
          set("ready", owner);
          return record.token;
        }
        const item = cliItem(owner.team);
        const marked = await setup
          .save(item, JSON.stringify({ ...record, state: "rotating" }))
          .catch(() => false);
        if (!marked)
          throw new Blocked(
            `couldn't confirm the Slack login's refresh was marked in ${item}, so it wasn't refreshed. Trying again later.`,
          );
        const answer = await configCall(setup, "tooling.tokens.rotate", {
          refresh_token: record.refresh_token,
        });
        if (answer.kind === "refused" && answer.error === "ratelimited") {
          // Slack refused, so the refresh token is still good: it goes back as it was.
          if (!(await setup.save(item, JSON.stringify(record)).catch(() => false)))
            throw relogin(owner, `couldn't put the Slack login back in ${item}. Log in again.`);
          throw new Blocked(
            "Slack is rate limiting the Slack login's refresh. Trying again later.",
          );
        }
        if (answer.kind !== "ok")
          throw relogin(
            owner,
            answer.kind === "refused" && !maybeDone.has(answer.error)
              ? `Slack refused to refresh the Slack login (${answer.error}). Log in again.`
              : "refreshing the Slack login got no clear answer, so its tokens may be used up. Log in again.",
          );
        const decoded = Schema.decodeUnknownOption(Rotated)(answer.body);
        const fresh = Option.isSome(decoded) ? decoded.value : undefined;
        if (
          !fresh ||
          !saneExp(fresh.exp) ||
          !(fresh.exp * 1000 > setup.now()) ||
          fresh.team_id !== owner.team ||
          fresh.user_id !== owner.id ||
          !looksLike(fresh.token, "xoxe.") ||
          !looksLike(fresh.refresh_token, "xoxe-")
        )
          throw relogin(
            owner,
            "Slack's refresh of the Slack login didn't name you, was already expired or was unreadable, so it wasn't used. Log in again.",
          );
        const saved = await setup
          .save(
            item,
            JSON.stringify({
              token: fresh.token,
              refresh_token: fresh.refresh_token,
              team_id: fresh.team_id,
              user_id: fresh.user_id,
              exp: fresh.exp,
              state: "ready",
            }),
          )
          .catch(() => false);
        if (!saved)
          throw relogin(
            owner,
            `the refreshed Slack login couldn't be saved in ${item}. Log in again.`,
          );
        set("ready", owner);
        return fresh.token;
      }),
  };
}

const logins = new WeakMap<Setup, ReturnType<typeof makeLogin>>();

/** The one login of this process for `setup`, shared by the daemon's API and its setup loop. */
export function cliLogin(setup: Setup) {
  const found = logins.get(setup) ?? makeLogin(setup);
  logins.set(setup, found);
  return found;
}

/** The owner from `open-dot-slack-user`, by Slack's auth.test, or undefined while there's none. */
export async function ownerOf(setup: Setup): Promise<Owner | undefined> {
  const client = slackClient(
    setup.fetch,
    { bot: async () => undefined, user: () => setup.read("open-dot-slack-user") },
    setup.now,
  );
  const answer = await client.call("user", "auth.test");
  const { user_id: id, team_id: team } = answer?.kind === "ok" ? answer.body : {};
  return typeof id === "string" &&
    slackIDs.user.test(id) &&
    typeof team === "string" &&
    slackIDs.team.test(team)
    ? { id, team }
    : undefined;
}

/**
 * The daemon's install of a dot's app with apps.developerInstall, kept in `attempt_id` so no
 * migration is needed: `install:<phase>:<code>:<uuid>`. "queued" waits for the daemon, "sending"
 * is saved just before the call, "saved" means both tokens reached the Keychain, "approval" an
 * admin must approve it, and "failed" anything else. Only "queued" is ever sent, once.
 */
const installPhases = ["queued", "sending", "saved", "approval", "failed"] as const;
type InstallPhase = (typeof installPhases)[number];

const installMark = (phase: InstallPhase, code = "") =>
  `install:${phase}:${code}:${crypto.randomUUID()}`;

export function installOf(app: Pick<SlackApp, "attemptID">) {
  const found = /^install:(queued|sending|saved|approval|failed):([a-z_]*):/.exec(
    app.attemptID ?? "",
  );
  const phase = installPhases.find((one) => one === found?.[1]);
  return phase ? { phase, code: found?.[2] || null } : null;
}

const appRow = (db: Db, dot: string) =>
  db.select().from(slackApps).where(eq(slackApps.dot, dot)).get();

/** The app an app-level token names: `xapp-<n>-<app ID>-…`. */
const appOfLevel = (token: string) => /^xapp-\d{1,4}-(A[A-Z0-9]{6,31})-/.exec(token)?.[1];

/**
 * Slack's documented prefilled link: a new app from the dot's manifest, which the owner creates,
 * installs and takes tokens from in Slack. Every time it's used, it makes another app.
 */
export const manifestLink = (dot: string, purpose: string | null) =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest(dot, purpose)))}`;

const approvals = new Map([
  [
    "app_approval_request_eligible",
    "Waiting for admin approval: your workspace needs an admin to approve this app, and open-dot hasn't asked for it. Request approval on the app's install page, then Retry install once an admin approves.",
  ],
  [
    "app_approval_request_pending",
    "Waiting for admin approval: a request to approve this app is waiting for your workspace's admins. Retry install once one approves.",
  ],
  [
    "app_approval_request_denied",
    "An admin denied this app. Ask your admins, then Retry install, or use a workspace that allows it.",
  ],
]);

const manualInstall = (appID: string) =>
  `Retry install, or install the same app yourself at ${appURL(appID)}/install-on-team and save its bot token and an app-level token. The prefilled link makes a second app instead, and this one stays in Slack until you delete it.`;

/** What an apps.developerInstall answer means: the bot and app-level tokens, or how it failed. */
function installed(
  answer: Answer,
  appID: string,
): { bot: string; level: string } | { phase: InstallPhase; code: string; problem: string } {
  if (answer.kind === "refused") {
    const approval = approvals.get(answer.error);
    if (approval) return { phase: "approval", code: answer.error, problem: approval };
    if (!maybeDone.has(answer.error))
      return {
        phase: "failed",
        code: answer.error,
        problem: `Slack refused to install the app (${answer.error}). ${manualInstall(appID)}`,
      };
  }
  if (answer.kind !== "ok")
    return {
      phase: "failed",
      code: unknownOutcome,
      problem: `installing the app got no clear answer, so Slack may have issued tokens open-dot didn't keep. ${manualInstall(appID)}`,
    };
  const issued = isRecord(answer.body.api_access_tokens) ? answer.body.api_access_tokens : {};
  const { bot, app_level: level } = issued;
  if (
    answer.body.app_id === appID &&
    typeof bot === "string" &&
    typeof level === "string" &&
    looksLike(bot, "xoxb-") &&
    looksLike(level, "xapp-") &&
    appOfLevel(level) === appID
  )
    return { bot, level };
  return {
    phase: "failed",
    code: "bad_answer",
    problem: `Slack's install answer had no usable tokens for this app, so none was saved. ${manualInstall(appID)}`,
  };
}

/**
 * Installs a created app with the owner's Slack login, the way `slack run` does: apps.developerInstall
 * with the app ID and bot scopes, and no team ID for a workspace. "sending" is saved first, and the
 * call is made once; a refusal or lost answer waits for the owner's Retry install. Its bot and
 * app-level tokens go only to their Keychain items, and only while the app is still this attempt's;
 * a user token is ignored. The tokens' own checks, `auth.test`, `bots.info` and Socket Mode's
 * `hello`, still decide when the app is active.
 */
async function installApp(db: Db, setup: Setup, app: SlackApp) {
  if (!app.appID || !app.ownerID || !app.teamID) return;
  const appID = app.appID;
  const token = await cliLogin(setup).token({ id: app.ownerID, team: app.teamID });
  if (!token) {
    const problem = `log in to Slack in the notch's Slack view to install it, or ${manualInstall(appID).replace(/^Retry install, or /, "")}`;
    if (app.problem !== problem) setSeen(db, app, ["created"], { problem });
    return;
  }
  const attemptID = installMark("sending");
  if (!setSeen(db, app, ["created"], { attemptID, problem: null })) return;
  const claimed: SlackApp = { ...app, attemptID };
  const settle = (phase: InstallPhase, code: string, problem: string | null) => {
    setSeen(db, claimed, ["created"], { attemptID: installMark(phase, code), problem });
  };
  const answer = await cliCall(setup, "apps.developerInstall", token, {
    app_id: appID,
    bot_scopes: botScopes,
  });
  const outcome = installed(answer, appID);
  if ("phase" in outcome) {
    settle(outcome.phase, outcome.code, outcome.problem);
    return;
  }
  const { bot, level } = outcome;
  await serial(setup, async () => {
    const now = appRow(db, app.dot);
    if (now?.state !== "created" || now.appID !== appID || now.attemptID !== attemptID) return;
    const saved =
      (await setup.save(botItem(app.dot), bot).catch(() => false)) &&
      (await setup.save(appItem(app.dot), level).catch(() => false));
    if (saved) {
      settle("saved", "", null);
      console.log(`Slack: installed the app ${appID} for ${app.dot}`);
    } else
      settle(
        "failed",
        "save_failed",
        `couldn't confirm the tokens Slack issued were saved in ${botItem(app.dot)} and ${appItem(app.dot)}. ${manualInstall(appID)}`,
      );
  });
}

/**
 * The owner's Retry install: the daemon installs the same created app again with the Slack
 * login, once. Gives why not.
 */
export function retryInstall(db: Db, dot: string) {
  const app = appRow(db, dot);
  if (app?.state !== "created" || !app.appID || !app.ownerID || !app.teamID)
    return `${dot} has no created app waiting to be installed.`;
  if (installOf(app)?.phase === "sending") return "The daemon is installing the app now.";
  return setSeen(db, app, ["created"], { attemptID: installMark("queued"), problem: null })
    ? undefined
    : "The app changed meanwhile. Try again.";
}

/**
 * Binds the dot to the app whose bot token and app-level token the owner gives, such as one made
 * from the prefilled link, with no Slack login or configuration token. Slack, not the owner's word,
 * says whose it is: the bot token's auth.test must show a bot in the owner's workspace, and its
 * bots.info the app the app-level token names. A different app than the dot's created or active
 * one replaces it only with `replacing`, the ID of that very app the owner confirmed replacing, so
 * a confirmation of an app since replaced never carries over; replacing forgets the old bot and
 * icon, and both Keychain items are written for the new app. Gives why not, never a token.
 */
export async function linkApp(
  db: Db,
  setup: Setup,
  dot: string,
  bot: string,
  level: string,
  replacing: string | undefined,
): Promise<Refusal | undefined> {
  const appID = appOfLevel(level);
  if (!looksLike(bot, "xoxb-") || !looksLike(level, "xapp-") || !appID)
    return {
      status: 400,
      problem:
        "Send the app's bot token (xoxb-…) and its app-level token (xapp-…). Nothing was saved.",
    };
  const before = appRow(db, dot);
  const busy =
    before &&
    (["creating", "attaching"].includes(before.state) || installOf(before)?.phase === "sending");
  if (busy)
    return { status: 409, problem: "The daemon is setting up this dot's app now. Try again soon." };
  const other = db
    .select({ dot: slackApps.dot })
    .from(slackApps)
    .where(eq(slackApps.appID, appID))
    .all()
    .find((row) => row.dot !== dot);
  if (other)
    return { status: 409, problem: `The app ${appID} is ${other.dot}'s. Nothing was saved.` };
  const boundApp =
    before?.appID && ["created", "active"].includes(before.state) ? before.appID : undefined;
  const same = boundApp === appID;
  // Checked before any call or write: the confirmation must name the app bound now.
  if (replacing !== undefined && replacing !== boundApp)
    return {
      status: 409,
      problem: `You confirmed replacing ${shownID(replacing, slackIDs.app)}, but ${dot}'s app is ${boundApp ?? "none"} now. Check it and confirm again. Nothing was saved.`,
    };
  if (boundApp && !same && replacing !== boundApp)
    return {
      status: 409,
      problem: `${dot} already has the app ${boundApp}. Replacing it with ${appID} needs your confirmation. Nothing was saved.`,
    };
  const owner = await ownerOf(setup);
  if (!owner)
    return {
      status: 409,
      problem:
        "open-dot needs your own Slack user token (open-dot-slack-user) to check whose app this is. Nothing was saved.",
    };
  const client = slackClient(
    setup.fetch,
    { bot: async () => bot, user: async () => undefined },
    setup.now,
    { item: botItem(dot) },
  );
  const unchecked = {
    status: 502,
    problem: "Slack didn't confirm whose bot token that is. Nothing was saved.",
  };
  const botUser = await client.bot().catch(() => undefined);
  const botID = client.botID();
  if (!botUser || !botID) return unchecked;
  if (client.botTeam() !== owner.team || (same && before?.teamID !== owner.team))
    return {
      status: 409,
      problem: "That bot is in another workspace than yours. Nothing was saved.",
    };
  const info = await client.call("bot", "bots.info", { bot: botID });
  if (info?.kind !== "ok") return unchecked;
  const found = isRecord(info.body.bot) ? info.body.bot : {};
  if (found.app_id !== appID || found.user_id !== botUser)
    return {
      status: 409,
      problem: "That bot token and app-level token belong to different apps. Nothing was saved.",
    };
  return serial(setup, async (): Promise<Refusal | undefined> => {
    const now = appRow(db, dot);
    const unchanged =
      now?.state === before?.state &&
      now?.appID === before?.appID &&
      now?.attemptID === before?.attemptID;
    if (!unchanged)
      return { status: 409, problem: "The dot's app changed meanwhile. Nothing was saved." };
    // Again with no await before the binding: no schema rule keeps an app to one dot.
    const taken = db
      .select({ dot: slackApps.dot })
      .from(slackApps)
      .where(eq(slackApps.appID, appID))
      .all()
      .find((row) => row.dot !== dot);
    if (taken)
      return { status: 409, problem: `The app ${appID} is ${taken.dot}'s. Nothing was saved.` };
    if (!same) {
      const bound = {
        state: "created" as const,
        appID,
        teamID: owner.team,
        ownerID: owner.id,
        botID: null,
        botUser: null,
        attemptID: crypto.randomUUID(),
        problem: null,
        // The prefilled link carries this version's manifest.
        manifestVersion,
        updateState: null,
        updateAt: null,
        updateNote: null,
        ...noIcon,
      };
      const moved = before
        ? setSeen(db, before, [before.state], bound)
        : db
            .insert(slackApps)
            .values({ dot, ...bound, createdAt: Date.now(), updatedAt: Date.now() })
            .onConflictDoNothing()
            .returning({ dot: slackApps.dot })
            .get() !== undefined;
      if (!moved)
        return { status: 409, problem: "The dot's app changed meanwhile. Nothing was saved." };
    }
    const saved =
      (await setup.save(botItem(dot), bot).catch(() => false)) &&
      (await setup.save(appItem(dot), level).catch(() => false));
    if (saved) return undefined;
    const problem = `Couldn't confirm the tokens were saved in ${botItem(dot)} and ${appItem(dot)}. They may or may not be there: save them again.`;
    const current = appRow(db, dot);
    if (current) setSeen(db, current, ["created", "active"], { problem });
    return { status: 500, problem };
  });
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

/**
 * The token that creates and checks apps: the owner's Slack login when there is one, else the
 * configuration pair, rotated as before. A login that needs logging in again blocks; it never
 * falls back, so a lost refresh is never hidden.
 */
async function toolFor(db: Db, setup: Setup, owner: Owner) {
  const cli = await cliLogin(setup).token(owner);
  if (cli) return { kind: "cli" as const, token: cli, team: owner.team, user: owner.id };
  try {
    return { kind: "config" as const, ...(await freshConfig(db, setup, owner)) };
  } catch (error) {
    throw error instanceof Blocked && error.message === noPair ? new Blocked(loginFirst) : error;
  }
}

type Tool = Awaited<ReturnType<typeof toolFor>>;

/** apps.manifest.create or export, as JSON with a CLI token or as a form with a configuration one. */
const toolCall = (setup: Setup, tool: Tool, method: string, params: Record<string, unknown>) =>
  tool.kind === "cli"
    ? cliCall(setup, method, tool.token, params)
    : configCall(setup, method, {
        token: tool.token,
        ...Object.fromEntries(
          Object.entries(params).map(([key, value]) => [
            key,
            typeof value === "string" ? value : JSON.stringify(value),
          ]),
        ),
      });

/** Creates one requested app. The attempt is saved before the call, which is never repeated blindly. */
async function create(db: Db, setup: Setup, app: SlackApp, owner: Owner) {
  const dot = findDot(db, app.dot);
  if (!dot) return;
  const tool = await toolFor(db, setup, owner);
  const attemptID = crypto.randomUUID();
  if (!setSeen(db, app, ["requested"], { state: "creating", attemptID, problem: null })) return;
  const claimed: SlackApp = { ...app, state: "creating", attemptID };
  // The dot's own name, with no "(local)" suffix: that's the Slack CLI's, added on its side.
  const answer = await toolCall(setup, tool, "apps.manifest.create", {
    manifest: manifest(dot.name, dot.purpose),
  });
  // Only the public app ID is kept. The client secret and signing secrets aren't needed.
  // An app ID not of Slack's form is never saved: the app may exist, so it's left for the owner.
  const appID = answer.kind === "ok" ? answer.body.app_id : undefined;
  if (typeof appID === "string" && slackIDs.app.test(appID)) {
    // With a Slack login the daemon installs it next; with a configuration token, the owner does.
    const install = tool.kind === "cli" ? installMark("queued") : undefined;
    const saved = setSeen(db, claimed, ["creating"], {
      state: "created",
      appID,
      teamID: tool.team,
      ownerID: tool.user,
      manifestVersion,
      ...(install ? { attemptID: install } : {}),
    });
    console.log(`Slack: created the app ${appID} for ${app.dot}`);
    const now = install && saved ? appRow(db, app.dot) : undefined;
    if (now && now.attemptID === install) await installApp(db, setup, now);
    return;
  }
  if (answer.kind === "refused" && answer.error === "ratelimited") {
    setSeen(db, claimed, ["creating"], { state: "requested", attemptID: null });
    return;
  }
  if (answer.kind === "refused" && !maybeDone.has(answer.error)) {
    setSeen(db, claimed, ["creating"], {
      state: "failed",
      problem: `Slack refused to create the app: ${answer.error}`,
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
async function attach(db: Db, setup: Setup, app: SlackApp, owner: Owner) {
  if (!app.appID) return;
  const tool = await toolFor(db, setup, owner);
  const answer = await toolCall(setup, tool, "apps.manifest.export", { app_id: app.appID });
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
    // With a Slack login, the same app is installed next, never a new one created.
    setSeen(db, app, ["attaching"], {
      state: "created",
      teamID: tool.team,
      ownerID: tool.user,
      problem: null,
      ...(tool.kind === "cli" ? { attemptID: installMark("queued") } : {}),
    });
    return;
  }
  setSeen(db, app, ["attaching"], {
    state: "unknown",
    appID: null,
    problem:
      answer.kind === "refused"
        ? `Slack wouldn't show the app ${app.appID} to your ${tool.kind === "cli" ? "Slack login" : "configuration token"}: ${answer.error}`
        : `the app ${app.appID} isn't ${app.dot}'s: its bot isn't named ${app.dot} or it doesn't use Socket Mode`,
  });
}

/**
 * Moves the owner's update on, only from the very state and stamp `seen` was read with. Each
 * move stamps `update_at` past the last one, so an answer or confirmation about an older attempt
 * never touches a newer one, even one that has already gone back to no update. Gives the new
 * stamp, or undefined when something changed meanwhile.
 */
const setUpdate = (db: Db, seen: SlackApp, now: number, set: Partial<SlackApp>) => {
  const stamp = Math.max(now, (seen.updateAt ?? 0) + 1);
  const saved = db
    .update(slackApps)
    .set({ ...set, updateAt: stamp, updatedAt: Date.now() })
    .where(
      and(
        eq(slackApps.dot, seen.dot),
        seen.appID === null ? isNull(slackApps.appID) : eq(slackApps.appID, seen.appID),
        seen.updateState === null
          ? isNull(slackApps.updateState)
          : eq(slackApps.updateState, seen.updateState),
        seen.updateAt === null ? isNull(slackApps.updateAt) : eq(slackApps.updateAt, seen.updateAt),
      ),
    )
    .returning({ dot: slackApps.dot })
    .get();
  return saved ? stamp : undefined;
};

const listAt = (from: Record<string, unknown>, path: readonly string[]) => {
  let value: unknown = from;
  for (const key of path) value = isRecord(value) ? value[key] : undefined;
  return Array.isArray(value) ? value : [];
};

/** What an update adds to the exported manifest, in the owner's words. */
const added = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  (
    [
      ["bot scopes", ["oauth_config", "scopes", "bot"]],
      ["bot events", ["settings", "event_subscriptions", "bot_events"]],
    ] as const
  ).flatMap(([name, path]) => {
    const had = listAt(before, path);
    const extra = listAt(after, path).filter((item) => !had.includes(item));
    return extra.length ? [`${name}: ${extra.join(", ")}`] : [];
  });

const reinstallNote = (appID: string, dot: string) =>
  `Slack says the update needs your approval. Reinstall the app at ${appURL(appID)}/install-on-team (Install, then Allow). If its Bot User OAuth Token changes, save it again with: ${save(botItem(dot))}. Once that's done, run open-dot slack update ${dot} to clear this note.`;

const landedNote = (appID: string, dot: string) =>
  `The update reached Slack, but its answer was lost, so Slack may want you to reinstall the app to approve its new events: open ${appURL(appID)}/install-on-team. If Slack shows nothing to approve, there's nothing to do. Run open-dot slack update ${dot} to clear this note.`;

/**
 * Brings the dot's existing app up to this version's manifest. Only the owner's
 * `open-dot slack update` runs it, never the daemon. The app's current manifest is exported and
 * checked to be the dot's, and only the missing scopes and events are added, since an update
 * replaces the whole manifest. The attempt is saved before apps.manifest.update. A lost answer
 * is never sent again: the next run checks the export to learn whether it landed.
 */
export async function updateApp(
  db: Db,
  setup: Setup,
  dot: string,
  confirm: (changes: readonly string[]) => boolean | Promise<boolean>,
) {
  const app = db.select().from(slackApps).where(eq(slackApps.dot, dot)).get();
  if (!app?.appID || !app.ownerID || !app.teamID || !["created", "active"].includes(app.state))
    return `${dot} has no created Slack app to update. Run: open-dot slack status ${dot}`;
  if (app.updateState === "updating" && setup.now() - (app.updateAt ?? 0) < 60_000)
    return `An update of ${dot}'s app started less than a minute ago. Run this again in a minute to check how it went.`;
  const config = await freshConfig(db, setup, { id: app.ownerID, team: app.teamID });
  const exported = await configCall(setup, "apps.manifest.export", {
    token: config.token,
    app_id: app.appID,
  });
  if (exported.kind !== "ok")
    return `Slack didn't show the manifest of ${app.appID} (${exported.kind === "refused" ? exported.error : "no clear answer"}), so nothing was changed. Try again later.`;
  const current = isRecord(exported.body.manifest) ? exported.body.manifest : undefined;
  const checked = Schema.decodeUnknownOption(Exported)(exported.body);
  if (
    !current ||
    Option.isNone(checked) ||
    checked.value.manifest.features.bot_user.display_name !== dot ||
    checked.value.manifest.settings.socket_mode_enabled !== true
  )
    return `The app ${app.appID} isn't ${dot}'s: its bot isn't named ${dot} or it doesn't use Socket Mode. Nothing was changed.`;
  const wanted = upgraded(current);
  const pending = app.updateState === "updating" || app.updateState === "unknown";
  if (Bun.deepEquals(wanted, current)) {
    const note = pending ? landedNote(app.appID, dot) : null;
    if (!setUpdate(db, app, setup.now(), { manifestVersion, updateState: null, updateNote: note }))
      return "The app's update changed meanwhile, so nothing was saved. Run this again.";
    return note ?? `${dot}'s app already has everything this version needs. Nothing was changed.`;
  }
  const changes = added(current, wanted);
  if (pending)
    changes.unshift("The last update didn't reach Slack: its manifest still lacks these.");
  if (!(await confirm(changes))) return "Nothing was changed.";
  // Claimed only if nothing moved since the export was read, so a stale export is never sent.
  const stamp = setUpdate(db, app, setup.now(), { updateState: "updating", updateNote: null });
  if (stamp === undefined) return "The app changed meanwhile, so nothing was sent. Run this again.";
  const claimed: SlackApp = { ...app, updateState: "updating", updateAt: stamp };
  const answer = await configCall(setup, "apps.manifest.update", {
    token: config.token,
    app_id: app.appID,
    manifest: JSON.stringify(wanted),
  });
  const settle = (set: Partial<SlackApp>, said: string) =>
    setUpdate(db, claimed, setup.now(), set)
      ? said
      : `A newer update of ${dot}'s app replaced this one, so its answer was ignored. Run: open-dot slack status ${dot}`;
  if (answer.kind === "ok") {
    // Slack says whether the new scopes or events need the owner's approval; that's kept for status.
    const note = answer.body.permissions_updated === true ? reinstallNote(app.appID, dot) : null;
    return settle(
      { updateState: null, manifestVersion, updateNote: note },
      `Updated ${dot}'s app. ${note ?? "Slack needs no reinstall for it."}`,
    );
  }
  if (answer.kind === "refused" && !maybeDone.has(answer.error)) {
    const note = `Slack refused the manifest update: ${answer.error}. Nothing changed in Slack.`;
    return settle({ updateState: "failed", updateNote: note }, note);
  }
  const note = `The manifest update got no clear answer, so it may have landed. It's never sent again on its own: run open-dot slack update ${dot} to check the app's manifest with Slack.`;
  return settle({ updateState: "unknown", updateNote: note }, note);
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
  // An install a stopped daemon left may have had tokens issued that nobody saved: never resent.
  for (const app of db
    .select()
    .from(slackApps)
    .where(
      and(
        eq(slackApps.state, "created"),
        like(slackApps.attemptID, "install:sending:%"),
        lt(slackApps.updatedAt, setup.now() - 60_000),
      ),
    )
    .all())
    if (app.appID)
      setSeen(db, app, ["created"], {
        attemptID: installMark("failed", unknownOutcome),
        problem: `the daemon stopped while installing the app, so Slack may have issued tokens open-dot didn't keep. ${manualInstall(app.appID)}`,
      });
  const rows = db.select().from(slackApps).all();
  const pending = rows.filter(
    (app) =>
      app.state === "requested" ||
      app.state === "attaching" ||
      (app.state === "created" && installOf(app)?.phase === "queued"),
  );
  const login = cliLogin(setup);
  // Once a daemon start, while some app isn't connected, the login's state is read for the notch.
  const unsure =
    login.view().state === "unknown" &&
    rows.some((app) => ["unknown", "failed", "created"].includes(app.state));
  const id = pending.length > 0 || unsure ? await shared.owner() : undefined;
  const team = id ? shared.team() : undefined;
  if (id && team) {
    if (unsure && pending.length === 0) await login.check({ id, team }).catch(() => {});
    // Rotations are serialized: one app at a time, in one loop.
    for (const app of pending) {
      try {
        if (app.state === "requested") await create(db, setup, app, { id, team });
        else if (app.state === "attaching") await attach(db, setup, app, { id, team });
        else await installApp(db, setup, app);
      } catch (error) {
        // Only open-dot's own words are saved, where the notch shows them; anything else is
        // logged in fixed words and left to the daemon's log line from the setup loop.
        const problem =
          error instanceof Blocked
            ? error.message
            : "app setup failed unexpectedly; see the daemon's log";
        if (problem !== app.problem) console.error(`Slack app for ${app.dot}: ${problem}`);
        setSeen(db, app, [app.state], { problem });
        if (error instanceof Blocked) return;
        throw error;
      }
    }
  }
  await setIcons(db, setup);
}

/** Slack's apps.icon.set is Tier 1, so open-dot makes at most one such call a minute. */
const iconSpacing = 60_000;
/** A daemon's own call ends within 20 seconds, so an older "setting" was left by a stopped one. */
const iconStale = 60_000;
/** The latest time `Date` can show, so even a huge Retry-After is kept, and still printable. */
const latestTime = 8.64e15;
/** What an icon call with no clear answer, or one left by a stopped daemon, is saved as. */
export const unknownOutcome = "unknown_outcome";

export type IconStatus = "no-avatar" | "set" | "pending" | "setting" | "waiting" | "refused";

/**
 * Where the app's icon stands against the dot's current avatar. A rate limit holds every revision,
 * so "waiting" shows whatever the avatar is now.
 */
export function iconStatus(app: SlackApp, revision = avatarRevision(app.dot)): IconStatus {
  if (!revision) return "no-avatar";
  if (app.iconRevision === revision) return "set";
  if (app.iconState === "setting") return "setting";
  if (app.iconState === "waiting") return "waiting";
  if (app.iconAttempt === revision && app.iconState === "refused") return "refused";
  return "pending";
}

/** Until when Slack's rate limit holds every icon call, across every app, or 0. */
const iconLimit = (apps: readonly SlackApp[]) =>
  Math.max(0, ...apps.map((app) => (app.iconState === "waiting" ? (app.iconRetryAt ?? 0) : 0)));

/**
 * Moves an icon attempt on, only from the very state and stamp `seen` was read with, for the
 * same app. Each move stamps `icon_at` past the last, so a late answer changes nothing newer.
 */
const setIcon = (db: Db, seen: SlackApp, now: number, set: Partial<SlackApp>) => {
  const stamp = Math.max(now, (seen.iconAt ?? 0) + 1);
  const saved = db
    .update(slackApps)
    .set({ ...set, iconAt: stamp, updatedAt: Date.now() })
    .where(
      and(
        eq(slackApps.dot, seen.dot),
        inArray(slackApps.state, ["created", "active"]),
        seen.appID === null ? isNull(slackApps.appID) : eq(slackApps.appID, seen.appID),
        seen.iconState === null
          ? isNull(slackApps.iconState)
          : eq(slackApps.iconState, seen.iconState),
        seen.iconAt === null ? isNull(slackApps.iconAt) : eq(slackApps.iconAt, seen.iconAt),
      ),
    )
    .returning({ dot: slackApps.dot })
    .get();
  return saved ? stamp : undefined;
};

/**
 * Sets one app's icon from its dot's avatar with apps.icon.set, when the avatar's revision isn't
 * the one last set. A call whose outcome is unknown, or one a stopped daemon left, is never sent
 * again on its own: like a refusal, it waits for a new avatar or the owner's retry. Slack's rate
 * limit holds every app until its Retry-After. One call a pass, at most one a minute.
 */
export async function setIcons(db: Db, setup: Setup) {
  const now = setup.now();
  const apps = db
    .select()
    .from(slackApps)
    .where(inArray(slackApps.state, ["created", "active"]))
    .all();
  if (apps.length === 0) return;
  for (const app of apps)
    if (app.iconState === "setting" && now - (app.iconAt ?? 0) >= iconStale)
      setIcon(db, app, now, { iconState: "refused", iconError: unknownOutcome });
  const last = Math.max(0, ...apps.map((app) => app.iconAt ?? 0));
  if (now - last < iconSpacing || now < iconLimit(apps)) return;
  for (const app of apps) {
    if (!app.appID || !app.ownerID || !app.teamID) continue;
    const revision = avatarRevision(app.dot);
    const status = iconStatus(app, revision);
    if (!revision || status === "set" || status === "refused" || status === "setting") continue;
    const avatar = readAvatar(app.dot);
    // Read only while the revision stayed the same, so the bytes are that revision's.
    if ("status" in avatar || avatarRevision(app.dot) !== revision) continue;
    let config: Awaited<ReturnType<typeof freshConfig>>;
    try {
      config = await freshConfig(db, setup, { id: app.ownerID, team: app.teamID });
    } catch (error) {
      // The configuration token's own state says why; slack status shows it.
      if (error instanceof Blocked) return;
      throw error;
    }
    const stamp = setIcon(db, app, setup.now(), {
      iconState: "setting",
      iconAttempt: revision,
      iconError: null,
      iconRetryAt: null,
    });
    if (stamp === undefined) return;
    const claimed: SlackApp = { ...app, iconState: "setting", iconAt: stamp };
    const answer = await configCall(
      setup,
      "apps.icon.set",
      { token: config.token, app_id: app.appID },
      {
        name: avatar.mime === "image/png" ? "avatar.png" : "avatar.jpg",
        mime: avatar.mime,
        bytes: avatar.bytes,
      },
    );
    const at = setup.now();
    if (answer.kind === "ok")
      setIcon(db, claimed, at, { iconState: null, iconRevision: revision, iconError: null });
    else if (answer.kind === "refused" && answer.error === "ratelimited")
      // Slack refused this call, so it's sent again once Retry-After has passed, however long.
      setIcon(db, claimed, at, {
        iconState: "waiting",
        iconError: answer.error,
        iconRetryAt: Math.min(
          latestTime,
          Math.ceil(at + Math.max((answer.retryAfter ?? 60) * 1000, iconSpacing)),
        ),
      });
    else {
      const error =
        answer.kind === "refused" && !maybeDone.has(answer.error) ? answer.error : unknownOutcome;
      setIcon(db, claimed, at, { iconState: "refused", iconError: error });
      console.error(`Slack app for ${app.dot}: Slack didn't set its icon (${error})`);
    }
    return;
  }
}

/**
 * The owner's retry of the app's icon: it's set again from the current avatar on a later pass,
 * after a refusal or an unknown outcome too. Gives why not, when it can't be: no app yet, a call
 * in flight, or Slack's rate limit still holding icon calls.
 */
export function retryIcon(db: Db, dot: string, now = Date.now()) {
  const apps = db.select().from(slackApps).all();
  const app = apps.find((row) => row.dot === dot);
  if (!app?.appID || !["created", "active"].includes(app.state))
    return `${dot} has no created Slack app yet.`;
  if (!avatarRevision(dot))
    return `${dot} has no avatar. Set one with: open-dot avatar ${dot} <file>`;
  if (app.iconState === "setting") return "The daemon is setting the icon now.";
  if (now < iconLimit(apps))
    return "Slack is rate limiting icon changes. The daemon tries again on its own once it allows.";
  const cleared = db
    .update(slackApps)
    .set({
      iconRevision: null,
      iconState: null,
      iconAttempt: null,
      iconError: null,
      iconRetryAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(slackApps.dot, dot),
        eq(slackApps.appID, app.appID),
        app.iconState === null
          ? isNull(slackApps.iconState)
          : eq(slackApps.iconState, app.iconState),
        app.iconAt === null ? isNull(slackApps.iconAt) : eq(slackApps.iconAt, app.iconAt),
      ),
    )
    .returning({ dot: slackApps.dot })
    .get();
  return cleared ? undefined : "The icon changed meanwhile. Try again.";
}

/** Clears what's known about an app's icon, when the app it was set on is no longer the one. */
const noIcon = {
  iconRevision: null,
  iconState: null,
  iconAttempt: null,
  iconError: null,
  iconRetryAt: null,
} as const;

const tokenLimit = 1024;
/** A token of the given kind, by its prefix: printable ASCII without spaces, bounded. */
const looksLike = (token: string, prefix: string) =>
  token.length > prefix.length &&
  token.length <= tokenLimit &&
  token.startsWith(prefix) &&
  /^[\x21-\x7e]+$/.test(token);

/**
 * Saves the owner's configuration token pair in its Keychain item, which ends a blocked rotation.
 * The CLI and the notch share it. A save and a rotation both write that item, so a save claims
 * the same "rotating" state a rotation does, only from the row as it read it: idle, blocked, or a
 * claim over a minute old that a stopped process left. It's refused while a rotation runs, which
 * renews its claim just before saving its own pair, so, among open-dot's own processes within
 * the Keychain calls' time limits, neither overwrites the other. A save whose
 * outcome is unclear blocks rotation until the owner saves again, since the item may hold either
 * pair. The pair carries its claim's time, and the claim a `from_iat` of -1, so a save a stopped
 * process left counts as finished only when the item holds that very pair; otherwise it blocks.
 * Gives why not, never a token.
 */
export async function saveConfigPair(db: Db, setup: Setup, token: string, refresh: string) {
  if (!looksLike(token, "xoxe.") || !looksLike(refresh, "xoxe-"))
    return "Those don't look like a configuration access token and refresh token. Nothing was saved.";
  const now = setup.now();
  const before = configRow(db, now);
  const mine: ConfigRow = {
    ...before,
    state: "rotating",
    fromIat: -1,
    problem: null,
    updatedAt: Math.max(now, before.updatedAt + 1),
  };
  const active = before.state === "rotating" && now - before.updatedAt <= claimStale;
  const { state, fromIat, problem, updatedAt } = mine;
  if (active || !setConfigFrom(db, before, { state, fromIat, problem, updatedAt }))
    return "A configuration token rotation is in progress, so nothing was saved. Try again in a minute.";
  const saved = await setup
    .save(configItem, JSON.stringify({ token, refresh_token: refresh, saved: mine.updatedAt }))
    .catch(() => false);
  const after = Math.max(setup.now(), mine.updatedAt + 1);
  if (!saved) {
    setConfigFrom(db, mine, {
      state: "blocked",
      problem: `saving a configuration token pair to the Keychain item ${configItem} wasn't confirmed, so it may hold either pair. Save the pair again with: open-dot slack config`,
      updatedAt: after,
    });
    return `Couldn't confirm the configuration tokens were saved in the Keychain item ${configItem}, so it may hold either pair. Save the pair again.`;
  }
  if (!setConfigFrom(db, mine, { state: "idle", fromIat: 0, problem: null, updatedAt: after }))
    return "The configuration tokens changed while they were being saved, so this save may not be the one in the Keychain. Save the pair again.";
  return undefined;
}

/**
 * Saves a created app's bot token (`xoxb-…`) or app-level token (`xapp-…`) in its Keychain item,
 * where the daemon reads and checks it. Gives why not, never the token.
 */
export async function saveAppToken(
  db: Db,
  setup: Setup,
  dot: string,
  kind: "bot" | "app",
  token: string,
) {
  const app = db.select().from(slackApps).where(eq(slackApps.dot, dot)).get();
  if (!app?.appID || !["created", "active"].includes(app.state))
    return `${dot} has no created Slack app to save a token for.`;
  if (installOf(app)?.phase === "sending") return installing;
  const [prefix, item] = kind === "bot" ? ["xoxb-", botItem(dot)] : ["xapp-", appItem(dot)];
  if (!looksLike(token, prefix))
    return `That doesn't look like ${kind === "bot" ? "a bot token (xoxb-…)" : "an app-level token (xapp-…)"}. Nothing was saved.`;
  // Written only while the app is still the one read above, so a token meant for an app that
  // was replaced while this waited its turn never overwrites the new app's.
  const saved = await serial(setup, async () => {
    const now = appRow(db, dot);
    if (
      now?.appID !== app.appID ||
      now.attemptID !== app.attemptID ||
      !["created", "active"].includes(now.state)
    )
      return changedMeanwhile;
    if (installOf(now)?.phase === "sending") return installing;
    // False may mean it was written but couldn't be read back, so nothing is claimed either way.
    return setup.save(item, token).catch(() => false);
  });
  if (typeof saved === "string") return saved;
  return saved
    ? undefined
    : `Couldn't confirm the token was saved in the Keychain item ${item}. It may or may not be there: check the item, or save the token again.`;
}

const changedMeanwhile =
  "The dot's app changed meanwhile, so nothing was saved. Check it and try again.";
const installing =
  "The daemon is installing the app now, so nothing was saved. Try again once it's done.";

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
    ...noIcon,
  });
  return db.select().from(slackApps).where(eq(slackApps.dot, dot)).get();
}

/** Asks the daemon to check and adopt an app the owner found, such as one whose creation was lost. */
export function attachApp(db: Db, dot: string, appID: string) {
  if (!slackIDs.app.test(appID)) return false;
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
    ...noIcon,
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

/** An owner-started DM check of a dot's app. The daemon keeps it in memory only. */
export interface DMCheck {
  readonly appID: string;
  readonly owner: string;
  readonly since: number;
}

/** Starts a DM check of an active app. It sends nothing and starts no turn. */
export function startDMCheck(db: Db, dot: string, now: number): DMCheck | undefined {
  const app = db.select().from(slackApps).where(eq(slackApps.dot, dot)).get();
  if (app?.state !== "active" || !app.appID || !app.ownerID) return undefined;
  return { appID: app.appID, owner: app.ownerID, since: now };
}

/**
 * Where an owner-started DM check stands: "replied" only once open-dot saved a reply as posted,
 * which it does after Slack confirmed it, to a DM the owner sent this same app since the check
 * began. A queued or unknown reply stays "pending". It only reads open-dot's own database.
 */
export function dmCheckStatus(db: Db, dot: string, check: DMCheck | undefined) {
  const app = db.select().from(slackApps).where(eq(slackApps.dot, dot)).get();
  if (!check || app?.appID !== check.appID || app.ownerID !== check.owner) return null;
  const replied = db
    .select({ ts: slackEvents.ts })
    .from(slackEvents)
    .where(
      and(
        eq(slackEvents.app, check.appID),
        eq(slackEvents.dot, dot),
        eq(slackEvents.kind, "dm"),
        eq(slackEvents.user, check.owner),
        eq(slackEvents.state, "posted"),
        isNotNull(slackEvents.replyTS),
        like(slackEvents.channel, "D%"),
        gte(slackEvents.createdAt, check.since),
      ),
    )
    .orderBy(asc(slackEvents.createdAt))
    .all()
    .map(({ ts }) => (ts && /^\d{1,16}\.\d{1,6}$/.test(ts) ? Number(ts) * 1000 : -1))
    .find((sentAt) => sentAt >= check.since);
  return replied !== undefined
    ? { state: "replied" as const, since: check.since, dmAt: replied }
    : { state: "pending" as const, since: check.since, dmAt: null };
}

const save = (item: string) => `security add-generic-password -U -a "$USER" -s ${item} -w`;

const appURL = (id: string) => `https://api.slack.com/apps/${id}`;

/** Where the app's icon stands, and the manual upload when Slack refused it. */
function iconLine(app: SlackApp, appID: string, blocked: string | null) {
  const revision = avatarRevision(app.dot);
  const path = avatarPath(app.dot);
  switch (iconStatus(app, revision)) {
    case "no-avatar":
      return `${app.dot} has no avatar yet. Set one with: open-dot avatar ${app.dot} <file>, and the daemon sets it as the app's icon with Slack's apps.icon.set. The icon is under Display Information at ${appURL(appID)}/general.`;
    case "set":
      return `set from ${path} with Slack's apps.icon.set.`;
    case "setting":
      return "the daemon is setting it from the avatar now.";
    case "pending":
      return `the daemon sets it from ${path} with Slack's apps.icon.set and your app configuration token, within a minute or two.${blocked ? ` Configuration token: ${blocked}` : ""}`;
    case "waiting":
      return `Slack is rate limiting apps.icon.set, so the daemon tries again after ${new Date(app.iconRetryAt ?? 0).toISOString()}.`;
    case "refused":
      break;
  }
  const manual = `Open ${appURL(appID)}/general, scroll to Display Information, upload ${path} under App icon & Preview (square, 512 to 2000 pixels), then click Save Changes. A new avatar, or Retry icon in the notch's Slack view, tries apps.icon.set again.`;
  return app.iconError === unknownOutcome
    ? `apps.icon.set got no clear answer (${unknownOutcome}), so it may or may not have set the icon, and it's never sent again on its own. Check the icon in Slack. If it isn't the avatar, set it yourself: ${manual}`
    : `Slack refused apps.icon.set (${app.iconError ?? "slack_error"}), so set it yourself. ${manual}`;
}

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
        "  The daemon creates the app with your Slack login from the notch's Slack view, and installs it. Without one it uses a configuration token pair saved with open-dot slack config; without either, create the app from the prefilled link in the notch's Slack view.",
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
    case "created": {
      if (!app.appID) break;
      const install = installOf(app);
      if (install?.phase === "queued" || install?.phase === "sending") {
        lines.push("  The daemon is installing it with your Slack login.");
        break;
      }
      if (install?.phase === "saved") {
        lines.push(
          "  Installed with your Slack login, and its tokens are in the Keychain. The daemon checks them and connects within a minute.",
        );
        break;
      }
      if (install) lines.push("  Retry install in the notch's Slack view, or:");
      lines.push(
        `  1. Install it: open ${appURL(app.appID)}/install-on-team, click Install, then Allow.`,
        `  2. Under App-Level Tokens at ${appURL(app.appID)}/general, generate a token with the connections:write scope.`,
        `  3. Save the Bot User OAuth Token (xoxb-…, from ${appURL(app.appID)}/oauth) and the app-level token (xapp-…). Each command asks for the token without echoing it:`,
        `     ${save(botItem(app.dot))}`,
        `     ${save(appItem(app.dot))}`,
        "  The daemon reads them within a minute, checks they belong to this app, and connects.",
      );
      break;
    }
    case "active":
      lines.push(
        `  Connected as <@${app.botUser ?? "?"}>. Invite it to a channel with /invite @${app.dot}, then mention it there, or DM it.`,
      );
      break;
  }
  if (app.appID && (app.state === "created" || app.state === "active")) {
    if ((app.manifestVersion ?? 1) < manifestVersion && app.updateState === null)
      lines.push(
        `  Its manifest is older than this open-dot, so the agent view can't get suggested prompts. Update it with: open-dot slack update ${app.dot}`,
      );
    if (app.updateNote) lines.push(`  Manifest update: ${app.updateNote}`);
    lines.push(
      `  App icon: ${iconLine(app, app.appID, config?.state === "blocked" ? config.problem : null)}`,
    );
  }
  return lines.join("\n");
}
