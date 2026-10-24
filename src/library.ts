import { dlopen, FFIType, read, toArrayBuffer } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { constants as os } from "node:os";
import { dirname } from "node:path";
import { and, count, desc, eq, lt, sum } from "drizzle-orm";
import type { Db } from "./db";
import { validName } from "./dots";
import { home, outputDirectory } from "./home";
import { type Artifact, artifacts, workers } from "./schema";

/** The most bytes one deliverable may have. */
export const artifactSizeLimit = 10 * 1024 * 1024;
/** The most deliverables, and their most bytes in all, one dot's Library holds. */
export const artifactCountLimit = 200;
export const artifactTotalLimit = 200 * 1024 * 1024;
/** Library pages hold this many, newest first. */
export const libraryPageSize = 50;
const pathLimit = 1024;
const depthLimit = 16;
const segmentLimit = 255;

/** The only deliverables a Library takes, by file extension. */
const types: Readonly<Record<string, Artifact["mime"]>> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  pdf: "application/pdf",
};

/**
 * A list says a copy is `present`, private and of its saved size, without reading it; reading it
 * for details or a download also checks its SHA-256, and says `verified`. A copy that's gone is
 * `missing`, and anything else wrong with it, or with the directories above it, `corrupt`.
 */
export type ArtifactStatus = "present" | "verified" | "missing" | "corrupt";

/**
 * The path's segments under the worker's output directory, or why it's refused. It's relative to
 * that directory, or absolute inside it, and plain: no URL, colon, backslash, control character,
 * empty, `.` or `..` segment.
 */
export function outputPath(value: unknown, root: string): string[] | string {
  if (typeof value !== "string" || value.length === 0 || value.length > pathLimit)
    return `Give a path of 1 to ${pathLimit} characters.`;
  // A colon rules out every URL scheme, file: included, so nothing is ever fetched.
  if (
    Array.from(value).some((character) => {
      const unit = character.charCodeAt(0);
      return unit <= 31 || (unit >= 127 && unit <= 159) || character === "\\" || character === ":";
    })
  )
    return "A deliverable's path has no colon, backslash or control character, so it can't be a URL.";
  const relative = value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value;
  if (relative.startsWith("/") || relative.startsWith("~"))
    return `The path must be inside the worker's output directory, ${root}.`;
  const segments = relative.split("/");
  if (
    segments.length > depthLimit ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment) > segmentLimit,
    )
  )
    return `The path must name a file inside ${root}, without empty, . or .. parts.`;
  return segments;
}

/** The type a deliverable's name and bytes agree on, or why they don't. */
export function deliverableType(
  name: string,
  bytes: Buffer,
): { mime: Artifact["mime"] } | { error: string } {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  const mime = Object.hasOwn(types, extension) ? types[extension] : undefined;
  if (!mime) return { error: "Only .txt, .md, .markdown, .csv and .pdf files can be added." };
  if (mime === "application/pdf")
    return bytes.subarray(0, 5).toString("latin1") === "%PDF-"
      ? { mime }
      : { error: "It doesn't start like a PDF." };
  if (bytes.includes(0)) return { error: "Text can't contain NUL bytes." };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { error: "Text must be UTF-8." };
  }
  return { mime };
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Why a Library operation stopped: something unsafe, or, when `missing`, something absent. */
class Refused extends Error {
  constructor(
    message: string,
    readonly missing = false,
  ) {
    super(message);
  }
}

/** Lets a test act between two file operations, such as swapping a directory. Unset otherwise. */
export const libraryProbe: { at?: (step: string, detail?: string) => void } = {};

// Below OPEN_DOT_HOME, every operation is relative to the descriptor of a directory already opened
// and checked, through macOS's own *at calls in bun:ffi, so a path swapped meanwhile can't
// redirect it. No call passes a variadic argument: openat never creates here, and the one file
// open-dot creates is made by mkostempsat_np, exclusively and 0600. Nothing here deletes a file.
const O_CLOEXEC = 0x1000000;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC;
const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC;
const { EEXIST, ELOOP, ENOENT, ENOTDIR } = os.errno;

