import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validName } from "./dots";
import { home } from "./home";

/** The largest avatar saved or served. A real 1254-pixel avatar is about 1.4 MB. */
export const avatarLimit = 8 * 1024 * 1024;
const smallest = 128;
const largest = 4096;
/** How far from square an avatar may be: its longer side over its shorter one. */
const squareness = 1.1;

export const avatarPath = (name: string) => join(home(), "dots", name, "avatar.png");

export type AvatarImage = {
  readonly mime: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
};

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Buffer, prefix: readonly number[]) =>
  prefix.every((byte, index) => bytes[index] === byte);

type Size = { width: number; height: number };

/**
 * A PNG's size if every chunk is whole with a matching CRC, IHDR comes first, there is image
 * data, and IEND ends the file. The image data itself isn't decompressed.
 */
const pngSize = (bytes: Buffer) => {
  let at = pngSignature.length;
  let size: Size | undefined;
  let data = false;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const end = at + 12 + length;
    if (end > bytes.length) return undefined;
    if (Bun.hash.crc32(bytes.subarray(at + 4, end - 4)) >>> 0 !== bytes.readUInt32BE(end - 4))
      return undefined;
    if ((at === pngSignature.length) !== (type === "IHDR")) return undefined;
    if (type === "IHDR") {
      if (length !== 13) return undefined;
      size = { width: bytes.readUInt32BE(at + 8), height: bytes.readUInt32BE(at + 12) };
    }
    if (type === "IDAT") data = true;
    if (type === "IEND") return data && length === 0 && end === bytes.length ? size : undefined;
    at = end;
  }
  return undefined;
};

const isFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

const isRestart = (marker: number | undefined) =>
  marker !== undefined && marker >= 0xd0 && marker <= 0xd7;

/**
 * Where a scan's entropy-coded data ends: at the next marker that isn't a stuffed zero byte, a
 * restart marker or a fill byte.
 */
const scanEnd = (bytes: Buffer, start: number) => {
  let at = start;
  while (at < bytes.length) {
    const next = bytes[at + 1];
    if (bytes[at] !== 0xff) at += 1;
    else if (next === 0x00 || isRestart(next)) at += 2;
    else if (next === 0xff) at += 1;
    else break;
  }
  return at;
};

/**
 * A JPEG's size if its markers and segments, including every scan's data, are whole from start
 * to an end-of-image marker that ends the file, with exactly one frame header, before the first
 * of one or more scans, each with data. The scans aren't decoded.
 */
