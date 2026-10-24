import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

test("installed public client carries worker requests and answers over fake HTTP only", async () => {
  await mkdir(".research", { recursive: true });
  const home = await mkdtemp(join(process.cwd(), ".research/requests-wire-"));
  try {
    const child = Bun.spawn([process.execPath, "test/fixtures/requests-wire.ts"], {
      env: {
        ...process.env,
        XDG_STATE_HOME: join(home, "state"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CONFIG_HOME: join(home, "config"),
        OPEN_DOT_HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr, stdout }).toMatchObject({ code: 0, stderr: "" });
      const result = JSON.parse(stdout) as { checks: string[]; requests: unknown[] };
      expect(result.checks).toContain("daemon attempts persisted before HTTP reply");
      expect(result.checks).toContain("unknown never replayed after disappearance and restart");
      expect(result.requests.length).toBeGreaterThan(20);
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 20_000);

/** Runs a fixture in a subprocess with its own XDG paths under `.research/<prefix>-…`. */
async function fixture(script: string, prefix: string) {
  await mkdir(".research", { recursive: true });
  const home = await mkdtemp(join(process.cwd(), `.research/${prefix}-`));
  try {
    const child = Bun.spawn([process.execPath, script], {
      env: {
        ...process.env,
        XDG_STATE_HOME: join(home, "state"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CONFIG_HOME: join(home, "config"),
        OPEN_DOT_HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stderr, checks: (JSON.parse(stdout) as { checks: string[] }).checks };
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("installed public client streams only text events over fake HTTP only", async () => {
  expect(await fixture("test/fixtures/events-wire.ts", "events-wire")).toEqual({
    code: 0,
    stderr: "",
    checks: ["the installed client's text events arrive in order, with no reasoning"],
  });
}, 20_000);

test("installed public client reads a running turn's text so far over fake HTTP only", async () => {
  const result = await fixture("test/fixtures/turn-wire.ts", "turn-wire");
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(result.checks).toHaveLength(10);
}, 20_000);

test("installed public client pages messages with opaque cursors over fake HTTP only", async () => {
  const result = await fixture("test/fixtures/messages-wire.ts", "messages-wire");
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(result.checks).toHaveLength(3);
}, 20_000);
