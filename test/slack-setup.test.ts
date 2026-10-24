import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { api } from "../src/api";
import { avatarPath, avatarRevision } from "../src/avatar";
import { type Db, openDatabase } from "../src/db";
import { dots, feed, outbox, slackApps, slackConfig, slackEvents } from "../src/schema";
import {
  appItem,
  botItem,
  botScopes,
  cliItem,
  cliLogin,
  configItem,
  describe as slackStatus,
  freshConfig,
  iconStatus,
  installOf,
  manifest as dotManifest,
  provision,
  retryIcon,
  saveAppToken,
  saveConfigPair,
  type Setup,
  ticketLife,
  unknownOutcome,
} from "../src/slack-setup";
import { type Slack, slackClient } from "../src/slack";
import { fakeOpenCode } from "./fake-opencode";

// Fake IDs and tokens only. No call leaves this process, and no Keychain is touched.
const owner = "UOWNER";
const team = "T1";
const appIDs = { jojo: "AJOJO01", polnareff: "APOLNA01" } as const;

let db: Db;
let home: string;
let previousHome: string | undefined;
let time: number;

test("owner setup logs only the checked ID, not Slack's user text", async () => {
  const logged: unknown[] = [];
  const log = spyOn(console, "log").mockImplementation((...args) => logged.push(...args));
  try {
    const client = slackClient(
      async () =>
        Response.json({ ok: true, user_id: owner, team_id: team, user: "xoxp-LEAKED\nunsafe" }),
      { bot: async () => undefined, user: async () => "fake-user-token" },
    );
    expect(await client.owner()).toBe(owner);
    expect(logged).toEqual([`Slack: acting for ${owner}`]);
  } finally {
    log.mockRestore();
  }
});

/** Slack's configuration API in memory: token rotation, apps.icon.set and manifest export/update. */
function fakeSlack() {
  const state = {
    keychain: new Map<string, string>(),
    rotations: 0,
    // What apps.icon.set answers next: ok, a Slack error, a 429, or a lost answer.
    icon: { kind: "ok" } as
      | { kind: "ok" }
      | { kind: "error"; error: string }
      | { kind: "429"; after?: string }
      | { kind: "lost" },
    icons: [] as {
      url: string;
      authorization: string | null;
      contentType: string | null;
      fields: string[];
      appID: unknown;
      token: unknown;
      file: { name: string; type: string; bytes: Buffer } | undefined;
    }[],
    exported: new Map<string, unknown>(),
    // What apps.manifest.export answers instead of the manifest, when set.
    exportAnswer: undefined as unknown,
    updated: [] as unknown[],
    saveWorks: true,
    // A save that writes the item but whose read-back fails, so it isn't confirmed.
    saveUnconfirmed: false,
    // What tooling.tokens.rotate and apps.manifest.create answer instead of a good answer, when set.
    rotateAnswer: undefined as unknown,
    createAnswer: undefined as unknown,
    onRotate: async () => {},
    onSave: async () => {},
    onRead: async () => {},
    fetches: 0,
    reads: 0,
    // Issue 50: every call's method, headers and body, and what a method answers instead of its
    // good answer: a body, or "lost" for a dropped connection.
    calls: [] as {
      method: string;
      authorization: string | null;
      type: string | null;
      body: string;
    }[],
    answers: new Map<string, unknown>(),
    // Runs as each call arrives, before it's answered, to see what was saved before it was sent.
    onCall: async (_method: string) => {},
    // Keychain items whose save fails.
    saveFails: new Set<string>(),
    // The workspace a bot token's auth.test names.
    botTeam: team as string,
  };
  const fetch = async (url: string, init: RequestInit) => {
    state.fetches++;
    const method = url.split("/").pop() ?? "";
    const sent = new Headers(init.headers);
    const text = typeof init.body === "string" ? init.body : "";
    state.calls.push({
      method,
      authorization: sent.get("authorization"),
      type: sent.get("content-type"),
      body: text,
    });
    await state.onCall(method);
    const override = state.answers.get(method);
    if (override === "lost") throw new Error("connection reset");
    if (override !== undefined) return Response.json(override);
    const json = sent.get("content-type")?.startsWith("application/json")
      ? (JSON.parse(text) as Record<string, unknown>)
      : {};
    const bearer = sent.get("authorization")?.replace(/^Bearer /, "");
    if (method === "apps.hosted.generateAuthTicket")
      return Response.json({ ok: true, ticket: "TICKET0123456789" });
    if (method === "apps.hosted.exchangeAuthTicket")
      return Response.json({
        ok: true,
        token: "xoxe.xoxp-1-CLISECRET",
        refresh_token: "xoxe-1-CLIREFRESH",
        team_id: team,
        team_domain: "jojo",
        user_id: owner,
        exp: Math.floor(time / 1000) + 43_200,
        is_ready: true,
      });
    if (method === "apps.developerInstall")
      return Response.json({
        ok: true,
        app_id: json.app_id,
        api_access_tokens: {
          bot: "xoxb-1-INSTALLEDBOT",
          app_level: `xapp-1-${String(json.app_id)}-1-INSTALLEDAPP`,
          user: "xoxp-1-USERSECRET",
        },
      });
    if (method === "auth.test") {
      if (bearer === "fake-user-token")
        return Response.json({ ok: true, user_id: owner, team_id: team, user: "owner" });
      if (bearer?.startsWith("xoxb-"))
        return Response.json({ ok: true, user_id: "UBOT", bot_id: "BBOT", team_id: state.botTeam });
      return Response.json({ ok: false, error: "invalid_auth" });
    }
    if (method === "bots.info")
      return Response.json({ ok: true, bot: { app_id: appIDs.jojo, user_id: "UBOT" } });
    if (method === "apps.icon.set") {
      const form = init.body instanceof FormData ? init.body : undefined;
      const file = form?.get("file");
      const headers = new Headers(init.headers);
      state.icons.push({
        url,
        authorization: headers.get("authorization"),
        contentType: headers.get("content-type"),
        fields: form ? [...form.keys()] : [],
        appID: form?.get("app_id"),
        token: form?.get("token"),
        file:
          file instanceof File
            ? { name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) }
            : undefined,
      });
      const answer = state.icon;
      if (answer.kind === "lost") throw new Error("connection reset");
      if (answer.kind === "429")
        return new Response("", {
          status: 429,
          headers: answer.after ? { "retry-after": answer.after } : {},
        });
      return Response.json(
        answer.kind === "ok" ? { ok: true } : { ok: false, error: answer.error },
      );
    }
    const params = Object.fromEntries(
      new URLSearchParams(typeof init.body === "string" ? init.body : ""),
    );
    if (method === "tooling.tokens.rotate") {
      state.rotations++;
      await state.onRotate();
      if (state.rotateAnswer !== undefined) return Response.json(state.rotateAnswer);
      const n = state.rotations;
      return Response.json({
        ok: true,
        token: `xoxe.xoxp-1-t${n}`,
        refresh_token: `xoxe-1-r${n}`,
        team_id: team,
        user_id: owner,
        iat: n,
        exp: n + 43_200,
      });
    }
    if (method === "apps.manifest.create")
      return Response.json(state.createAnswer ?? { ok: true, app_id: appIDs.jojo });
    if (method === "apps.manifest.export") {
      if (state.exportAnswer !== undefined) return Response.json(state.exportAnswer);
      const manifest = state.exported.get(
        params.app_id ?? (typeof json.app_id === "string" ? json.app_id : ""),
      );
      return Response.json(manifest ? { ok: true, manifest } : { ok: false, error: "invalid_app" });
    }
    if (method === "apps.manifest.update") {
      state.updated.push(JSON.parse(params.manifest ?? "null"));
      return Response.json({ ok: true, permissions_updated: false });
    }
    return Response.json({ ok: false, error: "unknown_method" });
  };
  const setup: Setup = {
    fetch,
    read: async (service) => {
      state.reads++;
      await state.onRead();
      return state.keychain.get(service);
    },
    save: async (service, secret) => {
      await state.onSave();
      if (!state.saveWorks || state.saveFails.has(service)) return false;
      if (state.saveUnconfirmed) {
        state.keychain.set(service, secret);
        return false;
      }
      state.keychain.set(service, secret);
      return true;
    },
    now: () => time,
  };
  return { state, setup };
}

let fake: ReturnType<typeof fakeSlack>;

/** The shared app isn't needed: no app is requested or attached in these tests. */
const shared = { owner: async () => owner, team: () => team } as unknown as Slack;

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
};
/** A PNG whose structure is whole; its image data need not decode for the daemon's check. */
const png = (side: number, fill: number) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", Buffer.alloc(16 + fill, fill)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
/** Replaces the dot's avatar the way the CLI does, through a rename, so its revision changes. */
const setAvatarFile = (dot: string, bytes: Buffer) => {
  const temporary = join(home, "dots", dot, ".avatar-test");
  writeFileSync(temporary, bytes);
  renameSync(temporary, avatarPath(dot));
  return bytes;
};

const app = (dot = "jojo") => {
  const row = db.select().from(slackApps).where(eq(slackApps.dot, dot)).get();
  if (!row) throw new Error("no app");
  return row;
};
const created = (dot: "jojo" | "polnareff", state: "created" | "active" = "active") =>
  db
    .insert(slackApps)
    .values({
      dot,
      state,
      appID: appIDs[dot],
      teamID: team,
      ownerID: owner,
      manifestVersion: 2,
      createdAt: 0,
      updatedAt: 0,
    })
    .run();
const savePair = () =>
  fake.state.keychain.set(
    configItem,
    JSON.stringify({ token: "xoxe.xoxp-1-t0", refresh_token: "xoxe-1-r0" }),
  );
