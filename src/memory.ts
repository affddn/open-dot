import { and, asc, desc, eq, ne, type SQL, sql } from "drizzle-orm";
import type { Db } from "./db";
import {
  type Note,
  notes,
  type Reminder,
  reminders,
  type Responsibility,
  responsibilities,
  responsibilityStatuses,
} from "./schema";
import { maxEveryMinutes, nextRunAfter } from "./schedule";

/** The longest note, goal or next action the owner can save, in UTF-16 code units. */
export const memoryTextLimit = 2000;
/** How far ahead the owner can move a reminder. */
const horizon = 10 * 365 * 24 * 60 * 60_000;
/** Finished responsibilities shown, most recently changed first, so one can be reopened. */
const finishedShown = 50;

const meta = (row: {
  id: number;
  version: number;
  createdAt: number;
  updatedAt: number | null;
  updatedBy: string;
}) => ({
  id: row.id,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt ?? row.createdAt,
  updatedBy: row.updatedBy,
});

/**
 * Where a note was saved from, or null when that's unknown. `edited` means the note changed since,
 * so the source shows where it was first saved, never that its current text came from there.
 */
export const noteSource = (row: Note) =>
  row.sourceSession && row.sourceMessage
    ? { sessionID: row.sourceSession, messageID: row.sourceMessage, edited: row.version > 1 }
    : null;

export const noteView = (row: Note) => ({ ...meta(row), text: row.text, source: noteSource(row) });

/** The longest search, in UTF-16 code units, its most words, and its most results. */
export const searchTextLimit = 200;
const searchTerms = 8;
export const searchResultLimit = 50;
export const searchDefaultLimit = 20;
const snippetLength = 160;

/** Lowercases code point by code point, keeping where each folded unit came from in `text`. */
export const fold = (text: string) => {
  let folded = "";
  const origin: number[] = [];
  let at = 0;
  for (const character of text) {
    const lower = character.toLowerCase();
    folded += lower;
    for (let unit = 0; unit < lower.length; unit++) origin.push(at);
    at += character.length;
  }
  origin.push(at);
  return { folded, origin };
};

/** Up to 160 characters of the note around its first match, on one line. */
export const snippet = (text: string, start: number) => {
  let from = Math.max(0, Math.min(start - 60, text.length - snippetLength));
  let to = Math.min(text.length, from + snippetLength);
  // Never split a surrogate pair.
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from] ?? "")) from--;
  if (to < text.length && /[\uDC00-\uDFFF]/.test(text[to] ?? "")) to++;
  const line = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${line}${to < text.length ? "…" : ""}`;
};

/** The words of a search, lowercased and each once, or why it can't run. */
export function parseSearch(value: unknown): string[] | Invalid {
  const text = memoryText(value, "The search");
  if (invalid(text)) return text;
  if (text.length > searchTextLimit)
    return { invalid: `The search must be at most ${searchTextLimit} characters.` };
  const words = [...new Set(fold(text).folded.split(/\s+/).filter(Boolean))];
  if (words.length > searchTerms) return { invalid: `Search for at most ${searchTerms} words.` };
  return words;
}

const phrase = (word: string) => `"${word.replaceAll('"', '""')}"`;

/**
 * Search words as full-text index phrases, for recall. The index (an FTS5 trigram tokenizer that
 * ignores case and diacritics, migration 0030) can match only a word that still has three
 * characters once its combining marks are gone; each phrase matches anywhere inside a word, and
 * every one must match.
 */
export const indexTerms = (words: readonly string[]) =>
  words.filter((word) => Array.from(word.replace(/\p{M}/gu, "")).length >= 3).map(phrase);

/**
 * The words that may narrow an exact note search: printable ASCII only, at least three long. A
 * note whose case-folded text contains such a word is always in the index's matches, since only
 * U+0130 and U+212A lowercase to ASCII outside ASCII and the index folds both the same way. Other
 * words could fold or lose combining marks differently, so they never narrow the search.
 */
const exactTerms = (words: readonly string[]) =>
  words.filter((word) => /^[\x21-\x7e]{3,}$/.test(word)).map(phrase);

