import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import journal from "../drizzle/meta/_journal.json";
import { api } from "../src/api";
import { type Db, openDatabase } from "../src/db";
import {
  captureDatabase,
  daemonHealth,
  type DatabaseSample,
  databaseSampler,
  describeReport,
  doctor,
  type Fetch,
  feedCheck,
  type HealthReport,
  healthStatuses,
  type Observations,
  observe,
  openCodeProbe,
  type OpenCodeProbe,
  parseReport,
  schemaCheck,
} from "../src/doctor";
import {
  dots,
  feed,
  outbox,
  slack,
  slackApps,
  slackConfig,
  slackEvents,
  slackNotices,
} from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

const token = "tok_SECRET_0123456789abcdef";
const minute = 60_000;
const now = 1_800_000_000_000;
const latest = 8_640_000_000_000_000;

let home: string;
let saved: Record<string, string | undefined>;
let lifecycle: { mockRestore(): void }[];
let discover: Mock<typeof Service.discover>;
let fixture: Db | undefined;
let open: Db | undefined;

const refuse = (name: string) => () => {
  throw new Error(`doctor called Service.${name}`);
};

beforeEach(() => {
  saved = { OPEN_DOT_HOME: process.env.OPEN_DOT_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  home = mkdtempSync(join(tmpdir(), "open-dot-doctor-"));
  process.env.OPEN_DOT_HOME = home;
  // Never the owner's own OpenCode registration.
  process.env.XDG_STATE_HOME = join(home, "state");
  lifecycle = [
    spyOn(Service, "ensure").mockImplementation(refuse("ensure")),
    spyOn(Service, "stop").mockImplementation(refuse("stop")),
  ];
  discover = spyOn(Service, "discover").mockImplementation(refuse("discover"));
  fixture = undefined;
  open = undefined;
  fetchLog.length = 0;
});

afterEach(() => {
  for (const spy of lifecycle) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
  discover.mockRestore();
  fixture?.$client.close();
  open?.$client.close();
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const databaseFile = () => join(home, "open-dot.db");

/**
 * Changes the fixture, built in memory, and writes it as a database file alone, with no side
 * files: exactly a database no connection holds, whatever SQLite leaves when one closes.
 */
const change = (edit: (db: Db) => void = () => {}) => {
  if (!fixture) throw new Error("No fixture");
  edit(fixture);
  writeFileSync(databaseFile(), fixture.$client.serialize());
};

/** A migrated database with two ready dots, which no connection holds. */
const seed = (edit: (db: Db) => void = () => {}) => {
  fixture = openDatabase(":memory:");
  fixture
    .insert(dots)
    .values(
      ["jojo", "jolyne"].map((name, at) => ({
        name,
        directory: `/Users/secret/dots/${name}`,
        sessionID: `ses_${name}SECRET`,
        sessionState: "ready" as const,
        purpose: "Private purpose text",
        createdAt: at,
      })),
    )
    .run();
  change(edit);
};

/** The database as a running daemon or plugin holds it: open, with its WAL files beside it. */
const holdOpen = () => {
  open = openDatabase(databaseFile());
  open.$client.run("UPDATE dots SET purpose = 'held' WHERE name = 'jojo'");
  return open;
};

/** Makes any SQLite call on the connection throw, so a health request can't read it. */
const forbidReads = (db: Db) =>
  (["query", "prepare", "run", "exec", "transaction"] as const).map((method) =>
    spyOn(db.$client, method).mockImplementation(() => {
      throw new Error("A health request read the database");
    }),
  );

const writeAPI = (url = "http://127.0.0.1:4321") =>
  writeFileSync(join(home, "api.json"), JSON.stringify({ url, token }), { mode: 0o600 });

/** Every file under the home, with its bytes' hash, every SQLite side file included. */
const files = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(home, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, createHash("sha256").update(readFileSync(path)).digest("hex")];
      }),
  );

const probe = (missing: string[] = []) => {
  const calls: string[][] = [];
  const run: OpenCodeProbe = async (ids) => {
    calls.push([...ids]);
    return {
      state: "reachable",
      sessions: new Map(ids.map((id) => [id, missing.includes(id) ? "missing" : "found"])),
    };
  };
  return { run, calls };
};

const fetchLog: { url: string; init: RequestInit }[] = [];
const answering =
  (answer: () => Promise<Response>): Fetch =>
  (url, init) => {
    fetchLog.push({ url, init });
    return answer();
  };
const never: Fetch = () => new Promise<Response>(() => {});

/** The CLI's fetch, answered by a daemon's handler in this process. */
const through =
  (handler: (request: Request) => Promise<Response>): Fetch =>
  (url, init) => {
    fetchLog.push({ url, init });
    return handler(new Request(url, init));
  };

const check = (report: HealthReport, id: string) => {
  const found = report.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`No check ${id}`);
  return found;
};

const run = (options: Parameters<typeof doctor>[0] = {}) =>
  doctor({ opencode: probe().run, now: () => now, timeout: 1_000, probeTimeout: 200, ...options });

const sendReport = (body: unknown) => run({ fetch: answering(async () => Response.json(body)) });

const shown = (report: HealthReport) => JSON.stringify(report) + describeReport(report);

const daemonAPI = (db: Db, health: () => Promise<HealthReport>) =>
  api(db, token, fakeOpenCode().layer, undefined, undefined, health);

