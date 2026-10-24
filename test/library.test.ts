import { afterEach, beforeEach, expect, test } from "bun:test";
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { api } from "../src/api";
import { type Db, openDatabase } from "../src/db";
import { databasePath, libraryDirectory, outputDirectory } from "../src/home";
import {
  addDeliverable,
  artifactCountLimit,
  artifactSizeLimit,
  artifactTotalLimit,
  libraryPageSize,
  libraryProbe,
  prepareOutput,
} from "../src/library";
import { OpenCode, OpenCodeError } from "../src/opencode";
import { artifacts, dots, outbox, workers } from "../src/schema";

let db: Db;
let home: string;
let previousHome: string | undefined;

// The Library needs no OpenCode, so every call runs as if it were down.
const down = Layer.effect(OpenCode, Effect.fail(new OpenCodeError({ message: "Not running" })));

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

const worker = (id: number, dot: string) => {
  db.insert(workers)
    .values({
      id,
      dot,
      task: `Task ${id}.`,
      directory: `/work/${dot}`,
      sessionID: `ses_w${id}`,
      state: "done",
      createdAt: 0,
    })
    .run();
  expect(prepareOutput(dot, id)).toBe(true);
  return outputDirectory(dot, id);
};

beforeEach(() => {
  previousHome = process.env.OPEN_DOT_HOME;
  home = mkdtempSync(join(tmpdir(), "open-dot-library-"));
  process.env.OPEN_DOT_HOME = home;
  db = openDatabase(databasePath());
  for (const name of ["jojo", "polnareff"])
    db.insert(dots)
      .values({
        name,
        directory: join(home, "dots", name),
        sessionID: `ses_${name}`,
        sessionState: "ready",
        createdAt: name === "jojo" ? 0 : 1,
      })
      .run();
  worker(1, "jojo");
  worker(2, "jojo");
  worker(3, "polnareff");
});

afterEach(() => {
  delete libraryProbe.at;
  chmodSync(home, 0o700);
  db.$client.close();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.OPEN_DOT_HOME;
  else process.env.OPEN_DOT_HOME = previousHome;
});