/** The dot's notes in the full-text index whose text may contain every term, as note IDs. */
const indexedNotes = (dot: string, terms: readonly string[]): SQL =>
  sql`${notes.id} IN (SELECT -rowid FROM memory_fts WHERE memory_fts MATCH ${terms.join(" AND ")} AND dot = ${dot} AND rowid < 0)`;

/**
 * The dot's saved notes that contain every word, ignoring case, most recently changed first, each
 * with a snippet. The full-text index (migration 0030), kept by triggers on `notes` for every
 * writer, narrows the notes by their ASCII words of three or more characters; each candidate's
 * text is then checked word by word, code point by code point, so results are exactly the ones a
 * scan finds. A search with no such word reads the dot's notes.
 */
export function searchNotes(db: Db, dot: string, words: readonly string[], limit: number) {
  const terms = exactTerms(words);
  const matched = db
    .select()
    .from(notes)
    .where(and(eq(notes.dot, dot), terms.length ? indexedNotes(dot, terms) : undefined))
    .orderBy(desc(sql`coalesce(${notes.updatedAt}, ${notes.createdAt})`), desc(notes.id))
    .all()
    .flatMap((row) => {
      const { folded, origin } = fold(row.text);
      const found = words.map((word) => folded.indexOf(word));
      if (found.some((at) => at < 0)) return [];
      const { text: _text, ...view } = noteView(row);
      return [{ ...view, snippet: snippet(row.text, origin[Math.min(...found)] ?? 0) }];
    });
  return { results: matched.slice(0, limit), more: matched.length > limit };
}

export const responsibilityView = (row: Responsibility) => ({
  ...meta(row),
  goal: row.goal,
  nextAction: row.nextAction,
  status: row.status,
  schedule: row.schedule,
  nextRunAt: row.nextRunAt,
});

export const reminderView = (row: Reminder) => ({
  ...meta(row),
  text: row.text,
  dueAt: row.dueAt,
  everyMinutes: row.everyMinutes,
  state: row.state,
});

/** What the dot's memory snapshot draws from, as the notch shows it. */
export const readMemory = (db: Db, dot: string) => ({
  notes: db
    .select()
    .from(notes)
    .where(eq(notes.dot, dot))
    .orderBy(asc(notes.id))
    .all()
    .map(noteView),
  responsibilities: [
    ...db
      .select()
      .from(responsibilities)
      .where(and(eq(responsibilities.dot, dot), eq(responsibilities.status, "active")))
      .orderBy(asc(responsibilities.id))
      .all(),
    ...db
      .select()
      .from(responsibilities)
      .where(and(eq(responsibilities.dot, dot), ne(responsibilities.status, "active")))
      .orderBy(desc(responsibilities.updatedAt), desc(responsibilities.id))
      .limit(finishedShown)
      .all(),
  ].map(responsibilityView),
  reminders: db
    .select()
    .from(reminders)
    .where(and(eq(reminders.dot, dot), eq(reminders.state, "scheduled")))
    .orderBy(asc(reminders.dueAt), asc(reminders.id))
    .all()
    .map(reminderView),
});

type Invalid = { readonly invalid: string };
type Fields = Record<string, unknown>;

const object = (body: unknown): body is Fields =>
  typeof body === "object" && body !== null && !Array.isArray(body);

const onlyKeys = (body: Fields, allowed: readonly string[]) =>
  Object.keys(body).every((key) => allowed.includes(key));

export const isID = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Text the owner typed: not blank, bounded, and no control characters except newline and tab. */
export const memoryText = (value: unknown, name: string): string | Invalid => {
  if (typeof value !== "string") return { invalid: `${name} must be a string.` };
  const text = value.trim();
  if (!text) return { invalid: `${name} can't be blank.` };
  if (text.length > memoryTextLimit)
    return { invalid: `${name} must be at most ${memoryTextLimit} characters.` };
  if (
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return (code <= 31 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
    })
  )
    return { invalid: `${name} can't contain control characters.` };
  return text;
};

