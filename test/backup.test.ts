import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import journal from "../drizzle/meta/_journal.json";
import { backupDatabase, checkIntegrity, openDatabase, restoreDatabase } from "../src/db";

const root = resolve(import.meta.dir, "..");
const evidence = join(root, ".research", "23-fixtures");
const modulePath = JSON.stringify(join(root, "src/db.ts"));
const previousEntries = journal.entries.filter((entry) => entry.tag < "0019_recent_reactions");
const directories: string[] = [];
mkdirSync(evidence, { recursive: true });

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(pending = false) {
  const directory = mkdtempSync(join(evidence, "backup-"));
  directories.push(directory);
  const home = join(directory, `owner's "quoted" home`);
  mkdirSync(home);
  const path = join(home, "open-dot.db");
  const migrations = join(directory, "drizzle");
  cpSync(join(root, "drizzle"), migrations, { recursive: true });
  writeFileSync(
    join(migrations, "meta/_journal.json"),
    JSON.stringify({
      ...journal,
      entries: pending ? previousEntries : journal.entries,
    }),
  );
  const sqlite = new Database(path);
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrations });
  sqlite.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('original')");
  sqlite.close();
  return { directory, home, path };
}

function backups(path: string) {
  const directory = join(path, "..", "backups");
  return existsSync(directory) ? readdirSync(directory).toSorted() : [];
}

function ledger(sqlite: Database) {
  return sqlite.query("SELECT rowid, * FROM __drizzle_migrations ORDER BY rowid").all();
}

function value(sqlite: Database) {
  return sqlite.query<{ value: string }, []>("SELECT value FROM probe").get()?.value;
}