test("with the daemon stopped, a database no connection holds is read from a copy", async () => {
  seed();
  const before = files();
  const sessions = probe(["ses_jolyneSECRET"]);
  const report = await run({
    fetch: answering(() => Promise.reject(new Error("must not be called"))),
    opencode: sessions.run,
  });
  expect(fetchLog).toHaveLength(0);
  expect(check(report, "daemon").status).toBe("failed");
  expect(check(report, "daemon").summary).toContain("no api.json");
  for (const source of ["github", "linear", "slack"])
    expect(check(report, `feed.${source}`).status).toBe("unknown");
  expect(check(report, "database").status).toBe("healthy");
  expect(report.sampledAt).toBe(now);
  expect(describeReport(report)).toContain(`Database sampled ${new Date(now).toISOString()}`);
  expect(sessions.calls).toEqual([["ses_jojoSECRET", "ses_jolyneSECRET"]]);
  expect(check(report, "sessions")).toMatchObject({
    status: "failed",
    counts: { ready: 2, missing: 1 },
  });
  expect(files()).toEqual(before);
  expect(existsSync(`${databaseFile()}-wal`)).toBe(false);
  expect(existsSync(`${databaseFile()}-shm`)).toBe(false);
  expect(discover).not.toHaveBeenCalled();
  expect(shown(report)).not.toContain("ses_");
  expect(shown(report)).not.toContain("/Users/secret");
});

test("a database a connection holds is never opened, and every side file stays byte for byte", async () => {
  seed();
  holdOpen();
  const before = files();
  expect(Object.keys(before).some((path) => path.endsWith("-shm"))).toBe(true);
  const sessions = probe();
  const report = await run({ opencode: sessions.run });
  expect(check(report, "database").status).toBe("unknown");
  expect(check(report, "database").summary).toContain("in use");
  expect(report.sampledAt).toBeUndefined();
  for (const id of ["sessions", "deliveries", "slack.apps", "slack.notices"])
    expect(check(report, id).summary).toStartWith("Not checked");
  expect(sessions.calls).toEqual([[]]);
  expect(files()).toEqual(before);
});

test("no database yet is reported without creating one", async () => {
  const before = files();
  const report = await run();
  expect(check(report, "database").status).toBe("not_configured");
  expect(existsSync(databaseFile())).toBe(false);
  expect(files()).toEqual(before);
});

test("a stale api.json, a refused token and a redirect each fail, sending the token only to loopback", async () => {
  seed();
  writeAPI();
  const stale = await run({
    fetch: answering(() => Promise.reject(new TypeError("Unable to connect"))),
  });
  expect(check(stale, "daemon")).toMatchObject({ status: "failed" });
  expect(check(stale, "daemon").summary).toContain("stale");
  const refused = await run({
    fetch: answering(async () => Response.json({ error: "Unauthorized" }, { status: 401 })),
  });
  expect(check(refused, "daemon").summary).toContain("refused its token");
  const redirected = await run({
    fetch: answering(
      async () =>
        new Response(null, { status: 307, headers: { location: "https://evil.example/" } }),
    ),
  });
  expect(check(redirected, "daemon").summary).toContain("redirect");
  expect(fetchLog).toHaveLength(3);
  for (const { url, init } of fetchLog) {
    expect(url).toBe("http://127.0.0.1:4321/health");
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("GET");
  }
});

test("api.json naming anything but plain loopback http never gets its token sent", async () => {
  for (const url of [
    "http://example.com:4321",
    "http://127.0.0.1.example.com:4321",
    "https://127.0.0.1:4321",
    "http://user:pw@127.0.0.1:4321",
    "http://localhost:4321",
    "http://127.0.0.1:4321/elsewhere",
    "file:///etc/passwd",
  ]) {
    writeAPI(url);
    const report = await run({ fetch: answering(async () => new Response("{}")) });
    expect(check(report, "daemon").status).toBe("failed");
    expect(check(report, "daemon").summary).toContain("loopback");
  }
  expect(fetchLog).toHaveLength(0);
});

