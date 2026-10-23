import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { validName } from "./dots";
import { home } from "./home";

/** The most UTF-8 bytes of instructions the notch reads or saves. */
export const instructionsLimit = 64 * 1024;
/** How many earlier versions are kept for revert. */
export const historyLimit = 10;

/** Exactly the dot's own AGENTS.md under OPEN_DOT_HOME, never the directory saved in the database. */
export const instructionsPath = (name: string) => join(home(), "dots", name, "AGENTS.md");

export type Instructions = {
  readonly content: string;
  readonly revision: string;
  readonly canRevert: boolean;
};

type Failure = { readonly status: 404 | 413 | 422; readonly error: string };

export type InstructionsOutcome =
  | { readonly saved: Instructions }
  | { readonly conflict: Instructions }
  | Failure;

const historyName = /^(\d{12})\.md$/;

const revisionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Whether a value can be saved: well-formed text without NUL, at most the limit in UTF-8. */
export const isInstructionsText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.isWellFormed() &&
  !value.includes("\0") &&
  Buffer.byteLength(value, "utf8") <= instructionsLimit;

export const isRevision = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const isRealDirectory = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

const missing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

type Place = { readonly directory: string; readonly file: string; readonly history: string };

/** The dot's directory and files, refused when `dots/` or the dot's directory isn't a real directory. */
const locate = (name: string): Place | Failure => {
  if (!validName.test(name)) return { status: 404, error: "There's no such dot." };
  const dots = join(home(), "dots");
  const directory = join(dots, name);
  if (!isRealDirectory(dots) || !isRealDirectory(directory))
    return {
      status: 422,
      error: `${directory} isn't a real directory, so its instructions aren't read or written here.`,
    };
  return {
    directory,
    file: join(directory, "AGENTS.md"),
    history: join(directory, ".instructions-history"),
  };
};

type Text = { readonly bytes: Buffer; readonly mode: number };

/**
 * A file's bytes, opened without following a link: only a regular file whose inode still matches
 * the path, at most the limit, holding UTF-8 text. Undefined when nothing is there.
 */
const readText = (path: string, label: string): Text | undefined | Failure => {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (cause) {
    if (missing(cause)) return undefined;
    throw cause;
  }
  const refused = {
    status: 422,
    error: `${label} isn't a regular file, so it isn't read or replaced here.`,
  } as const;
  if (!before.isFile()) return refused;
  // Non-blocking, so a FIFO swapped in can't hang the daemon.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) return refused;
    const tooLarge = {
      status: 413,
      error: `${label} is over 64 KiB, so the notch can't edit it. Edit the file in an editor instead.`,
    } as const;
    if (info.size > instructionsLimit) return tooLarge;
    // One byte past the limit, so growth since the stat is noticed rather than cut off.
    const buffer = Buffer.alloc(instructionsLimit + 1);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, null);
      if (count === 0) break;
      read += count;
    }
    if (read > instructionsLimit) return tooLarge;
    const bytes = buffer.subarray(0, read);
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      return { status: 422, error: `${label} isn't UTF-8 text, so the notch can't edit it.` };
    }
    if (text.includes("\0"))
      return { status: 422, error: `${label} contains NUL bytes, so the notch can't edit it.` };
    return { bytes: Buffer.from(bytes), mode: info.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
};

type Entry = { readonly number: number; readonly path: string };

/**
 * The kept versions, oldest first: regular files named by a sequence number. Undefined when the
 * history directory is there but isn't a real directory, so nothing may be kept or reverted.
 */
const listHistory = (place: Place): Entry[] | undefined => {
  try {
    lstatSync(place.history);
  } catch (cause) {
    if (missing(cause)) return [];
    throw cause;
  }
  if (!isRealDirectory(place.history)) return undefined;
  return readdirSync(place.history)
    .flatMap((name) => {
      const number = historyName.exec(name)?.[1];
      if (number === undefined) return [];
      const path = join(place.history, name);
      try {
        return lstatSync(path).isFile() ? [{ number: Number(number), path }] : [];
      } catch {
        return [];
      }
    })
    .toSorted((a, b) => a.number - b.number);
};

/** The highest sequence number of any name in the history, kept or not, so nothing is clobbered. */
const nextNumber = (place: Place) =>
  readdirSync(place.history).reduce(
    (highest, name) => Math.max(highest, Number(historyName.exec(name)?.[1] ?? 0)),
    0,
  ) + 1;

const syncDirectory = (directory: string) => {
  try {
    const fd = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best effort: the rename is already atomic.
  }
};

/**
 * Writes the bytes to a new temporary file in the directory, syncs it and renames it over `name`,
 * so the old file stays whole until the rename. A failure removes the temporary file.
 */