function child(code: string) {
  return Bun.spawn([process.execPath, "--eval", code], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
}

async function result(process: ReturnType<typeof child>) {
  const [exit, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for child barrier");
    await Bun.sleep(10);
  }
}

function cli(home: string, ...args: string[]) {
  const spawned = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
    cwd: root,
    env: { ...Bun.env, OPEN_DOT_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  return {
    exit: spawned.exitCode,
    stdout: spawned.stdout.toString().trim(),
    stderr: spawned.stderr.toString().trim(),
  };
}

test("ordinary and memory opens make no backups or migration lock", () => {
  const { path } = fixture();
  const before = readdirSync(join(path, ".."));
  for (let i = 0; i < 3; i++) openDatabase(path).$client.close();
  expect(readdirSync(join(path, "..")).filter((name) => !/-(wal|shm)$/.test(name))).toEqual(before);
  expect(backups(path)).toEqual([]);
  openDatabase(":memory:").$client.close();
});

test("pending migration snapshots old schema, rows and ledger before applying exactly once", () => {
  const { path, home } = fixture(true);
  const old = new Database(path);
  const before = ledger(old);
  old.close();
  const db = openDatabase(path);
  try {
    expect(backups(path)).toHaveLength(1);
    const name = backups(path)[0];
    assert(name);
    expect(name).toEndWith("-before-0019_recent_reactions.db");
    const copy = new Database(join(home, "backups", name), { readonly: true });
    try {
      expect(ledger(copy)).toEqual(before);
      expect(ledger(copy)).toHaveLength(previousEntries.length);
      expect(value(copy)).toBe("original");
      expect(
        copy.query("SELECT name FROM sqlite_master WHERE name='recent_reactions'").get(),
      ).toBeNull();
    } finally {
      copy.close();
    }
    expect(ledger(db.$client).slice(0, before.length)).toEqual(before);
    expect(ledger(db.$client)).toHaveLength(journal.entries.length);
    expect(
      db.$client.query("SELECT name FROM sqlite_master WHERE name='recent_reactions'").get(),
    ).not.toBeNull();
    expect(value(db.$client)).toBe("original");
  } finally {
    db.$client.close();
  }
  openDatabase(path).$client.close();
  expect(backups(path)).toHaveLength(1);
});

test("backup destination failure blocks migration without changing database bytes", () => {
  const { path, home } = fixture(true);
  writeFileSync(join(home, "backups"), "not a directory");
  const bytes = readFileSync(path);
  expect(() => openDatabase(path)).toThrow("migration/restore was not run");
  expect(readFileSync(path)).toEqual(bytes);
});

test("copy integrity failure blocks migration and removes rejected snapshot", async () => {
  const { path } = fixture(true);
  const bytes = readFileSync(path);
  const output = await result(
    child(`
    import { Database } from 'bun:sqlite';
    import { openDatabase } from ${modulePath};
    const query = Database.prototype.query;
    Database.prototype.query = function(sql, ...args) {
      if (sql === 'PRAGMA integrity_check') throw new Error('injected copy integrity failure');
      return query.call(this, sql, ...args);
    };
    try { openDatabase(${JSON.stringify(path)}); process.exit(2); }
    catch (error) { console.error(error.message); process.exit(1); }
  `),
  );
  expect(output.exit).toBe(1);
  expect(output.stderr).toContain("injected copy integrity failure");
  expect(output.stderr).toContain("migration/restore was not run");
  expect(readFileSync(path)).toEqual(bytes);
  expect(backups(path)).toEqual([]);
});

test.each(["none", "backups", "parent"])(
  "snapshot directory fsync on macOS: %s failure blocks migration after publication",
  async (failure) => {
    const { path, home } = fixture(true);
    const before = readFileSync(path);
    const output = await result(
      child(`
      import { mock } from 'bun:test';
      import * as fs from 'node:fs';
      const real = { ...fs };
      const home = ${JSON.stringify(home)};
      const directory = home + '/backups';
      const syncs = [];
      mock.module('node:fs', () => ({ ...real, fsyncSync(fd) {
        const stat = real.fstatSync(fd);
        const kind = stat.isDirectory()
          ? stat.ino === real.statSync(directory).ino ? 'backups' : 'parent'
          : 'file';
        const published = stat.isDirectory()
          ? real.readdirSync(directory).some(name => /^open-dot-.*\\.db$/.test(name))
          : false;
        syncs.push({ kind, published });
        if (kind === ${JSON.stringify(failure)}) throw new Error('injected ' + kind + ' directory fsync failure');
        return real.fsyncSync(fd);
      }}));
      const { openDatabase } = await import(${modulePath});
      try {
        openDatabase(${JSON.stringify(path)}).$client.close();
        console.log(JSON.stringify({ syncs }));
      } catch(error) {
        console.log(JSON.stringify({ syncs, message: error.message })); process.exit(1);
      }
    `),
    );
    expect(output.stderr).toBe("");
    const observed = JSON.parse(output.stdout) as {
      syncs: { kind: string; published: boolean }[];
      message?: string;
    };
    const expected = failure === "backups" ? ["file", "backups"] : ["file", "backups", "parent"];
    expect(observed.syncs.map((event) => event.kind)).toEqual(expected);
    expect(
      observed.syncs.filter((event) => event.kind !== "file").every((event) => event.published),
    ).toBe(true);
    const names = backups(path);
    expect(names).toHaveLength(1);
    const name = names[0];
    assert(name);
    const published = join(home, "backups", name);
    checkIntegrity(published);
    if (failure === "none") {
      expect(output.exit).toBe(0);
      expect(observed.message).toBeUndefined();
      const migrated = new Database(path, { readwrite: true, create: false });
      try {
        expect(ledger(migrated)).toHaveLength(journal.entries.length);
      } finally {
        migrated.close();
      }
    } else {
      expect(output.exit).toBe(1);
      expect(observed.message).toContain(`injected ${failure} directory fsync failure`);
      expect(observed.message).toContain("migration/restore was not run");
      expect(observed.message).toContain(published);
      expect(readFileSync(path)).toEqual(before);
    }
    const copy = new Database(published, { readwrite: true, create: false });
    try {
      expect(ledger(copy)).toHaveLength(previousEntries.length);
    } finally {
      copy.close();
    }
  },
);

test.each(["integrity", "pruning", "unknown"])(
  "restore %s failure reports replacement phase and usable recovery backup",
  async (failure) => {
    const source = fixture();
    const target = fixture();
    const sourceBytes = readFileSync(source.path);
    const old = new Database(target.path);
    old.exec("UPDATE probe SET value='old target state'");
    old.close();
    const output = await result(
      child(`
      import { Database } from 'bun:sqlite';
      import { mock } from 'bun:test';
      import * as fs from 'node:fs';
      const real = { ...fs };
      const target = real.realpathSync(${JSON.stringify(target.path)});
      const failure = ${JSON.stringify(failure)};
      if (failure === 'integrity') {
        const query = Database.prototype.query;
        Database.prototype.query = function(sql, ...args) {
          if (sql === 'PRAGMA integrity_check' && this.filename === target)
            throw new Error('injected post-replacement integrity failure');
          return query.call(this, sql, ...args);
        };
      }
      if (failure === 'pruning') {
        mock.module('node:fs', () => ({ ...real, readdirSync(path, ...args) {
          if (path === ${JSON.stringify(join(target.home, "backups"))}) throw new Error('injected post-replacement pruning failure');
          return real.readdirSync(path, ...args);
        }}));
      }
      if (failure === 'unknown') {
        const spawnSync = Bun.spawnSync;
        Bun.spawnSync = function(command, options) {
          const result = spawnSync(command, options);
          if (command[0] === 'sqlite3' && result.exitCode === 0)
            return { ...result, exitCode: 1, stderr: Buffer.from('injected unknown replacement outcome') };
          return result;
        };
      }
      const { restoreDatabase } = await import(${modulePath});
      try { restoreDatabase(target, ${JSON.stringify(source.path)}); process.exit(2); }
      catch(error) { console.log(JSON.stringify({ message: error.message })); process.exit(1); }
    `),
    );
    expect(output.exit).toBe(1);
    expect(output.stderr).toBe("");
    const { message } = JSON.parse(output.stdout) as { message: string };
    if (failure === "unknown") {
      expect(message).toContain("Restore failed during replacing");
      expect(message).toContain(
        "Database replacement was attempted; inspect its state before retrying.",
      );
      expect(message).toContain("injected unknown replacement outcome");
      expect(message).not.toContain("Database replacement completed.");
    } else {
      expect(message).toContain(
        `Restore failed during ${failure === "integrity" ? "checking restored database" : "pruning"}`,
      );
      expect(message).toContain("Database replacement completed.");
      expect(message).toContain(
        `injected post-replacement ${failure === "integrity" ? "integrity" : "pruning"} failure`,
      );
    }
    expect(message).not.toContain("Database replacement was not attempted.");
    const names = backups(target.path);
    expect(names).toHaveLength(1);
    const name = names[0];
    assert(name);
    expect(name).toEndWith("-before-restore.db");
    const recovery = join(target.home, "backups", name);
    expect(message).toContain(`Previous database backup: ${recovery}.`);
    checkIntegrity(recovery);
    checkIntegrity(target.path);
    const recovered = new Database(recovery, { readwrite: true, create: false });
    const replaced = new Database(target.path, { readwrite: true, create: false });
    try {
      expect(value(recovered)).toBe("old target state");
      expect(value(replaced)).toBe("original");
    } finally {
      recovered.close();
      replaced.close();
    }
    expect(readFileSync(source.path)).toEqual(sourceBytes);
    expect(readdirSync(target.home).some((entry) => entry.includes(".restore-"))).toBe(false);
  },
);

test("three real pending openers serialize to one old-schema backup and one complete migration batch", async () => {
  const { directory, path, home } = fixture(true);
  const lock = new Database(`${path}.migration-lock`);
  lock.exec("BEGIN IMMEDIATE");
  const processes = [0, 1, 2].map((index) =>
    child(`
    import { Database } from 'bun:sqlite';
    import { writeFileSync } from 'node:fs';
    import { openDatabase } from ${modulePath};
    const exec = Database.prototype.exec;
    Database.prototype.exec = function(sql, ...args) {
      if (sql.includes('BEGIN IMMEDIATE')) writeFileSync(${JSON.stringify(join(directory, `waiting-${index}`))}, 'waiting');
      return exec.call(this, sql, ...args);
    };
    const db = openDatabase(${JSON.stringify(path)}); db.$client.close(); console.log('opened');
  `),
  );
  try {
    await until(() => [0, 1, 2].every((index) => existsSync(join(directory, `waiting-${index}`))));
    lock.close();
    const outputs = await Promise.all(processes.map(result));
    expect(outputs).toEqual([0, 1, 2].map(() => ({ exit: 0, stdout: "opened\n", stderr: "" })));
    expect(backups(path)).toHaveLength(1);
    const sqlite = new Database(path);
    const name = backups(path)[0];
    assert(name);
    const copy = new Database(join(home, "backups", name));
    try {
      expect(ledger(sqlite)).toHaveLength(journal.entries.length);
      expect(ledger(copy)).toHaveLength(previousEntries.length);
      expect(ledger(sqlite).slice(0, previousEntries.length)).toEqual(ledger(copy));
    } finally {
      sqlite.close();
      copy.close();
    }
  } finally {
    lock.close();
    for (const process of processes) process.kill();
    await Promise.all(processes.map((process) => process.exited));
  }
}, 15000);

test("a killed lock holder releases its lock for a later pending opener", async () => {
  const { directory, path } = fixture(true);
  const ready = join(directory, "ready");
  const process = child(`
    import { Database } from 'bun:sqlite'; import { writeFileSync } from 'node:fs';
    const db = new Database(${JSON.stringify(`${path}.migration-lock`)});
    db.exec('BEGIN IMMEDIATE'); writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `);
  try {
    await until(() => existsSync(ready));
  } finally {
    process.kill("SIGKILL");
    await process.exited;
  }
  const output = await result(
    child(
      `import { openDatabase } from ${modulePath}; openDatabase(${JSON.stringify(path)}).$client.close();`,
    ),
  );
  expect(output).toEqual({ exit: 0, stdout: "", stderr: "" });
  expect(backups(path)).toHaveLength(1);
});

test("no-pending opens bypass a migration lock held by another connection", async () => {
  const { path } = fixture();
  const lock = new Database(`${path}.migration-lock`);
  lock.exec("BEGIN IMMEDIATE");
  try {
    const start = performance.now();
    const output = await result(
      child(
        `import { openDatabase } from ${modulePath}; openDatabase(${JSON.stringify(path)}).$client.close();`,
      ),
    );
    expect(output).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(performance.now() - start).toBeLessThan(5000);
    expect(backups(path)).toEqual([]);
  } finally {
    lock.close();
  }
});

test("pruning retains ten newest generated files and ignores unrelated names and directories", () => {
  const { path, home } = fixture();
  const directory = join(home, "backups");
  mkdirSync(directory);
  const generated = Array.from(
    { length: 12 },
    (_, index) =>
      `open-dot-2000-01-${String(index + 1).padStart(2, "0")}T00-00-00.000Z-${index % 2 ? "manual" : "before-0019_recent_reactions"}.db`,
  );
  for (const name of generated) writeFileSync(join(directory, name), "old fixture");
  const unrelated = [
    "keep.db",
    "open-dot-invalid-manual.db",
    "open-dot-2000-01-01T00-00-00.000Z-custom.db",
  ];
  for (const name of unrelated) writeFileSync(join(directory, name), "keep");
  mkdirSync(join(directory, "open-dot-1999-01-01T00-00-00.000Z-manual.db"));
  const newest = backupDatabase(path);
  for (const name of generated.slice(0, 3)) expect(existsSync(join(directory, name))).toBe(false);
  for (const name of [...generated.slice(3), ...unrelated])
    expect(existsSync(join(directory, name))).toBe(true);
  expect(existsSync(newest)).toBe(true);
  expect(statSync(newest).mode & 0o777).toBe(0o600);
});

test("actual CLI backup/restore preserves WAL content, existing connections, private permissions and quoted paths", () => {
  const { path, home } = fixture();
  const existing = new Database(path);
  try {
    existing.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE probe SET value='only in WAL'",
    );
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    const copied = cli(home, "backup");
    expect(copied.exit).toBe(0);
    expect(copied.stderr).toBe("");
    checkIntegrity(copied.stdout);
    expect(statSync(copied.stdout).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "backups")).mode & 0o777).toBe(0o700);
    const copy = new Database(copied.stdout);
    try {
      expect(value(copy)).toBe("only in WAL");
    } finally {
      copy.close();
    }
    existing.exec("UPDATE probe SET value='after backup'");
    const restored = cli(home, "restore", copied.stdout);
    expect(restored.exit).toBe(0);
    expect(restored.stderr).toBe("");
    expect(restored.stdout).toContain("Previous database backed up at");
    expect(value(existing)).toBe("only in WAL");
    const previous = restored.stdout.split("Previous database backed up at ")[1];
    assert(previous);
    const beforeRestore = new Database(previous);
    try {
      expect(value(beforeRestore)).toBe("after backup");
    } finally {
      beforeRestore.close();
    }
    expect(readdirSync(home).some((name) => name.includes(".restore-"))).toBe(false);
  } finally {
    existing.close();
  }
}, 15000);