const invalid = (value: unknown): value is Invalid => object(value) && "invalid" in value;

export function parseNote(body: unknown): { text: string } | Invalid {
  if (!object(body) || !onlyKeys(body, ["text"]) || !("text" in body))
    return { invalid: "Send {text}." };
  const text = memoryText(body.text, "text");
  return invalid(text) ? text : { text };
}

export function parseNoteEdit(body: unknown): { version: number; text: string } | Invalid {
  const usage = { invalid: "Send {version, text}." };
  if (!object(body) || !onlyKeys(body, ["version", "text"])) return usage;
  const { version } = body;
  if (!isID(version)) return usage;
  const text = memoryText(body.text, "text");
  return invalid(text) ? text : { version, text };
}

export function parseResponsibilityEdit(body: unknown):
  | {
      version: number;
      change: Partial<Pick<Responsibility, "goal" | "nextAction" | "status">>;
    }
  | Invalid {
  const usage = { invalid: "Send {version} and at least one of goal, nextAction and status." };
  if (!object(body) || !onlyKeys(body, ["version", "goal", "nextAction", "status"])) return usage;
  const { version } = body;
  if (!isID(version) || Object.keys(body).length < 2) return usage;
  const change: Partial<Pick<Responsibility, "goal" | "nextAction" | "status">> = {};
  if ("goal" in body) {
    const goal = memoryText(body.goal, "goal");
    if (invalid(goal)) return goal;
    change.goal = goal;
  }
  if ("nextAction" in body) {
    const next = memoryText(body.nextAction, "nextAction");
    if (invalid(next)) return next;
    change.nextAction = next;
  }
  if ("status" in body) {
    const wanted = body.status;
    const status = responsibilityStatuses.find((value) => value === wanted);
    if (!status) return { invalid: "status must be active, done or dropped." };
    change.status = status;
  }
  return { version, change };
}

export function parseReminderEdit(
  body: unknown,
  now: number,
): { version: number; change: Partial<Pick<Reminder, "dueAt" | "everyMinutes">> } | Invalid {
  const usage = { invalid: "Send {version} and at least one of dueAt and everyMinutes." };
  if (!object(body) || !onlyKeys(body, ["version", "dueAt", "everyMinutes"])) return usage;
  const { version } = body;
  if (!isID(version) || Object.keys(body).length < 2) return usage;
  const change: Partial<Pick<Reminder, "dueAt" | "everyMinutes">> = {};
  if ("dueAt" in body) {
    const { dueAt } = body;
    if (!isID(dueAt)) return { invalid: "dueAt must be a time in milliseconds." };
    if (dueAt <= now) return { invalid: "dueAt must be in the future." };
    if (dueAt > now + horizon) return { invalid: "dueAt must be within ten years from now." };
    change.dueAt = dueAt;
  }
  if ("everyMinutes" in body) {
    const every = body.everyMinutes;
    if (every === null) change.everyMinutes = null;
    else if (isID(every) && every <= maxEveryMinutes) change.everyMinutes = every;
    else
      return {
        invalid: `everyMinutes must be null, or whole minutes from 1 to ${maxEveryMinutes}.`,
      };
  }
  return { version, change };
}

/**
 * Where an owner's change landed. "conflict" means the item changed since the version the owner
 * saw, or a reminder is no longer scheduled, so nothing was saved and `current` is what it is now.
 * "missing" means this dot has no such item, for example because it was deleted.
 */
export type Outcome<T> =
  | { readonly saved: T }
  | { readonly deleted: true }
  | { readonly conflict: T }
  | { readonly missing: true };

const missing = { missing: true } as const;
const deleted = { deleted: true } as const;
const owner = (version: number) => ({
  version: version + 1,
  updatedAt: Date.now(),
  updatedBy: "owner" as const,
});

export const addNote = (db: Db, dot: string, text: string) => {
  const now = Date.now();
  return noteView(
    db
      .insert(notes)
      .values({ dot, text, createdAt: now, updatedAt: now, updatedBy: "owner" })
      .returning()
      .get(),
  );
};