test("the daemon's health requests read only its pinned snapshot, never the database", async () => {
  seed((built) =>
    built
      .insert(outbox)
      .values({
        sessionID: "ses_jojoSECRET",
        messageID: "msg_lost",
        text: "Private started message",
        state: "pending",
        startedAt: now - minute,
        createdAt: now - minute,
      })
      .run(),
  );
  const db = holdOpen();
  const pinned = captureDatabase(db.$client, now - 1_000);
  const forbidden = forbidReads(db);
  const seen: Observations = new Map();
  let sample: DatabaseSample = { snapshot: pinned, failed: false };
  let opencode: OpenCodeProbe = probe().run;
  const handler = daemonAPI(db, () => daemonHealth(sample, seen, opencode, () => now, 200));
  const ask = async () => {
    const answer = await handler(
      new Request("http://127.0.0.1/health", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(answer.status).toBe(200);
    return (await answer.json()) as HealthReport;
  };
  const before = files();
  try {
    const fresh = await ask();
    expect(fresh.sampledAt).toBe(now - 1_000);
    expect(fresh.sampleUnavailable).toBeUndefined();
    expect(check(fresh, "database").status).toBe("healthy");
    expect(check(fresh, "sessions").status).toBe("healthy");
    expect(check(fresh, "deliveries")).toMatchObject({
      status: "unknown",
      counts: { outboxUnknown: 1 },
    });

    const concurrent = await Promise.all(Array.from({ length: 5 }, ask));
    for (const report of concurrent) expect(report.sampledAt).toBe(now - 1_000);

    opencode = async () => ({ state: "failed" });
    const failed = await ask();
    expect(check(failed, "opencode").status).toBe("failed");
    expect(check(failed, "sessions").status).toBe("unknown");

    const unsampled = probe();
    opencode = unsampled.run;
    for (const [state, reason, words] of [
      [
        { snapshot: { ...pinned, sampledAt: now - 2 * minute }, failed: false },
        "expired",
        "over a minute old",
      ],
      [{ failed: false }, "missing", "hasn't sampled"],
      // A newer failed capture hides the older healthy snapshot it keeps.
      [{ snapshot: pinned, failed: true }, "failed", "latest database sample failed"],
    ] as const) {
      sample = state;
      const reports = await Promise.all(Array.from({ length: 3 }, ask));
      for (const report of reports) {
        expect(report.sampledAt).toBeUndefined();
        expect(report.sampleUnavailable).toBe(reason);
        expect(check(report, "database")).toMatchObject({ status: "unknown" });
        expect(check(report, "database").summary).toContain(words);
        for (const id of ["database", "sessions", "deliveries", "slack.apps", "slack.notices"])
          expect(check(report, id).counts).toBeUndefined();
        for (const id of ["sessions", "deliveries", "slack.apps", "slack.notices"])
          expect(check(report, id).summary).toStartWith("Not checked");
      }
    }
    expect(unsampled.calls.every((ids) => ids.length === 0)).toBe(true);

    sample = { snapshot: pinned, failed: false };
    expect((await ask()).sampledAt).toBe(now - 1_000);

    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    expect(files()).toEqual(before);
  } finally {
    for (const spy of forbidden) spy.mockRestore();
  }
});

test("the sampler samples at most every 15 seconds; a failure shows unknown until one succeeds", async () => {
  seed();
  const db = holdOpen();
  let clock = now;
  const sampler = databaseSampler(db.$client, () => clock);
  const report = () => daemonHealth(sampler.current(), new Map(), probe().run, () => clock, 200);
  expect(sampler.current()).toEqual({ failed: false });
  sampler.tick();
  expect(sampler.current()).toMatchObject({ failed: false, snapshot: { sampledAt: now } });
  clock += 10_000;
  sampler.tick();
  expect(sampler.current().snapshot?.sampledAt).toBe(now);

  const logged = spyOn(console, "error").mockImplementation(() => {});
  const broken = spyOn(db.$client, "transaction").mockImplementation(() => {
    throw new Error("locked");
  });
  try {
    clock += 10_000;
    sampler.tick();
    // The last good snapshot and its time stay, but none of it is shown.
    expect(sampler.current()).toMatchObject({ failed: true, snapshot: { sampledAt: now } });
    expect(logged.mock.calls).toEqual([["Health: couldn't sample the database."]]);
    const failing = await report();
    expect(failing.sampleUnavailable).toBe("failed");
    expect(failing.sampledAt).toBeUndefined();
    expect(check(failing, "database").counts).toBeUndefined();
    clock += 20_000;
    sampler.tick();
    expect(sampler.current()).toMatchObject({ failed: true, snapshot: { sampledAt: now } });
  } finally {
    broken.mockRestore();
    logged.mockRestore();
  }
  clock += 20_000;
  sampler.tick();
  expect(sampler.current()).toMatchObject({ failed: false, snapshot: { sampledAt: clock } });
  const recovered = await report();
  expect(recovered.sampledAt).toBe(clock);
  expect(recovered.sampleUnavailable).toBeUndefined();
  expect(check(recovered, "database").status).toBe("healthy");
});

test("a running daemon's current snapshot stands in for a database in use, made again from its counts", async () => {
  seed();
  const db = holdOpen();
  writeAPI();
  db.insert(feed)
    .values({
      source: "linear",
      sourceID: "n1",
      reason: "Mentioned",
      title: "Activity is not a pass",
      context: "ABC-1",
      url: null,
      updatedAt: now,
      state: "unread",
      createdAt: now,
    })
    .run();
  const pinned = captureDatabase(db.$client, now - 5_000);
  const forbidden = forbidReads(db);
  const seen: Observations = new Map();
  observe(seen, "github", "polled", now - minute);
  observe(seen, "slack", "not_configured", now - minute);
  const daemonProbe = probe(["ses_jolyneSECRET"]);
  const handler = daemonAPI(db, () =>
    daemonHealth({ snapshot: pinned, failed: false }, seen, daemonProbe.run, () => now, 200),
  );
  const before = files();
  const cliProbe = probe();
  try {
    const report = await run({ fetch: through(handler), opencode: cliProbe.run });
    expect(check(report, "daemon").status).toBe("healthy");
    expect(report.sampledAt).toBe(now - 5_000);
    expect(check(report, "database").status).toBe("healthy");
    expect(check(report, "database").summary).toContain("The running daemon reported this.");
    expect(check(report, "sessions")).toMatchObject({
      status: "failed",
      counts: { ready: 2, missing: 1 },
    });
    expect(check(report, "feed.github")).toMatchObject({
      status: "healthy",
      lastSuccessAt: now - minute,
    });
    expect(check(report, "feed.slack").status).toBe("not_configured");
    // Feed items are activity, never proof that Linear was polled.
    expect(check(report, "feed.linear").status).toBe("unknown");
    expect(daemonProbe.calls).toEqual([["ses_jojoSECRET", "ses_jolyneSECRET"]]);
    expect(cliProbe.calls).toEqual([[]]);
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    expect(files()).toEqual(before);

    expect((await handler(new Request("http://127.0.0.1/health"))).status).toBe(401);
    const posted = await handler(
      new Request("http://127.0.0.1/health", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(posted.status).toBe(404);
    const without = await api(
      db,
      token,
      fakeOpenCode().layer,
    )(new Request("http://127.0.0.1/health", { headers: { authorization: `Bearer ${token}` } }));
    expect(without.status).toBe(404);
  } finally {
    for (const spy of forbidden) spy.mockRestore();
  }
});

test("a daemon's stalled session read ends inside the CLI's wait, and its other checks survive", async () => {
  seed();
  const db = holdOpen();
  writeAPI();
  const pinned = captureDatabase(db.$client, now - 1_000);
  const reads: { path: string; aborted: () => boolean }[] = [];
  const stalled = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/info") return Response.json(info);
    reads.push({ path: url.pathname, aborted: () => init?.signal?.aborted === true });
    // A session read that never answers, unless its request is aborted.
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  }) as typeof globalThis.fetch;
  const seen: Observations = new Map();
  observe(seen, "github", "polled", now - minute);
  const handler = daemonAPI(db, () =>
    daemonHealth(
      { snapshot: pinned, failed: false },
      seen,
      openCodeProbe(async () => endpoint, stalled),
      () => now,
      100,
    ),
  );
  const started = performance.now();
  const report = await run({ fetch: through(handler), timeout: 1_000 });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(check(report, "daemon").status).toBe("healthy");
  expect(check(report, "sessions")).toMatchObject({
    status: "unknown",
    counts: { ready: 2, unread: 2, unreachable: 0 },
  });
  expect(check(report, "database").status).toBe("healthy");
  expect(check(report, "deliveries").status).toBe("healthy");
  expect(check(report, "feed.github").status).toBe("healthy");
  expect(reads).toHaveLength(2);
  for (const read of reads) expect(read.aborted()).toBe(true);
  await Bun.sleep(150);
  expect(reads).toHaveLength(2);
});

test("a daemon's sample that's too old or ahead of this clock is shown as expired", async () => {
  seed();
  holdOpen();
  writeAPI();
  for (const sampledAt of [now - 2 * minute, now + minute]) {
    const report = await sendReport({
      schemaVersion: 1,
      checkedAt: now,
      sampledAt,
      checks: [
        { id: "database", status: "healthy", summary: "", counts: { known: 29, applied: 29 } },
        { id: "feed.github", status: "healthy", summary: "" },
      ],
    });
    expect(report.sampledAt).toBeUndefined();
    expect(report.sampleUnavailable).toBe("expired");
    expect(check(report, "database").status).toBe("unknown");
    expect(check(report, "database").counts).toBeUndefined();
    expect(check(report, "database").summary).toContain("over a minute old");
    expect(check(report, "sessions").summary).toStartWith("Not checked");
    expect(check(report, "feed.github").status).toBe("healthy");
  }
});

test("the CLI carries the daemon's missing, expired or failed sample to its report", async () => {
  seed();
  const db = holdOpen();
  writeAPI();
  const pinned = captureDatabase(db.$client, now - 5_000);
  const forbidden = forbidReads(db);
  let sample: DatabaseSample = { failed: false };
  const handler = daemonAPI(db, () => daemonHealth(sample, new Map(), probe().run, () => now, 200));
  const before = files();
  try {
    for (const [state, reason, words] of [
      [{ failed: false }, "missing", "hasn't sampled"],
      [
        { snapshot: { ...pinned, sampledAt: now - 2 * minute }, failed: false },
        "expired",
        "over a minute old",
      ],
      [{ snapshot: pinned, failed: true }, "failed", "latest database sample failed"],
    ] as const) {
      sample = state;
      const report = await run({ fetch: through(handler) });
      expect(report.sampleUnavailable).toBe(reason);
      expect(report.sampledAt).toBeUndefined();
      expect(describeReport(report)).toContain(`Database sample unavailable: ${reason}`);
      expect(check(report, "database").status).toBe("unknown");
      expect(check(report, "database").summary).toContain(words);
      expect(check(report, "database").summary).toContain("The running daemon reported this.");
      for (const id of ["database", "sessions", "deliveries", "slack.apps", "slack.notices"])
        expect(check(report, id).counts).toBeUndefined();
      expect(check(report, "sessions").summary).toBe(
        "Not checked: the daemon has no usable database sample.",
      );
    }
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    expect(files()).toEqual(before);
  } finally {
    for (const spy of forbidden) spy.mockRestore();
  }
});

test("a failing health check logs and answers only fixed words", async () => {
  seed();
  const db = holdOpen();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const answer = await daemonAPI(db, () => Promise.reject(new Error(`xoxb-LEAKED ${token}`)))(
      new Request("http://127.0.0.1/health", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(answer.status).toBe(500);
    expect(await answer.text()).not.toContain("LEAKED");
    expect(logged.mock.calls).toEqual([["Health: the check itself failed."]]);
  } finally {
    logged.mockRestore();
  }
});

test("a daemon's words, extra fields and malformed values never reach the report", async () => {
  seed();
  holdOpen();
  writeAPI();
  const evil = "xoxb-LEAKED \u001b[31m/Users/secret ses_LEAKED";
  const valid = {
    schemaVersion: 1,
    checkedAt: now,
    sampledAt: now,
    checks: [
      { id: "daemon", status: "healthy", summary: evil, nextStep: evil, token: evil },
      { id: "elsewhere", status: "weird", summary: evil },
      {
        id: "deliveries",
        status: "unknown",
        summary: evil,
        nextStep: evil,
        counts: { outboxUnknown: 2, slackQueued: 1 },
        extra: evil,
      },
      { id: "feed.github", status: "failed", summary: evil, lastSuccessAt: now - minute },
      { id: "database", status: "healthy", summary: evil, counts: { known: 29, applied: 29 } },
    ],
  };
  const report = await sendReport(valid);
  expect(report.sampledAt).toBe(now);
  expect(check(report, "deliveries")).toMatchObject({
    status: "unknown",
    counts: { outboxUnknown: 2, slackQueued: 1 },
  });
  expect(check(report, "deliveries").summary).toStartWith("2 sends have an unknown outcome");
  expect(check(report, "feed.github")).toMatchObject({
    status: "failed",
    lastSuccessAt: now - minute,
  });
  expect(check(report, "database").summary).toContain("all 29 migrations");
  for (const secret of ["LEAKED", "\u001b", "/Users/secret", "elsewhere", "extra"])
    expect(shown(report)).not.toContain(secret);

  const broken = (checks: unknown[]) => ({ ...valid, checks });
  for (const body of [
    broken([{ id: "deliveries", status: "unknown", summary: "", counts: { secret: 1 } }]),
    broken([{ id: "deliveries", status: "unknown", summary: "", counts: { outboxQueued: -1 } }]),
    broken([{ id: "deliveries", status: "unknown", summary: "", counts: { outboxQueued: 1.5 } }]),
    broken([{ id: "deliveries", status: "unknown", summary: "", counts: { outboxQueued: "1" } }]),
    broken([{ id: "feed.github", status: "healthy", summary: "", lastSuccessAt: "yesterday" }]),
    broken([{ id: "feed.github", status: "healthy", summary: "", lastSuccessAt: 1e300 }]),
    broken([
      { id: "feed.github", status: "healthy", summary: "", lastSuccessAt: Number.MAX_SAFE_INTEGER },
    ]),
    broken([{ id: "feed.github", status: "healthy", summary: "", lastSuccessAt: latest + 1 }]),
    broken([{ id: "feed.github", status: "healthy", summary: "", lastSuccessAt: 0 }]),
    broken([{ id: "sessions", status: "healthy", summary: "", lastSuccessAt: now }]),
    broken([{ id: "feed.github", status: "disabled", summary: "" }]),
    broken([{ id: "sessions", status: "fine", summary: "" }]),
    broken([
      { id: "feed.github", status: "healthy", summary: "" },
      { id: "feed.github", status: "failed", summary: "" },
    ]),
    { ...valid, schemaVersion: 2 },
    { ...valid, checkedAt: Number.NaN },
    { ...valid, checkedAt: Number.MAX_SAFE_INTEGER },
    { ...valid, sampledAt: Number.MAX_SAFE_INTEGER },
    { ...valid, sampledAt: "now" },
    // A reason never comes with a sample time, and is one of three.
    { ...valid, sampleUnavailable: "failed" },
    { schemaVersion: 1, checkedAt: now, sampleUnavailable: "weird", checks: [] },
    // Without a sample time, no database check may be anything but unknown, or carry counts.
    {
      schemaVersion: 1,
      checkedAt: now,
      checks: [{ id: "database", status: "healthy", summary: "", counts: { known: 29 } }],
    },
    {
      schemaVersion: 1,
      checkedAt: now,
      sampleUnavailable: "failed",
      checks: [{ id: "deliveries", status: "unknown", summary: "", counts: { outboxQueued: 3 } }],
    },
    {
      schemaVersion: 1,
      checkedAt: now,
      sampleUnavailable: "expired",
      checks: [{ id: "slack.notices", status: "disabled", summary: "" }],
    },
  ]) {
    expect(parseReport(JSON.parse(JSON.stringify(body)))).toBeUndefined();
    const rejected = await sendReport(body);
    expect(check(rejected, "daemon").summary).toContain("couldn't be read");
    expect(check(rejected, "feed.github").status).toBe("unknown");
    expect(shown(rejected)).not.toContain("LEAKED");
  }
});

test("the latest time Date can print is accepted and printed", async () => {
  seed();
  holdOpen();
  writeAPI();
  const report = await sendReport({
    schemaVersion: 1,
    checkedAt: latest,
    checks: [{ id: "feed.github", status: "failed", summary: "", lastSuccessAt: latest }],
  });
  expect(check(report, "feed.github").lastSuccessAt).toBe(latest);
  expect(describeReport(report)).toContain(`Last success: ${new Date(latest).toISOString()}`);
});

test("feed checks come only from finished passes: unconfigured, stale and failed sources", () => {
  const seen: Observations = new Map();
  expect(feedCheck("github", seen.get("github"), now).status).toBe("unknown");
  observe(seen, "linear", "not_configured", now - minute);
  expect(feedCheck("linear", seen.get("linear"), now)).toMatchObject({
    status: "not_configured",
  });
  expect(feedCheck("linear", seen.get("linear"), now).lastSuccessAt).toBeUndefined();
  observe(seen, "github", "polled", now - 6 * minute);
  expect(feedCheck("github", seen.get("github"), now)).toMatchObject({
    status: "stale",
    lastSuccessAt: now - 6 * minute,
  });
  observe(seen, "github", "failed", now - minute);
  expect(feedCheck("github", seen.get("github"), now)).toMatchObject({
    status: "failed",
    lastSuccessAt: now - 6 * minute,
  });
  observe(seen, "github", "polled", now - minute);
  expect(feedCheck("github", seen.get("github"), now)).toMatchObject({
    status: "healthy",
    lastSuccessAt: now - minute,
  });
});

test("Slack: a saved problem fails, a saved active is unknown, and notices on aren't proof", async () => {
  seed();
  const none = await run();
  expect(check(none, "slack.apps").status).toBe("not_configured");
  expect(check(none, "slack.notices").status).toBe("disabled");

  change((db) => {
    db.insert(slackApps)
      .values({
        dot: "jojo",
        state: "active",
        appID: "A0SECRETAPP",
        teamID: "T0SECRET",
        botUser: "U0SECRETBOT",
        createdAt: 0,
        updatedAt: 0,
      })
      .run();
    db.insert(slackConfig).values({ id: 1, state: "idle", noticesSince: now, updatedAt: 0 }).run();
  });
  const active = await run();
  expect(check(active, "slack.apps")).toMatchObject({
    status: "unknown",
    counts: { apps: 1, active: 1, problem: 0 },
  });
  expect(check(active, "slack.apps").nextStep).toContain("open-dot slack status");
  expect(check(active, "slack.notices").status).toBe("unknown");

  change((db) => {
    db.update(slackApps)
      .set({
        problem: "Slack refused the app-level token in open-dot-slack-jojo-app: invalid_auth",
      })
      .run();
    db.update(slackConfig).set({ state: "blocked", problem: "xoxe-LEAKED" }).run();
  });
  const failing = await run();
  expect(check(failing, "slack.apps")).toMatchObject({
    status: "failed",
    counts: { active: 1, problem: 1, blocked: 1 },
  });
  expect(check(failing, "slack.apps").nextStep).toContain("open-dot slack config");
  for (const secret of ["A0SECRETAPP", "T0SECRET", "U0SECRETBOT", "LEAKED", "invalid_auth"])
    expect(shown(failing)).not.toContain(secret);
});

test("unresolved and stale sends are counted with the outbox's and Slack's own states", async () => {
  seed();
  expect(check(await run(), "deliveries").status).toBe("healthy");

  change((db) =>
    db
      .insert(outbox)
      .values({
        sessionID: "ses_jojoSECRET",
        messageID: "msg_old",
        text: "Private queued message",
        state: "pending",
        createdAt: now - 20 * minute,
      })
      .run(),
  );
  expect(check(await run(), "deliveries")).toMatchObject({
    status: "stale",
    counts: { outboxQueued: 1, outboxUnknown: 0 },
  });

  change((db) => {
    db.insert(outbox)
      .values({
        sessionID: "ses_jojoSECRET",
        messageID: "msg_lost",
        text: "Private started message",
        state: "pending",
        startedAt: now - minute,
        createdAt: now - minute,
      })
      .run();
    db.insert(slack)
      .values({
        ts: "1.0",
        dot: "jojo",
        channel: "D0SECRET",
        messageID: "msg_slack",
        replyText: "Private reply",
        state: "unknown",
        createdAt: now,
      })
      .run();
    db.insert(slackEvents)
      .values({
        app: "A0SECRET",
        dot: "jojo",
        kind: "dm",
        text: "Private DM",
        state: "waiting",
        createdAt: now,
      })
      .run();
    db.insert(slackNotices)
      .values({
        bot: "U0SECRET",
        channel: "D1SECRET",
        user: "U1SECRET",
        state: "sending",
        createdAt: now,
      })
      .run();
  });
  const unresolved = await run();
  expect(check(unresolved, "deliveries")).toMatchObject({
    status: "unknown",
    counts: { outboxQueued: 1, outboxUnknown: 1, slackQueued: 1, slackUnknown: 2 },
  });
  expect(check(unresolved, "deliveries").nextStep).toContain("never retrying it blindly");
  for (const secret of ["Private", "msg_", "D0SECRET", "A0SECRET", "U1SECRET"])
    expect(shown(unresolved)).not.toContain(secret);
});

test("an unsupported schema is reported without reading its tables", async () => {
  seed((db) => {
    db.$client.run(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)",
    );
    // A table this code would read is gone, so reading it would fail rather than say "not checked".
    db.$client.run("DROP TABLE slack_notices");
  });
  const before = files();
  const sessions = probe();
  const report = await run({ opencode: sessions.run });
  expect(check(report, "database")).toMatchObject({
    status: "failed",
    counts: { unknown: 1, pending: 0 },
  });
  for (const id of ["sessions", "deliveries", "slack.apps", "slack.notices"])
    expect(check(report, id).summary).toStartWith("Not checked");
  expect(sessions.calls).toEqual([[]]);
  expect(files()).toEqual(before);
});

test("pending migrations are counted exactly and never applied", async () => {
  seed((db) =>
    db.$client.run(
      "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)",
    ),
  );
  const before = files();
  const report = await run();
  expect(check(report, "database")).toMatchObject({
    status: "stale",
    counts: { pending: 1, applied: 34, known: 35 },
  });
  expect(files()).toEqual(before);
});

const when0015 = 1792600000000;
const draftHash = "fe72d1f09d8da72982f3bd71ef974d1d3640c5fbdfd22614c280bfe274d4efad";
const rescan = "`rescan` integer DEFAULT false NOT NULL";

/**
 * Remakes `slack_threads` as 0015's draft created it, then adds `rescan` (or another definition)
 * at the end, as the live database had it, and records the draft's hash for 0015.
 */
const draftThreads = (db: Db, ...added: string[]) => {
  db.$client.run("DROP TABLE slack_threads");
  db.$client.run(`CREATE TABLE \`slack_threads\` (
  \`key\` text PRIMARY KEY NOT NULL,
  \`route\` text NOT NULL,
  \`parent\` text,
  \`oldest\` text NOT NULL,
  \`newest\` text NOT NULL,
  \`cursor\` text DEFAULT '' NOT NULL,
  \`active_at\` integer NOT NULL,
  \`polled_at\` integer DEFAULT 0 NOT NULL
);`);
  for (const definition of added)
    db.$client.run(`ALTER TABLE \`slack_threads\` ADD ${definition};`);
  db.$client.run(
    `UPDATE __drizzle_migrations SET hash = '${draftHash}' WHERE created_at = ${when0015}`,
  );
};

/** schemaCheck on a fresh migrated database after `edit`. */
const schemaAfter = (edit: (db: Db) => void) => {
  const db = openDatabase(":memory:");
  try {
    edit(db);
    return schemaCheck(db.$client);
  } finally {
    db.$client.close();
  }
};

test("0015's draft hash passes over its real reordered slack_threads, and the other checks read", async () => {
  seed((db) => draftThreads(db, rescan));
  const columns = fixture?.$client
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('slack_threads')")
    .all()
    .map((column) => column.name);
  expect(columns?.at(-1)).toBe("rescan");
  expect(columns?.indexOf("rescan")).toBeGreaterThan(columns?.indexOf("active_at") ?? Infinity);

  const before = files();
  const sessions = probe();
  const report = await run({ opencode: sessions.run });
  expect(check(report, "database")).toMatchObject({
    status: "healthy",
    counts: { changed: 0, unknown: 0, skipped: 0, pending: 0, applied: 35, known: 35 },
  });
  expect(check(report, "sessions").status).toBe("healthy");
  expect(check(report, "deliveries").status).toBe("healthy");
  expect(sessions.calls).toEqual([["ses_jojoSECRET", "ses_jolyneSECRET"]]);
  expect(files()).toEqual(before);
});

test("0015's draft hash fails over any other slack_threads, and other hashes never pass", () => {
  const changed = { status: "failed", counts: { changed: 1, unknown: 0, skipped: 0 } };
  const when0014 = journal.entries.find((entry) => entry.tag.startsWith("0014"))?.when;
  expect(when0014).toBeNumber();
  const cases: [string, (db: Db) => void][] = [
    ["rescan never added", (db) => draftThreads(db)],
    ["another default", (db) => draftThreads(db, "`rescan` integer DEFAULT true NOT NULL")],
    ["nullable", (db) => draftThreads(db, "`rescan` integer DEFAULT false")],
    ["another type", (db) => draftThreads(db, "`rescan` text DEFAULT false NOT NULL")],
    [
      "a check",
      (db) =>
        draftThreads(db, "`rescan` integer DEFAULT false NOT NULL CHECK (`rescan` IN (0, 1))"),
    ],
    ["an extra column", (db) => draftThreads(db, rescan, "`extra` text")],
    [
      "non-SQL whitespace in a type is not a constraint",
      (db) => {
        draftThreads(db, rescan);
        const table = db.$client
          .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'slack_threads'")
          .get();
        if (!table) throw new Error("Missing fixture table");
        db.$client.run("DROP TABLE slack_threads");
        db.$client.run(
          table.sql.replace("`route` text NOT NULL", "`route` text\u00a0NOT\u00a0NULL"),
        );
        expect(
          db.$client
            .query<{ notnull: number }, []>(
              "SELECT \"notnull\" FROM pragma_table_info('slack_threads') WHERE name = 'route'",
            )
            .get()?.notnull,
        ).toBe(0);
      },
    ],
    [
      "an extra index",
      (db) => {
        draftThreads(db, rescan);
        db.$client.run("CREATE INDEX threads_route ON slack_threads (route)");
      },
    ],
    [
      "a trigger",
      (db) => {
        draftThreads(db, rescan);
        db.$client.run(
          "CREATE TRIGGER threads_touch AFTER INSERT ON slack_threads BEGIN SELECT 1; END",
        );
      },
    ],
    [
      "another hash at 0015",
      (db) => {
        draftThreads(db, rescan);
        db.$client.run(
          `UPDATE __drizzle_migrations SET hash = '${"f".repeat(64)}' WHERE created_at = ${when0015}`,
        );
      },
    ],
    [
      "the draft hash at 0014",
      (db) =>
        db.$client.run(
          `UPDATE __drizzle_migrations SET hash = '${draftHash}' WHERE created_at = ${when0014}`,
        ),
    ],
  ];
  for (const [name, edit] of cases)
    expect({ name, ...schemaAfter(edit) }).toMatchObject({ name, ...changed });
});

test("with 0015's draft accepted, duplicate, unknown, skipped and pending migrations still count", () => {
  const newest = Math.max(...journal.entries.map((entry) => entry.when));
  const when0014 = journal.entries.find((entry) => entry.tag.startsWith("0014"))?.when;
  expect(
    schemaAfter((db) => {
      draftThreads(db, rescan);
      db.$client.run(
        `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${draftHash}', ${when0015})`,
      );
    }),
  ).toMatchObject({ status: "failed", counts: { changed: 0, applied: 36 } });
  expect(
    schemaAfter((db) => {
      draftThreads(db, rescan);
      db.$client.run(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)",
      );
    }),
  ).toMatchObject({ status: "failed", counts: { unknown: 1, changed: 0 } });
  expect(
    schemaAfter((db) => {
      draftThreads(db, rescan);
      db.$client.run(`DELETE FROM __drizzle_migrations WHERE created_at = ${when0014}`);
    }),
  ).toMatchObject({ status: "failed", counts: { skipped: 1, changed: 0 } });
  expect(
    schemaAfter((db) => {
      draftThreads(db, rescan);
      db.$client.run(`DELETE FROM __drizzle_migrations WHERE created_at = ${newest}`);
    }),
  ).toMatchObject({ status: "stale", counts: { pending: 1, changed: 0 } });
});

test("every probe is bounded", async () => {
  seed();
  writeAPI();
  const started = performance.now();
  const report = await run({
    fetch: never,
    opencode: () => new Promise(() => {}),
    timeout: 50,
    probeTimeout: 50,
  });
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(check(report, "daemon").status).toBe("unknown");
  expect(check(report, "opencode").status).toBe("unknown");
  expect(check(report, "sessions").status).toBe("unknown");
});

// The public adapter, over a fake fetch: no OpenCode, server or network.

const info = { version: "2.1.1", pid: 1, urls: [], paths: { tmp: "/tmp" } };
const sessionBody = (id: string) => ({
  data: {
    id,
    projectID: "global",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: "/tmp/fake" },
  },
});
const endpoint = {
  url: "http://opencode.test",
  auth: { type: "basic" as const, username: "opencode", password: "pw_SECRET" },
};