test("CLI backup accepts a closed WAL-mode database without sidecar files", async () => {
  const { path, home } = fixture();
  const opened = await result(
    child(
      `import { openDatabase } from ${modulePath}; openDatabase(${JSON.stringify(path)}).$client.close();`,
    ),
  );
  expect(opened).toEqual({ exit: 0, stdout: "", stderr: "" });
  expect(existsSync(`${path}-wal`)).toBe(false);
  expect(existsSync(`${path}-shm`)).toBe(false);
  const copied = cli(home, "backup");
  expect(copied.exit).toBe(0);
  expect(copied.stderr).toBe("");
  checkIntegrity(copied.stdout);
});

test("CLI backup copies a pending database without applying migrations", () => {
  const { path, home } = fixture(true);
  const before = readFileSync(path);
  const output = cli(home, "backup");
  expect(output.exit).toBe(0);
  expect(output.stderr).toBe("");
  expect(readFileSync(path)).toEqual(before);
  const copy = new Database(output.stdout, { readwrite: true, create: false });
  try {
    expect(ledger(copy)).toHaveLength(previousEntries.length);
    expect(
      copy.query("SELECT name FROM sqlite_master WHERE name='recent_reactions'").get(),
    ).toBeNull();
    expect(value(copy)).toBe("original");
  } finally {
    copy.close();
  }
});

