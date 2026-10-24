import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Session } from "@opencode/client/effect";
import { Service } from "@opencode/client/service";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import journal from "../drizzle/meta/_journal.json";
import { apiPath, databasePath } from "./home";
import { connect, type Endpoint, OpenCodeError } from "./opencode";

/**
 * A read-only health report shared by `open-dot doctor` and the daemon's `GET /health`. It never
 * writes, migrates, repairs, starts, stops or reloads anything. Its words are fixed text with
 * counts: no token, password, path, name, ID, message text or raw error.
 */
export const healthSchemaVersion = 1;

export const healthStatuses = [
  "disabled",
  "not_configured",
  "healthy",
  "stale",
  "failed",
  "unknown",
] as const;
export type HealthStatus = (typeof healthStatuses)[number];

export type Counts = Readonly<Record<string, number>>;

export interface HealthCheck {
  readonly id: string;
  readonly status: HealthStatus;
  readonly summary: string;
  readonly nextStep?: string;
  readonly lastSuccessAt?: number;
  readonly counts?: Counts;
}

export interface HealthReport {
  readonly schemaVersion: typeof healthSchemaVersion;
  readonly checkedAt: number;
  /** When the database checks' sample was taken, if any check comes from one. */
  readonly sampledAt?: number;
  /** Why the daemon has no usable sample. Never with `sampledAt`. */
  readonly sampleUnavailable?: SampleUnavailable;
  readonly checks: readonly HealthCheck[];
}

/**
 * Why a daemon's database checks have no sample behind them: none taken yet, the last one too
 * old, or the latest attempt failed. Each makes every database check unknown, without counts.
 */
export const sampleReasons = ["missing", "expired", "failed"] as const;
export type SampleUnavailable = (typeof sampleReasons)[number];

/** The checks a database sample gives. */
const fromDatabase = ["database", "sessions", "deliveries", "slack.apps", "slack.notices"];

/** How long the CLI waits for the daemon's report. */
export const transportTimeout = 5_000;
/**
 * The whole OpenCode probe's limit, discovery, info and session reads together, well inside
 * `transportTimeout`, so a daemon's probe always ends before the CLI stops waiting for it.
 */
export const probeTimeout = 3_000;
/** The daemon samples its database at most this often, from its existing one-second tick. */
export const sampleEvery = 15_000;
/** A sample older than this isn't used. */
export const sampleExpiresAfter = 60_000;

/** A time `Date` can represent and print: a positive safe integer of at most 8.64e15 ms. */
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;

const timedOut = Symbol("timed out");

/** The promise's value, or `timedOut` once `ms` pass. The promise isn't cancelled, only dropped. */
const bounded = <T>(promise: Promise<T>, ms: number): Promise<T | typeof timedOut> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Each check's words, made here from its status and counts alone. The CLI makes a daemon's
// checks again with these, so no text the daemon sent is ever shown.

interface Text {
  readonly summary: string;
  readonly nextStep?: string;
}

const count = (counts: Counts | undefined, key: string) => counts?.[key] ?? 0;
const again = "Check again.";

const feedSources = ["github", "linear", "slack"] as const;
type FeedSource = (typeof feedSources)[number];
const sourceNames = { github: "GitHub", linear: "Linear", slack: "Slack" } as const;
const sourceSetup = {
  github: "Sign in with gh auth login; the daemon needs gh on its PATH.",
  linear: "Save a Linear personal API key in the Keychain item open-dot-linear (see the README).",
  slack: "Save the Slack user token in the Keychain item open-dot-slack-user (see the README).",
} as const;

/** Passes run each minute, so five minutes without one that read the source is stale. */
export const feedStaleAfter = 5 * 60_000;
/** Queued sends older than this are stale. */
export const queueStaleAfter = 10 * 60_000;

const feedText =
  (source: FeedSource) =>
  (status: HealthStatus): Text => {
    const name = sourceNames[source];
    switch (status) {
      case "healthy":
        return { summary: `The last ${name} feed pass read it.` };
      case "failed":
        return {
          summary: `The last ${name} feed pass failed.`,
          nextStep: "The daemon's log says why. It tries again each minute.",
        };
      case "not_configured":
        return {
          summary: `${name} has no usable credentials, so the last feed pass read nothing.`,
          nextStep: sourceSetup[source],
        };
      case "stale":
        return {
          summary: `No ${name} feed pass has finished for over ${feedStaleAfter / 60_000} minutes.`,
          nextStep:
            "A pass may be stuck. The daemon's log may say why; restarting it is up to you.",
        };
      default:
        return {
          summary: `No ${name} feed pass has finished since the daemon started.`,
          nextStep: "Check again in a minute.",
        };
    }
  };

const databaseText = (status: HealthStatus, counts?: Counts): Text => {
  const known = count(counts, "known");
  if (!counts || !["healthy", "stale", "failed"].includes(status))
    return { summary: "Couldn't read the migration ledger.", nextStep: again };
  if (status === "healthy")
    return { summary: `The schema is current: all ${known} migrations are applied.` };
  if (status === "stale")
    return {
      summary: `${count(counts, "pending")} of ${known} migrations are pending. None was applied, and no other table was read.`,
      nextStep:
        "The next normal open by the daemon, the plugin or another open-dot command backs up the database and applies them.",
    };
  return {
    summary: count(counts, "untracked")
      ? "The database has tables but no migration ledger, so its schema is unknown. No other table was read."
      : `The migration ledger doesn't match this open-dot: ${count(counts, "unknown")} unknown, ${count(counts, "changed")} changed and ${count(counts, "skipped")} skipped migrations. A newer open-dot may have migrated it. No other table was read.`,
    nextStep:
      "Run the open-dot version that last opened this database, or restore a backup from before it. doctor changes nothing.",
  };
};

