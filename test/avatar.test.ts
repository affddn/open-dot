import { afterEach, beforeEach, expect, test } from "bun:test";
import {
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
import { deflateSync } from "node:zlib";
import { Effect, Layer } from "effect";
import { api } from "../src/api";
import { avatarLimit, avatarPath, avatarRevision, checkAvatar, setAvatar } from "../src/avatar";
import { type Db, openDatabase } from "../src/db";
import { OpenCode, OpenCodeError } from "../src/opencode";
import { dots, slackApps } from "../src/schema";
import { describe as slackStatus } from "../src/slack-setup";
import { fakeOpenCode } from "./fake-opencode";

let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;
let home: string;
let previousHome: string | undefined;

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
};

const header = (width: number, height: number) => {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  // 8-bit RGB, deflate, no interlacing.
  data.set([8, 2, 0, 0, 0], 8);
  return chunk("IHDR", data);
};

/** A PNG's chunks around the given image data, which need not decode. */
const pngOf = (width: number, height: number, data: Buffer) =>
  Buffer.concat([
    signature,
    header(width, height),
    chunk("IDAT", data),
    chunk("IEND", Buffer.alloc(0)),
  ]);

/**
 * A real, decodable RGB PNG. Its first `noisy` rows are pseudo-random, so it compresses like a
 * real image: 372 noisy rows make a 1254-pixel one about 1.4 MB, like the real avatars.
 */
const png = (width: number, height: number, noisy = 4) => {
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  let seed = width;
  for (let y = 0; y < Math.min(noisy, height); y++)
    for (let x = 1; x < row; x++) {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      raw[y * row + x] = seed >>> 24;
    }
  return pngOf(width, height, deflateSync(raw));
};

/** A real JPEG, encoded by macOS from a real PNG. */
const jpeg = (width: number, height: number) => {
  const directory = mkdtempSync(join(home, "jpeg-"));
  writeFileSync(join(directory, "in.png"), png(width, height, 16));
  const sips = Bun.spawnSync(
    ["/usr/bin/sips", "-s", "format", "jpeg", "in.png", "--out", "out.jpg"],
    { cwd: directory, stdout: "ignore", stderr: "pipe" },
  );
  if (sips.exitCode !== 0) throw new Error(`sips: ${sips.stderr.toString()}`);
  return readFileSync(join(directory, "out.jpg"));
};

const isFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
const isScan = (marker: number) => marker === 0xda;

/** Where a header segment of a real JPEG starts and ends, found by walking to its first scan. */
const segment = (photo: Buffer, wanted: (marker: number) => boolean) => {
  let at = 2;
  for (;;) {
    const marker = photo.readUInt8(at + 1);
    const end = at + 2 + photo.readUInt16BE(at + 2);
    if (wanted(marker)) return { at, end };
    if (isScan(marker)) throw new Error("No such segment before the scan");
    at = end;
  }
};

beforeEach(() => {
  previousHome = process.env.OPEN_DOT_HOME;
  home = mkdtempSync(join(tmpdir(), "open-dot-avatar-"));
  process.env.OPEN_DOT_HOME = home;
  db = openDatabase(":memory:");
  fake = fakeOpenCode();
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

const call = (
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
  layer: Layer.Layer<OpenCode, OpenCodeError> = fake.layer,
) =>
  api(
    db,
    "secret",
    layer,
  )(
    new Request(`http://127.0.0.1${path}`, {
      ...init,
      headers: { authorization: "Bearer secret", ...init.headers },
    }),
  );

const listed = async () => {
  const body = (await (await call("/dots")).json()) as { name: string; avatar: unknown }[];
  return Object.fromEntries(body.map((dot) => [dot.name, dot.avatar]));
};

const revision = async (name: string) =>
  ((await listed())[name] as { revision: string } | null)?.revision ?? null;

test("the route serves exactly the dot's avatar with the token, and /dots tracks each revision", async () => {
  expect(await listed()).toEqual({ jojo: null, polnareff: null });
  expect((await call("/dots/jojo/avatar")).status).toBe(404);

  const image = png(1254, 1254, 372);
  expect(image.length).toBeGreaterThan(1_300_000);
  writeFileSync(avatarPath("jojo"), image);
  expect(
    (await call("/dots/jojo/avatar", { headers: { authorization: "Bearer wrong" } })).status,
  ).toBe(401);
  const served = await call("/dots/jojo/avatar");
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await served.arrayBuffer()).equals(image)).toBe(true);
  const first = await revision("jojo");
  expect(first).toBeString();
  expect(await revision("polnareff")).toBeNull();
  expect(await revision("jojo")).toBe(first);

  // Replaced the way the CLI does it, with a JPEG, then rewritten in place: each is a new revision.
  const photo = jpeg(600, 600);
  writeFileSync(join(home, "replacement.jpg"), photo);
  expect(setAvatar("jojo", join(home, "replacement.jpg"))).toMatchObject({ mime: "image/jpeg" });
  const second = await revision("jojo");
  expect(second).not.toBe(first);
  const replaced = await call("/dots/jojo/avatar");
  expect(replaced.headers.get("content-type")).toBe("image/jpeg");
  expect(Buffer.from(await replaced.arrayBuffer()).equals(photo)).toBe(true);
  writeFileSync(avatarPath("jojo"), png(700, 700));
  expect(await revision("jojo")).not.toBe(second);

  rmSync(avatarPath("jojo"));
  expect(await revision("jojo")).toBeNull();
  expect((await call("/dots/jojo/avatar")).status).toBe(404);
});