test("missing backup or restore sources and current databases are never created", () => {
  const { path, home } = fixture();
  const missing = join(home, "missing.db");
  const before = readFileSync(path);
  expect(() => checkIntegrity(missing)).toThrow("Integrity check failed");
  expect(existsSync(missing)).toBe(false);
  const failedRestore = cli(home, "restore", missing);
  expect(failedRestore.exit).toBe(1);
  expect(existsSync(missing)).toBe(false);
  expect(readFileSync(path)).toEqual(before);
  expect(backups(path)).toEqual([]);
  const absentHome = join(home, "missing home");
  const absentCurrent = join(absentHome, "open-dot.db");
  expect(cli(absentHome, "backup").exit).toBe(1);
  expect(existsSync(absentCurrent)).toBe(false);
  expect(cli(absentHome, "restore", path).exit).toBe(1);
  expect(existsSync(absentCurrent)).toBe(false);
  expect(backups(absentCurrent)).toEqual([]);
  expect(readFileSync(path)).toEqual(before);
});

test.skipIf(process.getuid?.() === 0)(
  "a chmod 0400 valid backup can be restored without changing its bytes or mode",
  () => {
    const { path, home } = fixture();
    const source = backupDatabase(path);
    chmodSync(source, 0o400);
    const sourceBytes = readFileSync(source);
    const current = new Database(path);
    current.exec("UPDATE probe SET value='changed'");
    current.close();
    const restored = cli(home, "restore", source);
    expect(restored.exit).toBe(0);
    expect(restored.stderr).toBe("");
    const inspected = new Database(path, { readwrite: true, create: false });
    try {
      expect(value(inspected)).toBe("original");
    } finally {
      inspected.close();
    }
    expect(readFileSync(source)).toEqual(sourceBytes);
    expect(statSync(source).mode & 0o777).toBe(0o400);
  },
);

