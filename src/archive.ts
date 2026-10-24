import { and, count, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Db } from "./db";
import { fold, indexTerms, noteSource, snippet } from "./memory";
import { type HistoryItem, OpenCode, OpenCodeError } from "./opencode";
import { messageKind, messageSources } from "./reactions";
import {
  archive,
  archiveCursors,
  type Dot,
  dots,
  memorySettings,
  notes,
  type PendingMessage,
} from "./schema";

/**
 * History items per page and pages per dot per pass; unfinished replies read again per pass, in
 * turn; and how many may wait before the walk pauses, so none is ever dropped to make room.
 */
const pageLimit = 200;
const pagesPerPass = 10;
const recheckLimit = 50;
export const pendingPause = 1000;

type Settings = typeof memorySettings.$inferSelect;
type Cursor = typeof archiveCursors.$inferSelect;
type Invalid = { readonly invalid: string };

/** A dot without a settings row has every memory layer off. */
export const settingsOf = (db: Db, dot: string): Settings =>
  db.select().from(memorySettings).where(eq(memorySettings.dot, dot)).get() ?? {
    dot,
    archive: false,
    backfill: false,
    archiveSince: null,
    updatedAt: 0,
  };

/** The owner's change to the archive switches: `{ archive?, backfill? }`, at least one. */
export function parseArchiveSettings(
  body: unknown,
): { archive?: boolean; backfill?: boolean } | Invalid {
  const usage = { invalid: "Send {archive, backfill}, each true or false, at least one." };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return usage;
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => key !== "archive" && key !== "backfill")) return usage;
  const { archive: archiveOn, backfill } = Object.fromEntries(Object.entries(body));
  if (![archiveOn, backfill].every((value) => value === undefined || typeof value === "boolean"))
    return usage;
  return {
    ...(typeof archiveOn === "boolean" ? { archive: archiveOn } : {}),
    ...(typeof backfill === "boolean" ? { backfill } : {}),
  };
}

/**
 * Saves the owner's switches. Switching the archive on starts it from now; switching backfill on
 * restarts the walk from the start of the session, which copies nothing twice.
 */
export const saveArchiveSettings = (
  db: Db,
  dot: string,
  change: { archive?: boolean; backfill?: boolean },
  now: number,
) =>
  db.transaction(
    (tx) => {
      const before = settingsOf(db, dot);
      const archiveOn = change.archive ?? before.archive;
      const backfill = change.backfill ?? before.backfill;
      const next = {
        archive: archiveOn,
        backfill,
        archiveSince: archiveOn && !before.archive ? now : before.archiveSince,
        updatedAt: now,
      };
      tx.insert(memorySettings)
        .values({ dot, ...next })
        .onConflictDoUpdate({ target: memorySettings.dot, set: next })
        .run();
      if (backfill && !before.backfill)
        tx.update(archiveCursors)
          .set({
            cursor: null,
            anchor: null,
            pending: [],
            revision: sql`${archiveCursors.revision} + 1`,
          })
          .where(eq(archiveCursors.dot, dot))
          .run();
    },
    { behavior: "immediate" },
  );

/** What the notch shows about a dot's archive: its switches and how far it has got. */
export const archiveStatus = (db: Db, dot: Dot) => {
  const settings = settingsOf(db, dot.name);
  const cursor = db.select().from(archiveCursors).where(eq(archiveCursors.dot, dot.name)).get();
  const current = cursor?.sessionID === dot.sessionID ? cursor : undefined;
  const archived =
    db
      .select({ value: count() })
      .from(archive)
      .where(and(eq(archive.dot, dot.name), eq(archive.sessionID, dot.sessionID)))
      .get()?.value ?? 0;
  return {
    archive: settings.archive,
    backfill: settings.backfill,
    since: settings.archiveSince,
    sessionID: dot.sessionID,
    archived,
    unfinished: current?.pending.length ?? 0,
    checkedAt: current?.checkedAt ?? null,
  };
};

/** The dots whose archive the daemon reads now. */
export const archivingDots = (db: Db) =>
  db
    .select({ name: dots.name })
    .from(dots)
    .innerJoin(memorySettings, eq(memorySettings.dot, dots.name))
    .where(and(eq(memorySettings.archive, true), eq(dots.sessionState, "ready")))
    .all()
    .map((row) => row.name);

