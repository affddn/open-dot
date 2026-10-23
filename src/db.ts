import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import journal from "../drizzle/meta/_journal.json";
import * as schema from "./schema";

function pending(sqlite: Database) {
  const ledger = sqlite
    .query("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'")
    .get();
  const latest = ledger
    ? sqlite
        .query<{ created_at: unknown }, []>(
          "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
        )
        .get()
    : null;
  return journal.entries.find((entry) => !latest || Number(latest.created_at) < entry.when);
}

function canonical(path: string) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  try {
    return realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return join(realpathSync(dirname(resolve(path))), basename(path));
  }
}

function lock(path: string, timeout: number) {
  const sqlite = new Database(path, { create: true });
  try {
    sqlite.exec(`PRAGMA busy_timeout = ${timeout}; BEGIN IMMEDIATE`);
    return () => sqlite.close();
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

const stopDaemon =
  "Stop the daemon first: launchctl bootout gui/$(id -u)/com.opzero1.open-dot.daemon (or stop the foreground open-dot daemon).";

export function claimDaemon(path: string) {
  try {
    return lock(`${canonical(path)}.daemon-lock`, 0);
  } catch (error) {
    throw new Error(`The daemon is running, or its lock is unavailable. ${stopDaemon}`, {
      cause: error,
    });
  }
}

export function checkIntegrity(path: string) {
  let sqlite: Database | undefined;
  try {
    sqlite = existing(path);
    const rows = sqlite.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
      throw new Error(rows.map((row) => row.integrity_check).join("; "));
  } catch (error) {
    throw new Error(
      `Integrity check failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    sqlite?.close();
  }
}

function existing(path: string) {
  // Bun's readonly connection cannot open a closed WAL database without its sidecars.
  // Allow SQLite to manage those files, but never create a missing source or run migrations.
  const sqlite = new Database(path, { readwrite: true, create: false });
  sqlite.exec("PRAGMA busy_timeout = 5000");
  return sqlite;
}

function sync(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function snapshot(sqlite: Database, path: string, reason: string) {
  const directory = join(dirname(path), "backups");
  let target = join(
    directory,
    `open-dot-${new Date().toISOString().replaceAll(":", "-")}-${reason}.db`,
  );
  let staging: string | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    staging = mkdtempSync(join(directory, ".snapshot-"));
    const copy = join(staging, "copy.db");
    sqlite.run("VACUUM INTO ?", [copy]);
    checkIntegrity(copy);
    chmodSync(copy, 0o600);
    sync(copy);
    for (;;) {
      target = join(
        directory,
        `open-dot-${new Date().toISOString().replaceAll(":", "-")}-${reason}.db`,
      );
      try {
        linkSync(copy, target);
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        Bun.sleepSync(1);
      }
    }
    sync(directory);
    sync(dirname(directory));
  } catch (error) {
    throw new Error(
      `Database backup failed at ${target}; migration/restore was not run: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

function prune(path: string) {
  const directory = join(dirname(path), "backups");
  const backups = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^open-dot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-(manual|before-[\w-]+)\.db$/.test(
          entry.name,
        ),
    )
    .map((entry) => entry.name)
    .toSorted()
    .toReversed();
  for (const file of backups.slice(10)) rmSync(join(directory, file));
}

export function backupDatabase(path: string) {
  path = canonical(path);
  const release = lock(`${path}.migration-lock`, 60_000);
  let sqlite: Database | undefined;
  try {
    sqlite = existing(path);
    const backup = snapshot(sqlite, path, "manual");
    prune(path);
    return backup;
  } finally {
    sqlite?.close();
    release();
  }
}

export function restoreDatabase(path: string, source: string) {
  path = canonical(path);
  source = realpathSync(source);
  if (path === source)
    throw new Error("Restore source is the current database; choose a backup file.");
  const releaseDaemon = claimDaemon(path);
  try {
    const release = lock(`${path}.migration-lock`, 60_000);
    let current: Database | undefined;
    let input: Database | undefined;
    let staging: string | undefined;
    let backup: string | undefined;
    let phase: "preparing" | "replacing" | "checking restored database" | "pruning" = "preparing";
    try {
      checkIntegrity(source);
      input = existing(source);
      staging = mkdtempSync(`${path}.restore-`);
      const staged = join(staging, "copy.db");
      input.run("VACUUM INTO ?", [staged]);
      checkIntegrity(staged);
      input.close();
      input = undefined;
      current = existing(path);
      backup = snapshot(current, path, "before-restore");
      current.close();
      current = undefined;
      // SQLite's backup API replaces pages in place, preserving existing connections and WAL safety.
      const quoted = JSON.stringify(staged);
      phase = "replacing";
      const restored = Bun.spawnSync(["sqlite3", "-batch", "-bail", path], {
        stdin: Buffer.from(`.timeout 5000\n.restore ${quoted}\n`),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (restored.exitCode !== 0) throw new Error(restored.stderr.toString().trim());
      phase = "checking restored database";
      checkIntegrity(path);
      phase = "pruning";
      prune(path);
      return backup;
    } catch (error) {
      const state =
        phase === "preparing"
          ? "Database replacement was not attempted."
          : phase === "replacing"
            ? "Database replacement was attempted; inspect its state before retrying."
            : "Database replacement completed.";
      throw new Error(
        `Restore failed during ${phase} for ${path} from ${source}. ${state}${backup ? ` Previous database backup: ${backup}.` : ""} ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      input?.close();
      current?.close();
      if (staging) rmSync(staging, { recursive: true, force: true });
      release();
    }
  } finally {
    releaseDaemon();
  }
}

export function openDatabase(path: string) {
  if (path !== ":memory:") path = canonical(path);
  const sqlite = new Database(path, { create: true });
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    const db = drizzle({ client: sqlite, schema });
    if (pending(sqlite)) {
      const release = path === ":memory:" ? () => {} : lock(`${path}.migration-lock`, 60_000);
      try {
        const first = pending(sqlite);
        if (first) {
          if (path !== ":memory:") snapshot(sqlite, path, `before-${first.tag}`);
          migrate(db, { migrationsFolder: join(import.meta.dir, "..", "drizzle") });
          if (path !== ":memory:") prune(path);
        }
      } finally {
        release();
      }
    }
    sqlite.exec("PRAGMA journal_mode = WAL");
    return db;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type Db = ReturnType<typeof openDatabase>;