test("CLI restore accepts a closed WAL source without sidecars", async () => {
  const source = fixture();
  const target = fixture();
  const opened = await result(
    child(
      `import { openDatabase } from ${modulePath}; openDatabase(${JSON.stringify(source.path)}).$client.close();`,
    ),
  );
  expect(opened).toEqual({ exit: 0, stdout: "", stderr: "" });
  expect(existsSync(`${source.path}-wal`)).toBe(false);
  expect(existsSync(`${source.path}-shm`)).toBe(false);
  const sourceBytes = readFileSync(source.path);
  const current = new Database(target.path);
  current.exec("UPDATE probe SET value='target before restore'");
  current.close();
  const restored = cli(target.home, "restore", source.path);
  expect(restored.exit).toBe(0);
  expect(restored.stderr).toBe("");
  const inspected = new Database(target.path, { readwrite: true, create: false });
  try {
    expect(value(inspected)).toBe("original");
  } finally {
    inspected.close();
  }
  expect(readFileSync(source.path)).toEqual(sourceBytes);
});

test("corrupt restore source is rejected without backup or database mutation", () => {
  const { path, home } = fixture();
  const source = join(home, "broken source.db");
  writeFileSync(source, "not a database");
  const before = readFileSync(path);
  const output = cli(home, "restore", source);
  expect(output.exit).toBe(1);
  expect(output.stderr).toContain("Integrity check failed");
  expect(output.stderr).toContain("Database replacement was not attempted.");
  expect(output.stderr).not.toContain("Previous database backup:");
  expect(readFileSync(path)).toEqual(before);
  expect(backups(path)).toEqual([]);
  expect(() => restoreDatabase(path, path)).toThrow("source is the current database");
});