const secrets = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:xox[abposre]-|xapp-|xoxe\.)[\w.-]{8,}/g,
  /\b(?:gh[pousr]_|github_pat_|lin_api_|sk-|sk_live_|rk_live_)[\w-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
];
const labelled = /\b(pass(?:word|phrase|code)?|secret|token|api[_ -]?key|otp)(\s*[:=]\s*)\S+/gi;

/** Drops what looks like a credential before anything is saved, best effort. */
export const redact = (text: string) =>
  secrets
    .reduce((rest, pattern) => rest.replace(pattern, "[redacted]"), text)
    .replace(labelled, "$1$2[redacted]");

/**
 * The rows a page adds: the dot's own text and the owner's own words, never a notice, another
 * dot's message or the framing open-dot adds to the owner's. Before `archiveSince` only backfill
 * copies anything.
 */
const archived = (
  db: Db,
  dot: Dot,
  settings: Settings,
  items: readonly HistoryItem[],
  now: number,
) => {
  const sources = messageSources(
    db,
    dot.sessionID,
    items.filter((item) => item.type === "user").map((item) => item.id),
  );
  return items.flatMap((item) => {
    if (!settings.backfill && (settings.archiveSince === null || item.time < settings.archiveSince))
      return [];
    const source = sources.get(item.id);
    if (item.type === "user" && messageKind("user", source) !== "owner") return [];
    const own =
      item.type === "user"
        ? (source?.quote?.prompt ?? source?.feed?.prompt ?? source?.ownerText ?? item.text)
        : item.text;
    const text = redact(own).trim();
    if (!text) return [];
    return [
      {
        dot: dot.name,
        sessionID: dot.sessionID,
        messageID: item.id,
        role: item.type === "user" ? ("owner" as const) : ("dot" as const),
        text,
        createdAt: item.time,
        archivedAt: now,
      },
    ];
  });
};

/**
 * Saves what a read found, only if nothing changed since the read: the dot is still ready and
 * bound to the same session, its switches are the same, and the cursor row is at the revision the
 * read began from. The rows and the cursor move together, so a restart resumes exactly here.
 */
const save = (
  db: Db,
  dot: Dot,
  settings: Settings,
  from: Cursor,
  change: Pick<Cursor, "cursor" | "anchor" | "pending">,
  items: readonly HistoryItem[],
): Cursor | undefined =>
  db.transaction(
    (tx) => {
      const now = Date.now();
      const bound = tx.select().from(dots).where(eq(dots.name, dot.name)).get();
      if (bound?.sessionState !== "ready" || bound.sessionID !== dot.sessionID) return undefined;
      const current = settingsOf(db, dot.name);
      if (
        !current.archive ||
        current.backfill !== settings.backfill ||
        current.archiveSince !== settings.archiveSince
      )
        return undefined;
      const rows = archived(db, dot, settings, items, now);
      const moved = tx
        .update(archiveCursors)
        .set({ ...change, revision: from.revision + 1, checkedAt: now })
        .where(
          and(
            eq(archiveCursors.dot, dot.name),
            eq(archiveCursors.sessionID, dot.sessionID),
            eq(archiveCursors.revision, from.revision),
          ),
        )
        .returning()
        .get();
      if (!moved) return undefined;
      if (rows.length) tx.insert(archive).values(rows).onConflictDoNothing().run();
      return moved;
    },
    { behavior: "immediate" },
  );