/** A fake OpenCode over fetch. Reads wait their delay, unless their request is aborted. */
const fakeService = (sessionDelay = 0, infoDelay = 0) => {
  const calls: { method: string; path: string }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname });
    const isInfo = url.pathname === "/api/info";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, isInfo ? infoDelay : sessionDelay);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
    if (isInfo) return Response.json(info);
    const id = url.pathname.match(/^\/api\/session\/(ses_\w+)$/)?.[1];
    if (!id) return new Response("unexpected", { status: 500 });
    return id.startsWith("ses_gone")
      ? Response.json(
          { _tag: "SessionNotFoundError", sessionID: id, message: "Session not found" },
          { status: 404 },
        )
      : Response.json(sessionBody(id));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

test("the public adapter reads only server info and each session", async () => {
  const service = fakeService();
  const result = await openCodeProbe(async () => endpoint, service.fetch)(
    ["ses_here", "ses_gone"],
    1_000,
  );
  expect(result).toEqual({
    state: "reachable",
    sessions: new Map([
      ["ses_here", "found"],
      ["ses_gone", "missing"],
    ]),
  });
  expect(service.calls.map(({ method, path }) => `${method} ${path}`).toSorted()).toEqual([
    "GET /api/info",
    "GET /api/session/ses_gone",
    "GET /api/session/ses_here",
  ]);
});

