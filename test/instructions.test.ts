import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { api } from "../src/api";
import { type Db, openDatabase } from "../src/db";
import { historyLimit, instructionsLimit, instructionsPath } from "../src/instructions";
import { OpenCode, OpenCodeError } from "../src/opencode";
import { dots, outbox } from "../src/schema";

let db: Db;
let home: string;
let previousHome: string | undefined;

// The instructions need no OpenCode, so every call runs as if it were down.
const down = Layer.effect(OpenCode, Effect.fail(new OpenCodeError({ message: "Not running" })));

const revision = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(() => {
  previousHome = process.env.OPEN_DOT_HOME;
  home = mkdtempSync(join(tmpdir(), "open-dot-instructions-"));
  process.env.OPEN_DOT_HOME = home;
  db = openDatabase(":memory:");
  for (const name of ["jojo", "polnareff"]) {
    mkdirSync(join(home, "dots", name), { recursive: true });
    writeFileSync(instructionsPath(name), `# ${name}\n`);
    db.insert(dots)
      .values({
        name,
        // The database's directory is never where the file is read from.
        directory: join(home, "elsewhere", name),
        sessionID: `ses_${name}`,
        sessionState: "ready",
        createdAt: name === "jojo" ? 0 : 1,
      })
      .run();
  }
});

afterEach(() => {
  db.$client.close();
  chmodSync(join(home, "dots", "jojo"), 0o755);
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.OPEN_DOT_HOME;
  else process.env.OPEN_DOT_HOME = previousHome;
});

const call = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  api(
    db,
    "secret",
    down,
  )(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${init.token ?? "secret"}` },
      ...(init.body === undefined
        ? {}
        : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    }),
  );

const json = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
});

const save = (content: string, from: string, name = "jojo") =>
  call(`/dots/${name}/instructions`, {
    method: "PUT",
    body: { content, revision: revision(from) },
  });

const revert = (from: string) =>
  call("/dots/jojo/instructions/revert", { method: "POST", body: { revision: revision(from) } });

const historyDir = () => join(home, "dots", "jojo", ".instructions-history");
const kept = () => {
  try {
    return readdirSync(historyDir()).toSorted();
  } catch {
    return [];
  }
};
const onDisk = () => readFileSync(instructionsPath("jojo"), "utf8");
const dotFiles = () => readdirSync(join(home, "dots", "jojo")).toSorted();

test("reading and saving need the token and no OpenCode, and start no turn", async () => {
  expect((await call("/dots/jojo/instructions", { token: "wrong" })).status).toBe(401);
  expect((await save("# changed\n", "# jojo\n")).status).toBe(200);
  expect(
    (
      await call("/dots/jojo/instructions", {
        method: "PUT",
        token: "wrong",
        body: { content: "x", revision: revision("# changed\n") },
      })
    ).status,
  ).toBe(401);
  expect(await json(await call("/dots/jojo/instructions"))).toEqual({
    status: 200,
    body: { content: "# changed\n", revision: revision("# changed\n"), canRevert: true },
  });
  expect(readFileSync(instructionsPath("polnareff"), "utf8")).toBe("# polnareff\n");
  expect(db.select().from(outbox).all()).toEqual([]);
});

test("names, shapes, revisions and queries are strict", async () => {
  for (const path of [
    "/dots/missing/instructions",
    "/dots/%2e%2e/instructions",
    "/dots/jojo%2F..%2Fpolnareff/instructions",
    "/dots/%E0%A4%A/instructions",
    "/dots/jojo/instructions/x",
    "/dots/jojo/instructions/revert/x",
  ])
    expect((await call(path)).status).toBe(404);
  expect((await call("/dots/jojo/instructions", { method: "POST", body: {} })).status).toBe(404);
  expect((await call("/dots/jojo/instructions/revert")).status).toBe(404);
  expect((await call("/dots/jojo/instructions?x=1")).status).toBe(400);
  const current = revision("# jojo\n");
  for (const body of [
    "not json",
    [],
    null,
    {},
    { content: "x" },
    { revision: current },
    { content: 1, revision: current },
    { content: "x", revision: "abc" },
    { content: "x", revision: current.toUpperCase() },
    { content: "x", revision: current, extra: true },
    { content: "a\u0000b", revision: current },
    '{"content":"\\ud800","revision":"' + current + '"}',
  ])
    expect((await call("/dots/jojo/instructions", { method: "PUT", body })).status).toBe(400);
  for (const body of [{}, { revision: "abc" }, { revision: current, content: "x" }])
    expect((await call("/dots/jojo/instructions/revert", { method: "POST", body })).status).toBe(
      400,
    );
  expect(onDisk()).toBe("# jojo\n");
  expect(kept()).toEqual([]);
});

test("the size cap counts UTF-8 bytes and allows JSON escapes", async () => {
  // 64 KiB of characters that are escaped as \u0001: six bytes each in the body.
  const escaped = "\u0001".repeat(instructionsLimit);
  expect((await save(escaped, "# jojo\n")).status).toBe(200);
  expect(onDisk()).toBe(escaped);
  // One byte over, in three-byte characters.
  const over = "é".repeat(instructionsLimit / 2) + "a";
  expect((await save(over, escaped)).status).toBe(413);
  expect((await save("x".repeat(instructionsLimit * 7), escaped)).status).toBe(413);
  expect(onDisk()).toBe(escaped);

  writeFileSync(instructionsPath("polnareff"), "x".repeat(instructionsLimit + 1));
  expect((await call("/dots/polnareff/instructions")).status).toBe(413);
  writeFileSync(instructionsPath("polnareff"), Buffer.from([0xff, 0xfe, 0x00]));
  expect((await call("/dots/polnareff/instructions")).status).toBe(422);
});

test("a stale revision gets 409 with the current text, and only one of two racing saves lands", async () => {
  writeFileSync(instructionsPath("jojo"), "# edited on disk\n");
  const stale = await json(await save("# mine\n", "# jojo\n"));
  expect(stale.status).toBe(409);
  expect(stale.body.current).toEqual({
    content: "# edited on disk\n",
    revision: revision("# edited on disk\n"),
    canRevert: false,
  });
  expect(onDisk()).toBe("# edited on disk\n");

  // Overwrite is a fresh save at the revision the conflict returned.
  const [first, second] = await Promise.all([
    save("# first\n", "# edited on disk\n"),
    save("# second\n", "# edited on disk\n"),
  ]);
  expect([first.status, second.status].toSorted((a, b) => a - b)).toEqual([200, 409]);
  const winner = first.status === 200 ? "# first\n" : "# second\n";
  expect(onDisk()).toBe(winner);
  expect(kept()).toHaveLength(1);
  expect(readFileSync(join(historyDir(), kept()[0] ?? ""), "utf8")).toBe("# edited on disk\n");
});

test("saves replace the file atomically, keep at most ten versions, and revert steps back", async () => {
  let text = "# jojo\n";
  for (let version = 1; version <= historyLimit + 2; version++) {
    const next = `# version ${version}\n`;
    expect((await save(next, text)).status).toBe(200);
    text = next;
  }
  expect(kept()).toHaveLength(historyLimit);
  expect(dotFiles()).toEqual([".instructions-history", "AGENTS.md"]);
  // Saving the same text keeps nothing more.
  expect((await save(text, text)).status).toBe(200);
  expect(kept()).toHaveLength(historyLimit);

  expect((await revert("# jojo\n")).status).toBe(409);
  // History lives only on disk, and each call builds a fresh API, as a restarted daemon would.
  const reverted = await json(await revert(text));
  expect(reverted).toEqual({
    status: 200,
    body: {
      content: `# version ${historyLimit + 1}\n`,
      revision: revision(`# version ${historyLimit + 1}\n`),
      canRevert: true,
    },
  });
  text = `# version ${historyLimit + 1}\n`;
  for (let step = historyLimit; step >= 2; step--) {
    const back = await json(await revert(text));
    text = `# version ${step}\n`;
    expect(back.body.content).toBe(text);
  }
  expect((await json(await call("/dots/jojo/instructions"))).body.canRevert).toBe(false);
  expect((await revert(text)).status).toBe(404);
  expect(onDisk()).toBe("# version 2\n");
  expect(dotFiles()).toEqual([".instructions-history", "AGENTS.md"]);
});