const sessionsText = (status: HealthStatus, counts?: Counts): Text => {
  const ready = count(counts, "ready");
  if (!counts) return { summary: "Couldn't read the dots.", nextStep: again };
  if (status === "not_configured")
    return {
      summary: "There are no dots yet.",
      nextStep: "Create one with: open-dot create <name>",
    };
  if (status === "healthy")
    return { summary: `OpenCode has the saved session of all ${ready} ready dots.` };
  if (status === "failed")
    return {
      summary: `OpenCode has no saved session for ${count(counts, "missing")} of ${ready} ready dots.`,
      nextStep:
        "open-dot never replaces a dot's session on its own. open-dot list shows each dot's session; check that OpenCode uses the same data as when it was created.",
    };
  if (count(counts, "unreachable"))
    return {
      summary: `Couldn't check ${ready} saved sessions while OpenCode isn't reachable.`,
      nextStep: "See the opencode check.",
    };
  if (count(counts, "unread"))
    return {
      summary: `Couldn't read ${count(counts, "unread")} of ${ready} saved sessions in time.`,
      nextStep: again,
    };
  return {
    summary: `The session of ${count(counts, "creating")} dots is still being created.`,
    nextStep: "Finish each with: open-dot open <name>",
  };
};

const deliveriesText = (status: HealthStatus, counts?: Counts): Text => {
  if (!counts) return { summary: "Couldn't read the outbox.", nextStep: again };
  const toOpenCode = count(counts, "outboxUnknown");
  const toSlack = count(counts, "slackUnknown");
  const queued = count(counts, "outboxQueued") + count(counts, "slackQueued");
  const held = count(counts, "outboxHeld");
  const heldText = held ? ` ${held} are held for stopped workers.` : "";
  if (status === "unknown")
    return {
      summary: `${toOpenCode + toSlack} sends have an unknown outcome (${toOpenCode} to OpenCode, ${toSlack} to Slack), and ${queued} are queued.${heldText}`,
      nextStep:
        "Check the dot's chat or Slack thread. open-dot looks a send with a lost outcome up by its ID, never retrying it blindly, and doctor sends nothing.",
    };
  if (status === "stale")
    return {
      summary: `${queued} sends are queued, the oldest for over ${queueStaleAfter / 60_000} minutes.${heldText}`,
      nextStep: "Check the daemon and opencode checks. Queued sends go out once both work.",
    };
  return {
    summary: queued
      ? `${queued} sends are queued, none for over ${queueStaleAfter / 60_000} minutes.${heldText}`
      : `Nothing is waiting to be sent.${heldText}`,
  };
};

const slackStatus = "For each app's state, problem and next step, run: open-dot slack status";

const slackAppsText = (_status: HealthStatus, counts?: Counts): Text => {
  if (!counts) return { summary: "Couldn't read Slack's setup.", nextStep: again };
  const blocked = count(counts, "blocked")
    ? " The Slack configuration token can't rotate until you save a new pair."
    : "";
  const nextStep = blocked ? "Save a new pair with: open-dot slack config" : slackStatus;
  if (!count(counts, "apps"))
    return {
      summary: `No dot has its own Slack app.${blocked}`,
      nextStep: blocked
        ? nextStep
        : "Optional: give a dot its own app with open-dot slack connect <name>",
    };
  return {
    summary: `${count(counts, "apps")} dots have their own Slack app: ${count(counts, "active")} saved as active, ${count(counts, "setup")} waiting for setup, ${count(counts, "pending")} in progress or unconfirmed, and ${count(counts, "failed")} failed. ${count(counts, "problem")} have a problem the daemon saw, and ${count(counts, "update")} a manifest update in progress, failed or unknown.${blocked} A saved state isn't proof that a connection works now.`,
    nextStep,
  };
};

const noticesText = (_status: HealthStatus, counts?: Counts): Text => {
  if (!counts) return { summary: "Couldn't read Slack's setup.", nextStep: again };
  return count(counts, "on")
    ? {
        summary:
          "Notes to others who DM the shared Slack app are turned on. Whether they go out isn't observed here.",
        nextStep: "open-dot slack status shows the setting.",
      }
    : {
        summary: "The shared Slack app doesn't tell others who DM it that it only answers you.",
        nextStep: "Turn that on with: open-dot slack notices enable",
      };
};

/** Every check a daemon's report may give the CLI, with the counts each may carry. */
const shared: Record<
  string,
  {
    readonly text: (status: HealthStatus, counts?: Counts) => Text;
    readonly counts: readonly string[];
  }