test("a real child daemon claim refuses CLI restore without backup or mutation", async () => {
  const { directory, path, home } = fixture();
  const source = backupDatabase(path);
  const before = readFileSync(path);
  const names = backups(path);
  const ready = join(directory, "daemon-ready");
  const process = child(`
    import { claimDaemon } from ${modulePath}; import { writeFileSync } from 'node:fs';
    const release = claimDaemon(${JSON.stringify(path)});
    writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);
    process.on('exit', release);
  `);
  try {
    await until(() => existsSync(ready));
    const output = cli(home, "restore", source);
    expect(output.exit).toBe(1);
    expect(output.stderr).toContain("Stop the daemon first");
    expect(readFileSync(path)).toEqual(before);
    expect(backups(path)).toEqual(names);
  } finally {
    process.kill("SIGKILL");
    await process.exited;
  }
});

test("a restore holds the daemon claim while waiting for the migration lock", async () => {
  const { path } = fixture();
  const source = backupDatabase(path);
  const lock = new Database(`${path}.migration-lock`);
  lock.exec("BEGIN IMMEDIATE");
  const process = child(
    `import { restoreDatabase } from ${modulePath}; restoreDatabase(${JSON.stringify(path)}, ${JSON.stringify(source)});`,
  );
  try {
    await until(() => {
      const probe = new Database(`${path}.daemon-lock`);
      try {
        probe.exec("BEGIN IMMEDIATE");
        return false;
      } catch {
        return true;
      } finally {
        probe.close();
      }
    });
    const claimant = await result(
      child(
        `import { claimDaemon } from ${modulePath}; try { claimDaemon(${JSON.stringify(path)})(); process.exit(2); } catch(error) { console.error(error.message); process.exit(1); }`,
      ),
    );
    expect(claimant.exit).toBe(1);
    expect(claimant.stderr).toContain("Stop the daemon first");
    lock.close();
    expect(await result(process)).toEqual({ exit: 0, stdout: "", stderr: "" });
    const after = await result(
      child(`import { claimDaemon } from ${modulePath}; claimDaemon(${JSON.stringify(path)})();`),
    );
    expect(after.exit).toBe(0);
  } finally {
    lock.close();
    process.kill();
    await process.exited;
  }
}, 15000);