test("links and other files are refused, and a failed save leaves both files as they were", async () => {
  const outside = join(home, "outside.md");
  writeFileSync(outside, "keep");

  rmSync(instructionsPath("jojo"));
  symlinkSync(outside, instructionsPath("jojo"));
  expect((await call("/dots/jojo/instructions")).status).toBe(422);
  expect((await save("x", "keep")).status).toBe(422);
  expect(readFileSync(outside, "utf8")).toBe("keep");
  rmSync(instructionsPath("jojo"));
  mkdirSync(instructionsPath("jojo"));
  expect((await call("/dots/jojo/instructions")).status).toBe(422);
  rmSync(instructionsPath("jojo"), { recursive: true });
  // A missing file reads as empty and is created by the first save.
  expect((await json(await call("/dots/jojo/instructions"))).body.content).toBe("");
  expect((await save("# back\n", "")).status).toBe(200);

  mkdirSync(join(home, "real-history"));
  symlinkSync(join(home, "real-history"), historyDir());
  expect((await save("# again\n", "# back\n")).status).toBe(422);
  expect(onDisk()).toBe("# back\n");
  expect(readdirSync(join(home, "real-history"))).toEqual([]);
  rmSync(historyDir());

  rmSync(join(home, "dots", "polnareff"), { recursive: true });
  mkdirSync(join(home, "real-polnareff"));
  writeFileSync(join(home, "real-polnareff", "AGENTS.md"), "linked");
  symlinkSync(join(home, "real-polnareff"), join(home, "dots", "polnareff"));
  expect((await call("/dots/polnareff/instructions")).status).toBe(422);
  expect((await save("x", "linked", "polnareff")).status).toBe(422);
  expect(readFileSync(join(home, "real-polnareff", "AGENTS.md"), "utf8")).toBe("linked");

  // The dot's directory can't take new files, so the rename never happens.
  expect((await save("# kept\n", "# back\n")).status).toBe(200);
  const before = kept();
  chmodSync(join(home, "dots", "jojo"), 0o555);
  const failed = await call("/dots/jojo/instructions", {
    method: "PUT",
    body: { content: "# lost\n", revision: revision("# kept\n") },
  });
  chmodSync(join(home, "dots", "jojo"), 0o755);
  expect(failed.status).toBe(500);
  expect(onDisk()).toBe("# kept\n");
  expect(kept()).toEqual(before);
  expect(dotFiles()).toEqual([".instructions-history", "AGENTS.md"]);
  expect(readdirSync(historyDir()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("open-dot instructions prints the dot's AGENTS.md path", () => {
  const disk = openDatabase(join(home, "open-dot.db"));
  disk
    .insert(dots)
    .values({
      name: "jojo",
      directory: join(home, "elsewhere", "jojo"),
      sessionID: "ses_jojo",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
  disk.$client.close();
  const cli = (...args: string[]) =>
    Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...Bun.env, OPEN_DOT_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
  const printed = cli("instructions", "jojo");
  expect(printed.exitCode).toBe(0);
  expect(printed.stdout.toString()).toBe(`${instructionsPath("jojo")}\n`);
  const unknown = cli("instructions", "nobody");
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr.toString()).toContain('No dot named "nobody"');
});