test("the public adapter has one deadline for everything, and starts no read after it", async () => {
  const service = fakeService(40);
  const ids = Array.from({ length: 12 }, (_, at) => `ses_s${at}`);
  const started = performance.now();
  const result = await openCodeProbe(async () => endpoint, service.fetch)(ids, 60);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(result.state).toBe("reachable");
  const reads = service.calls.filter((call) => call.path.startsWith("/api/session/"));
  expect(reads.length).toBeLessThan(ids.length);
  const count = service.calls.length;
  await Bun.sleep(150);
  expect(service.calls.length).toBe(count);
  if (result.state === "reachable")
    expect([...result.sessions.values()].every((state) => state === "found")).toBe(true);

  const slowInfo = fakeService(0, 1_000);
  expect(await openCodeProbe(async () => endpoint, slowInfo.fetch)(["ses_x"], 50)).toEqual({
    state: "timeout",
  });
  await Bun.sleep(100);
  expect(slowInfo.calls.map((call) => call.path)).toEqual(["/api/info"]);

  const hung = fakeService();
  expect(await openCodeProbe(() => new Promise(() => {}), hung.fetch)(["ses_x"], 50)).toEqual({
    state: "timeout",
  });
  expect(await openCodeProbe(async () => undefined, hung.fetch)(["ses_x"], 50)).toEqual({
    state: "not_running",
  });
  expect(
    await openCodeProbe(() => Promise.reject(new Error("/secret/path")), hung.fetch)(["ses_x"], 50),
  ).toEqual({ state: "failed" });
  expect(hung.calls).toHaveLength(0);
});