const call = (path: string, init: { method?: string; token?: string } = {}) =>
  api(
    db,
    "secret",
    down,
  )(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${init.token ?? "secret"}` },
    }),
  );

const add = (dot: string, id: number, path: unknown) => {
  const result = addDeliverable(db, dot, id, path);
  return "error" in result ? result.error : result;
};

const added = (dot: string, id: number, path: unknown) => {
  const result = addDeliverable(db, dot, id, path);
  if ("error" in result) throw new Error(result.error);
  return result.artifact;
};

const copies = (dot: string) =>
  readdirSync(libraryDirectory(dot)).filter((f) => !f.startsWith("."));

test("a worker's own file is copied privately with its metadata, and outlives its source", async () => {
  writeFileSync(join(outputDirectory("jojo", 1), "report.md"), "# Findings\n");
  const artifact = added("jojo", 1, "report.md");
  expect(artifact).toMatchObject({
    dot: "jojo",
    worker: 1,
    sessionID: "ses_w1",
    path: "report.md",
    name: "report.md",
    mime: "text/markdown",
    size: 11,
    sha256: sha("# Findings\n"),
  });
  const copy = join(libraryDirectory("jojo"), artifact.file);
  expect(statSync(copy).mode & 0o777).toBe(0o600);
  expect(statSync(libraryDirectory("jojo")).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, "library")).mode & 0o777).toBe(0o700);
  expect(statSync(outputDirectory("jojo", 1)).mode & 0o777).toBe(0o700);

  // Later changes or deletion of the worker's file don't reach the copy.
  writeFileSync(join(outputDirectory("jojo", 1), "report.md"), "# Rewritten\n");
  unlinkSync(join(outputDirectory("jojo", 1), "report.md"));
  const response = await call(`/dots/jojo/library/${artifact.id}/content`);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("# Findings\n");

  // An absolute path inside the worker's own directory works too; adding it unchanged again
  // finds the first copy and stores nothing new.
  writeFileSync(join(outputDirectory("jojo", 1), "data.csv"), "a,b\n1,2\n");
  const csv = added("jojo", 1, join(outputDirectory("jojo", 1), "data.csv"));
  expect(csv.mime).toBe("text/csv");
  expect(add("jojo", 1, "data.csv")).toMatchObject({ added: false, artifact: { id: csv.id } });
  expect(copies("jojo")).toHaveLength(2);
  mkdirSync(join(outputDirectory("jojo", 1), "out"));
  writeFileSync(join(outputDirectory("jojo", 1), "out", "paper.pdf"), "%PDF-1.7\n%%EOF\n");
  expect(added("jojo", 1, "out/paper.pdf")).toMatchObject({
    mime: "application/pdf",
    path: "out/paper.pdf",
    name: "paper.pdf",
  });
});

test("only the dot's own workers count, and a path can't leave that worker's directory", () => {
  writeFileSync(join(outputDirectory("polnareff", 3), "secret.md"), "theirs");
  writeFileSync(join(outputDirectory("jojo", 2), "other.md"), "worker 2's");
  writeFileSync(join(home, "outside.md"), "outside");
  expect(add("jojo", 3, "secret.md")).toContain("isn't one of jojo's workers");
  expect(add("jojo", 99, "secret.md")).toContain("isn't one of jojo's workers");
  expect(add("jojo", 1.5, "other.md")).toContain("isn't one of jojo's workers");
  for (const path of [
    "../2/other.md",
    "../../polnareff/3/secret.md",
    "./other.md",
    "a//b.md",
    join(home, "outside.md"),
    join(outputDirectory("jojo", 2), "other.md"),
    "~/outside.md",
    "",
    7,
  ])
    expect(add("jojo", 1, path)).toBeTypeOf("string");
  // URLs never become reads, local or remote.
  for (const url of [
    "https://example.com/report.md",
    "file:///etc/hosts",
    "file:report.md",
    "C:\\report.md",
  ])
    expect(add("jojo", 1, url)).toContain("can't be a URL");
  expect(add("jojo", 1, "nothing.md")).toBe("There's no such file.");
  expect(db.select().from(artifacts).all()).toEqual([]);
});

test("links, swapped directories, hard links and special files are refused", () => {
  const root = outputDirectory("jojo", 1);
  writeFileSync(join(home, "outside.md"), "outside");
  symlinkSync(join(home, "outside.md"), join(root, "link.md"));
  expect(add("jojo", 1, "link.md")).toBe("That file is a link.");

  // A directory on the path swapped for a link to somewhere else.
  mkdirSync(join(home, "elsewhere"));
  writeFileSync(join(home, "elsewhere", "x.md"), "elsewhere");
  symlinkSync(join(home, "elsewhere"), join(root, "sub"));
  expect(add("jojo", 1, "sub/x.md")).toContain("is a link");

  // The worker's whole output directory swapped for a link to another worker's.
  writeFileSync(join(outputDirectory("jojo", 2), "two.md"), "two");
  renameSync(root, join(home, "old-root"));
  symlinkSync(outputDirectory("jojo", 2), root);
  expect(add("jojo", 1, "two.md")).toContain("is a link");
  unlinkSync(root);
  renameSync(join(home, "old-root"), root);

  // A hard link is a second name for a file outside.
  linkSync(join(home, "outside.md"), join(root, "hard.md"));
  expect(add("jojo", 1, "hard.md")).toContain("another hard link");

  mkdirSync(join(root, "folder.md"));
  expect(add("jojo", 1, "folder.md")).toBe("That isn't a regular file.");
  expect(Bun.spawnSync(["mkfifo", join(root, "pipe.md")]).success).toBe(true);
  expect(add("jojo", 1, "pipe.md")).toBe("That isn't a regular file.");
  expect(db.select().from(artifacts).all()).toEqual([]);
});

test("types, sizes and the Library's count and byte caps are enforced", () => {
  const root = outputDirectory("jojo", 1);
  writeFileSync(join(root, "run.sh"), "echo hi\n");
  writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
  writeFileSync(join(root, "fake.pdf"), "not a pdf");
  writeFileSync(join(root, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
  writeFileSync(join(root, "latin.txt"), Buffer.from([0xff, 0xfe, 0x41]));
  expect(add("jojo", 1, "run.sh")).toContain("Only .txt");
  expect(add("jojo", 1, "page.html")).toContain("Only .txt");
  expect(add("jojo", 1, "fake.pdf")).toBe("It doesn't start like a PDF.");
  expect(add("jojo", 1, "binary.txt")).toContain("NUL");
  expect(add("jojo", 1, "latin.txt")).toContain("UTF-8");

  const big = join(root, "big.txt");
  writeFileSync(big, Buffer.alloc(artifactSizeLimit + 1, 0x61));
  expect(add("jojo", 1, "big.txt")).toContain("over the 10 MiB limit");
  truncateSync(big, artifactSizeLimit);
  expect(add("jojo", 1, "big.txt")).toMatchObject({ added: true });

  writeFileSync(join(root, "small.txt"), "small");
  const filler = (count: number, size: number) =>
    db
      .insert(artifacts)
      .values(
        Array.from({ length: count }, (_, i) => ({
          dot: "jojo",
          worker: 2,
          sessionID: "ses_w2",
          path: `f${i}.txt`,
          name: `f${i}.txt`,
          mime: "text/plain" as const,
          size,
          sha256: sha(String(i)),
          file: `filler-${size}-${i}`,
          createdAt: 0,
        })),
      )
      .run();
  filler(1, artifactTotalLimit - artifactSizeLimit);
  expect(add("jojo", 1, "small.txt")).toContain("would pass 200 MiB");
  db.delete(artifacts).run();
  filler(artifactCountLimit, 1);
  expect(add("jojo", 1, "small.txt")).toContain(`already holds ${artifactCountLimit}`);
  // Another dot's Library has its own caps.
  writeFileSync(join(outputDirectory("polnareff", 3), "small.txt"), "small");
  expect(add("polnareff", 3, "small.txt")).toMatchObject({ added: true });
});

test("same names stay separate, and a copy that's gone or changed is shown honestly", async () => {
  for (const [id, text] of [
    [1, "from one"],
    [2, "from two"],
  ] as const)
    writeFileSync(join(outputDirectory("jojo", id), "report.md"), text);
  const one = added("jojo", 1, "report.md");
  const two = added("jojo", 2, "report.md");
  writeFileSync(join(outputDirectory("jojo", 1), "report.md"), "from one, revised");
  const revised = added("jojo", 1, "report.md");
  expect(new Set([one.id, two.id, revised.id]).size).toBe(3);
  expect(new Set([one.file, two.file, revised.file]).size).toBe(3);
  for (const [artifact, text] of [
    [one, "from one"],
    [two, "from two"],
    [revised, "from one, revised"],
  ] as const) {
    const response = await call(`/dots/jojo/library/${artifact.id}/content`);
    expect(await response.text()).toBe(text);
  }

  // Same size, other bytes: only the digest tells, and nothing is served.
  writeFileSync(join(libraryDirectory("jojo"), one.file), "FROM ONE");
  expect(await (await call(`/dots/jojo/library/${one.id}`)).json()).toMatchObject({
    artifact: { id: one.id, status: "corrupt", sha256: sha("from one") },
  });
  const corrupt = await call(`/dots/jojo/library/${one.id}/content`);
  expect(corrupt.status).toBe(422);
  expect(await corrupt.json()).toMatchObject({ artifact: { status: "corrupt" } });

  unlinkSync(join(libraryDirectory("jojo"), two.file));
  const missing = await call(`/dots/jojo/library/${two.id}/content`);
  expect(missing.status).toBe(410);
  expect(await missing.json()).toMatchObject({ artifact: { status: "missing" } });

  // A copy replaced by a link is never followed.
  unlinkSync(join(libraryDirectory("jojo"), revised.file));
  writeFileSync(join(home, "planted.md"), "from one, revised");
  symlinkSync(join(home, "planted.md"), join(libraryDirectory("jojo"), revised.file));
  expect((await call(`/dots/jojo/library/${revised.id}/content`)).status).toBe(422);

  const list = (await (await call("/dots/jojo/library")).json()) as {
    artifacts: { id: number; status: string }[];
  };
  expect(list.artifacts.map(({ id, status }) => [id, status])).toEqual([
    [revised.id, "corrupt"],
    [two.id, "missing"],
    // A list checks only that the copy is there, private and of its size, not its digest.
    [one.id, "present"],
  ]);
});

test("a Library survives a restart and pages newest first by ID", async () => {
  const root = outputDirectory("jojo", 1);
  for (let i = 0; i < libraryPageSize + 2; i++)
    writeFileSync(join(root, `r${i}.txt`), `report ${i}`);
  for (let i = 0; i < libraryPageSize + 2; i++) added("jojo", 1, `r${i}.txt`);
  db.$client.close();
  db = openDatabase(databasePath());

  type Page = { artifacts: { id: number; name: string; status: string }[]; next: number | null };
  const first = (await (await call("/dots/jojo/library")).json()) as Page;
  expect(first.artifacts).toHaveLength(libraryPageSize);
  expect(first.artifacts[0]).toMatchObject({
    name: `r${libraryPageSize + 1}.txt`,
    status: "present",
  });
  expect(first.next).toBe(first.artifacts.at(-1)?.id ?? -1);
  const second = (await (await call(`/dots/jojo/library?before=${first.next}`)).json()) as Page;
  expect(second.artifacts.map((a) => a.name)).toEqual(["r1.txt", "r0.txt"]);
  expect(second.next).toBeNull();
  const content = await call(`/dots/jojo/library/${second.artifacts[1]?.id}/content`);
  expect(await content.text()).toBe("report 0");

  for (const query of ["?before=0", "?before=x", "?before=1&before=2", "?after=1", "?before=1.5"])
    expect((await call(`/dots/jojo/library${query}`)).status).toBe(400);
  expect((await call(`/dots/jojo/library/1?x=1`)).status).toBe(400);
});

test("each dot's Library is its own, needs the token, serves only by ID and starts no turn", async () => {
  writeFileSync(join(outputDirectory("jojo", 1), "report.md"), "jojo's");
  const artifact = added("jojo", 1, "report.md");
  expect((await call(`/dots/polnareff/library/${artifact.id}`)).status).toBe(404);
  expect((await call(`/dots/polnareff/library/${artifact.id}/content`)).status).toBe(404);
  expect(await (await call("/dots/polnareff/library")).json()).toEqual({
    artifacts: [],
    next: null,
  });
  expect((await call(`/dots/jojo/library/${artifact.id}`, { token: "wrong" })).status).toBe(401);
  expect((await call("/dots/dio/library")).status).toBe(404);
  for (const path of [
    `/dots/jojo/library/${artifact.id}/report.md`,
    `/dots/jojo/library/report.md`,
    `/dots/jojo/library/${artifact.id}/content/x`,
    `/dots/jojo/library/0`,
  ])
    expect((await call(path)).status).toBe(404);
  for (const method of ["POST", "PUT", "DELETE"])
    expect((await call(`/dots/jojo/library/${artifact.id}`, { method })).status).toBe(404);
  expect(db.select().from(outbox).all()).toEqual([]);
});

test("a download is an attachment that's never sniffed, under a safe file name", async () => {
  const root = outputDirectory("jojo", 1);
  const name = 'Q3 "draft" résumé;x=1.md';
  writeFileSync(join(root, name), "<script>alert(1)</script>");
  const artifact = added("jojo", 1, name);
  const response = await call(`/dots/jojo/library/${artifact.id}/content`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("content-disposition")).toBe(
    `attachment; filename="Q3 _draft_ r_sum__x_1.md"; filename*=UTF-8''Q3%20%22draft%22%20r%C3%A9sum%C3%A9%3Bx%3D1.md`,
  );
  expect(await response.text()).toBe("<script>alert(1)</script>");
  expect(await (await call(`/dots/jojo/library/${artifact.id}`)).json()).toEqual({
    artifact: {
      id: artifact.id,
      name,
      mime: "text/markdown",
      size: 25,
      sha256: sha("<script>alert(1)</script>"),
      createdAt: artifact.createdAt,
      worker: 1,
      sessionID: "ses_w1",
      path: name,
      status: "verified",
    },
  });
});

/** Runs `act` once, the first time the operation reaches `step` (and `detail`, if given). */
const at = (step: string, act: (detail?: string) => void, detail?: string) => {
  let done = false;
  libraryProbe.at = (reached, reachedDetail) => {
    if (done || reached !== step || (detail !== undefined && reachedDetail !== detail)) return;
    done = true;
    act(reachedDetail);
  };
  return () => done;
};

const content = async (dot: string, id: number) =>
  (await call(`/dots/${dot}/library/${id}/content`)).text();

test("a directory swapped while the path is walked can't redirect the read", async () => {
  const root = outputDirectory("jojo", 1);
  writeFileSync(join(root, "report.md"), "mine");
  writeFileSync(join(outputDirectory("jojo", 2), "report.md"), "theirs");

  // The worker's whole output directory swapped for a link to another worker's once it's open:
  // the read stays in the directory that was checked.
  let swapped = at(
    "directory",
    () => {
      renameSync(root, join(home, "moved"));
      symlinkSync(outputDirectory("jojo", 2), root);
    },
    "1",
  );
  const first = added("jojo", 1, "report.md");
  expect(swapped()).toBe(true);
  expect(await content("jojo", first.id)).toBe("mine");
  unlinkSync(root);
  renameSync(join(home, "moved"), root);

  // Swapped away and straight back (ABA) changes nothing either.
  writeFileSync(join(root, "aba.md"), "mine too");
  swapped = at(
    "directory",
    () => {
      renameSync(root, join(home, "moved"));
      renameSync(join(home, "moved"), root);
    },
    "1",
  );
  expect(await content("jojo", added("jojo", 1, "aba.md").id)).toBe("mine too");
  expect(swapped()).toBe(true);

  // A parent replaced by a link before it's opened is refused, never followed.
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "x.md"), "inside");
  mkdirSync(join(home, "elsewhere"));
  writeFileSync(join(home, "elsewhere", "x.md"), "elsewhere");
  swapped = at(
    "directory",
    () => {
      renameSync(join(root, "sub"), join(root, "sub-old"));
      symlinkSync(join(home, "elsewhere"), join(root, "sub"));
    },
    "1",
  );
  expect(add("jojo", 1, "sub/x.md")).toBe("sub/ isn't a directory, or is a link.");
  expect(swapped()).toBe(true);
  unlinkSync(join(root, "sub"));
  renameSync(join(root, "sub-old"), join(root, "sub"));

  // One replaced after it's opened: the file still comes from the one that was checked.
  swapped = at(
    "directory",
    () => {
      renameSync(join(root, "sub"), join(root, "sub-old"));
      symlinkSync(join(home, "elsewhere"), join(root, "sub"));
    },
    "sub",
  );
  expect(await content("jojo", added("jojo", 1, "sub/x.md").id)).toBe("inside");
  expect(swapped()).toBe(true);

  // The file itself replaced by a link once its directory is open.
  writeFileSync(join(root, "late.md"), "late");
  swapped = at(
    "directory",
    () => {
      unlinkSync(join(root, "late.md"));
      symlinkSync(join(home, "elsewhere", "x.md"), join(root, "late.md"));
    },
    "1",
  );
  expect(add("jojo", 1, "late.md")).toBe("That file is a link.");
  expect(swapped()).toBe(true);
  const saved = db.select().from(artifacts).all();
  expect(saved.map((row) => row.sha256)).not.toContain(sha("theirs"));
  expect(saved.map((row) => row.sha256)).not.toContain(sha("elsewhere"));
});

test("a write while the file is read is caught, even one that keeps its size", () => {
  const path = join(outputDirectory("jojo", 1), "big.txt");
  writeFileSync(path, Buffer.alloc(200 * 1024, 0x61));
  const mutated = at("chunk", () => {
    const fd = openSync(path, "r+");
    writeSync(fd, "b", 0);
    closeSync(fd);
  });
  expect(add("jojo", 1, "big.txt")).toBe("That file changed while it was read.");
  expect(mutated()).toBe(true);
  expect(statSync(path).size).toBe(200 * 1024);
  // Between checking the file and reading it, too.
  const rewritten = at("source", () => writeFileSync(path, Buffer.alloc(200 * 1024, 0x63)));
  expect(add("jojo", 1, "big.txt")).toBe("That file changed while it was read.");
  expect(rewritten()).toBe(true);
  expect(db.select().from(artifacts).all()).toEqual([]);
});

test("a copy is published only from the Library's own directory, as exactly the bytes read", () => {
  const library = libraryDirectory("jojo");
  writeFileSync(join(outputDirectory("jojo", 1), "report.md"), "report");
  const inLibrary = () => readdirSync(library).toSorted();

  // The dot's Library directory swapped for another while the copy is written. The copy is
  // never deleted: it stays behind, in the directory that moved, as an orphan.
  let acted = at("created", () => {
    renameSync(library, `${library}-old`);
    mkdirSync(library, { mode: 0o700 });
  });
  expect(add("jojo", 1, "report.md")).toBe(
    "The Library's directory moved while the copy was saved.",
  );
  expect(acted()).toBe(true);
  expect(readdirSync(`${library}-old`)).toHaveLength(1);
  expect(inLibrary()).toEqual([]);

  // The new copy's name pointed at another file: refused, and that file is left alone.
  let planted = "";
  acted = at("written", (file = "") => {
    planted = file;
    unlinkSync(join(library, file));
    writeFileSync(join(library, file), "planted", { mode: 0o600 });
  });
  expect(add("jojo", 1, "report.md")).toBe("The Library's copy changed before it was saved.");
  expect(acted()).toBe(true);
  expect(inLibrary()).toEqual([planted]);
  expect(readFileSync(join(library, planted), "utf8")).toBe("planted");

  // A second link to the copy, made before it's published, is refused. The copy stays, and
  // while it has two links the Library takes nothing more, rather than skipping it.
  let linked = "";
  acted = at("written", (file = "") => {
    linked = file;
    linkSync(join(library, file), join(home, "stolen"));
  });
  expect(add("jojo", 1, "report.md")).toBe("The Library's copy changed before it was saved.");
  expect(acted()).toBe(true);
  expect(inLibrary()).toEqual([planted, linked].toSorted());
  delete libraryProbe.at;
  expect(add("jojo", 1, "report.md")).toBe(
    "The Library holds something that isn't a private copy.",
  );
  unlinkSync(join(home, "stolen"));

  // A write, sync or insert that fails leaves its copy as an orphan and no row; even a copy
  // that was whole and checked isn't deleted.
  const orphans: string[] = [];
  for (const step of ["created", "written", "verified"]) {
    acted = at(step, (file = "") => {
      orphans.push(file);
      throw new Error(`${step} failed`);
    });
    expect(() => addDeliverable(db, "jojo", 1, "report.md")).toThrow(`${step} failed`);
    expect(acted()).toBe(true);
  }
  expect(inLibrary()).toEqual([planted, linked, ...orphans].toSorted());
  expect(readFileSync(join(library, orphans[2] ?? ""), "utf8")).toBe("report");

  // A replacement made at the copy's name just as publication fails is never deleted.
  let replaced = "";
  acted = at("verified", (file = "") => {
    replaced = file;
    unlinkSync(join(library, file));
    writeFileSync(join(library, file), "replacement", { mode: 0o600 });
    throw new Error("insert failed");
  });
  expect(() => addDeliverable(db, "jojo", 1, "report.md")).toThrow("insert failed");
  expect(acted()).toBe(true);
  expect(readFileSync(join(library, replaced), "utf8")).toBe("replacement");
  expect(db.select().from(artifacts).all()).toEqual([]);

  // The orphans count against the caps, and there's still room for this one.
  delete libraryProbe.at;
  expect(add("jojo", 1, "report.md")).toMatchObject({ added: true });
  expect(inLibrary()).toHaveLength(orphans.length + 4);
});

test("directories and copies must stay the owner's and private, with one link", async () => {
  const root = outputDirectory("jojo", 1);
  writeFileSync(join(root, "report.md"), "report");
  const artifact = added("jojo", 1, "report.md");
  const library = libraryDirectory("jojo");
  const copy = join(library, artifact.file);
  const status = async () =>
    (
      (await (await call(`/dots/jojo/library/${artifact.id}`)).json()) as {
        artifact: { status: string };
      }
    ).artifact.status;
  expect(await status()).toBe("verified");

  chmodSync(copy, 0o644);
  expect(await status()).toBe("corrupt");
  expect((await call(`/dots/jojo/library/${artifact.id}/content`)).status).toBe(422);
  chmodSync(copy, 0o600);
  linkSync(copy, join(home, "copy-link"));
  expect(await status()).toBe("corrupt");
  unlinkSync(join(home, "copy-link"));
  expect(await status()).toBe("verified");

  writeFileSync(join(root, "other.md"), "other");
  chmodSync(library, 0o755);
  expect(await status()).toBe("corrupt");
  expect(add("jojo", 1, "other.md")).toBe("library/jojo/ must be private (0700).");
  chmodSync(library, 0o700);
  chmodSync(root, 0o755);
  expect(add("jojo", 1, "other.md")).toBe("Worker #1's output directory must be private (0700).");
  expect(prepareOutput("jojo", 1)).toBe(false);
  chmodSync(root, 0o700);
  mkdirSync(join(root, "open"), { mode: 0o700 });
  writeFileSync(join(root, "open", "x.md"), "x");
  chmodSync(join(root, "open"), 0o777);
  expect(add("jojo", 1, "open/x.md")).toBe("open/ is writable by others.");
  chmodSync(home, 0o777);
  expect(add("jojo", 1, "other.md")).toContain("must be your own directory");
  expect(await status()).toBe("corrupt");
  chmodSync(home, 0o700);
  expect(add("jojo", 1, "other.md")).toMatchObject({ added: true });
});

test("copies a crash left without a row count against the caps, across a restart", () => {
  const library = libraryDirectory("jojo");
  writeFileSync(join(outputDirectory("jojo", 1), "report.md"), "report");
  mkdirSync(join(home, "library"), { mode: 0o700 });
  mkdirSync(library, { mode: 0o700 });
  for (let i = 0; i < artifactCountLimit; i++)
    writeFileSync(join(library, `orphan${i}`), "", { mode: 0o600 });
  expect(add("jojo", 1, "report.md")).toContain(`already holds ${artifactCountLimit}`);
  db.$client.close();
  db = openDatabase(databasePath());
  expect(add("jojo", 1, "report.md")).toContain(`already holds ${artifactCountLimit}`);
  for (let i = 0; i < artifactCountLimit; i++) unlinkSync(join(library, `orphan${i}`));

  // A partial copy as large as the cap, sparse here, leaves no room.
  const partial = join(library, "partial");
  writeFileSync(partial, "", { mode: 0o600 });
  truncateSync(partial, artifactTotalLimit);
  expect(add("jojo", 1, "report.md")).toContain("would pass 200 MiB");
  unlinkSync(partial);

  // Anything but a private copy in the Library stops adding, rather than being skipped.
  mkdirSync(join(home, "elsewhere"));
  symlinkSync(join(home, "elsewhere"), join(library, "link"));
  expect(add("jojo", 1, "report.md")).toBe(
    "The Library holds something that isn't a private copy.",
  );
  unlinkSync(join(library, "link"));
  expect(add("jojo", 1, "report.md")).toMatchObject({ added: true });
  expect(existsSync(join(library, db.select().from(artifacts).get()?.file ?? ""))).toBe(true);
});

test("a listing that fails part way is refused, and a planted flood is read only up to the cap", () => {
  const library = libraryDirectory("jojo");
  writeFileSync(join(outputDirectory("jojo", 1), "report.md"), "report");
  mkdirSync(join(home, "library"), { mode: 0o700 });
  mkdirSync(library, { mode: 0o700 });
  writeFileSync(join(library, "orphan"), "", { mode: 0o600 });

  // readdir answers null with errno set: an error, as libc reports it, never the end.
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    // oxlint-disable-next-line no-underscore-dangle -- libc's own name for the errno location
    __error: { args: [], returns: FFIType.ptr },
  });
  let failed = 0;
  libraryProbe.at = (step) => {
    if (step !== "readdir") return;
    failed++;
    // oxlint-disable-next-line no-underscore-dangle -- libc's own name for the errno location
    const errno = libc.symbols.__error();
    if (errno) new Int32Array(toArrayBuffer(errno, 0, 4))[0] = 5;
  };
  expect(add("jojo", 1, "report.md")).toBe("The Library can't be listed.");
  expect(failed).toBeGreaterThan(0);
  expect(readdirSync(library)).toEqual(["orphan"]);
  expect(db.select().from(artifacts).all()).toEqual([]);

  // Twice the count cap planted: the scan stops at the cap.
  for (let i = 0; i < artifactCountLimit * 2; i++)
    writeFileSync(join(library, `flood${i}`), "", { mode: 0o600 });
  let reads = 0;
  libraryProbe.at = (step) => {
    if (step === "readdir") reads++;
  };
  expect(add("jojo", 1, "report.md")).toContain(`already holds ${artifactCountLimit}`);
  expect(reads).toBeLessThanOrEqual(artifactCountLimit + 2);
  libc.close();
});

test("a home under a directory others or a group can write to is refused unless it's sticky", () => {
  const parent = join(home, "shared");
  mkdirSync(join(parent, "home"), { recursive: true, mode: 0o700 });
  process.env.OPEN_DOT_HOME = join(parent, "home");
  try {
    for (const [mode, safe] of [
      [0o775, false],
      [0o757, false],
      [0o1775, true],
      [0o755, true],
    ] as const) {
      chmodSync(parent, mode);
      expect(prepareOutput("jojo", 1)).toBe(safe);
    }
  } finally {
    chmodSync(parent, 0o755);
    process.env.OPEN_DOT_HOME = home;
  }
});