> = {
  database: {
    text: databaseText,
    counts: ["applied", "known", "pending", "unknown", "changed", "skipped", "untracked"],
  },
  sessions: {
    text: sessionsText,
    counts: ["dots", "ready", "creating", "missing", "unread", "unreachable"],
  },
  deliveries: {
    text: deliveriesText,
    counts: ["outboxQueued", "outboxUnknown", "outboxHeld", "slackQueued", "slackUnknown"],
  },
  "slack.apps": {
    text: slackAppsText,
    counts: ["apps", "active", "setup", "pending", "failed", "problem", "update", "blocked"],
  },
  "slack.notices": { text: noticesText, counts: ["on"] },
  ...Object.fromEntries(
    feedSources.map((source) => [`feed.${source}`, { text: feedText(source), counts: [] }]),
  ),
};

/** A check whose words come only from its status and counts. */
const make = (id: string, status: HealthStatus, counts?: Counts, lastSuccessAt?: number) => {
  const check: HealthCheck = {
    id,
    status,
    ...(shared[id]?.text(status, counts) ?? { summary: "Unknown check." }),
    ...(counts ? { counts } : {}),
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
  };
  return check;
};

/**
 * One check from a daemon's report, made again here from its id, status, allowlisted counts and
 * last success, which must all be well formed. Its own words and any other field are dropped.
 */
const importCheck = (value: unknown): HealthCheck | undefined => {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const allowed = Object.hasOwn(shared, value.id) ? shared[value.id]?.counts : undefined;
  const status = healthStatuses.find((candidate) => candidate === value.status);
  const feed = value.id.startsWith("feed.");
  if (!allowed || !status || (feed && status === "disabled")) return undefined;
  let counts: Record<string, number> | undefined;
  if (value.counts !== undefined) {
    if (!isRecord(value.counts)) return undefined;
    const raw = value.counts;
    if (Object.keys(raw).some((key) => !allowed.includes(key))) return undefined;
    counts = {};
    for (const key of allowed) {
      const n = raw[key];
      if (n === undefined) continue;
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return undefined;
      counts[key] = n;
    }
  }
  const last = value.lastSuccessAt;
  if (last !== undefined && (!feed || !isTime(last))) return undefined;
  const check = make(value.id, status, counts, isTime(last) ? last : undefined);
  return feed ? check : { ...check, summary: `${check.summary} The running daemon reported this.` };
};

/**
 * The checks of a daemon's report this CLI may show, and either when its database was sampled or
 * why it has no usable sample.
 */
export interface ParsedReport {
  readonly checks: ReadonlyMap<string, HealthCheck>;
  readonly sampledAt?: number;
  readonly unavailable?: SampleUnavailable;
}

/**
 * A daemon's report made again from structured fields only, or undefined when it isn't one this
 * version reads. Checks the CLI doesn't import are ignored. Without `sampledAt`, every database
 * check must be unknown and without counts, so nothing from an old or failed sample passes.
 */
export const parseReport = (value: unknown): ParsedReport | undefined => {
  if (!isRecord(value)) return undefined;
  const unavailable = sampleReasons.find((reason) => reason === value.sampleUnavailable);
  if (
    value.schemaVersion !== healthSchemaVersion ||
    !isTime(value.checkedAt) ||
    (value.sampledAt !== undefined && !isTime(value.sampledAt)) ||
    (value.sampleUnavailable !== undefined && (!unavailable || value.sampledAt !== undefined)) ||
    !Array.isArray(value.checks)
  )
    return undefined;
  const checks = new Map<string, HealthCheck>();
  const all: unknown[] = value.checks;
  for (const entry of all) {
    if (!isRecord(entry) || typeof entry.id !== "string") return undefined;
    if (!Object.hasOwn(shared, entry.id)) continue;
    const check = importCheck(entry);
    if (!check || checks.has(check.id)) return undefined;
    if (
      !isTime(value.sampledAt) &&
      fromDatabase.includes(check.id) &&
      (check.status !== "unknown" || check.counts)
    )
      return undefined;
    checks.set(check.id, check);
  }
  if (isTime(value.sampledAt)) return { checks, sampledAt: value.sampledAt };
  return unavailable ? { checks, unavailable } : { checks };
};

// The daemon's feed loop.

/** A feed source's latest finished pass in this daemon, kept in memory only. */
export interface Observation {
  readonly outcome: "polled" | "not_configured" | "failed";
  readonly at: number;
  readonly lastSuccessAt?: number;
}

export type Observations = Map<string, Observation>;

/** Records a finished pass. Only a pass that read its source counts as a success, never items. */
export function observe(
  seen: Observations,
  source: string,
  outcome: Observation["outcome"],
  at: number,
) {
  const lastSuccessAt = outcome === "polled" ? at : seen.get(source)?.lastSuccessAt;
  seen.set(source, lastSuccessAt === undefined ? { outcome, at } : { outcome, at, lastSuccessAt });
}

export function feedCheck(source: FeedSource, seen: Observation | undefined, now: number) {
  const status: HealthStatus = !seen
    ? "unknown"
    : seen.outcome === "failed"
      ? "failed"
      : seen.outcome === "not_configured"
        ? "not_configured"
        : now - (seen.lastSuccessAt ?? 0) > feedStaleAfter
          ? "stale"
          : "healthy";
  return make(`feed.${source}`, status, undefined, seen?.lastSuccessAt);
}

// The daemon, through api.json.

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const startDaemon =
  "Start the daemon: load its launch agent (see the README) or run open-dot daemon. doctor starts nothing.";