const pass = () => provision(db, shared, fake.setup);
/** The message a promise fails with, or undefined when it succeeds. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : "not an Error"),
  );
const minute = 60_000;

beforeEach(() => {
  previousHome = process.env.OPEN_DOT_HOME;
  home = mkdtempSync(join(tmpdir(), "open-dot-slack-setup-"));
  process.env.OPEN_DOT_HOME = home;
  db = openDatabase(":memory:");
  fake = fakeSlack();
  time = 10_000_000;
  for (const name of ["jojo", "polnareff"]) {
    mkdirSync(join(home, "dots", name), { recursive: true });
    db.insert(dots)
      .values({
        name,
        directory: join(home, "dots", name),
        sessionID: `ses_${name}`,
        sessionState: "ready",
        purpose: null,
        createdAt: name === "jojo" ? 0 : 1,
      })
      .run();
  }
});

afterEach(() => {
  db.$client.close();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.OPEN_DOT_HOME;
  else process.env.OPEN_DOT_HOME = previousHome;
});

test("the icon is set from the avatar once, as a multipart apps.icon.set with a fresh configuration token", async () => {
  created("jojo");
  savePair();
  // No avatar: nothing is called, and nothing rotates.
  await pass();
  expect(fake.state.icons).toEqual([]);
  expect(fake.state.rotations).toBe(0);

  const image = setAvatarFile("jojo", png(1024, 1));
  const revision = avatarRevision("jojo");
  await pass();
  expect(fake.state.rotations).toBe(1);
  expect(fake.state.icons).toHaveLength(1);
  const [sent] = fake.state.icons;
  expect(sent?.url).toEndWith("/apps.icon.set");
  // The rotated token goes in the header, never as a form field; the file is the avatar's bytes.
  expect(sent?.authorization).toBe("Bearer xoxe.xoxp-1-t1");
  expect(sent?.token).toBeNull();
  expect(sent?.fields.toSorted()).toEqual(["app_id", "file"]);
  expect(sent?.appID).toBe(appIDs.jojo);
  expect(sent?.file?.name).toBe("avatar.png");
  expect(sent?.file?.type).toBe("image/png");
  expect(sent?.file?.bytes.equals(image)).toBe(true);
  expect(app()).toMatchObject({ iconRevision: revision, iconState: null, iconError: null });
  expect(slackStatus(db, app())).toContain("App icon: set from");
  // Nothing secret reached the database.
  expect(JSON.stringify(db.select().from(slackApps).all())).not.toMatch(/xox/);

  // Nothing but a new avatar sets it again: not time, not another pass.
  for (let step = 0; step < 5; step++) {
    time += 10 * minute;
    await pass();
  }
  expect(fake.state.icons).toHaveLength(1);
  expect(fake.state.rotations).toBe(1);

  setAvatarFile("jojo", png(1024, 2));
  expect(avatarRevision("jojo")).not.toBe(revision);
  await pass();
  expect(fake.state.icons).toHaveLength(2);
  expect(app().iconRevision).toBe(avatarRevision("jojo"));
});

test("an app still being set up, or with another state, gets no icon", async () => {
  savePair();
  setAvatarFile("jojo", png(1024, 1));
  db.insert(slackApps).values({ dot: "jojo", state: "unknown", createdAt: 0, updatedAt: 0 }).run();
  await pass();
  expect(fake.state.icons).toEqual([]);
  db.update(slackApps)
    .set({ state: "created", appID: appIDs.jojo, teamID: team, ownerID: owner })
    .run();
  await pass();
  expect(fake.state.icons).toHaveLength(1);
});

test("invalid_icon_size and token refusals are permanent: the manual step shows Slack's error until a new avatar or a retry", async () => {
  for (const error of ["invalid_icon_size", "not_allowed_token_type", "missing_scope"]) {
    db.delete(slackApps).run();
    fake.state.icons = [];
    created("jojo");
    savePair();
    setAvatarFile("jojo", png(1024, error.length));
    fake.state.icon = { kind: "error", error };
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      await pass();
      expect(app()).toMatchObject({ iconState: "refused", iconError: error, iconRevision: null });
      const status = slackStatus(db, app());
      expect(status).toContain(`Slack refused apps.icon.set (${error})`);
      expect(status).toContain(`https://api.slack.com/apps/${appIDs.jojo}/general`);
      expect(status).toContain(`upload ${avatarPath("jojo")} under App icon & Preview`);
      // Never again on its own, however long it waits.
      for (let step = 0; step < 5; step++) {
        time += 30 * minute;
        await pass();
      }
      expect(fake.state.icons).toHaveLength(1);

      // A new avatar tries again.
      fake.state.icon = { kind: "ok" };
      setAvatarFile("jojo", png(1024, 100 + error.length));
      time += 2 * minute;
      await pass();
      expect(fake.state.icons).toHaveLength(2);
      expect(app().iconRevision).toBe(avatarRevision("jojo"));
    } finally {
      quiet.mockRestore();
    }
  }
});

test("ratelimited holds every app's icon until the whole Retry-After, even across a new avatar", async () => {
  created("jojo");
  created("polnareff");
  savePair();
  setAvatarFile("jojo", png(1024, 1));
  setAvatarFile("polnareff", png(1024, 2));
  // Two hours, longer than any cap would allow.
  fake.state.icon = { kind: "429", after: "7200" };
  const start = time;
  await pass();
  expect(fake.state.icons).toHaveLength(1);
  expect(fake.state.icons[0]?.appID).toBe(appIDs.jojo);
  expect(app("jojo")).toMatchObject({ iconState: "waiting", iconError: "ratelimited" });
  expect(app("jojo").iconRetryAt).toBe(start + 7_200_000);
  expect(slackStatus(db, app("jojo"))).toContain("Slack is rate limiting apps.icon.set");

  // Neither the other app nor a new avatar gets a call while the limit holds.
  fake.state.icon = { kind: "ok" };
  setAvatarFile("jojo", png(1024, 3));
  for (const step of [61_000, 30 * minute, 60 * minute, 28 * minute]) {
    time += step;
    await pass();
  }
  expect(time).toBeLessThan(start + 7_200_000);
  expect(fake.state.icons).toHaveLength(1);
  expect(fake.state.rotations).toBe(1);
  expect(iconStatus(app("jojo"))).toBe("waiting");
  expect(retryIcon(db, "polnareff", time)).toContain("rate limiting");

  // Once it has passed, one call a pass, a minute apart: jojo's new avatar, then polnareff.
  time = start + 7_200_000;
  await pass();
  expect(fake.state.icons).toHaveLength(2);
  expect(app("jojo").iconRevision).toBe(avatarRevision("jojo"));
  await pass();
  expect(fake.state.icons).toHaveLength(2);
  // A minute after jojo's answer, which is stamped just after its claim.
  time += 61_000;
  await pass();
  expect(fake.state.icons).toHaveLength(3);
  expect(app("polnareff").iconRevision).toBe(avatarRevision("polnareff"));
});

test("a huge Retry-After is kept as the latest time there is, and status can still print it", async () => {
  created("jojo");
  savePair();
  setAvatarFile("jojo", png(1024, 1));
  fake.state.icon = { kind: "429", after: "1e300" };
  await pass();
  expect(app().iconRetryAt).toBe(8.64e15);
  expect(slackStatus(db, app())).toContain("+275760-09-13T00:00:00.000Z");
});

test("an icon call with no clear answer, or one a stopped daemon left, is never sent again on its own", async () => {
  created("jojo");
  savePair();
  setAvatarFile("jojo", png(1024, 1));
  for (const lost of [{ kind: "lost" }, { kind: "error", error: "internal_error" }] as const) {
    db.update(slackApps).set({ iconState: null, iconAttempt: null, iconError: null }).run();
    const before = fake.state.icons.length;
    fake.state.icon = lost;
    time += 2 * minute;
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      await pass();
    } finally {
      quiet.mockRestore();
    }
    expect(fake.state.icons).toHaveLength(before + 1);
    expect(app()).toMatchObject({ iconState: "refused", iconError: "unknown_outcome" });
    expect(slackStatus(db, app())).toContain("never sent again on its own");
    fake.state.icon = { kind: "ok" };
    for (let step = 0; step < 6; step++) {
      time += 30 * minute;
      await pass();
    }
    expect(fake.state.icons).toHaveLength(before + 1);
  }

  // The owner's retry sends it again.
  expect(retryIcon(db, "jojo", time)).toBeUndefined();
  await pass();
  expect(app().iconRevision).toBe(avatarRevision("jojo"));
  const sent = fake.state.icons.length;

  // A new avatar does too. A "setting" a stopped daemon left becomes an unknown outcome, unsent.
  setAvatarFile("jojo", png(1024, 3));
  db.update(slackApps)
    .set({ iconState: "setting", iconAttempt: avatarRevision("jojo"), iconAt: time })
    .run();
  time += 30_000;
  await pass();
  expect(app().iconState).toBe("setting");
  time += minute;
  await pass();
  expect(app()).toMatchObject({ iconState: "refused", iconError: "unknown_outcome" });
  for (let step = 0; step < 3; step++) {
    time += 30 * minute;
    await pass();
  }
  expect(fake.state.icons).toHaveLength(sent);
  setAvatarFile("jojo", png(1024, 4));
  await pass();
  expect(fake.state.icons).toHaveLength(sent + 1);
  expect(app().iconRevision).toBe(avatarRevision("jojo"));
});

test("no app, or no avatar, makes no Slack call and reads no Keychain item", async () => {
  savePair();
  setAvatarFile("jojo", png(1024, 1));
  for (let step = 0; step < 3; step++) {
    time += 10 * minute;
    await pass();
  }
  created("polnareff");
  for (let step = 0; step < 3; step++) {
    time += 10 * minute;
    await pass();
  }
  expect(fake.state.fetches).toBe(0);
  expect(fake.state.reads).toBe(0);
  expect(db.select().from(slackConfig).all()).toEqual([]);
});

test("Slack's own words, odd error codes and IDs are never saved, logged or shown", async () => {
  const leak = "xoxb-LEAKED <script>";
  const logged: unknown[] = [];
  const errors = spyOn(console, "error").mockImplementation((...args) => logged.push(...args));
  const logs = spyOn(console, "log").mockImplementation((...args) => logged.push(...args));
  try {
    savePair();
    // A refused rotation names only a known code.
    fake.state.rotateAnswer = { ok: false, error: leak, errors: [{ message: leak }] };
    const blocked = await failure(freshConfig(db, fake.setup, { id: owner, team }));
    expect(blocked).toContain("slack_error");
    // A rotation for an odd user or workspace prints no ID it can't vouch for.
    db.update(slackConfig).set({ state: "idle" }).run();
    fake.state.rotateAnswer = {
      ok: true,
      token: "xoxe.xoxp-1-t9",
      refresh_token: "xoxe-1-r9",
      team_id: leak,
      user_id: leak,
      iat: 9,
      exp: 99,
    };
    const odd = await failure(freshConfig(db, fake.setup, { id: owner, team }));
    expect(odd).toContain("an unrecognized ID");
    fake.state.rotateAnswer = undefined;

    // A create refused with Slack's own words keeps only the code; an odd app ID is never saved.
    for (const answer of [
      { ok: false, error: "invalid_manifest", errors: [{ message: leak }] },
      { ok: true, app_id: leak },
    ]) {
      db.delete(slackApps).run();
      db.update(slackConfig).set({ state: "idle", problem: null }).run();
      fake.state.createAnswer = answer;
      await call("/dots/jojo/slack/connect", { method: "POST" });
      await pass();
    }
    expect(app()).toMatchObject({ state: "unknown", appID: null });

    // An icon refusal with an unknown code is saved as slack_error.
    db.delete(slackApps).run();
    db.update(slackConfig).set({ state: "idle", problem: null }).run();
    created("jojo");
    setAvatarFile("jojo", png(1024, 1));
    fake.state.icon = { kind: "error", error: leak };
    time += 2 * minute;
    await pass();
    expect(app()).toMatchObject({ iconState: "refused", iconError: "slack_error" });

    // An export refused with odd words, through the notch's update.
    db.update(slackApps).set({ manifestVersion: null }).run();
    fake.state.exportAnswer = { ok: false, error: leak };
    const update = await call("/dots/jojo/slack/update", { method: "POST" });
    expect(await update.text()).toContain("slack_error");

    const shown = [
      JSON.stringify(db.select().from(slackApps).all()),
      JSON.stringify(db.select().from(slackConfig).all()),
      await (await call("/dots/jojo/slack")).text(),
      slackStatus(db, app()),
      logged.map(String).join("\n"),
    ].join("\n");
    expect(shown).not.toContain("LEAKED");
    expect(shown).not.toContain("<script>");
  } finally {
    errors.mockRestore();
    logs.mockRestore();
  }
});

test("a saved pair and a rotation never overwrite each other", async () => {
  const pair = { token: "xoxe.xoxp-1-owner", refresh: "xoxe-1-owner" };
  savePair();
  // A save while a rotation runs is refused, and the rotated pair stays.
  let duringRotation: string | undefined;
  fake.state.onRotate = async () => {
    duringRotation = await saveConfigPair(db, fake.setup, pair.token, pair.refresh);
  };
  await freshConfig(db, fake.setup, { id: owner, team });
  expect(duringRotation).toContain("rotation is in progress");
  expect(JSON.parse(fake.state.keychain.get(configItem) ?? "{}")).toMatchObject({
    refresh_token: "xoxe-1-r1",
  });
  fake.state.onRotate = async () => {};

  // A rotation while a save writes the item is refused, and sends nothing.
  let duringSave: string | undefined;
  fake.state.onSave = async () => {
    duringSave = await failure(freshConfig(db, fake.setup, { id: owner, team }));
  };
  expect(await saveConfigPair(db, fake.setup, pair.token, pair.refresh)).toBeUndefined();
  expect(duringSave).toContain("rotation is in progress");
  expect(fake.state.rotations).toBe(1);
  expect(JSON.parse(fake.state.keychain.get(configItem) ?? "{}")).toEqual({
    token: pair.token,
    refresh_token: pair.refresh,
    saved: expect.any(Number),
  });
  expect(db.select().from(slackConfig).get()).toMatchObject({ state: "idle", fromIat: 0 });
  fake.state.onSave = async () => {};

  // A failed save may have written either pair, so it fails closed: rotation waits for a new save.
  db.update(slackConfig).set({ state: "idle", problem: null }).run();
  fake.state.saveWorks = false;
  expect(await saveConfigPair(db, fake.setup, pair.token, pair.refresh)).toContain(
    "Couldn't confirm",
  );
  expect(db.select().from(slackConfig).get()?.state).toBe("blocked");
  expect(db.select().from(slackConfig).get()?.problem).toContain("Save the pair again");
  expect(await failure(freshConfig(db, fake.setup, { id: owner, team }))).toContain(
    "Save the pair again",
  );
  expect(fake.state.rotations).toBe(1);
  fake.state.saveWorks = true;

  // A rotation a stopped daemon left over a minute ago doesn't stop a save, which ends it.
  db.update(slackConfig)
    .set({ state: "rotating", fromIat: 1, updatedAt: time - 2 * minute })
    .run();
  expect(await saveConfigPair(db, fake.setup, pair.token, pair.refresh)).toBeUndefined();
  expect(db.select().from(slackConfig).get()).toMatchObject({ state: "idle", problem: null });

  // A save a stopped process left, with no proof its pair was written, fails closed: the item
  // may still hold a pair whose refresh token a lost rotation used up.
  const left = time - 2 * minute;
  fake.state.keychain.set(configItem, JSON.stringify({ refresh_token: "xoxe-1-used", iat: 7 }));
  db.update(slackConfig).set({ state: "rotating", fromIat: -1, updatedAt: left }).run();
  const rotations = fake.state.rotations;
  expect(await failure(freshConfig(db, fake.setup, { id: owner, team }))).toContain(
    "saving a configuration token pair was interrupted",
  );
  expect(db.select().from(slackConfig).get()?.state).toBe("blocked");
  expect(fake.state.rotations).toBe(rotations);
  // A pair marked by another save's claim isn't proof either.
  fake.state.keychain.set(
    configItem,
    JSON.stringify({ token: pair.token, refresh_token: pair.refresh, saved: left - 1 }),
  );
  db.update(slackConfig).set({ state: "rotating", fromIat: -1, updatedAt: left }).run();
  expect(await failure(freshConfig(db, fake.setup, { id: owner, team }))).toContain(
    "Save the pair again",
  );
  expect(fake.state.rotations).toBe(rotations);

  // Only the very pair that save meant to write shows it finished, and rotation carries on.
  fake.state.keychain.set(
    configItem,
    JSON.stringify({ token: pair.token, refresh_token: pair.refresh, saved: left }),
  );
  db.update(slackConfig).set({ state: "rotating", fromIat: -1, updatedAt: left }).run();
  expect(await failure(freshConfig(db, fake.setup, { id: owner, team }))).toBeUndefined();
  expect(db.select().from(slackConfig).get()?.state).toBe("idle");
  expect(fake.state.rotations).toBe(rotations + 1);
});

test("a rotation that outlives its claim saves nothing over the owner's pair and gives no token", async () => {
  const pair = { token: "xoxe.xoxp-1-owner", refresh: "xoxe-1-owner" };
  savePair();
  // The rotation stalls past a minute; the owner's save takes the stale claim over meanwhile.
  let takeover: string | undefined = "not run";
  fake.state.onRotate = async () => {
    time += 2 * minute;
    takeover = await saveConfigPair(db, fake.setup, pair.token, pair.refresh);
  };
  const late = await failure(freshConfig(db, fake.setup, { id: owner, team }));
  expect(takeover).toBeUndefined();
  expect(late).toContain("weren't used");
  expect(JSON.parse(fake.state.keychain.get(configItem) ?? "{}")).toEqual({
    token: pair.token,
    refresh_token: pair.refresh,
    saved: expect.any(Number),
  });
  expect(db.select().from(slackConfig).get()).toMatchObject({ state: "idle", fromIat: 0 });
  fake.state.onRotate = async () => {};

  // A save between a rotation's read of the row and of the pair stops the rotation before Slack.
  let raced = false;
  fake.state.onRead = async () => {
    if (raced) return;
    raced = true;
    expect(await saveConfigPair(db, fake.setup, pair.token, pair.refresh)).toBeUndefined();
  };
  const rotations = fake.state.rotations;
  expect(await failure(freshConfig(db, fake.setup, { id: owner, team }))).toContain(
    "another rotation or save started",
  );
  expect(fake.state.rotations).toBe(rotations);
  expect(db.select().from(slackConfig).get()?.state).toBe("idle");
});

test("the notch's config save is refused while a rotation runs, echoing nothing", async () => {
  savePair();
  const before = fake.state.keychain.get(configItem);
  db.insert(slackConfig).values({ id: 1, state: "rotating", fromIat: 0, updatedAt: time }).run();
  const response = await call("/slack/config", {
    method: "POST",
    body: { token: "xoxe.xoxp-1-SECRETBUSY", refreshToken: "xoxe-1-SECRETBUSY" },
  });
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("SECRET");
  expect(fake.state.keychain.get(configItem)).toBe(before);
  expect(db.select().from(slackConfig).get()).toMatchObject({ state: "rotating", updatedAt: time });
});

test("a ratelimited answer in Slack's JSON waits a minute, then the same revision is tried again", async () => {
  created("jojo");
  created("polnareff");
  savePair();
  setAvatarFile("jojo", png(1024, 1));
  setAvatarFile("polnareff", png(1024, 2));
  fake.state.icon = { kind: "error", error: "ratelimited" };
  await pass();
  expect(app("jojo")).toMatchObject({ iconState: "waiting", iconError: "ratelimited" });
  expect(app("jojo").iconRetryAt).toBe(time + minute);
  fake.state.icon = { kind: "ok" };
  time += 30_000;
  await pass();
  expect(fake.state.icons).toHaveLength(1);
  time += 31_000;
  await pass();
  expect(fake.state.icons.map((sent) => sent.appID)).toEqual([appIDs.jojo, appIDs.jojo]);
  expect(app("jojo").iconRevision).toBe(avatarRevision("jojo"));
});

test("nothing but the avatar's revision sets the icon again", async () => {
  created("jojo");
  savePair();
  setAvatarFile("jojo", png(1024, 1));
  await pass();
  expect(fake.state.icons).toHaveLength(1);
  // The dot, its app's other fields, the configuration row and another dot's avatar all change.
  db.update(dots).set({ purpose: "Something else" }).where(eq(dots.name, "jojo")).run();
  db.update(slackApps)
    .set({
      prompts: [{ title: "Hi", message: "Hello" }],
      manifestVersion: 1,
      updateState: "unknown",
      updateNote: "Reinstall",
      botUser: "UBOT2",
      problem: "something",
      state: "created",
    })
    .run();
  setAvatarFile("polnareff", png(1024, 2));
  db.update(slackConfig).set({ noticesSince: time }).run();
  for (let step = 0; step < 3; step++) {
    time += 10 * minute;
    await pass();
  }
  expect(fake.state.icons).toHaveLength(1);
  setAvatarFile("jojo", png(1024, 3));
  await pass();
  expect(fake.state.icons).toHaveLength(2);
});

const call = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  api(
    db,
    "secret",
    fakeOpenCode().layer,
    undefined,
    () => time,
    undefined,
    fake.setup,
  )(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${init.token ?? "secret"}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined
        ? {}
        : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    }),
  );

test("the Slack routes need the token, check every body, save tokens only in their Keychain items and never echo one", async () => {
  const bot = "xoxb-1-SECRETBOT";
  const appToken = "xapp-1-AJOJO01-SECRETAPP";
  const pair = { token: "xoxe.xoxp-1-SECRETACCESS", refreshToken: "xoxe-1-SECRETREFRESH" };
  const texts: string[] = [];
  const send = async (path: string, init: Parameters<typeof call>[1] = {}) => {
    const response = await call(path, init);
    const text = await response.text();
    texts.push(text);
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  };

  // Without the token, nothing is read or saved.
  for (const [path, body] of [
    ["/slack/config", pair],
    ["/dots/jojo/slack/tokens", { kind: "bot", token: bot }],
    ["/dots/jojo/slack/dm-check", {}],
  ] as const)
    expect((await send(path, { method: "POST", body, token: "wrong" })).status).toBe(401);
  expect((await send("/dots/jojo/slack", { token: "wrong" })).status).toBe(401);
  expect(fake.state.keychain.size).toBe(0);

  // No app yet.
  expect((await send("/dots/jojo/slack")).body).toEqual({
    config: { state: "idle", problem: null, saved: false },
    ownerFeed: { items: 0, latestAt: null },
    dmCheck: null,
    login: { state: "unknown", team: null, user: null, problem: null, pending: null },
    manifestLink: expect.stringMatching(
      /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/,
    ),
    app: null,
  });
  expect((await send("/dots/nobody/slack")).status).toBe(404);

  // The configuration pair: checked, saved in its one item, and it ends a blocked rotation.
  db.insert(slackConfig)
    .values({ id: 1, state: "blocked", problem: "save a new pair", updatedAt: 1 })
    .run();
  for (const body of [
    {},
    { token: pair.token },
    { ...pair, extra: true },
    { token: pair.refreshToken, refreshToken: pair.token },
    { token: "xoxe.has space", refreshToken: pair.refreshToken },
    { token: `xoxe.${"a".repeat(2000)}`, refreshToken: pair.refreshToken },
    [pair],
    "not json xoxe.xoxp-1-SECRETACCESS",
  ])
    expect((await send("/slack/config", { method: "POST", body })).status).toBe(400);
  expect((await send("/slack/config", { method: "POST", body: "x".repeat(9000) })).status).toBe(
    413,
  );
  expect((await send("/slack/config", { method: "GET" })).status).toBe(404);
  expect(fake.state.keychain.size).toBe(0);
  expect(await send("/slack/config", { method: "POST", body: pair })).toEqual({
    status: 200,
    body: { saved: true },
  });
  expect(JSON.parse(fake.state.keychain.get(configItem) ?? "{}")).toEqual({
    token: pair.token,
    refresh_token: pair.refreshToken,
    saved: expect.any(Number),
  });
  expect(db.select().from(slackConfig).get()).toMatchObject({ state: "idle", problem: null });

  // Connect only records the request; the daemon creates the app.
  expect(
    (await send("/dots/jojo/slack/connect", { method: "POST", body: { retry: "yes" } })).status,
  ).toBe(400);
  const connected = await send("/dots/jojo/slack/connect", { method: "POST" });
  expect(connected.body).toMatchObject({ app: { state: "requested", appID: null, icon: null } });
  expect(
    (await send("/dots/jojo/slack/attach", { method: "POST", body: { appID: "nope" } })).status,
  ).toBe(400);
  expect(
    (await send("/dots/jojo/slack/attach", { method: "POST", body: { appID: appIDs.jojo } })).body,
  ).toMatchObject({ app: { state: "attaching", appID: appIDs.jojo } });

  // Tokens wait for a created app, and each goes only to its own item.
  expect(
    (await send("/dots/jojo/slack/tokens", { method: "POST", body: { kind: "bot", token: bot } }))
      .status,
  ).toBe(400);
  db.update(slackApps).set({ state: "created", teamID: team, ownerID: owner }).run();
  for (const body of [
    { kind: "bot", token: appToken },
    { kind: "app", token: bot },
    { kind: "user", token: bot },
    { kind: "bot" },
    { kind: "bot", token: bot, also: appToken },
    { kind: "bot", token: "xoxb-" },
  ])
    expect((await send("/dots/jojo/slack/tokens", { method: "POST", body })).status).toBe(400);
  expect(fake.state.keychain.has(botItem("jojo"))).toBe(false);
  // An unconfirmed save says so, and never that nothing was saved: it may have been written.
  for (const mode of ["saveWorks", "saveUnconfirmed"] as const) {
    fake.state.saveWorks = mode !== "saveWorks";
    fake.state.saveUnconfirmed = mode === "saveUnconfirmed";
    const unconfirmed = await send("/dots/jojo/slack/tokens", {
      method: "POST",
      body: { kind: "bot", token: bot },
    });
    expect(unconfirmed.status).toBe(500);
    expect(unconfirmed.body.error).toContain("Couldn't confirm the token was saved");
    expect(unconfirmed.body.error).toContain("may or may not be there");
    expect(unconfirmed.body.error).not.toContain("Nothing was saved");
  }
  expect(fake.state.keychain.get(botItem("jojo"))).toBe(bot);
  fake.state.keychain.delete(botItem("jojo"));
  fake.state.saveWorks = true;
  fake.state.saveUnconfirmed = false;
  for (const [kind, token] of [
    ["bot", bot],
    ["app", appToken],
  ] as const) {
    const saved = await send("/dots/jojo/slack/tokens", { method: "POST", body: { kind, token } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ app: { state: "created", appID: appIDs.jojo } });
  }
  expect(fake.state.keychain.get(botItem("jojo"))).toBe(bot);
  expect(fake.state.keychain.get(appItem("jojo"))).toBe(appToken);
  expect(fake.state.keychain.has(botItem("polnareff"))).toBe(false);

  // No answer, and nothing in the database, ever repeats a token.
  for (const text of texts) expect(text).not.toMatch(/SECRET/);
  expect(
    JSON.stringify([db.select().from(slackApps).all(), db.select().from(slackConfig).all()]),
  ).not.toMatch(/SECRET|xox/);
  expect((await send("/dots/jojo/slack/nothing", { method: "POST" })).status).toBe(404);
  expect((await send("/dots/jojo/slack?x=1")).status).toBe(400);
});

test("the notch's view shows the icon's refusal, and its retry sets the icon again", async () => {
  created("jojo");
  savePair();
  setAvatarFile("jojo", png(1024, 1));
  fake.state.icon = { kind: "error", error: "not_allowed_token_type" };
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    await pass();
  } finally {
    quiet.mockRestore();
  }
  const view = (await (await call("/dots/jojo/slack")).json()) as {
    app: { icon: unknown; manifestOutdated: boolean };
  };
  expect(view.app.icon).toEqual({
    status: "refused",
    error: "not_allowed_token_type",
    retryAt: null,
  });
  expect(view.app.manifestOutdated).toBe(false);
  time += 2 * minute;
  await pass();
  expect(fake.state.icons).toHaveLength(1);

  fake.state.icon = { kind: "ok" };
  const retried = await call("/dots/jojo/slack/icon", { method: "POST" });
  expect(retried.status).toBe(200);
  expect(((await retried.json()) as { app: { icon: unknown } }).app.icon).toMatchObject({
    status: "pending",
  });
  await pass();
  expect(fake.state.icons).toHaveLength(2);
  expect(app().iconRevision).toBe(avatarRevision("jojo"));
  // A retry while Slack's rate limit runs changes nothing.
  db.update(slackApps)
    .set({ iconState: "waiting", iconError: "ratelimited", iconRetryAt: time + minute })
    .run();
  expect((await call("/dots/jojo/slack/icon", { method: "POST" })).status).toBe(409);
});

test("the notch's manifest update shows the changes first and sends only the ones the owner approved", async () => {
  created("jojo");
  db.update(slackApps).set({ manifestVersion: null }).run();
  savePair();
  fake.state.exported.set(appIDs.jojo, {
    display_information: { name: "jojo" },
    features: { bot_user: { display_name: "jojo" } },
    oauth_config: { scopes: { bot: ["chat:write"] } },
    settings: {
      event_subscriptions: { bot_events: ["app_mention", "message.im"] },
      socket_mode_enabled: true,
    },
  });
  const view = (await (await call("/dots/jojo/slack")).json()) as {
    app: { manifestOutdated: boolean };
  };
  expect(view.app.manifestOutdated).toBe(true);
  const update = async (body?: unknown) =>
    (await (await call("/dots/jojo/slack/update", { method: "POST", body })).json()) as {
      said: string;
      confirm?: string[];
    };

  const preview = await update();
  expect(preview.confirm?.length).toBe(2);
  expect(fake.state.updated).toEqual([]);
  // Changes other than the ones shown aren't approved.
  const stale = await update({ approve: ["bot scopes: chat:write"] });
  expect(stale.confirm).toEqual(preview.confirm);
  expect(fake.state.updated).toEqual([]);
  expect(
    (await call("/dots/jojo/slack/update", { method: "POST", body: { approve: "yes" } })).status,
  ).toBe(400);

  const sent = await update({ approve: preview.confirm });
  expect(sent.confirm).toBeUndefined();
  expect(sent.said).toContain("Updated jojo's app");
  expect(fake.state.updated).toHaveLength(1);
  expect(app().manifestVersion).toBe(2);
});

/** One daemon's API, whose in-memory DM checks last across its requests until it's replaced. */
const daemonAPI = () => {
  const handler = api(
    db,
    "secret",
    fakeOpenCode().layer,
    undefined,
    () => time,
    undefined,
    fake.setup,
  );
  return async (path: string, method = "GET", body?: unknown) => {
    const response = await handler(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          authorization: "Bearer secret",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
};

test("issue48: the guided install's status reads only open-dot's database, with the owner's feed apart from the bot", async () => {
  const daemon = daemonAPI();
  const view = async () => (await daemon("/dots/jojo/slack")).body;
  expect(await view()).toMatchObject({
    config: { saved: false },
    ownerFeed: { items: 0, latestAt: null },
    dmCheck: null,
  });
  for (const [source, sourceID, updatedAt] of [
    ["slack", "D1:1", 5_000],
    ["slack", "C1:2", 7_000],
    ["github", "n1", 9_000],
  ] as const)
    db.insert(feed)
      .values({
        source,
        sourceID,
        reason: "Mentioned",
        title: "t",
        context: "c",
        updatedAt,
        state: "unread",
        createdAt: 1,
      })
      .run();
  created("jojo");
  db.update(slackApps).set({ botUser: "UJOJOBOT" }).run();
  const shown = await view();
  expect(shown.ownerFeed).toEqual({ items: 2, latestAt: 7_000 });
  expect(shown.app).toMatchObject({ state: "active", botUser: "UJOJOBOT" });

  // A pair saved through the existing route marks the workspace as set up; a later block keeps it.
  expect(await saveConfigPair(db, fake.setup, "xoxe.xoxp-1-a", "xoxe-1-b")).toBeUndefined();
  expect(((await view()).config as { saved: boolean }).saved).toBe(true);
  db.update(slackConfig).set({ state: "blocked", problem: "save a new pair" }).run();
  expect((await view()).config).toEqual({
    state: "blocked",
    problem: "save a new pair",
    saved: true,
  });
  // A save still in progress isn't counted.
  db.update(slackConfig).set({ state: "rotating", fromIat: -1 }).run();
  expect(((await view()).config as { saved: boolean }).saved).toBe(false);

  // Reading the status asks neither Slack nor the Keychain.
  const reads = fake.state.reads;
  for (let read = 0; read < 3; read++) await view();
  expect(fake.state.fetches).toBe(0);
  expect(fake.state.reads).toBe(reads);
});

test("issue48: a DM check is pending until a reply Slack confirmed to the owner's own later DM, and sends nothing", async () => {
  let daemon = daemonAPI();
  const view = async () => (await daemon("/dots/jojo/slack")).body;
  const start = () => daemon("/dots/jojo/slack/dm-check", "POST");
  let ts = 0;
  const dm = (values: Partial<typeof slackEvents.$inferInsert>) =>
    db
      .insert(slackEvents)
      .values({
        app: appIDs.jojo,
        dot: "jojo",
        kind: "dm",
        channel: "DJOJO",
        ts: `${Math.floor(time / 1000)}.${String(++ts).padStart(6, "0")}`,
        user: owner,
        replyTS: `${ts}.0002`,
        state: "posted",
        createdAt: time,
        ...values,
      })
      .run();

  // Only an active app can be checked.
  expect((await start()).status).toBe(409);
  created("jojo", "created");
  expect((await start()).status).toBe(409);
  db.update(slackApps).set({ state: "active", botID: "BJOJO", botUser: "UJOJOBOT" }).run();
  expect((await daemon("/dots/jojo/slack/dm-check", "POST", { send: true })).status).toBe(400);

  // A reply from before the check started never counts.
  dm({ createdAt: time - 1 });
  const outboxBefore = db.select().from(outbox).all().length;
  const eventsBefore = db.select().from(slackEvents).all().length;
  const started = await start();
  expect(started.status).toBe(200);
  expect(started.body.dmCheck).toEqual({ state: "pending", since: time, dmAt: null });

  // Queued, unknown, unconfirmed, channel, outsider, other-app and other-dot rows don't either.
  time += 1_000;
  for (const state of ["new", "waiting", "posting", "unknown", "failed", "answered"] as const)
    dm({ state });
  dm({ replyTS: null });
  dm({ kind: "mention", channel: "CGENERAL" });
  dm({ kind: "outsider", user: "UOTHER" });
  dm({ user: "UOTHER" });
  dm({ app: appIDs.polnareff });
  dm({ dot: "polnareff" });
  dm({ ts: `${Math.floor((time - 2_000) / 1000)}.000001` });
  dm({ ts: "not-a-timestamp" });
  dm({ ts: null });
  expect((await view()).dmCheck).toEqual({ state: "pending", since: time - 1_000, dmAt: null });

  // The owner's own DM whose reply Slack confirmed.
  dm({ createdAt: time + 5, ts: ((time + 5) / 1000).toFixed(6) });
  expect((await view()).dmCheck).toEqual({
    state: "replied",
    since: time - 1_000,
    dmAt: time + 5,
  });

  // Starting sent nothing, queued nothing and asked nothing of Slack or the Keychain.
  expect(db.select().from(outbox).all().length).toBe(outboxBefore);
  expect(db.select().from(slackEvents).all().length).toBe(eventsBefore + 16);
  expect(fake.state.fetches).toBe(0);
  expect(fake.state.reads).toBe(0);

  // Another app forgets it, and so does a daemon restart.
  db.update(slackApps).set({ appID: "AOTHERAPP" }).run();
  expect((await view()).dmCheck).toBeNull();
  db.update(slackApps).set({ appID: appIDs.jojo }).run();
  expect((await view()).dmCheck).toMatchObject({ state: "replied" });
  daemon = daemonAPI();
  expect((await view()).dmCheck).toBeNull();
});

// Issue 50: a Slack CLI-style login, then one-click create and install per dot.

const userToken = () => fake.state.keychain.set("open-dot-slack-user", "fake-user-token");
const calls = (method: string) => fake.state.calls.filter((one) => one.method === method);
const loginRecord = () => JSON.parse(fake.state.keychain.get(cliItem(team)) ?? "null");
/** A saved login, as a finished one leaves it, expiring `hours` from now. */
const savedLogin = (hours = 12, state = "ready") =>
  fake.state.keychain.set(
    cliItem(team),
    JSON.stringify({
      token: "xoxe.xoxp-1-CLISECRET",
      refresh_token: "xoxe-1-CLIREFRESH",
      team_id: team,
      user_id: owner,
      exp: Math.floor(time / 1000) + hours * 3600,
      state,
    }),
  );
/** Queues the dot's install, as Retry install does, and runs one setup pass. */
const install = () => {
  db.update(slackApps).set({ attemptID: "install:queued::r" }).run();
  return pass();
};
/** Logs in through the daemon's routes, with the challenge code Slack showed. */
const logIn = async (daemon: ReturnType<typeof daemonAPI>, challenge = "CHALLENGE42") => {
  const started = await daemon("/slack/login", "POST", {});
  expect(started.status).toBe(200);
  return daemon(`/slack/login/${String(started.body.attempt)}`, "POST", { challenge });
};

test("issue50: the login asks for a ticket, exchanges it once with the challenge, and keeps the tokens only in the Keychain", async () => {
  const daemon = daemonAPI();
  // The login must be the owner's, so it needs open-dot-slack-user first, and asks Slack nothing.
  expect((await daemon("/slack/login", "POST", {})).status).toBe(409);
  expect(calls("apps.hosted.generateAuthTicket")).toEqual([]);
  userToken();

  const started = await daemon("/slack/login", "POST", {});
  expect(started.body).toEqual({
    attempt: expect.any(String),
    command: "/slackauthticket TICKET0123456789",
    expiresAt: time + ticketLife,
  });
  // Rotating credentials, as `slack login` asks: major.minor, and no no_rotation.
  expect(
    Object.fromEntries(new URLSearchParams(calls("apps.hosted.generateAuthTicket")[0]?.body)),
  ).toEqual({
    slack_cli_version: "v4.11",
  });
  expect((await daemon("/slack/login")).body.login).toMatchObject({
    state: "unknown",
    pending: { attempt: started.body.attempt, expiresAt: time + ticketLife },
  });

  for (const body of [
    {},
    { challenge: "" },
    { challenge: "has space" },
    { challenge: "x", more: 1 },
  ])
    expect(
      (await daemon(`/slack/login/${String(started.body.attempt)}`, "POST", body)).status,
    ).toBe(400);
  expect((await daemon("/slack/login/not-the-attempt", "POST", { challenge: "C1" })).status).toBe(
    409,
  );
  const finished = await daemon(`/slack/login/${String(started.body.attempt)}`, "POST", {
    challenge: " CHALLENGE42 ",
  });
  expect(finished).toEqual({
    status: 200,
    body: { login: { state: "ready", team, user: owner, problem: null, pending: null } },
  });
  expect(
    Object.fromEntries(new URLSearchParams(calls("apps.hosted.exchangeAuthTicket")[0]?.body)),
  ).toEqual({
    ticket: "TICKET0123456789",
    challenge: "CHALLENGE42",
    slack_cli_version: "v4.11.0",
  });
  expect(loginRecord()).toEqual({
    token: "xoxe.xoxp-1-CLISECRET",
    refresh_token: "xoxe-1-CLIREFRESH",
    team_id: team,
    user_id: owner,
    exp: Math.floor(time / 1000) + 43_200,
    state: "ready",
  });

  // A login is used once: a replay is refused without asking Slack again.
  const replay = await daemon(`/slack/login/${String(started.body.attempt)}`, "POST", {
    challenge: "CHALLENGE42",
  });
  expect(replay.status).toBe(409);
  expect(calls("apps.hosted.exchangeAuthTicket").length).toBe(1);

  // An expired login is refused, also without asking Slack.
  const late = await daemon("/slack/login", "POST", {});
  time += ticketLife;
  expect(
    (await daemon(`/slack/login/${String(late.body.attempt)}`, "POST", { challenge: "C1" })).status,
  ).toBe(409);
  expect(calls("apps.hosted.exchangeAuthTicket").length).toBe(1);

  // Nothing the daemon answered, saved in the database or logged repeats a token or the challenge.
  const shown = JSON.stringify([started, finished, replay, await daemon("/dots/jojo/slack")]);
  expect(shown).not.toMatch(/CLISECRET|CLIREFRESH|CHALLENGE42/);
  expect(JSON.stringify(db.select().from(slackApps).all())).not.toMatch(/xox/);
  expect(await daemon("/slack/login", "DELETE")).toMatchObject({ status: 404 });
  expect((await call("/slack/login", { method: "POST", body: {}, token: "wrong" })).status).toBe(
    401,
  );
});

test("issue50: a login that isn't the owner's, is org-wide, or isn't complete saves nothing", async () => {
  userToken();
  const daemon = daemonAPI();
  const good = {
    ok: true,
    token: "xoxe.xoxp-1-CLISECRET",
    refresh_token: "xoxe-1-CLIREFRESH",
    team_id: team,
    user_id: owner,
    exp: Math.floor(time / 1000) + 43_200,
    is_ready: true,
  };
  for (const [answer, status] of [
    [{ ...good, user_id: "UOTHER" }, 409],
    [{ ...good, team_id: "T2" }, 409],
    [{ ...good, team_id: "E1", is_enterprise_install: true }, 409],
    [{ ...good, is_ready: false }, 502],
    [{ ...good, refresh_token: undefined }, 502],
    [{ ...good, token: "xoxp-1-legacy" }, 502],
    [{ ...good, exp: 1 }, 502],
    [{ ok: false, error: "invalid_challenge" }, 502],
    ["lost", 502],
  ] as const) {
    fake.state.answers.set("apps.hosted.exchangeAuthTicket", answer);
    const refused = await logIn(daemon);
    expect([refused.status, answer]).toEqual([status, answer]);
    expect(JSON.stringify(refused.body)).not.toMatch(/CLISECRET|CLIREFRESH/);
  }
  expect(fake.state.keychain.has(cliItem(team))).toBe(false);
  expect(fake.state.keychain.has(cliItem("T2"))).toBe(false);
  // An unconfirmed save asks for another login.
  fake.state.answers.delete("apps.hosted.exchangeAuthTicket");
  fake.state.saveFails.add(cliItem(team));
  expect((await logIn(daemon)).status).toBe(500);
  expect(((await daemon("/slack/login")).body.login as { state: string }).state).toBe("relogin");
});

test("issue50: Install creates the app with the login under the dot's own name, then installs it with its bot scopes and saves both tokens", async () => {
  userToken();
  const daemon = daemonAPI();
  expect((await logIn(daemon)).status).toBe(200);
  await daemon("/dots/jojo/slack/connect", "POST", {});
  await pass();

  const [creation] = calls("apps.manifest.create");
  expect(creation?.authorization).toBe("Bearer xoxe.xoxp-1-CLISECRET");
  expect(creation?.type).toBe("application/json; charset=utf-8");
  const sent = JSON.parse(creation?.body ?? "{}");
  expect(sent).toEqual({ manifest: dotManifest("jojo", null) });
  expect(sent.manifest.display_information.name).toBe("jojo");
  expect(sent.manifest.settings.socket_mode_enabled).toBe(true);

  const installs = calls("apps.developerInstall");
  expect(installs.map((one) => [one.authorization, JSON.parse(one.body)])).toEqual([
    ["Bearer xoxe.xoxp-1-CLISECRET", { app_id: appIDs.jojo, bot_scopes: botScopes }],
  ]);
  expect(fake.state.keychain.get(botItem("jojo"))).toBe("xoxb-1-INSTALLEDBOT");
  expect(fake.state.keychain.get(appItem("jojo"))).toBe(`xapp-1-${appIDs.jojo}-1-INSTALLEDAPP`);
  // The user token Slack also issues is never kept, and the configuration pair is never read.
  expect([...fake.state.keychain.values()].join()).not.toContain("USERSECRET");
  expect(calls("tooling.tokens.rotate")).toEqual([]);

  // Saved isn't connected: only the tokens' own checks and hello make it active.
  expect(app()).toMatchObject({
    state: "created",
    appID: appIDs.jojo,
    teamID: team,
    ownerID: owner,
    botID: null,
    problem: null,
  });
  expect(installOf(app())).toEqual({ phase: "saved", code: null });
  const view = (await daemon("/dots/jojo/slack")).body;
  expect(view.app).toMatchObject({ state: "created", install: { phase: "saved", code: null } });
  expect(JSON.stringify(view)).not.toMatch(/INSTALLED|CLISECRET/);

  // Later passes create and install nothing more.
  for (let step = 0; step < 3; step++) {
    time += minute;
    await pass();
  }
  expect(calls("apps.manifest.create").length).toBe(1);
  expect(calls("apps.developerInstall").length).toBe(1);
});

test("issue50: admin approval, a refusal, a lost answer or unusable tokens wait for the owner's Retry install, on the same app", async () => {
  userToken();
  savedLogin();
  created("jojo", "created");
  const daemon = daemonAPI();
  const retry = () => daemon("/dots/jojo/slack/install", "POST", {});
  const outcomes = [
    [
      { ok: false, error: "app_approval_request_eligible" },
      "approval",
      "app_approval_request_eligible",
    ],
    [
      { ok: false, error: "app_approval_request_pending" },
      "approval",
      "app_approval_request_pending",
    ],
    [
      { ok: false, error: "app_approval_request_denied" },
      "approval",
      "app_approval_request_denied",
    ],
    [{ ok: false, error: "invalid_scopes <b>" }, "failed", "slack_error"],
    [{ ok: false, error: "internal_error" }, "failed", unknownOutcome],
    ["lost", "failed", unknownOutcome],
    [
      {
        ok: true,
        app_id: appIDs.jojo,
        api_access_tokens: { bot: "xoxb-1-B", app_level: "xapp-1-AOTHER01-1-X" },
      },
      "failed",
      "bad_answer",
    ],
  ] as const;
  for (const [answer, phase, code] of outcomes) {
    expect((await retry()).status).toBe(200);
    fake.state.answers.set("apps.developerInstall", answer);
    await pass();
    expect([installOf(app()), answer]).toEqual([{ phase, code }, answer]);
    // Never sent again on its own.
    time += minute;
    await pass();
  }
  expect(calls("apps.developerInstall").length).toBe(outcomes.length);
  expect(calls("apps.manifest.create")).toEqual([]);
  expect(fake.state.keychain.has(botItem("jojo"))).toBe(false);
  expect(app()).toMatchObject({ state: "created", appID: appIDs.jojo });

  // Approval doesn't pretend a request was sent, and says how to ask.
  fake.state.answers.set("apps.developerInstall", {
    ok: false,
    error: "app_approval_request_eligible",
  });
  await retry();
  await pass();
  expect(app().problem).toContain("Waiting for admin approval");
  expect(app().problem).toContain("hasn't asked");

  // A save that isn't confirmed says so; the retry then saves both.
  fake.state.answers.delete("apps.developerInstall");
  fake.state.saveFails.add(appItem("jojo"));
  await retry();
  await pass();
  expect(installOf(app())).toEqual({ phase: "failed", code: "save_failed" });
  fake.state.saveFails.clear();
  await retry();
  await pass();
  expect(installOf(app())).toEqual({ phase: "saved", code: null });

  // One a stopped daemon left sending is failed a minute later, unsent.
  await retry();
  db.update(slackApps).set({ attemptID: "install:sending::x", updatedAt: 0 }).run();
  const before = calls("apps.developerInstall").length;
  await pass();
  expect(installOf(app())).toEqual({ phase: "failed", code: unknownOutcome });
  expect(calls("apps.developerInstall").length).toBe(before);
  // Retry install is only for a created app, and not while one is sending.
  db.update(slackApps).set({ attemptID: "install:sending::y" }).run();
  expect((await retry()).status).toBe(409);
  db.update(slackApps).set({ state: "active" }).run();
  expect((await retry()).status).toBe(409);
});

test("issue50: the login is refreshed near its expiry with the intent saved first; a lost or wrong refresh needs a new login", async () => {
  userToken();
  created("jojo", "created");

  // Refreshed once its expiry is near, with "rotating" in the Keychain while Slack is asked.
  savedLogin(0.05);
  let during: unknown;
  fake.state.onRotate = async () => {
    during = loginRecord()?.state;
  };
  await install();
  expect(during).toBe("rotating");
  expect(Object.fromEntries(new URLSearchParams(calls("tooling.tokens.rotate")[0]?.body))).toEqual({
    refresh_token: "xoxe-1-CLIREFRESH",
  });
  expect(loginRecord()).toMatchObject({
    token: "xoxe.xoxp-1-t1",
    refresh_token: "xoxe-1-r1",
    state: "ready",
  });
  expect(calls("apps.developerInstall")[0]?.authorization).toBe("Bearer xoxe.xoxp-1-t1");

  // Rate limited: Slack refused, so the same refresh token stays, and nothing is installed.
  savedLogin(0.05);
  fake.state.rotateAnswer = { ok: false, error: "ratelimited" };
  await install();
  expect(loginRecord()).toMatchObject({ refresh_token: "xoxe-1-CLIREFRESH", state: "ready" });

  // Lost, refused, another user's, or unsaved: the next use asks for a login, never the old token.
  for (const [rotate, fails] of [
    [{ ok: false, error: "internal_error" }, undefined],
    [{ ok: false, error: "invalid_refresh_token" }, undefined],
    [
      {
        ok: true,
        token: "xoxe.xoxp-1-x",
        refresh_token: "xoxe-1-x",
        team_id: team,
        user_id: "UOTHER",
        iat: 1,
        exp: 2,
      },
      undefined,
    ],
    [undefined, cliItem(team)],
  ] as const) {
    savedLogin(0.05);
    fake.state.rotateAnswer = rotate;
    if (fails) fake.state.onRotate = async () => void fake.state.saveFails.add(fails);
    const rotations = fake.state.rotations;
    const installs = calls("apps.developerInstall").length;
    await install();
    // The intent stays, so the refresh token Slack may have used up is never sent again.
    expect(loginRecord()).toMatchObject({ refresh_token: "xoxe-1-CLIREFRESH", state: "rotating" });
    await install();
    expect([fake.state.rotations - rotations, rotate]).toEqual([1, rotate]);
    expect(calls("apps.developerInstall").length).toBe(installs);
    expect(app().problem).toContain("Log in again");
    expect(((await daemonAPI()("/slack/login")).body.login as { state: string }).state).toBe(
      "relogin",
    );
    fake.state.saveFails.clear();
    fake.state.onRotate = async () => {};
  }

  // A new login replaces it.
  fake.state.rotateAnswer = undefined;
  expect((await logIn(daemonAPI())).status).toBe(200);
  const installs = calls("apps.developerInstall").length;
  await install();
  expect(calls("apps.developerInstall").length).toBe(installs + 1);
});

test("issue50: without a login or configuration token, the prefilled link and the app's own tokens bind it, checked with Slack", async () => {
  userToken();
  const daemon = daemonAPI();
  await daemon("/dots/jojo/slack/connect", "POST", {});
  await pass();
  expect(app()).toMatchObject({ state: "requested" });
  expect(app().problem).toContain("prefilled link");
  expect(calls("apps.manifest.create")).toEqual([]);

  const view = (await daemon("/dots/jojo/slack")).body;
  const link = new URL(String(view.manifestLink));
  expect([link.origin, link.pathname, link.searchParams.get("new_app")]).toEqual([
    "https://api.slack.com",
    "/apps",
    "1",
  ]);
  expect(JSON.parse(link.searchParams.get("manifest_json") ?? "")).toEqual(
    dotManifest("jojo", null),
  );

  const bot = "xoxb-1-PASTEDBOT";
  const level = `xapp-1-${appIDs.jojo}-1-PASTEDAPP`;
  const texts: string[] = [];
  const linkWith = async (body: unknown) => {
    const answer = await daemon("/dots/jojo/slack/link", "POST", body);
    texts.push(JSON.stringify(answer));
    return answer;
  };
  for (const body of [
    { bot },
    { bot, app: level, replace: true },
    { bot, app: level, replaceAppID: "nope" },
    { bot: level, app: bot },
    { bot, app: "xapp-1-nope" },
  ])
    expect((await linkWith(body)).status).toBe(400);
  // Slack must say the bot is in the owner's workspace and belongs to the app the token names.
  fake.state.answers.set("bots.info", { ok: true, bot: { app_id: "AOTHER01", user_id: "UBOT" } });
  expect((await linkWith({ bot, app: level })).status).toBe(409);
  fake.state.answers.delete("bots.info");
  fake.state.botTeam = "T2";
  expect((await linkWith({ bot, app: level })).status).toBe(409);
  fake.state.botTeam = team;
  fake.state.answers.set("bots.info", "lost");
  expect((await linkWith({ bot, app: level })).status).toBe(502);
  fake.state.answers.delete("bots.info");
  expect(fake.state.keychain.has(botItem("jojo"))).toBe(false);

  const linked = await linkWith({ bot, app: level });
  expect(linked.status).toBe(200);
  expect(linked.body.app).toMatchObject({ state: "created", appID: appIDs.jojo });
  expect(app()).toMatchObject({ teamID: team, ownerID: owner, botID: null, manifestVersion: 2 });
  expect(fake.state.keychain.get(botItem("jojo"))).toBe(bot);
  expect(fake.state.keychain.get(appItem("jojo"))).toBe(level);
  // The app's own pickup for the same app keeps working.
  expect(
    (await daemon("/dots/jojo/slack/tokens", "POST", { kind: "bot", token: bot })).status,
  ).toBe(200);

  // Another app replaces this one only with the owner's confirmation, forgetting its bot.
  db.update(slackApps).set({ state: "active", botID: "BBOT", botUser: "UBOT" }).run();
  fake.state.answers.set("bots.info", { ok: true, bot: { app_id: "ANEWAPP01", user_id: "UBOT" } });
  const other = "xapp-1-ANEWAPP01-1-PASTEDAPP";
  expect((await linkWith({ bot, app: other })).status).toBe(409);
  expect(app()).toMatchObject({ state: "active", appID: appIDs.jojo });
  expect((await linkWith({ bot, app: other, replace: true })).status).toBe(400);
  expect((await linkWith({ bot, app: other, replaceAppID: "AOTHER01" })).status).toBe(409);
  expect((await linkWith({ bot, app: other, replaceAppID: appIDs.jojo })).status).toBe(200);
  expect(app()).toMatchObject({ state: "created", appID: "ANEWAPP01", botID: null, botUser: null });
  expect(fake.state.keychain.get(appItem("jojo"))).toBe(other);
  // An app already another dot's is never taken.
  db.insert(slackApps)
    .values({ dot: "polnareff", state: "created", appID: "AOWNED01", createdAt: 0, updatedAt: 0 })
    .run();
  fake.state.answers.set("bots.info", { ok: true, bot: { app_id: "AOWNED01", user_id: "UBOT" } });
  expect(
    (await linkWith({ bot, app: "xapp-1-AOWNED01-1-X", replaceAppID: "ANEWAPP01" })).status,
  ).toBe(409);

  for (const text of texts) expect(text).not.toMatch(/PASTED/);
  expect(JSON.stringify(db.select().from(slackApps).all())).not.toMatch(/xox|xapp/);
});

test("issue50: attach checks a named app with the login, then installs that same app", async () => {
  userToken();
  savedLogin();
  fake.state.exported.set(appIDs.jojo, {
    features: { bot_user: { display_name: "jojo" } },
    settings: { socket_mode_enabled: true },
  });
  const daemon = daemonAPI();
  await daemon("/dots/jojo/slack/attach", "POST", { appID: appIDs.jojo });
  await pass();
  expect(
    calls("apps.manifest.export").map((one) => [one.authorization, JSON.parse(one.body)]),
  ).toEqual([["Bearer xoxe.xoxp-1-CLISECRET", { app_id: appIDs.jojo }]]);
  expect(app()).toMatchObject({ state: "created", appID: appIDs.jojo });
  await pass();
  expect(calls("apps.developerInstall").length).toBe(1);
  expect(calls("apps.manifest.create")).toEqual([]);
  expect(installOf(app())?.phase).toBe("saved");
});

test("issue50: a malformed saved login is never used, an expired one is refreshed, and a refresh already expired stays unused", async () => {
  userToken();
  created("jojo", "created");
  const record = {
    token: "xoxe.xoxp-1-CLISECRET",
    refresh_token: "xoxe-1-CLIREFRESH",
    team_id: team,
    user_id: owner,
    exp: Math.floor(time / 1000) + 43_200,
    state: "ready",
  };
  // Not refreshed while more than five minutes are left, as the Slack CLI does.
  savedLogin(301 / 3600);
  await install();
  expect(fake.state.rotations).toBe(0);
  expect(calls("apps.developerInstall").length).toBe(1);

  for (const bad of [
    { token: "xoxp-1-legacy" },
    { token: "" },
    { refresh_token: "nope" },
    { refresh_token: `xoxe-${"a".repeat(2000)}` },
    { exp: -1 },
    { exp: 0 },
    { exp: 1e20 },
    { exp: null },
  ]) {
    fake.state.keychain.set(cliItem(team), JSON.stringify({ ...record, ...bad }));
    await install();
    expect([app().problem, bad]).toEqual([expect.stringContaining("Log in again"), bad]);
  }
  expect(fake.state.rotations).toBe(0);
  expect(calls("apps.developerInstall").length).toBe(1);

  // Long expired but well formed: its refresh token renews it.
  fake.state.keychain.set(cliItem(team), JSON.stringify({ ...record, exp: 1 }));
  await install();
  expect(fake.state.rotations).toBe(1);
  expect(loginRecord()).toMatchObject({ token: "xoxe.xoxp-1-t1", state: "ready" });
  expect(calls("apps.developerInstall").length).toBe(2);

  // A refresh whose own expiry has passed, or isn't a sane time, is never saved or used.
  for (const exp of [Math.floor(time / 1000) - 1, 1e20]) {
    savedLogin(0.05);
    fake.state.rotateAnswer = {
      ok: true,
      token: "xoxe.xoxp-1-stale",
      refresh_token: "xoxe-1-stale",
      team_id: team,
      user_id: owner,
      iat: 1,
      exp,
    };
    await install();
    expect(loginRecord()).toMatchObject({ refresh_token: "xoxe-1-CLIREFRESH", state: "rotating" });
    expect(calls("apps.developerInstall").length).toBe(2);
  }
});

test("issue50: two dots linking the same app at once bind it to one", async () => {
  userToken();
  const daemon = daemonAPI();
  const body = { bot: "xoxb-1-PASTEDBOT", app: `xapp-1-${appIDs.jojo}-1-PASTEDAPP` };
  // Both read no owner of the app before either reaches Slack.
  const answers = await Promise.all([
    daemon("/dots/jojo/slack/link", "POST", body),
    daemon("/dots/polnareff/slack/link", "POST", body),
  ]);
  expect(answers.map((answer) => answer.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
  const bound = db
    .select()
    .from(slackApps)
    .all()
    .filter((row) => row.appID === appIDs.jojo);
  expect(bound.length).toBe(1);
  const loser = bound[0]?.dot === "jojo" ? "polnareff" : "jojo";
  expect(fake.state.keychain.has(botItem(loser))).toBe(false);
  expect(fake.state.keychain.has(appItem(loser))).toBe(false);
});

test("issue50: a token saved while the app is replaced, or while it installs, writes nothing", async () => {
  created("jojo", "created");
  // A login refresh holds the daemon's Keychain queue while the token's save waits its turn.
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  fake.state.onRead = () => held;
  const blocker = cliLogin(fake.setup)
    .token({ id: owner, team })
    .catch(() => undefined);
  const stale = saveAppToken(db, fake.setup, "jojo", "bot", "xoxb-1-OLDAPPBOT");
  // The link binds another app before the queued save runs.
  db.update(slackApps).set({ appID: "ANEWAPP01", attemptID: "linked" }).run();
  release();
  await blocker;
  fake.state.onRead = async () => {};
  expect(await stale).toContain("changed meanwhile");
  expect(fake.state.keychain.has(botItem("jojo"))).toBe(false);

  db.update(slackApps).set({ attemptID: "install:sending::x" }).run();
  expect(await saveAppToken(db, fake.setup, "jojo", "bot", "xoxb-1-OLDAPPBOT")).toContain(
    "installing",
  );
  const refused = await daemonAPI()("/dots/jojo/slack/tokens", "POST", {
    kind: "app",
    token: "xapp-1-ANEWAPP01-1-X",
  });
  expect(refused.status).toBe(409);
  expect(fake.state.keychain.size).toBe(0);
});

test("issue50: the app and its install intent are saved before developerInstall leaves, and a lost one is retried only on the same app", async () => {
  userToken();
  savedLogin();
  const seen: unknown[] = [];
  fake.state.onCall = async (method) => {
    if (method === "apps.manifest.create" || method === "apps.developerInstall")
      seen.push({ method, ...app(), install: installOf(app()) });
  };
  // A lost create: its intent was saved first, it turns unknown and is never sent again.
  fake.state.answers.set("apps.manifest.create", "lost");
  await call("/dots/jojo/slack/connect", { method: "POST" });
  await pass();
  expect(seen).toEqual([
    expect.objectContaining({ method: "apps.manifest.create", state: "creating", appID: null }),
  ]);
  expect(calls("apps.manifest.create")[0]?.authorization).toBe("Bearer xoxe.xoxp-1-CLISECRET");
  expect(app()).toMatchObject({ state: "unknown", appID: null });
  for (let step = 0; step < 3; step++) {
    time += 2 * minute;
    await pass();
  }
  expect(calls("apps.manifest.create").length).toBe(1);
  expect(calls("apps.developerInstall")).toEqual([]);

  // The owner says there's none; this create works, and its install is lost.
  fake.state.answers.delete("apps.manifest.create");
  fake.state.answers.set("apps.developerInstall", "lost");
  await call("/dots/jojo/slack/connect", { method: "POST", body: { retry: true } });
  seen.length = 0;
  await pass();
  expect(seen).toEqual([
    expect.objectContaining({ method: "apps.manifest.create", state: "creating" }),
    expect.objectContaining({
      method: "apps.developerInstall",
      state: "created",
      appID: appIDs.jojo,
      install: { phase: "sending", code: null },
    }),
  ]);
  expect(installOf(app())).toEqual({ phase: "failed", code: unknownOutcome });

  // A restarted daemon, with a fresh login state, creates and installs nothing on its own.
  const restarted: Setup = { ...fake.setup };
  for (let step = 0; step < 3; step++) {
    time += 2 * minute;
    await provision(db, shared, restarted);
  }
  expect(calls("apps.manifest.create").length).toBe(2);
  expect(calls("apps.developerInstall").length).toBe(1);

  // Retry install sends the same app's ID, and creates nothing.
  fake.state.answers.delete("apps.developerInstall");
  const retried = await api(
    db,
    "secret",
    fakeOpenCode().layer,
    undefined,
    () => time,
    undefined,
    restarted,
  )(
    new Request("http://127.0.0.1/dots/jojo/slack/install", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    }),
  );
  expect(retried.status).toBe(200);
  await provision(db, shared, restarted);
  expect(calls("apps.developerInstall").map((one) => JSON.parse(one.body).app_id)).toEqual([
    appIDs.jojo,
    appIDs.jojo,
  ]);
  expect(calls("apps.manifest.create").length).toBe(2);
  expect(app()).toMatchObject({ state: "created", appID: appIDs.jojo });
  expect(installOf(app())?.phase).toBe("saved");
});

/** A request to the daemon's API with exactly these headers and body. */
const raw = (
  path: string,
  init: { method?: string; body?: string | undefined; auth?: string | undefined } = {},
) =>
  api(
    db,
    "secret",
    fakeOpenCode().layer,
    undefined,
    () => time,
    undefined,
    fake.setup,
  )(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? "POST",
      headers: init.auth === undefined ? {} : { authorization: init.auth },
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
  );
/** What a refused request must leave unchanged: Slack, the Keychain and the apps. */
const quiet = () => [
  fake.state.fetches,
  fake.state.reads,
  fake.state.keychain.size,
  JSON.stringify(db.select().from(slackApps).all()),
];

test("issue50: the login, install and link routes need the token and take only their exact bodies", async () => {
  userToken();
  created("jojo", "created");
  const routes = [
    ["GET", "/slack/login"],
    ["POST", "/slack/login"],
    ["POST", "/slack/login/attempt"],
    ["POST", "/dots/jojo/slack/install"],
    ["POST", "/dots/jojo/slack/link"],
  ] as const;
  const before = quiet();
  for (const [method, path] of routes)
    for (const auth of [
      undefined,
      "",
      "Bearer",
      "Bearer wrong",
      "bearer secret",
      "Basic secret",
      "Bearer secretx",
    ])
      expect([
        method,
        path,
        auth,
        (await raw(path, { method, auth, body: method === "GET" ? undefined : "{}" })).status,
      ]).toEqual([method, path, auth, 401]);

  const secret = "xoxb-1-BOUNDARYSECRET";
  const bodies = [
    ["/slack/login", '{"x":1}', 400],
    ["/slack/login", "[]", 400],
    ["/slack/login", '"x"', 400],
    ["/slack/login", "{", 400],
    ["/slack/login", `{"pad":"${"a".repeat(9000)}"}`, 413],
    ["/slack/login/attempt", "{}", 400],
    ["/slack/login/attempt", '{"challenge":12}', 400],
    ["/slack/login/attempt", `{"challenge":"${"c".repeat(129)}"}`, 400],
    ["/slack/login/attempt", '{"challenge":"a b"}', 400],
    ["/slack/login/attempt", '{"challenge":"C1","extra":true}', 400],
    ["/slack/login/attempt", `{"challenge":"${"c".repeat(9000)}"}`, 413],
    ["/dots/jojo/slack/install", '{"x":1}', 400],
    ["/dots/jojo/slack/install", "[1]", 400],
    ["/dots/jojo/slack/link", `{"bot":"${secret}"}`, 400],
    ["/dots/jojo/slack/link", `{"bot":"${secret}","app":"xapp-1-AJOJO01-1-X","also":1}`, 400],
    ["/dots/jojo/slack/link", `{"bot":"${secret}","app":"xapp-1-AJOJO01-1-X","replace":true}`, 400],
    [
      "/dots/jojo/slack/link",
      `{"bot":"${secret}","app":"xapp-1-AJOJO01-1-X","replaceAppID":true}`,
      400,
    ],
    [
      "/dots/jojo/slack/link",
      `{"bot":"${secret}","app":"xapp-1-AJOJO01-1-X","replaceAppID":"a1"}`,
      400,
    ],
    ["/dots/jojo/slack/link", `{"bot":"${secret}","app":"xapp-nope"}`, 400],
    ["/dots/jojo/slack/link", `{"bot":"${secret}","app":"${"x".repeat(9000)}"}`, 413],
    ["/dots/jojo/slack/link", "{", 400],
  ] as const;
  for (const [path, body, status] of bodies) {
    const answer = await raw(path, { auth: "Bearer secret", body });
    const text = await answer.text();
    expect([path, body.slice(0, 40), answer.status]).toEqual([path, body.slice(0, 40), status]);
    expect(text).not.toContain("BOUNDARYSECRET");
  }
  for (const [method, path, status] of [
    ["POST", "/slack/login?x=1", 400],
    ["POST", "/dots/jojo/slack/install?x=1", 400],
    ["PUT", "/slack/login", 404],
    ["DELETE", "/slack/login", 404],
    ["GET", "/slack/login/attempt", 404],
    ["POST", "/slack/login/a/b", 404],
    ["GET", "/dots/jojo/slack/install", 404],
    ["GET", "/dots/jojo/slack/link", 404],
    ["POST", "/dots/jojo/slack/install/x", 404],
    ["POST", "/dots/nobody/slack/install", 404],
  ] as const)
    expect([
      method,
      path,
      (
        await raw(path, {
          method,
          auth: "Bearer secret",
          body: method === "GET" ? undefined : "{}",
        })
      ).status,
    ]).toEqual([method, path, status]);
  // Nothing above asked Slack or the Keychain, or changed an app.
  expect(quiet()).toEqual(before);

  // The bounds themselves pass: a 128-character challenge reaches Slack, once, for a live login.
  const started = await raw("/slack/login", { auth: "Bearer secret" });
  expect(started.status).toBe(200);
  const { attempt } = (await started.json()) as { attempt: string };
  const challenge = "c".repeat(128);
  expect(
    (
      await raw(`/slack/login/${attempt}`, {
        auth: "Bearer secret",
        body: JSON.stringify({ challenge }),
      })
    ).status,
  ).toBe(200);
  expect(
    new URLSearchParams(calls("apps.hosted.exchangeAuthTicket")[0]?.body).get("challenge"),
  ).toBe(challenge);
  expect((await raw("/dots/jojo/slack/install", { auth: "Bearer secret" })).status).toBe(200);
});

test("issue50: concurrent uses of the login refresh it once, a login finished meanwhile isn't overwritten, and a thrown refresh needs a new login", async () => {
  userToken();
  savedLogin(0.05);
  const login = cliLogin(fake.setup);
  const started = await login.start();
  if ("problem" in started) throw new Error(started.problem);
  const { promise: rotating, resolve: release } = Promise.withResolvers<void>();
  fake.state.onRotate = () => rotating;
  const first = login.token({ id: owner, team });
  const second = login.token({ id: owner, team });
  const finished = login.finish(started.attempt, "CHALLENGE42", { id: owner, team });
  await Bun.sleep(5);
  // One refresh is in flight, and nothing else has reached Slack or the Keychain item.
  expect(fake.state.rotations).toBe(1);
  expect(loginRecord()).toMatchObject({ refresh_token: "xoxe-1-CLIREFRESH", state: "rotating" });
  expect(calls("apps.hosted.exchangeAuthTicket")).toEqual([]);
  release();
  expect(await first).toBe("xoxe.xoxp-1-t1");
  expect(await second).toBe("xoxe.xoxp-1-t1");
  expect(await finished).toBeUndefined();
  expect(fake.state.rotations).toBe(1);
  // The refreshed pair was used by both, then the finished login replaced it, in that order.
  const order = fake.state.calls
    .map((one) => one.method)
    .filter((method) => method !== "auth.test");
  expect(order.slice(-2)).toEqual(["tooling.tokens.rotate", "apps.hosted.exchangeAuthTicket"]);
  expect(loginRecord()).toMatchObject({
    token: "xoxe.xoxp-1-CLISECRET",
    refresh_token: "xoxe-1-CLIREFRESH",
    state: "ready",
  });
  fake.state.onRotate = async () => {};

  // A refresh whose connection drops leaves the intent, so no refresh token is ever sent twice.
  savedLogin(0.05);
  fake.state.answers.set("tooling.tokens.rotate", "lost");
  created("jojo", "created");
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await failure(login.token({ id: owner, team }))).toContain("Log in again");
    await install();
  }
  expect(calls("tooling.tokens.rotate").length).toBe(2);
  expect(loginRecord()).toMatchObject({ refresh_token: "xoxe-1-CLIREFRESH", state: "rotating" });
  expect(login.view().state).toBe("relogin");
  expect(calls("apps.developerInstall")).toEqual([]);
});

test("issue50: a replacement the owner confirmed for one app is refused once another is bound, before any call or write", async () => {
  userToken();
  // The notch showed AJOJO01 and the owner confirmed replacing it; meanwhile AMIDDLE01 was bound.
  created("jojo", "active");
  db.update(slackApps).set({ appID: "AMIDDLE01", botID: "BMID", botUser: "UMID" }).run();
  fake.state.answers.set("bots.info", { ok: true, bot: { app_id: "ANEWAPP01", user_id: "UBOT" } });
  const body = { bot: "xoxb-1-PASTEDBOT", app: "xapp-1-ANEWAPP01-1-PASTEDAPP" };
  const daemon = daemonAPI();
  const before = quiet();
  for (const [stale, status] of [
    [{ ...body, replaceAppID: appIDs.jojo }, 409],
    // The boolean of the earlier contract is no confirmation at all.
    [{ ...body, replace: true }, 400],
    [{ ...body }, 409],
  ] as const) {
    const refused = await daemon("/dots/jojo/slack/link", "POST", stale);
    expect([refused.status, stale]).toEqual([status, stale]);
    expect(JSON.stringify(refused.body)).not.toContain("PASTED");
  }
  expect(quiet()).toEqual(before);
  expect(app()).toMatchObject({ state: "active", appID: "AMIDDLE01", botID: "BMID" });

  // Confirming the app bound now replaces it.
  const replaced = await daemon("/dots/jojo/slack/link", "POST", {
    ...body,
    replaceAppID: "AMIDDLE01",
  });
  expect(replaced.status).toBe(200);
  expect(app()).toMatchObject({ state: "created", appID: "ANEWAPP01", botID: null, botUser: null });
  expect(fake.state.keychain.get(appItem("jojo"))).toBe(body.app);

  // A confirmation with nothing bound, or of the same app, changes nothing it shouldn't.
  db.delete(slackApps).run();
  expect(
    (await daemon("/dots/jojo/slack/link", "POST", { ...body, replaceAppID: "ANEWAPP01" })).status,
  ).toBe(409);
  expect((await daemon("/dots/jojo/slack/link", "POST", body)).status).toBe(200);
  expect(
    (await daemon("/dots/jojo/slack/link", "POST", { ...body, replaceAppID: "ANEWAPP01" })).status,
  ).toBe(200);
  expect(app()).toMatchObject({ state: "created", appID: "ANEWAPP01" });
});