const noteKey = (dot: string, id: number) => and(eq(notes.id, id), eq(notes.dot, dot));

/** Changes the note only if it's still at `version`, in one statement. */
export const editNote = (db: Db, dot: string, id: number, version: number, text: string) =>
  db.transaction((tx): Outcome<ReturnType<typeof noteView>> => {
    const saved = tx
      .update(notes)
      .set({ text, ...owner(version) })
      .where(and(noteKey(dot, id), eq(notes.version, version)))
      .returning()
      .get();
    if (saved) return { saved: noteView(saved) };
    const current = tx.select().from(notes).where(noteKey(dot, id)).get();
    return current ? { conflict: noteView(current) } : missing;
  });

export const deleteNote = (db: Db, dot: string, id: number, version: number) =>
  db.transaction((tx): Outcome<ReturnType<typeof noteView>> => {
    const removed = tx
      .delete(notes)
      .where(and(noteKey(dot, id), eq(notes.version, version)))
      .returning({ id: notes.id })
      .get();
    if (removed) return deleted;
    const current = tx.select().from(notes).where(noteKey(dot, id)).get();
    return current ? { conflict: noteView(current) } : missing;
  });

const responsibilityKey = (dot: string, id: number) =>
  and(eq(responsibilities.id, id), eq(responsibilities.dot, dot));

export const editResponsibility = (
  db: Db,
  dot: string,
  id: number,
  version: number,
  change: Partial<Pick<Responsibility, "goal" | "nextAction" | "status">>,
) =>
  db.transaction(
    (tx): Outcome<ReturnType<typeof responsibilityView>> => {
      const current = tx.select().from(responsibilities).where(responsibilityKey(dot, id)).get();
      if (!current) return missing;
      if (current.version !== version) return { conflict: responsibilityView(current) };
      // A status change pauses or resumes the schedule in the same statement.
      const nextRunAt =
        change.status === undefined
          ? {}
          : { nextRunAt: nextRunAfter(current, { ...current, ...change }, Date.now()) };
      const saved = tx
        .update(responsibilities)
        .set({ ...change, ...nextRunAt, ...owner(version) })
        .where(and(responsibilityKey(dot, id), eq(responsibilities.version, version)))
        .returning()
        .get();
      return saved
        ? { saved: responsibilityView(saved) }
        : { conflict: responsibilityView(current) };
    },
    { behavior: "immediate" },
  );

const reminderKey = (dot: string, id: number) => and(eq(reminders.id, id), eq(reminders.dot, dot));

/**
 * Changes a scheduled reminder only if it's still at `version`. The daemon claims a due reminder
 * only at the version it read, so a stale claim can't send the old time or undo this change.
 */
export const editReminder = (
  db: Db,
  dot: string,
  id: number,
  version: number,
  change: Partial<Pick<Reminder, "dueAt" | "everyMinutes">>,
) =>
  db.transaction((tx): Outcome<ReturnType<typeof reminderView>> => {
    const saved = tx
      .update(reminders)
      .set({ ...change, ...owner(version) })
      .where(
        and(reminderKey(dot, id), eq(reminders.version, version), eq(reminders.state, "scheduled")),
      )
      .returning()
      .get();
    if (saved) return { saved: reminderView(saved) };
    const current = tx.select().from(reminders).where(reminderKey(dot, id)).get();
    return current ? { conflict: reminderView(current) } : missing;
  });

/** Deletes a scheduled reminder at `version`, as `dot_cancel` does, so it never fires. */
export const cancelReminder = (db: Db, dot: string, id: number, version: number) =>
  db.transaction((tx): Outcome<ReturnType<typeof reminderView>> => {
    const removed = tx
      .delete(reminders)
      .where(
        and(reminderKey(dot, id), eq(reminders.version, version), eq(reminders.state, "scheduled")),
      )
      .returning({ id: reminders.id })
      .get();
    if (removed) return deleted;
    const current = tx.select().from(reminders).where(reminderKey(dot, id)).get();
    return current ? { conflict: reminderView(current) } : missing;
  });