test("the route needs no OpenCode, and nothing in the request reaches another file", async () => {
  const image = png(256, 256);
  writeFileSync(avatarPath("jojo"), image);
  writeFileSync(join(home, "dots", "avatar.png"), image);
  writeFileSync(join(home, "avatar.png"), image);
  const down = Layer.effect(OpenCode, Effect.fail(new OpenCodeError({ message: "Not running" })));
  expect((await call("/dots/jojo/avatar", {}, down)).status).toBe(200);
  for (const path of [
    "/dots/%2e%2e/avatar",
    "/dots/..%2F..%2Fjojo/avatar",
    "/dots/jojo%2F..%2Fpolnareff/avatar",
    "/dots/missing/avatar",
    "/dots/%E0%A4%A/avatar",
    "/dots/jojo/avatar/x",
    "/dots/jojo/avatar.png",
  ])
    expect((await call(path)).status).toBe(404);
  expect((await call("/dots/jojo/avatar", { method: "PUT" })).status).toBe(404);
  expect((await call("/dots/jojo/avatar", { method: "DELETE" })).status).toBe(404);
  expect(readFileSync(avatarPath("jojo")).equals(image)).toBe(true);
});

test("links anywhere on the path, non-files and broken or oversized files are never served", async () => {
  const outside = join(home, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "avatar.png"), png(256, 256));

  symlinkSync(join(outside, "avatar.png"), avatarPath("jojo"));
  expect((await call("/dots/jojo/avatar")).status).toBe(404);
  expect(await revision("jojo")).toBeNull();
  rmSync(avatarPath("jojo"));

  rmSync(join(home, "dots", "polnareff"), { recursive: true });
  symlinkSync(outside, join(home, "dots", "polnareff"));
  expect((await call("/dots/polnareff/avatar")).status).toBe(404);
  expect(await revision("polnareff")).toBeNull();

  const real = join(home, "real-dots");
  mkdirSync(join(real, "jojo"), { recursive: true });
  writeFileSync(join(real, "jojo", "avatar.png"), png(256, 256));
  rmSync(join(home, "dots"), { recursive: true });
  symlinkSync(real, join(home, "dots"));
  expect((await call("/dots/jojo/avatar")).status).toBe(404);
  expect(await revision("jojo")).toBeNull();
  rmSync(join(home, "dots"));

  mkdirSync(join(home, "dots", "jojo", "avatar.png"), { recursive: true });
  expect((await call("/dots/jojo/avatar")).status).toBe(404);
  rmSync(join(home, "dots", "jojo", "avatar.png"), { recursive: true });

  for (const broken of [Buffer.from("<svg/>"), png(256, 256).subarray(0, -1)]) {
    writeFileSync(avatarPath("jojo"), broken);
    expect((await call("/dots/jojo/avatar")).status).toBe(415);
  }
  writeFileSync(avatarPath("jojo"), Buffer.alloc(avatarLimit + 1));
  expect((await call("/dots/jojo/avatar")).status).toBe(413);
  expect(await revision("jojo")).toBeNull();
});