const load = () =>
  dlopen("/usr/lib/libSystem.B.dylib", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u16], returns: FFIType.i32 },
    mkostempsat_np: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
    readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
    // oxlint-disable-next-line no-underscore-dangle -- libc's own name for the errno location
    __error: { args: [], returns: FFIType.ptr },
  }).symbols;

let loaded: ReturnType<typeof load> | null | undefined;

/** The calls above, only on macOS on Apple silicon, whose struct dirent layout is read below. */
function libc() {
  if (loaded === undefined) {
    try {
      loaded = process.platform === "darwin" && process.arch === "arm64" ? load() : null;
    } catch {
      loaded = null;
    }
  }
  if (!loaded) throw new Refused("The Library needs macOS on Apple silicon.");
  return loaded;
}

const errno = () => {
  // oxlint-disable-next-line no-underscore-dangle -- libc's own name for the errno location
  const at = libc().__error();
  return at ? read.i32(at, 0) : 0;
};

/** Clears this thread's errno, so a call that reports errors only through it can be told apart. */
const clearErrno = () => {
  // oxlint-disable-next-line no-underscore-dangle -- libc's own name for the errno location
  const at = libc().__error();
  if (!at) throw new Refused("The Library can't be listed.");
  new Int32Array(toArrayBuffer(at, 0, 4))[0] = 0;
};

const cName = (name: string | Buffer) =>
  Buffer.concat([typeof name === "string" ? Buffer.from(name) : name, Buffer.from([0])]);

/** A descriptor, or the negated errno. */
const openAt = (directory: number, name: string | Buffer, flags: number) => {
  const fd = libc().openat(directory, cName(name), flags);
  return fd >= 0 ? fd : -errno();
};

const uid = () => process.getuid?.() ?? -1;

const closeAll = (held: number[]) => {
  for (const fd of held.splice(0).toReversed()) closeSync(fd);
};

const identity = (fd: number) => {
  const info = fstatSync(fd, { bigint: true });
  return `${info.dev}:${info.ino}`;
};

/** The same file, unchanged: identity, size, links, mode, owner and nanosecond times. */
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.nlink === b.nlink &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;

/** A private file open-dot made: the owner's regular file, 0600, with exactly one link. */
const privateFile = (info: BigIntStats) =>
  info.isFile() &&
  Number(info.uid) === uid() &&
  info.nlink === 1n &&
  (Number(info.mode) & 0o7777) === 0o600;

/**
 * Opens OPEN_DOT_HOME, following links above it, which are trusted but checked: the home must be
 * the owner's and writable by no one else, and each directory above it root's or the owner's,
 * and writable by no group or others unless sticky, like /tmp. Nothing here changes their modes.
 */
function openHome() {
  let fd: number;
  try {
    fd = openSync(home(), constants.O_RDONLY | constants.O_DIRECTORY);
  } catch {
    throw new Refused(`${home()} can't be opened.`, true);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o022) !== 0)
      throw new Refused(`${home()} must be your own directory, writable by no one else.`);
    const real = realpathSync(home());
    const now = lstatSync(real);
    if (now.dev !== info.dev || now.ino !== info.ino)
      throw new Refused(`${home()} changed while it was opened.`);
    for (let above = dirname(real); ; above = dirname(above)) {
      const parent = lstatSync(above);
      if (
        (parent.uid !== 0 && parent.uid !== uid()) ||
        ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0)
      )
        throw new Refused(`${above} isn't safe to keep the Library under.`);
      if (above === dirname(above)) break;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error instanceof Refused ? error : new Refused(`${home()} can't be checked.`);
  }
}

/**
 * Opens a directory in `parent` without following a link and checks it is the owner's: exactly
 * 0700 when open-dot manages it, otherwise writable by no one else. With `create`, a missing one
 * is made 0700 first; open-dot sets the mode only of a directory it just made.
 */