const jpegSize = (bytes: Buffer) => {
  let at = 2;
  let size: Size | undefined;
  let scans = 0;
  while (at + 2 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd9) return scans > 0 && at + 2 === bytes.length ? size : undefined;
    if (marker === 0x00 || marker === 0xd8 || isRestart(marker)) return undefined;
    if (marker === 0x01) {
      at += 2;
      continue;
    }
    if (at + 4 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(at + 2);
    const end = at + 2 + length;
    if (length < 2 || end > bytes.length) return undefined;
    if (isFrame(marker)) {
      // One frame only: a second could disagree about the size.
      if (size || length < 8) return undefined;
      size = { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at = end;
    if (marker === 0xda) {
      if (!size) return undefined;
      at = scanEnd(bytes, end);
      if (at === end) return undefined;
      scans += 1;
    }
  }
  return undefined;
};

/**
 * The image's type and size if its structure can be an avatar: a whole, roughly square PNG or
 * JPEG within the limits. Else why not. This reads headers, segments and checksums, not pixels,
 * so only `setAvatar` proves an image decodes.
 */
export function checkAvatar(bytes: Buffer): AvatarImage | string {
  if (bytes.length > avatarLimit) return "It's over 8 MiB.";
  let image: AvatarImage;
  if (startsWith(bytes, pngSignature)) {
    const size = pngSize(bytes);
    if (!size) return "It isn't a complete, intact PNG.";
    image = { mime: "image/png", ...size };
  } else if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    const size = jpegSize(bytes);
    if (!size) return "It isn't a complete JPEG.";
    image = { mime: "image/jpeg", ...size };
  } else return "Use a PNG or JPEG image.";
  const short = Math.min(image.width, image.height);
  const long = Math.max(image.width, image.height);
  const size = `It's ${image.width}×${image.height} pixels`;
  if (short < smallest || long > largest)
    return `${size}; use ${smallest} to ${largest} pixels a side.`;
  if (long > short * squareness) return `${size}; use a square image.`;
  return image;
}

/**
 * Why Slack would refuse this avatar as a dot's app icon, since apps.icon.set takes 512 to 2000
 * pixels a side, or undefined when it fits.
 */
export const iconSizeWarning = ({ width, height }: AvatarImage) =>
  Math.min(width, height) < 512 || Math.max(width, height) > 2000
    ? `Warning: Slack app icons must be 512 to 2000 pixels a side, so Slack will refuse this ${width}×${height} image as the dot's app icon (invalid_icon_size). Use one within that size for its Slack app.`
    : undefined;

const isDirectory = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Opens the dot's avatar.png for reading: the file itself is opened without following a link, and
 * must be a regular file; `dots/` and the dot's directory must not be links when checked. Those
 * checks run again after opening, and the open file must still be the one at the path. That
 * narrows, but doesn't close, a race with someone who can write to these directories swapping a
 * parent for a link while it opens.
 */
const openAvatar = (name: string): { fd: number; info: Stats } | undefined => {
  if (!validName.test(name)) return undefined;
  const dots = join(home(), "dots");
  const directory = join(dots, name);
  const path = join(directory, "avatar.png");
  if (!isDirectory(dots) || !isDirectory(directory)) return undefined;
  let fd: number;
  try {
    // Non-blocking, so a FIFO in its place can't hang the daemon.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const info = fstatSync(fd);
    const now = lstatSync(path);
    if (
      info.isFile() &&
      now.ino === info.ino &&
      now.dev === info.dev &&
      isDirectory(dots) &&
      isDirectory(directory)
    )
      return { fd, info };
  } catch {
    // Gone or changed meanwhile.
  }
  closeSync(fd);
  return undefined;
};

/** A token that changes whenever the dot's avatar is replaced or rewritten, or null without one. */
export function avatarRevision(name: string) {
  const opened = openAvatar(name);
  if (!opened) return null;
  closeSync(opened.fd);
  const { info } = opened;
  return info.size > 0 && info.size <= avatarLimit
    ? `${info.ino}-${info.size}-${info.mtimeMs}-${info.ctimeMs}`
    : null;
}

/** Up to one byte past the size the file had, so growth since is noticed rather than read. */
const readAll = (fd: number, size: number) => {
  const buffer = Buffer.alloc(Math.min(size, avatarLimit) + 1);
  let read = 0;
  while (read < buffer.length) {
    const count = readSync(fd, buffer, read, buffer.length - read, null);
    if (count === 0) break;
    read += count;
  }
  return buffer.subarray(0, read);
};

/** The dot's avatar bytes and type, or the HTTP status and reason it can't be served. */
export function readAvatar(
  name: string,
): { bytes: Buffer; mime: string } | { status: 404 | 413 | 415; reason: string } {
  const opened = openAvatar(name);
  if (!opened) return { status: 404, reason: `${name} has no avatar.` };
  try {
    if (opened.info.size > avatarLimit)
      return { status: 413, reason: "The avatar is over the 8 MiB limit." };
    const bytes = readAll(opened.fd, opened.info.size);
    const image =
      bytes.length > opened.info.size ? "It changed while being read." : checkAvatar(bytes);
    if (typeof image === "string")
      return { status: 415, reason: `The avatar can't be shown. ${image}` };
    return { bytes, mime: image.mime };
  } finally {
    closeSync(opened.fd);
  }
}

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Whether macOS decodes the image to the same size: `sips` converts a private copy of exactly
 * these bytes to a PNG, so it never sees the source and leaves nothing behind. Called only once
 * the structure check has bounded the image's bytes and sides.
 */
const decodes = (bytes: Buffer, image: AvatarImage) => {
  let directory: string;
  try {
    directory = mkdtempSync(join(tmpdir(), "open-dot-avatar-"));
  } catch {
    return false;
  }
  try {
    const input = join(directory, image.mime === "image/png" ? "input.png" : "input.jpg");
    const output = join(directory, "decoded.png");
    writeFileSync(input, bytes, { mode: 0o600 });
    const sips = Bun.spawnSync(["/usr/bin/sips", "-s", "format", "png", input, "--out", output], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: 30_000,
    });
    if (sips.exitCode !== 0) return false;
    // Only the signature and header of what sips wrote, however large the rest is.
    const head = Buffer.alloc(24);
    const fd = openSync(output, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (readSync(fd, head, 0, head.length, 0) !== head.length) return false;
    } finally {
      closeSync(fd);
    }
    if (!startsWith(head, pngSignature) || head.toString("latin1", 12, 16) !== "IHDR") return false;
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    // A JPEG's orientation may swap the sides.
    return (
      (width === image.width && height === image.height) ||
      (width === image.height && height === image.width)
    );
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/**
 * Checks the image and that it decodes, then copies its original bytes to the dot's avatar.png
 * through a temporary file and a rename, so any failure leaves the current avatar as it was. The
 * source is only read, once.
 */
export function setAvatar(name: string, source: string): AvatarImage | string {
  if (!validName.test(name)) return `"${name}" isn't a dot name.`;
  let bytes: Buffer;
  try {
    const fd = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) return "It isn't a regular file.";
      if (info.size > avatarLimit) return "It's over 8 MiB.";
      bytes = readAll(fd, info.size);
      if (bytes.length > info.size) return "It changed while being read.";
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    return `Couldn't read it: ${reason(cause)}`;
  }
  const image = checkAvatar(bytes);
  if (typeof image === "string") return image;
  if (!decodes(bytes, image)) return "macOS couldn't decode it as an image.";
  const directory = join(home(), "dots", name);
  if (!isDirectory(join(home(), "dots")) || !isDirectory(directory))
    return `${directory} isn't a directory.`;
  const temporary = join(directory, `.avatar-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(directory, "avatar.png"));
  } catch (cause) {
    rmSync(temporary, { force: true });
    return `Couldn't save it: ${reason(cause)}`;
  }
  return image;
}