/** The dot's cursor row for its bound session, made fresh for a new or rebound session. */
const cursorFor = (db: Db, dot: Dot) =>
  db.transaction(
    (tx) => {
      const row = tx.select().from(archiveCursors).where(eq(archiveCursors.dot, dot.name)).get();
      if (row?.sessionID === dot.sessionID) return row;
      const fresh = {
        sessionID: dot.sessionID,
        cursor: null,
        anchor: null,
        pending: [],
        checkedAt: null,
        revision: (row?.revision ?? 0) + 1,
      };
      return tx
        .insert(archiveCursors)
        .values({ dot: dot.name, ...fresh })
        .onConflictDoUpdate({ target: archiveCursors.dot, set: fresh })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );

/**
 * One archive pass over a dot's bound session, through OpenCode's public paged history, at most
 * ten pages. Replies OpenCode hasn't finished are all kept and read again by ID, 50 a pass in
 * turn, until they finish or a turn end follows them; while 1,000 wait, the walk pauses. A cursor that would loop fails the pass; one whose message is gone restarts the
 * walk, which copies nothing twice. Every save rechecks the binding and switches after the reads,
 * and a change since the read saves nothing and ends the pass.
 */
export const archiveDot = (db: Db, name: string) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode;
    const dot = db.select().from(dots).where(eq(dots.name, name)).get();
    const settings = settingsOf(db, name);
    if (dot?.sessionState !== "ready" || !settings.archive) return;
    let row = cursorFor(db, dot);
    const keep = (
      change: Pick<Cursor, "cursor" | "anchor" | "pending">,
      items: readonly HistoryItem[],
    ) => {
      const saved = save(db, dot, settings, row, change, items);
      if (saved) row = saved;
      return saved !== undefined;
    };

    if (row.pending.length) {
      // The oldest waiters first; any still waiting go to the back, so each gets its turn.
      const batch = row.pending.slice(0, recheckLimit);
      const waiting: PendingMessage[] = [];
      const finished: HistoryItem[] = [];
      for (const entry of batch) {
        const item = yield* opencode.historyItem({
          sessionID: dot.sessionID,
          messageID: entry.id,
        });
        if (!item) continue;
        if (item.complete || entry.ended) finished.push(item);
        else waiting.push(entry);
      }
      const pending = [...row.pending.slice(recheckLimit), ...waiting];
      if (!keep({ cursor: row.cursor, anchor: row.anchor, pending }, finished)) return;
    }

    const seen = new Set(row.cursor ? [row.cursor] : []);
    for (let pages = 0; pages < pagesPerPass; pages++) {
      // Too many unfinished replies: the walk waits for them rather than drop any.
      if (row.pending.length >= pendingPause) return;
      const page = yield* opencode.historyPage(dot.sessionID, pageLimit, row.cursor ?? undefined);
      const last = page.items.at(-1);
      if (!last) {
        // An empty page after a cursor is either the end or a cursor whose message is gone.
        const gone =
          row.anchor !== null &&
          !(yield* opencode.historyItem({ sessionID: dot.sessionID, messageID: row.anchor }));
        const { cursor, anchor, pending } = row;
        keep(gone ? { cursor: null, anchor: null, pending } : { cursor, anchor, pending }, []);
        return;
      }
      if (!page.next || seen.has(page.next)) {
        yield* new OpenCodeError({
          message: `OpenCode returned a history cursor of ${dot.sessionID} that would loop`,
        });
        return;
      }
      seen.add(page.next);
      let pending = [...row.pending];
      const items: HistoryItem[] = [];
      for (const item of page.items) {
        if (item.type === "idle") pending = pending.map((waiting) => ({ ...waiting, ended: true }));
        else if (item.type === "assistant" && !item.complete) {
          if (!pending.some((waiting) => waiting.id === item.id))
            pending.push({ id: item.id, ended: false });
        } else if (item.type === "user" || item.type === "assistant") items.push(item);
      }
      const moved = { cursor: page.next, anchor: last.id, pending };
      if (!keep(moved, items) || page.items.length < pageLimit) return;
    }
  });

/** One archive pass over every dot whose archive is on. One dot's failure doesn't stop the rest. */
export const archiveAll = (db: Db) =>
  Effect.forEach(
    archivingDots(db),
    (name) =>
      archiveDot(db, name).pipe(
        Effect.timeout("60 seconds"),
        Effect.catch((error) =>
          Effect.sync(() => console.error(`Archive of ${name}: ${error.message}`)),
        ),
      ),
    { discard: true },
  );

/** The most results a recall returns, its default, and the furthest it pages. */
export const recallLimit = 20;
export const recallDefault = 8;
export const recallOffsetLimit = 200;
/** How much of an archived message one zoom shows. */
export const zoomLength = 4000;

const firstMatch = (text: string, words: readonly string[]) => {
  const { folded, origin } = fold(text);
  const found = words.map((word) => folded.indexOf(word)).filter((at) => at >= 0);
  return found.length ? (origin[Math.min(...found)] ?? 0) : 0;
};