const restartDaemon = "Restart the daemon, which writes a fresh api.json. doctor starts nothing.";

/** api.json's address, only when it's plain http on this Mac's loopback. */
const loopback = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

const daemonCheck = (status: HealthStatus, summary: string, nextStep?: string) => ({
  check: { id: "daemon", status, summary, ...(nextStep ? { nextStep } : {}) },
});

/**
 * Asks the daemon at api.json's address for its report. The token goes only to plain http on the
 * loopback address, and a redirect is never followed, so it can't leave this Mac.
 */
export async function askDaemon(
  file: string,
  fetch: Fetch,
  timeout: number,
): Promise<{ readonly check: HealthCheck; readonly report?: ParsedReport }> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? daemonCheck(
          "failed",
          "The daemon isn't running: there's no api.json, which it writes at start.",
          startDaemon,
        )
      : daemonCheck("failed", "Couldn't read api.json.", restartDaemon);
  }
  let endpoint: unknown;
  try {
    endpoint = JSON.parse(text);
  } catch {
    endpoint = undefined;
  }
  if (!isRecord(endpoint) || typeof endpoint.token !== "string" || !endpoint.token)
    return daemonCheck(
      "failed",
      "api.json doesn't hold a daemon address and token.",
      restartDaemon,
    );
  const url = loopback(endpoint.url);
  if (!url)
    return daemonCheck(
      "failed",
      "api.json names an address off this Mac's loopback, so its token wasn't sent.",
      restartDaemon,
    );
  const answer = await bounded(
    fetch(new URL("/health", url).href, {
      method: "GET",
      headers: { authorization: `Bearer ${endpoint.token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    }).catch((error: unknown) =>
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? timedOut
        : undefined,
    ),
    timeout,
  );
  if (answer === timedOut)
    return daemonCheck(
      "unknown",
      `The daemon at api.json's address didn't answer within ${timeout / 1000} seconds.`,
      "Check again. If it keeps happening, the daemon may be stuck.",
    );
  if (!answer)
    return daemonCheck(
      "failed",
      "Nothing answers at api.json's address, so the file is stale and the daemon isn't running.",
      startDaemon,
    );
  if (answer.status === 401)
    return daemonCheck(
      "failed",
      "The process at api.json's address refused its token, so the file is stale.",
      restartDaemon,
    );
  if (answer.status >= 300 && answer.status < 400)
    return daemonCheck(
      "failed",
      "api.json's address answered with a redirect, which doctor didn't follow.",
      restartDaemon,
    );
  if (answer.status === 404)
    return daemonCheck(
      "stale",
      "The daemon is running code from before health checks.",
      "Restart it when convenient to run this version. doctor starts nothing.",
    );
  if (answer.status !== 200)
    return daemonCheck(
      "failed",
      `The daemon answered HTTP ${answer.status}.`,
      "The daemon's log says why.",
    );
  const body = await bounded(
    answer.json().catch(() => undefined),
    timeout,
  );
  const report = body === timedOut ? undefined : parseReport(body);
  return {
    check: {
      id: "daemon",
      status: "healthy",
      summary: report
        ? "The daemon is running and answered with api.json's token."
        : "The daemon is running and answered with api.json's token, but its report couldn't be read.",
    },
    ...(report ? { report } : {}),
  };
}

// OpenCode, through public discovery and reads only.

export type SessionState = "found" | "missing" | "unknown";

export type OpenCodeState =
  | { readonly state: "not_running" | "failed" | "timeout" }
  | { readonly state: "reachable"; readonly sessions: ReadonlyMap<string, SessionState> };

/** Finds OpenCode and reads each saved session. Tests pass a fake. */
export type OpenCodeProbe = (
  sessionIDs: readonly string[],
  timeout: number,
) => Promise<OpenCodeState>;

/**
 * `Service.discover()` returns a healthy registered service without starting one; then only the
 * public `server.info` and `session.get` reads follow, through `fetch`. All of it runs within one
 * `timeout`: the deadline interrupts what's in flight, no read starts after it, and a session left
 * unread is unknown. Nothing is ensured, stopped, reloaded or prompted, and OpenCode's database is
 * never read.
 */
export const openCodeProbe =
  (
    discover: () => Promise<Endpoint | undefined> = () => Service.discover(),
    fetch: typeof globalThis.fetch = globalThis.fetch,
  ): OpenCodeProbe =>
  (sessionIDs, timeout) => {
    const sessions = new Map<string, SessionState>();
    let reached = false;
    return Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* Effect.tryPromise({
          try: () => discover(),
          catch: (cause) => new OpenCodeError({ message: "Discovery failed", cause }),
        });
        if (endpoint === undefined) return { state: "not_running" } as const;
        const client = yield* connect(endpoint);
        yield* client.server.info();
        reached = true;
        yield* Effect.forEach(
          sessionIDs,
          (id) =>
            client.session.get({ sessionID: Session.ID.make(id) }).pipe(
              Effect.map((): SessionState => "found"),
              Effect.catchTag("SessionNotFoundError", () =>
                Effect.succeed<SessionState>("missing"),
              ),
              Effect.catch(() => Effect.succeed<SessionState>("unknown")),
              Effect.map((state) => {
                sessions.set(id, state);
              }),
            ),
          { concurrency: 4, discard: true },
        );
        return { state: "reachable", sessions } as const;
      }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.timeoutOrElse({
          duration: `${timeout} millis`,
          orElse: () =>
            Effect.succeed<OpenCodeState>(
              reached ? { state: "reachable", sessions } : { state: "timeout" },
            ),
        }),
        Effect.catch(() => Effect.succeed<OpenCodeState>({ state: "failed" })),
      ),
    );
  };

export const publicOpenCode = openCodeProbe();

const opencodeCheck = (found: OpenCodeState): HealthCheck => {
  const id = "opencode";
  switch (found.state) {
    case "reachable":
      return { id, status: "healthy", summary: "OpenCode's registered service answered." };
    case "not_running":
      return {
        id,
        status: "failed",
        summary: "OpenCode has no healthy, compatible service registered.",
        nextStep: "Start OpenCode yourself. open-dot never starts, stops or reloads it.",
      };
    case "timeout":
      return {
        id,
        status: "unknown",
        summary: "OpenCode didn't answer in time.",
        nextStep: "Check again. If it keeps happening, OpenCode may be busy or stuck.",
      };
    default:
      return {
        id,
        status: "failed",
        summary: "OpenCode's registered service didn't answer its public reads.",
        nextStep: "Check that OpenCode is running. open-dot never starts, stops or reloads it.",
      };
  }
};

// open-dot's database, read only.

let migrations: readonly { readonly when: number; readonly hash: string }[] | undefined;

/** Each migration this code knows, hashed as drizzle's migrator records it in the ledger. */
const known = () =>
  (migrations ??= journal.entries.map((entry) => ({
    when: entry.when,
    hash: createHash("sha256")
      .update(readFileSync(join(import.meta.dir, "..", "drizzle", `${entry.tag}.sql`), "utf8"))
      .digest("hex"),
  })));

/**
 * Compares the migration ledger with this code's migrations, exactly, by time and hash. Only a
 * matching ledger lets the other checks read tables.
 */
export function schemaCheck(sqlite: Database): HealthCheck {
  const expected = known();
  const tables = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => row.name);
  const ledger = tables.includes("__drizzle_migrations");
  if (!ledger && tables.length > 0)
    return make("database", "failed", { known: expected.length, untracked: 1 });
  const applied = ledger
    ? sqlite
        .query<{ hash: unknown; created_at: unknown }, []>(
          "SELECT hash, created_at FROM __drizzle_migrations",
        )
        .all()
        .map((row) => ({ hash: String(row.hash), when: Number(row.created_at) }))
    : [];
  const byTime = new Map(expected.map((migration) => [migration.when, migration.hash]));
  const times = new Set(applied.map((row) => row.when));
  const newest = Math.max(0, ...applied.map((row) => row.when));
  const missing = expected.filter((migration) => !times.has(migration.when));
  const counts = {
    applied: applied.length,
    known: expected.length,
    pending: missing.filter((migration) => migration.when > newest).length,
    unknown: applied.filter((row) => !byTime.has(row.when)).length,
    changed: applied.filter((row) => byTime.has(row.when) && byTime.get(row.when) !== row.hash)
      .length,
    skipped: missing.filter((migration) => migration.when <= newest).length,
  };
  const status =
    counts.unknown || counts.changed || counts.skipped || times.size !== applied.length
      ? "failed"
      : counts.pending
        ? "stale"
        : "healthy";
  return make("database", status, counts);
}

export interface BoundDot {
  readonly sessionID: string;
  readonly state: string;
}

const boundDots = (sqlite: Database) =>
  sqlite
    .query<BoundDot, []>("SELECT session_id AS sessionID, session_state AS state FROM dots")
    .all();

function sessionsCheck(dots: readonly BoundDot[], found: OpenCodeState): HealthCheck {
  const ready = dots.filter((dot) => dot.state === "ready");
  const states = ready.map((dot) =>
    found.state === "reachable" ? (found.sessions.get(dot.sessionID) ?? "unknown") : "unknown",
  );
  const counts = {
    dots: dots.length,
    ready: ready.length,
    creating: dots.length - ready.length,
    missing: states.filter((state) => state === "missing").length,
    unread: found.state === "reachable" ? states.filter((state) => state === "unknown").length : 0,
    unreachable: found.state === "reachable" ? 0 : 1,
  };
  const status: HealthStatus = !dots.length
    ? "not_configured"
    : counts.missing
      ? "failed"
      : counts.unreachable || counts.unread || counts.creating
        ? "unknown"
        : "healthy";
  return make("sessions", status, counts);
}

/**
 * Counts what's waiting to be sent, with the outbox's and Slack's own states: queued is pending and
 * not yet started, unknown is started with its outcome unresolved. Held rows belong to stopped
 * workers.
 */
function deliveriesCheck(sqlite: Database, now: number): HealthCheck {
  const tally = (query: string) =>
    sqlite.query<{ n: number; oldest: number | null }, []>(query).get() ?? { n: 0, oldest: null };
  const outboxQueued = tally(
    "SELECT count(*) AS n, min(created_at) AS oldest FROM outbox WHERE state = 'pending' AND started_at IS NULL",
  );
  const outboxUnknown = tally(
    "SELECT count(*) AS n, NULL AS oldest FROM outbox WHERE state = 'pending' AND started_at IS NOT NULL",
  );
  const outboxHeld = tally("SELECT count(*) AS n, NULL AS oldest FROM outbox WHERE state = 'held'");
  const slackQueued = tally(`SELECT count(*) AS n, min(created_at) AS oldest FROM (
    SELECT created_at FROM slack WHERE state IN ('waiting', 'posting')
    UNION ALL SELECT created_at FROM slack_events WHERE state IN ('new', 'waiting', 'posting'))`);
  const slackUnknown = tally(`SELECT count(*) AS n, NULL AS oldest FROM (
    SELECT created_at FROM slack WHERE state = 'unknown'
    UNION ALL SELECT created_at FROM slack_events WHERE state = 'unknown'
    UNION ALL SELECT created_at FROM slack_notices WHERE state IN ('sending', 'unknown'))`);
  const oldest = Math.min(
    ...[outboxQueued.oldest, slackQueued.oldest].filter((time): time is number => time !== null),
  );
  const status: HealthStatus =
    outboxUnknown.n + slackUnknown.n
      ? "unknown"
      : now - oldest > queueStaleAfter
        ? "stale"
        : "healthy";
  return make("deliveries", status, {
    outboxQueued: outboxQueued.n,
    outboxUnknown: outboxUnknown.n,
    outboxHeld: outboxHeld.n,
    slackQueued: slackQueued.n,
    slackUnknown: slackUnknown.n,
  });
}

/**
 * Each dot's own Slack app by saved state, and whether the daemon saved a problem for it, never
 * the problem's words or any ID. A saved "active" isn't a working connection, so the best this
 * says is unknown; `open-dot slack status` gives the full explanation.
 */
function slackChecks(sqlite: Database): HealthCheck[] {
  const apps = sqlite
    .query<{ state: string; update: string | null; problem: number }, []>(
      'SELECT state, update_state AS "update", problem IS NOT NULL AS problem FROM slack_apps',
    )
    .all();
  const config = sqlite
    .query<{ blocked: number; on: number }, []>(
      "SELECT state = 'blocked' AS blocked, notices_since IS NOT NULL AS \"on\" FROM slack_config WHERE id = 1",
    )
    .get();
  const inState = (...states: string[]) => apps.filter((app) => states.includes(app.state)).length;
  const counts = {
    apps: apps.length,
    active: inState("active"),
    setup: inState("requested", "created"),
    pending: inState("creating", "attaching", "unknown"),
    failed: inState("failed"),
    problem: apps.filter((app) => app.problem).length,
    update: apps.filter((app) => app.update !== null).length,
    blocked: config?.blocked ? 1 : 0,
  };
  const status: HealthStatus =
    counts.blocked || counts.failed || counts.problem
      ? "failed"
      : counts.pending || counts.update
        ? "unknown"
        : counts.setup || !counts.apps
          ? "not_configured"
          : "unknown";
  const on = config?.on ? 1 : 0;
  return [
    make("slack.apps", status, counts),
    make("slack.notices", on ? "unknown" : "disabled", { on }),
  ];
}

/**
 * What was read from a database in one read transaction, so its schema, bindings and counts agree.
 * Bindings and counts are read only when the schema is current.
 */
export interface DatabaseSnapshot {
  readonly sampledAt: number;
  readonly schema: HealthCheck;
  readonly dots?: readonly BoundDot[];
  readonly deliveries?: HealthCheck;
  readonly slack?: readonly HealthCheck[];
}

/** Takes a snapshot with SELECTs only. Any failure throws, so no partial snapshot is kept. */
export const captureDatabase = (sqlite: Database, sampledAt: number): DatabaseSnapshot =>
  sqlite
    .transaction((): DatabaseSnapshot => {
      const schema = schemaCheck(sqlite);
      if (schema.status !== "healthy") return { sampledAt, schema };
      return {
        sampledAt,
        schema,
        dots: boundDots(sqlite),
        deliveries: deliveriesCheck(sqlite, sampledAt),
        slack: slackChecks(sqlite),
      };
    })
    .deferred();

/**
 * The daemon's database sample: its last successful snapshot, and whether the latest attempt
 * failed, which holds until a capture succeeds. A failed sample shows none of the snapshot.
 */
export interface DatabaseSample {
  readonly snapshot?: DatabaseSnapshot;
  readonly failed: boolean;
}

/**
 * The daemon's pinned database sample. `tick` runs at daemon start and from its existing
 * one-second tick, and samples at most every `sampleEvery`. A failed capture marks the sample
 * failed and keeps the last snapshot and its time; only a successful one clears it. A health
 * request only reads `current`, so it never touches the database.
 */
export function databaseSampler(sqlite: Database, now: () => number = Date.now) {
  let pinned: DatabaseSnapshot | undefined;
  let failed = false;
  let tried = -Infinity;
  return {
    tick() {
      const at = now();
      if (at - tried < sampleEvery) return;
      tried = at;
      try {
        pinned = captureDatabase(sqlite, at);
        failed = false;
      } catch {
        failed = true;
        console.error("Health: couldn't sample the database.");
      }
    },
    current: (): DatabaseSample => (pinned ? { snapshot: pinned, failed } : { failed }),
  };
}

const unknownDatabase = (summary: string, nextStep: string): HealthCheck => ({
  id: "database",
  status: "unknown",
  summary,
  nextStep,
});

/** The database check when a daemon has no usable sample, in fixed words for each reason. */
const unavailableDatabase = (reason: SampleUnavailable) =>
  reason === "failed"
    ? unknownDatabase(
        "The daemon's latest database sample failed, so none of an earlier one is shown.",
        "The daemon tries again within 15 seconds; its log says only that sampling failed.",
      )
    : reason === "expired"
      ? unknownDatabase(
          "The daemon's last database sample is over a minute old, so none of it is shown.",
          "The daemon samples its database every 15 seconds from a tick it already runs; its log may say why it stopped.",
        )
      : unknownDatabase(
          "The daemon hasn't sampled its database yet.",
          "Check again in a few seconds.",
        );

const notRead = (id: string, why: string): HealthCheck => ({
  id,
  status: "unknown",
  summary: `Not checked: ${why}.`,
  nextStep: "See the database check.",
});

export interface Diagnosis {
  readonly now: number;
  readonly daemon: HealthCheck;
  readonly feeds: readonly HealthCheck[];
  /** The database's snapshot, the check that says why there's none, or why the daemon has none. */
  readonly database: DatabaseSnapshot | HealthCheck | SampleUnavailable;
  /** A running daemon's report. Its database checks stand in when there's no snapshot here. */
  readonly imported?: ParsedReport;
  readonly opencode: OpenCodeProbe;
  readonly timeout: number;
}

/** Room for a probe that ignores its own deadline, as a fake may. */
const probeMargin = 250;

/**
 * The report, from a snapshot taken earlier, never from the database itself, plus OpenCode's
 * public reads. Without a snapshot here, a running daemon's current one stands in, made again
 * here, or the daemon's reason for having none.
 */
export async function diagnose(input: Diagnosis): Promise<HealthReport> {
  const { database, imported } = input;
  const sample = typeof database === "object" && "sampledAt" in database ? database : undefined;
  const ids = (sample?.dots ?? [])
    .filter((dot) => dot.state === "ready")
    .map((dot) => dot.sessionID);
  const probed = await bounded(
    input.opencode(ids, input.timeout).catch((): OpenCodeState => ({ state: "failed" })),
    input.timeout + probeMargin,
  );
  const found: OpenCodeState = probed === timedOut ? { state: "timeout" } : probed;
  const own = typeof database === "string";
  const daemon =
    !sample && !own && imported?.sampledAt !== undefined && imported.checks.has("database")
      ? imported
      : undefined;
  const unavailable =
    typeof database === "string"
      ? database
      : !sample && !daemon
        ? imported?.unavailable
        : undefined;
  const local = new Map<string, HealthCheck>();
  if (sample) {
    local.set("database", sample.schema);
    if (sample.dots) local.set("sessions", sessionsCheck(sample.dots, found));
    if (sample.deliveries) local.set("deliveries", sample.deliveries);
    for (const check of sample.slack ?? []) local.set(check.id, check);
  } else if (unavailable) {
    const check = unavailableDatabase(unavailable);
    local.set(
      "database",
      own ? check : { ...check, summary: `${check.summary} The running daemon reported this.` },
    );
  } else if (typeof database === "object" && "id" in database) local.set("database", database);
  const why = daemon
    ? "the daemon didn't report it"
    : unavailable
      ? "the daemon has no usable database sample"
      : sample
        ? "the database's schema isn't one this open-dot reads"
        : local.get("database")?.status === "not_configured"
          ? "there's no database yet"
          : "there's no current database sample";
  const stored = (id: string) => (daemon?.checks ?? local).get(id) ?? notRead(id, why);
  const sampledAt = sample?.sampledAt ?? daemon?.sampledAt;
  return {
    schemaVersion: healthSchemaVersion,
    checkedAt: input.now,
    ...(sampledAt === undefined ? {} : { sampledAt }),
    ...(unavailable ? { sampleUnavailable: unavailable } : {}),
    checks: [
      input.daemon,
      stored("database"),
      opencodeCheck(found),
      stored("sessions"),
      stored("deliveries"),
      ...input.feeds,
      stored("slack.apps"),
      stored("slack.notices"),
    ],
  };
}

const daemonRunning: HealthCheck = {
  id: "daemon",
  status: "healthy",
  summary: "The daemon is running and answered this check.",
};

/**
 * The daemon's own `GET /health`: its pinned database sample, its feed loop's passes in memory
 * and OpenCode's public reads. It never reads the database. A missing, expired or failed sample
 * makes every database check unknown, with no counts and no saved session read.
 */
export const daemonHealth = (
  sample: DatabaseSample,
  seen: Observations,
  opencode: OpenCodeProbe = publicOpenCode,
  now = Date.now,
  timeout = probeTimeout,
) => {
  const at = now();
  const { snapshot } = sample;
  const usable =
    !sample.failed &&
    snapshot &&
    snapshot.sampledAt <= at &&
    at - snapshot.sampledAt <= sampleExpiresAfter
      ? snapshot
      : undefined;
  const reason: SampleUnavailable = sample.failed ? "failed" : snapshot ? "expired" : "missing";
  return diagnose({
    now: at,
    daemon: daemonRunning,
    feeds: feedSources.map((source) => feedCheck(source, seen.get(source), at)),
    database: usable ?? reason,
    opencode,
    timeout,
  });
};

/** The biggest database doctor copies into memory. */
const copyLimit = 256 * 1024 * 1024;

const inUse = (path: string) =>
  ["-wal", "-shm", "-journal"].some((suffix) => existsSync(`${path}${suffix}`));

/**
 * A snapshot of a private in-memory copy of the database file, or why there's none. SQLite never
 * opens the file itself, so nothing in it or beside it is created or changed. A WAL, shared-memory
 * or journal file means a connection may hold changes the file lacks, so then the file isn't read
 * at all; nor is one that changed while it was copied.
 */
function sampleCopy(path: string, at: number): DatabaseSnapshot | HealthCheck {
  if (inUse(path))
    return unknownDatabase(
      "The database is in use: a connection may hold changes its file doesn't have yet, so doctor didn't read it.",
      "With the daemon running, its report covers the database. doctor never opens the file itself.",
    );
  let copy: Database | undefined;
  try {
    const before = statSync(path, { bigint: true });
    if (!before.isFile() || before.size > copyLimit)
      return unknownDatabase("The database file is too large or not a regular file.", again);
    const bytes = readFileSync(path);
    const after = statSync(path, { bigint: true });
    if (
      inUse(path) ||
      BigInt(bytes.length) !== before.size ||
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      return unknownDatabase("The database changed while doctor copied it.", again);
    // A WAL database's header says so. With no WAL file, its file holds every change, so the copy
    // is read as a rollback database, which an in-memory one must be.
    if (bytes.length > 19 && bytes[18] === 2 && bytes[19] === 2) bytes.set([1, 1], 18);
    copy = Database.deserialize(bytes, true);
    const check = copy.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
    if (check.length !== 1 || check[0]?.quick_check !== "ok")
      return unknownDatabase("The copy of the database didn't pass SQLite's quick check.", again);
    return captureDatabase(copy, at);
  } catch {
    return unknownDatabase("Couldn't copy and read the database.", again);
  } finally {
    copy?.close();
  }
}

/** How far ahead of this clock a daemon's sample time may be. */
const clockSkew = 5_000;

const noDatabase: HealthCheck = {
  id: "database",
  status: "not_configured",
  summary: "There's no open-dot database yet.",
  nextStep: "Create a dot with: open-dot create <name>",
};

/**
 * `open-dot doctor`: works with or without the daemon, never starting it. The database is read
 * from an in-memory copy, never opened, created or migrated. While it's in use, a running daemon's
 * current snapshot, or its reason for having none, stands in for it; feed passes come only from
 * the daemon's report.
 */
export async function doctor(
  options: {
    readonly fetch?: Fetch;
    readonly opencode?: OpenCodeProbe;
    readonly now?: () => number;
    /** How long to wait for the daemon's report. */
    readonly timeout?: number;
    /** The whole OpenCode probe's limit. */
    readonly probeTimeout?: number;
  } = {},
): Promise<HealthReport> {
  const now = options.now ?? Date.now;
  const asked = await askDaemon(
    apiPath(),
    options.fetch ?? globalThis.fetch,
    options.timeout ?? transportTimeout,
  );
  const feeds = feedSources.map(
    (source): HealthCheck =>
      asked.report?.checks.get(`feed.${source}`) ?? {
        id: `feed.${source}`,
        status: "unknown",
        summary: `Only the running daemon knows its ${sourceNames[source]} feed passes, and it didn't report them.`,
        nextStep: "See the daemon check.",
      },
  );
  const at = now();
  const path = databasePath();
  const database = existsSync(path) ? sampleCopy(path, at) : noDatabase;
  const { report } = asked;
  // A sample too old or too far ahead by this clock is expired here, whatever the daemon said.
  const outdated =
    report?.sampledAt !== undefined &&
    (report.sampledAt - at > clockSkew || at - report.sampledAt > sampleExpiresAfter);
  const imported: ParsedReport | undefined =
    report && outdated ? { checks: report.checks, unavailable: "expired" } : report;
  return diagnose({
    now: at,
    daemon: asked.check,
    feeds,
    database,
    ...(imported ? { imported } : {}),
    opencode: options.opencode ?? publicOpenCode,
    timeout: options.probeTimeout ?? probeTimeout,
  });
}

/** The report for a terminal: one line per check, then its next step and last success. */
export const describeReport = (report: HealthReport) =>
  [
    `open-dot doctor, checked ${new Date(report.checkedAt).toISOString()}`,
    ...(report.sampledAt === undefined
      ? []
      : [`Database sampled ${new Date(report.sampledAt).toISOString()}`]),
    ...(report.sampleUnavailable === undefined
      ? []
      : [`Database sample unavailable: ${report.sampleUnavailable}`]),
    ...report.checks.flatMap((check) => [
      `${check.status.padEnd(14)} ${check.id}: ${check.summary}`,
      ...(check.lastSuccessAt === undefined
        ? []
        : [`${"".padEnd(14)} Last success: ${new Date(check.lastSuccessAt).toISOString()}`]),
      ...(check.nextStep ? [`${"".padEnd(14)} Next: ${check.nextStep}`] : []),
    ]),
  ].join("\n");