const writeAtomically = (directory: string, name: string, bytes: Buffer, mode: number) => {
  const temporary = join(
    directory,
    `.instructions-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const fd = openSync(temporary, "wx", mode);
    try {
      let written = 0;
      while (written < bytes.length)
        written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(directory, name));
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause;
  }
  syncDirectory(directory);
};

const view = (bytes: Buffer, canRevert: boolean): Instructions => ({
  content: decoder.decode(bytes),
  revision: revisionOf(bytes),
  canRevert,
});

const hasHistory = (history: readonly Entry[] | undefined) => (history?.length ?? 0) > 0;

type Current = {
  readonly place: Place;
  readonly text: Text | undefined;
  readonly history: Entry[] | undefined;
};

const current = (name: string): Current | Failure => {
  const place = locate(name);
  if ("status" in place) return place;
  const text = readText(place.file, "AGENTS.md");
  if (text && "status" in text) return text;
  return { place, text, history: listHistory(place) };
};

const empty = Buffer.alloc(0);

/** The dot's instructions as they are now. A missing AGENTS.md reads as empty. */
export function readInstructions(name: string): Instructions | Failure {
  const now = current(name);
  if ("status" in now) return now;
  return view(now.text?.bytes ?? empty, hasHistory(now.history));
}

const unsafeHistory = (place: Place): Failure => ({
  status: 422,
  error: `${place.history} isn't a real directory, so earlier versions aren't kept or put back. Nothing was changed.`,
});

/**
 * Replaces AGENTS.md only if it's still the revision the owner saw. The old text is kept first as
 * the newest version in the history, then the new text is renamed into place; any failure before
 * the rename removes that copy and leaves AGENTS.md as it was. Everything runs synchronously, so
 * two requests in this daemon can't both pass the revision check.
 */
export function saveInstructions(
  name: string,
  content: string,
  revision: string,
): InstructionsOutcome {
  const now = current(name);
  if ("status" in now) return now;
  const { place, text, history } = now;
  const before = text?.bytes ?? empty;
  if (revisionOf(before) !== revision) return { conflict: view(before, hasHistory(history)) };
  const bytes = Buffer.from(content, "utf8");
  if (bytes.equals(before)) return { saved: view(before, hasHistory(history)) };
  if (!history) return unsafeHistory(place);
  let kept: string | undefined;
  try {
    if (text) {
      if (!isRealDirectory(place.history)) {
        mkdirSync(place.history, { mode: 0o700 });
        if (!isRealDirectory(place.history)) return unsafeHistory(place);
      }
      const entry = `${String(nextNumber(place)).padStart(12, "0")}.md`;
      writeAtomically(place.history, entry, before, 0o600);
      kept = join(place.history, entry);
    }
    writeAtomically(place.directory, "AGENTS.md", bytes, text?.mode ?? 0o644);
  } catch (cause) {
    if (kept) rmSync(kept, { force: true });
    throw cause;
  }
  prune(place);
  return { saved: view(bytes, kept !== undefined || hasHistory(history)) };
}

/** Removes the oldest kept versions past the limit. A failure here never undoes a save. */
const prune = (place: Place) => {
  try {
    const entries = listHistory(place) ?? [];
    for (const entry of entries.slice(0, Math.max(0, entries.length - historyLimit)))
      rmSync(entry.path, { force: true });
  } catch (cause) {
    console.error(
      `Instructions history: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

/**
 * Puts back the newest kept version, if AGENTS.md is still the revision the owner saw, and then
 * drops that version from the history, so each revert steps one version further back. The text
 * it replaces isn't kept. A failure before the rename leaves both files as they were.
 */
export function revertInstructions(name: string, revision: string): InstructionsOutcome {
  const now = current(name);
  if ("status" in now) return now;
  const { place, text, history } = now;
  const before = text?.bytes ?? empty;
  if (revisionOf(before) !== revision) return { conflict: view(before, hasHistory(history)) };
  if (!history) return unsafeHistory(place);
  const newest = history.at(-1);
  if (!newest) return { status: 404, error: "There's no earlier version to revert to." };
  const previous = readText(newest.path, "The earlier version");
  if (!previous) return { status: 404, error: "There's no earlier version to revert to." };
  if ("status" in previous) return previous;
  writeAtomically(place.directory, "AGENTS.md", previous.bytes, text?.mode ?? 0o644);
  try {
    rmSync(newest.path, { force: true });
    syncDirectory(place.history);
  } catch (cause) {
    // AGENTS.md is already reverted; the next revert would put this same text back.
    console.error(
      `Instructions history: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  let left = history.length > 1;
  try {
    left = hasHistory(listHistory(place));
  } catch {
    // Keep the count from before the revert.
  }
  return { saved: view(previous.bytes, left) };
}