/**
 * The dot's saved notes and, with its archive on, its archived messages from the bound session,
 * that match every word of three or more characters, best match first by BM25, a page at a time.
 */
export function recall(db: Db, dot: Dot, words: readonly string[], limit: number, offset: number) {
  const terms = indexTerms(words);
  if (!terms.length) return { invalid: "Search for at least one word of 3 or more characters." };
  const archiveOn = settingsOf(db, dot.name).archive;
  const hits = db.all<{ id: number }>(
    sql`SELECT rowid AS id FROM memory_fts WHERE memory_fts MATCH ${terms.join(" AND ")} AND dot = ${dot.name} AND (rowid < 0 OR (${archiveOn ? 1 : 0} = 1 AND session = ${dot.sessionID})) ORDER BY rank, rowid DESC LIMIT ${limit + 1} OFFSET ${offset}`,
  );
  const shown = hits.slice(0, limit);
  const noteIDs = shown.filter((hit) => hit.id < 0).map((hit) => -hit.id);
  const messageIDs = shown.filter((hit) => hit.id > 0).map((hit) => hit.id);
  const saved = new Map(
    (noteIDs.length
      ? db
          .select()
          .from(notes)
          .where(and(eq(notes.dot, dot.name), inArray(notes.id, noteIDs)))
          .all()
      : []
    ).map((row) => [-row.id, row]),
  );
  const messages = new Map(
    (messageIDs.length
      ? db
          .select()
          .from(archive)
          .where(
            and(
              eq(archive.dot, dot.name),
              eq(archive.sessionID, dot.sessionID),
              inArray(archive.id, messageIDs),
            ),
          )
          .all()
      : []
    ).map((row) => [row.id, row]),
  );
  type Result =
    | {
        kind: "note";
        note: number;
        updated: string;
        snippet: string;
        source: ReturnType<typeof noteSource> | "unknown";
      }
    | {
        kind: "message";
        message: string;
        sessionID: string;
        from: "owner" | "dot";
        date: string;
        snippet: string;
      };
  const results = shown.flatMap((hit): Result[] => {
    const note = saved.get(hit.id);
    if (note)
      return [
        {
          kind: "note",
          note: note.id,
          updated: new Date(note.updatedAt ?? note.createdAt).toISOString(),
          snippet: snippet(note.text, firstMatch(note.text, words)),
          source: noteSource(note) ?? "unknown",
        },
      ];
    const message = messages.get(hit.id);
    if (message)
      return [
        {
          kind: "message",
          message: message.messageID,
          sessionID: message.sessionID,
          from: message.role,
          date: new Date(message.createdAt).toISOString(),
          snippet: snippet(message.text, firstMatch(message.text, words)),
        },
      ];
    return [];
  });
  const more = hits.length > limit && offset + limit <= recallOffsetLimit;
  return { results, next: more ? offset + limit : null };
}

/** Part of one archived message of the bound session, from `offset`, at most `zoomLength` long. */
export function zoom(db: Db, dot: Dot, messageID: string, offset: number) {
  if (!settingsOf(db, dot.name).archive)
    return { invalid: "Your conversation archive is off. Only your owner can turn it on." };
  const row = db
    .select()
    .from(archive)
    .where(
      and(
        eq(archive.dot, dot.name),
        eq(archive.sessionID, dot.sessionID),
        eq(archive.messageID, messageID),
      ),
    )
    .get();
  if (!row) return { invalid: "There's no archived message with that ID in this conversation." };
  if (offset > 0 && offset >= row.text.length)
    return { invalid: `offset must be below ${row.text.length}.` };
  // Never splits a surrogate pair at either end.
  let from = offset;
  if (/[\uDC00-\uDFFF]/.test(row.text[from] ?? "")) from--;
  let to = Math.min(row.text.length, from + zoomLength);
  if (/[\uD800-\uDBFF]/.test(row.text[to - 1] ?? "") && to < row.text.length) to--;
  return {
    message: row.messageID,
    sessionID: row.sessionID,
    from: row.role,
    date: new Date(row.createdAt).toISOString(),
    length: row.text.length,
    offset: from,
    text: row.text.slice(from, to),
    next: to < row.text.length ? to : null,
  };
}