function openChild(parent: number, name: string, label: string, managed: boolean, create = false) {
  let made = false;
  if (create) {
    if (libc().mkdirat(parent, cName(name), 0o700) === 0) made = true;
    else if (errno() !== EEXIST) throw new Refused(`${label} couldn't be made.`);
  }
  const fd = openAt(parent, name, directoryFlags);
  if (fd === -ENOENT) throw new Refused(`${label} is missing.`, true);
  if (fd === -ENOTDIR || fd === -ELOOP)
    throw new Refused(`${label} isn't a directory, or is a link.`);
  if (fd < 0) throw new Refused(`${label} can't be opened.`);
  try {
    if (made && (fstatSync(fd).mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
    const info = fstatSync(fd);
    if (!info.isDirectory()) throw new Refused(`${label} isn't a directory.`);
    if (info.uid !== uid()) throw new Refused(`${label} isn't yours.`);
    if (managed && (info.mode & 0o7777) !== 0o700)
      throw new Refused(`${label} must be private (0700).`);
    if (!managed && (info.mode & 0o022) !== 0) throw new Refused(`${label} is writable by others.`);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Opens a worker's output directory, keeping it and every directory above it open in `held`. */
function openOutputRoot(held: number[], dot: string, worker: number, create: boolean) {
  held.push(openHome());
  held.push(openChild(held[0] ?? -1, "outputs", "outputs/", true, create));
  held.push(openChild(held[1] ?? -1, dot, `outputs/${dot}/`, true, create));
  held.push(
    openChild(held[2] ?? -1, String(worker), `Worker #${worker}'s output directory`, true, create),
  );
  return held[3] ?? -1;
}

/** Opens the dot's Library directory, keeping it and every directory above it open in `held`. */
function openStore(held: number[], dot: string, create: boolean) {
  held.push(openHome());
  held.push(openChild(held[0] ?? -1, "library", "library/", true, create));
  held.push(openChild(held[1] ?? -1, dot, `library/${dot}/`, true, create));
  return held[2] ?? -1;
}

/**
 * Makes a new worker's own output directory, and `outputs/` and the dot's directory above it, all
 * 0700. False when it couldn't, or when one that exists isn't the owner's private directory.
 */
export function prepareOutput(dot: string, worker: number) {
  if (!validName.test(dot) || !Number.isSafeInteger(worker)) return false;
  const held: number[] = [];
  try {
    openOutputRoot(held, dot, worker, true);
    return true;
  } catch {
    return false;
  } finally {
    closeAll(held);
  }
}

const chunk = 64 * 1024;

/**
 * Reads an open file of at most the size limit, in chunks, and only when its identity, size,
 * links, mode, owner and nanosecond times are the same before and after, so a write while it's
 * read, even one that keeps its size, is caught.
 */
function readStable(fd: number, before: BigIntStats) {
  const size = Number(before.size);
  const buffer = Buffer.alloc(Math.min(size, artifactSizeLimit) + 1);
  let done = 0;
  while (done < buffer.length) {
    const got = readSync(fd, buffer, done, Math.min(chunk, buffer.length - done), done);
    if (got === 0) break;
    done += got;
    libraryProbe.at?.("chunk");
  }
  return done === size && sameFile(before, fstatSync(fd, { bigint: true }))
    ? buffer.subarray(0, done)
    : undefined;
}

/**
 * Reads a file in the worker's output directory, walking every directory from the home down by
 * descriptor. Each directory open-dot made must still be the owner's and 0700, and each the
 * worker made the owner's and writable by no one else. The file is opened without following a
 * link or blocking on a FIFO, and must be the owner's regular file with exactly one link, so it
 * can't be a second name for a file elsewhere.
 */
function readSource(dot: string, worker: number, segments: string[]) {
  const held: number[] = [];
  try {
    let directory = openOutputRoot(held, dot, worker, false);
    libraryProbe.at?.("directory", String(worker));
    for (const segment of segments.slice(0, -1)) {
      directory = openChild(directory, segment, `${segment}/`, false);
      held.push(directory);
      libraryProbe.at?.("directory", segment);
    }
    const fd = openAt(directory, segments.at(-1) ?? "", readFlags);
    if (fd === -ENOENT) throw new Refused("There's no such file.");
    if (fd === -ELOOP) throw new Refused("That file is a link.");
    if (fd < 0) throw new Refused("That file can't be opened.");
    held.push(fd);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Refused("That isn't a regular file.");
    if (Number(before.uid) !== uid()) throw new Refused("That file isn't yours.");
    if (before.nlink !== 1n)
      throw new Refused("That file has another hard link, so it can't be added.");
    if (before.size > BigInt(artifactSizeLimit))
      throw new Refused(`That file is over the ${artifactSizeLimit / 1024 / 1024} MiB limit.`);
    libraryProbe.at?.("source");
    const bytes = readStable(fd, before);
    if (!bytes) throw new Refused("That file changed while it was read.");
    return bytes;
  } finally {
    closeAll(held);
  }
}

/**
 * What the dot's Library directory physically holds. Every entry counts, saved or not, so a copy
 * a crash left without its row still uses up the caps; anything but a private copy makes the
 * Library unsafe to add to. It stops as soon as the caps are reached with `size` more bytes, so
 * however many files are planted there, it reads at most as many as the count cap; entries it
 * didn't reach can't matter, since adding is refused anyway. A listing that fails part way is
 * refused, never taken as the end.
 */
function physical(store: number, size: number) {
  const listing = openAt(store, ".", directoryFlags);
  if (listing < 0) throw new Refused("The Library can't be listed.");
  const directory = libc().fdopendir(listing);
  if (!directory) {
    closeSync(listing);
    throw new Refused("The Library can't be listed.");
  }
  let held = 0;
  let bytes = 0;
  try {
    for (;;) {
      // readdir answers null both at the end and on an error, which only errno tells apart.
      clearErrno();
      libraryProbe.at?.("readdir");
      const entry = libc().readdir(directory);
      if (!entry) {
        if (errno() !== 0) throw new Refused("The Library can't be listed.");
        break;
      }
      // struct dirent on arm64 macOS: d_namlen is a u16 at 18, and d_name starts at 21.
      const name = Buffer.from(new Uint8Array(toArrayBuffer(entry, 21, read.u16(entry, 18))));
      if (name.toString("latin1") === "." || name.toString("latin1") === "..") continue;
      const fd = openAt(store, name, readFlags);
      if (fd < 0) throw new Refused("The Library holds something that isn't a private copy.");
      try {
        const info = fstatSync(fd, { bigint: true });
        if (!privateFile(info))
          throw new Refused("The Library holds something that isn't a private copy.");
        held += 1;
        bytes += Number(info.size);
      } finally {
        closeSync(fd);
      }
      if (held >= artifactCountLimit || bytes + size > artifactTotalLimit) break;
    }
  } finally {
    libc().closedir(directory);
  }
  return { count: held, bytes };
}

/**
 * Before its row publishes it, a copy must still be a private file holding exactly these bytes,
 * under its name in the dot's Library directory, which must still be `library/<dot>/`.
 */
function verifyCopy(dot: string, store: number, copy: { fd: number; name: string }, bytes: Buffer) {
  const changed = new Refused("The Library's copy changed before it was saved.");
  const info = fstatSync(copy.fd, { bigint: true });
  if (!privateFile(info) || info.size !== BigInt(bytes.length)) throw changed;
  const again = openAt(store, copy.name, readFlags);
  if (again < 0) throw changed;
  try {
    const now = fstatSync(again, { bigint: true });
    const copied = sameFile(info, now) ? readStable(again, now) : undefined;
    if (!copied || !copied.equals(bytes)) throw changed;
  } finally {
    closeSync(again);
  }
  const held: number[] = [];
  try {
    if (identity(openStore(held, dot, false)) !== identity(store))
      throw new Refused("The Library's directory moved while the copy was saved.");
  } finally {
    closeAll(held);
  }
}

const totals = (db: Pick<Db, "select">, dot: string) => {
  const row = db
    .select({ count: count(), bytes: sum(artifacts.size) })
    .from(artifacts)
    .where(eq(artifacts.dot, dot))
    .get();
  return { count: row?.count ?? 0, bytes: Number(row?.bytes ?? 0) };
};

/** Both the saved rows and the copies on disk count against the caps, whichever is more. */
const capped = (
  saved: { count: number; bytes: number },
  stored: { count: number; bytes: number },
  dot: string,
  size: number,
) => {
  if (Math.max(saved.count, stored.count) >= artifactCountLimit)
    return `${dot}'s Library already holds ${artifactCountLimit} deliverables, its most.`;
  if (Math.max(saved.bytes, stored.bytes) + size > artifactTotalLimit)
    return `${dot}'s Library would pass ${artifactTotalLimit / 1024 / 1024} MiB in all.`;
  return undefined;
};

const sameOrigin = (dot: string, worker: number, path: string, sha256: string) =>
  and(
    eq(artifacts.dot, dot),
    eq(artifacts.worker, worker),
    eq(artifacts.path, path),
    eq(artifacts.sha256, sha256),
  );

/**
 * Adds a file one of the dot's own workers saved in its output directory to the dot's Library, as
 * a private copy. The worker, its session and its output directory come from the database, never
 * the caller; only the path inside that directory is the caller's. The same bytes from the same
 * place again return the first copy. Nothing reads a URL or any other directory.
 *
 * The copy is made inside an immediate transaction, so competing processes take turns: the caps
 * are checked against both the rows and the files on disk, a new file is created exclusively,
 * written, synced and checked, and the row is what publishes it. A copy whose publication fails
 * is never removed, since its name may by then be another file; it stays as an orphan that counts
 * against the caps until the owner removes it.
 */
export function addDeliverable(
  db: Db,
  dot: string,
  workerID: number,
  rawPath: unknown,
): { artifact: Artifact; added: boolean } | { error: string } {
  if (!validName.test(dot)) return { error: "That isn't a dot." };
  const worker = Number.isSafeInteger(workerID)
    ? db
        .select()
        .from(workers)
        .where(and(eq(workers.id, workerID), eq(workers.dot, dot)))
        .get()
    : undefined;
  if (!worker) return { error: `Worker #${workerID} isn't one of ${dot}'s workers.` };
  const segments = outputPath(rawPath, outputDirectory(dot, worker.id));
  if (typeof segments === "string") return { error: segments };
  const held: number[] = [];
  try {
    const bytes = readSource(dot, worker.id, segments);
    const name = segments.at(-1) ?? "";
    const type = deliverableType(name, bytes);
    if ("error" in type) return type;
    const path = segments.join("/");
    const sha256 = digest(bytes);
    const found = db
      .select()
      .from(artifacts)
      .where(sameOrigin(dot, worker.id, path, sha256))
      .get();
    if (found) return { artifact: found, added: false };
    const directory = openStore(held, dot, true);
    const saved = db.transaction(
      (tx) => {
        const again = tx
          .select()
          .from(artifacts)
          .where(sameOrigin(dot, worker.id, path, sha256))
          .get();
        if (again) return { artifact: again, added: false };
        const over = capped(totals(tx, dot), physical(directory, bytes.length), dot, bytes.length);
        if (over) return { error: over };
        const template = Buffer.from(`${"X".repeat(32)}\0`);
        const fd = libc().mkostempsat_np(directory, template, 0, O_CLOEXEC);
        if (fd < 0) throw new Refused("The Library's copy couldn't be made.");
        held.push(fd);
        const file = template.toString("latin1", 0, 32);
        libraryProbe.at?.("created", file);
        let written = 0;
        while (written < bytes.length)
          written += writeSync(fd, bytes, written, bytes.length - written, written);
        libraryProbe.at?.("written", file);
        fsyncSync(fd);
        fsyncSync(directory);
        verifyCopy(dot, directory, { fd, name: file }, bytes);
        libraryProbe.at?.("verified", file);
        const artifact = tx
          .insert(artifacts)
          .values({
            dot,
            worker: worker.id,
            sessionID: worker.sessionID,
            path,
            name,
            mime: type.mime,
            size: bytes.length,
            sha256,
            file,
            createdAt: Date.now(),
          })
          .returning()
          .get();
        return { artifact, added: true };
      },
      { behavior: "immediate" },
    );
    return saved;
  } catch (error) {
    if (error instanceof Refused) return { error: error.message };
    throw error;
  } finally {
    closeAll(held);
  }
}

/**
 * Opens an artifact's copy by descriptor from the home down, or says it's missing or corrupt:
 * gone is missing, and anything else wrong with it or the directories above it is corrupt.
 */
function openCopy(held: number[], row: Artifact) {
  if (!/^[A-Za-z0-9]{32}$/.test(row.file)) return "corrupt";
  let store: number;
  try {
    store = openStore(held, row.dot, false);
  } catch (error) {
    if (error instanceof Refused) return error.missing ? "missing" : "corrupt";
    throw error;
  }
  const fd = openAt(store, row.file, readFlags);
  if (fd === -ENOENT) return "missing";
  if (fd < 0) return "corrupt";
  held.push(fd);
  const info = fstatSync(fd, { bigint: true });
  return privateFile(info) && info.size === BigInt(row.size) ? { fd, info } : "corrupt";
}

/** Whether the copy is there, private and of its size, without reading it: for lists. */
export function copyStatus(row: Artifact): ArtifactStatus {
  const held: number[] = [];
  try {
    const opened = openCopy(held, row);
    return typeof opened === "string" ? opened : "present";
  } finally {
    closeAll(held);
  }
}

/** The copy's bytes, only when they still have the saved size and SHA-256. */
export function readArtifact(row: Artifact): { bytes: Buffer } | { status: "missing" | "corrupt" } {
  const held: number[] = [];
  try {
    const opened = openCopy(held, row);
    if (typeof opened === "string") return { status: opened };
    const bytes = readStable(opened.fd, opened.info);
    return bytes && digest(bytes) === row.sha256 ? { bytes } : { status: "corrupt" };
  } finally {
    closeAll(held);
  }
}

export const artifactView = (row: Artifact, status: ArtifactStatus) => ({
  id: row.id,
  name: row.name,
  mime: row.mime,
  size: row.size,
  sha256: row.sha256,
  createdAt: row.createdAt,
  worker: row.worker,
  sessionID: row.sessionID,
  path: row.path,
  status,
});

/** One page of the dot's Library, newest first, each with its copy's unread status. */
export function listArtifacts(db: Db, dot: string, before?: number) {
  const page = db
    .select()
    .from(artifacts)
    .where(
      before === undefined
        ? eq(artifacts.dot, dot)
        : and(eq(artifacts.dot, dot), lt(artifacts.id, before)),
    )
    .orderBy(desc(artifacts.id))
    .limit(libraryPageSize)
    .all();
  return {
    artifacts: page.map((row) => artifactView(row, copyStatus(row))),
    next: page.length === libraryPageSize ? (page.at(-1)?.id ?? null) : null,
  };
}

export const findArtifact = (db: Db, dot: string, id: number) =>
  db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.dot, dot)))
    .get();

/**
 * A download's Content-Disposition: always an attachment, with an ASCII fallback name in which
 * anything but letters, digits, space, `.`, `_`, `-` and parentheses becomes `_`, and the exact
 * name percent-encoded.
 */
export function attachmentDisposition(name: string) {
  const fallback = name.replace(/[^A-Za-z0-9 ._()-]/g, "_").replace(/^[. ]+/, "") || "deliverable";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