test("the report is machine-readable, versioned and free of secrets", async () => {
  seed();
  writeAPI();
  const report = await run({ fetch: answering(async () => new Response(null, { status: 404 })) });
  expect(report.schemaVersion).toBe(1);
  expect(report.checkedAt).toBe(now);
  expect(report.sampledAt).toBe(now);
  expect(report.checks.map((entry) => entry.id)).toEqual([
    "daemon",
    "database",
    "opencode",
    "sessions",
    "deliveries",
    "feed.github",
    "feed.linear",
    "feed.slack",
    "slack.apps",
    "slack.notices",
  ]);
  for (const entry of report.checks) {
    expect(healthStatuses).toContain(entry.status);
    expect(entry.summary.length).toBeGreaterThan(0);
  }
  expect(check(report, "daemon").status).toBe("stale");
  // The CLI reads its own report back exactly, from structured fields alone.
  const parsed = parseReport(JSON.parse(JSON.stringify(report)));
  expect(parsed?.sampledAt).toBe(now);
  for (const entry of report.checks.filter((candidate) => parsed?.checks.has(candidate.id))) {
    const back = parsed?.checks.get(entry.id);
    expect(back?.status).toBe(entry.status);
    expect(back?.counts).toEqual(entry.counts);
  }
  for (const secret of [token, home, "ses_", "/Users/secret", "Private purpose", "jojo"])
    expect(shown(report)).not.toContain(secret);
});
