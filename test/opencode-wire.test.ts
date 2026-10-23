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