test("the structure check takes whole, roughly square PNGs and JPEGs and refuses broken ones", () => {
  expect(checkAvatar(png(1254, 1254, 372))).toEqual({
    mime: "image/png",
    width: 1254,
    height: 1254,
  });
  const photo = jpeg(512, 540);
  expect(checkAvatar(photo)).toEqual({ mime: "image/jpeg", width: 512, height: 540 });
  expect(checkAvatar(png(128, 128))).toMatchObject({ width: 128 });
  // Sizes only: this data doesn't decode, which only setAvatar checks.
  const empty = deflateSync(Buffer.alloc(1));
  expect(checkAvatar(pngOf(4096, 4096, empty))).toMatchObject({ width: 4096 });
  expect(checkAvatar(pngOf(4097, 4097, empty))).toContain("4097×4097");

  const good = png(256, 256);
  // One byte of the image data changed, so its chunk's CRC no longer matches.
  const flipped = Buffer.from(good);
  const inData = signature.length + 25 + 8 + 4;
  flipped.writeUInt8(flipped.readUInt8(inData) ^ 0xff, inData);
  const noData = Buffer.concat([signature, header(256, 256), chunk("IEND", Buffer.alloc(0))]);
  const dataFirst = Buffer.concat([
    signature,
    chunk("IDAT", empty),
    header(256, 256),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const overrun = Buffer.from(photo);
  overrun.writeUInt16BE(0xffff, 4);
  const frameOnly = photo.subarray(0, segment(photo, isScan).at);
  for (const bad of [
    png(127, 127),
    png(1254, 800),
    jpeg(300, 600),
    noData,
    dataFirst,
    flipped,
    good.subarray(0, -1),
    good.subarray(0, Math.floor(good.length / 2)),
    Buffer.concat([good, Buffer.from([0])]),
    photo.subarray(0, -2),
    photo.subarray(0, Math.floor(photo.length / 2)),
    Buffer.concat([photo, Buffer.from("junk")]),
    Buffer.concat([frameOnly, Buffer.from([0xff, 0xd9])]),
    overrun,
    Buffer.from("GIF89a"),
    Buffer.from("not an image"),
    Buffer.alloc(0),
    pngOf(1254, 1254, Buffer.alloc(avatarLimit)),
  ])
    expect(checkAvatar(bad)).toBeString();
});

test("a JPEG is walked through its scans to the end-of-image marker that ends it, with one frame", () => {
  const photo = jpeg(512, 512);
  const frame = segment(photo, isFrame);
  const scan = segment(photo, isScan);
  const body = photo.subarray(0, -2);
  const end = Buffer.from([0xff, 0xd9]);
  expect(checkAvatar(photo)).toEqual({ mime: "image/jpeg", width: 512, height: 512 });

  // Stuffed bytes, a restart marker and fill bytes are all scan data.
  const restarted = Buffer.concat([body, Buffer.from([0xff, 0xd0, 0x12, 0xff, 0x00, 0xff]), end]);
  expect(checkAvatar(restarted)).toMatchObject({ width: 512 });
  // A progressive JPEG's one frame (SOF2) with two scans, each with data. Structure only.
  const progressive = Buffer.concat([body, photo.subarray(scan.at, -2), end]);
  progressive.writeUInt8(0xc2, frame.at + 1);
  expect(checkAvatar(progressive)).toMatchObject({ width: 512, height: 512 });

  // A first frame that claims another size, before the real one.
  const oversized = Buffer.from(photo.subarray(frame.at, frame.end));
  oversized.writeUInt16BE(9000, 5);
  oversized.writeUInt16BE(9000, 7);
  const twoFrames = Buffer.concat([
    photo.subarray(0, frame.at),
    oversized,
    photo.subarray(frame.at),
  ]);
  // A second frame after the scan.
  const frameAfterScan = Buffer.concat([body, photo.subarray(frame.at, frame.end), end]);
  // A whole JPEG, then junk and another end marker.
  const junkThenEnd = Buffer.concat([photo, Buffer.from("junk"), end]);
  // A scan with no data before the end.
  const emptyScan = Buffer.concat([photo.subarray(0, scan.end), end]);
  // A second start-of-image inside it.
  const restartedImage = Buffer.concat([body, Buffer.from([0xff, 0xd8]), end]);
  for (const bad of [twoFrames, frameAfterScan, junkThenEnd, emptyScan, restartedImage])
    expect(checkAvatar(bad)).toBeString();
});

test("setting an avatar decodes it, keeps its exact bytes, and a refusal leaves the current one", () => {
  const source = join(home, "in.png");
  const image = png(1254, 1254, 372);
  writeFileSync(source, image);
  expect(setAvatar("jojo", source)).toEqual({ mime: "image/png", width: 1254, height: 1254 });
  expect(readFileSync(avatarPath("jojo")).equals(image)).toBe(true);
  expect(readFileSync(source).equals(image)).toBe(true);
  expect(readdirSync(join(home, "dots", "jojo"))).toEqual(["avatar.png"]);

  // Whole chunks with good checksums, but image data that isn't compressed pixels.
  const undecodable = pngOf(256, 256, Buffer.from("not deflated pixel data at all"));
  expect(checkAvatar(undecodable)).toMatchObject({ width: 256 });
  for (const bad of [
    undecodable,
    png(1254, 600),
    png(256, 256).subarray(0, -1),
    jpeg(256, 256).subarray(0, -2),
    Buffer.from("text"),
    Buffer.alloc(avatarLimit + 1, 0xff),
  ]) {
    writeFileSync(source, bad);
    expect(setAvatar("jojo", source)).toBeString();
  }
  expect(setAvatar("jojo", join(home, "missing.png"))).toBeString();
  expect(setAvatar("jojo", home)).toBeString();
  expect(setAvatar("../jojo", source)).toBeString();
  expect(readFileSync(avatarPath("jojo")).equals(image)).toBe(true);
  expect(readdirSync(join(home, "dots", "jojo"))).toEqual(["avatar.png"]);

  // A JPEG keeps its own bytes in avatar.png, and a link in its place is replaced, never written through.
  const target = join(home, "target.png");
  writeFileSync(target, "keep");
  rmSync(avatarPath("jojo"));
  symlinkSync(target, avatarPath("jojo"));
  const photo = jpeg(300, 300);
  writeFileSync(source, photo);
  expect(setAvatar("jojo", source)).toMatchObject({ mime: "image/jpeg" });
  expect(readFileSync(target, "utf8")).toBe("keep");
  expect(readFileSync(avatarPath("jojo")).equals(photo)).toBe(true);
});

test("open-dot avatar copies a checked image and keeps the old one on a refusal", () => {
  const disk = openDatabase(join(home, "open-dot.db"));
  disk
    .insert(dots)
    .values({
      name: "jojo",
      directory: join(home, "dots", "jojo"),
      sessionID: "ses_jojo",
      sessionState: "ready",
      purpose: null,
      createdAt: 0,
    })
    .run();
  disk.$client.close();
  const cli = (...args: string[]) => {
    const spawned = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...Bun.env, OPEN_DOT_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    return {
      exit: spawned.exitCode,
      out: spawned.stdout.toString() + spawned.stderr.toString(),
    };
  };
  const good = png(1254, 1254, 16);
  writeFileSync(join(home, "good.png"), good);
  writeFileSync(join(home, "wide.png"), png(1254, 600));

  const saved = cli("avatar", "jojo", join(home, "good.png"));
  expect(saved.exit).toBe(0);
  expect(saved.out).toContain("1254×1254");
  expect(saved.out).not.toContain("Warning");
  expect(readFileSync(avatarPath("jojo")).equals(good)).toBe(true);

  // A valid avatar outside Slack's 512 to 2000 pixels is saved, with a warning about its app icon.
  const small = png(300, 300, 16);
  writeFileSync(join(home, "small.png"), small);
  const warned = cli("avatar", "jojo", join(home, "small.png"));
  expect(warned.exit).toBe(0);
  expect(warned.out).toContain("Warning: Slack app icons must be 512 to 2000 pixels a side");
  expect(readFileSync(avatarPath("jojo")).equals(small)).toBe(true);
  writeFileSync(join(home, "good.png"), good);
  expect(cli("avatar", "jojo", join(home, "good.png")).exit).toBe(0);

  const refused = cli("avatar", "jojo", join(home, "wide.png"));
  expect(refused.exit).toBe(1);
  expect(refused.out).toContain("use a square image");
  expect(refused.out).toContain("avatar is unchanged");
  expect(readFileSync(avatarPath("jojo")).equals(good)).toBe(true);

  expect(cli("avatar", "nobody", join(home, "good.png")).exit).toBe(1);
});

test("slack status says the daemon sets the icon, and names the avatar file only once Slack refuses", () => {
  db.insert(slackApps)
    .values({ dot: "jojo", state: "created", appID: "A0123", createdAt: 0, updatedAt: 0 })
    .run();
  const app = () => {
    const row = db.select().from(slackApps).get();
    if (!row) throw new Error("no app");
    return row;
  };
  const status = () => slackStatus(db, app());
  expect(status()).toContain(
    "open-dot avatar jojo <file>, and the daemon sets it as the app's icon",
  );
  expect(status()).not.toContain("no API");
  writeFileSync(avatarPath("jojo"), png(512, 512));
  expect(status()).toContain(
    `the daemon sets it from ${avatarPath("jojo")} with Slack's apps.icon.set`,
  );
  expect(status()).not.toContain("has no avatar yet");
  expect(status()).not.toContain("App icon & Preview");

  // Slack refused the token: the manual upload comes back, naming Slack's error.
  db.update(slackApps)
    .set({
      iconState: "refused",
      iconAttempt: avatarRevision("jojo"),
      iconError: "not_allowed_token_type",
    })
    .run();
  expect(status()).toContain("Slack refused apps.icon.set (not_allowed_token_type)");
  expect(status()).toContain(`upload ${avatarPath("jojo")} under App icon & Preview`);
});
