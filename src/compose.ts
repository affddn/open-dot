import {
  autoRecall,
  autoRecallHits,
  autoRecallWords,
  listedNotes,
  recall,
  recalledBlock,
  settingsOf,
} from "./archive";
import type { Db } from "./db";
import { headFor, ledgerHits, type LatestCompaction, sinceCheckpoint, stateOf } from "./ledger";
import { messageKind, messageSources } from "./reactions";
import type { Dot } from "./schema";

/** A public `session.context` item, as far as composing a request needs it. */
export interface ContextItem {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly status?: string;
  readonly native?: unknown;
}

/** The newest owner message since the last turn end in context, with the owner's own words. */
export function latestOwner(db: Db, dot: Dot, items: readonly ContextItem[]) {
  const turn = items.slice(items.findLastIndex((item) => item.type === "idle") + 1);
  const users = turn.filter((item) => item.type === "user");
  const sources = messageSources(
    db,
    dot.sessionID,
    users.map((item) => item.id),
  );
  const latest = users.findLast((item) => messageKind("user", sources.get(item.id)) === "owner");
  if (!latest) return undefined;
  const source = sources.get(latest.id);
  return {
    id: latest.id,
    text: source?.quote?.prompt ?? source?.feed?.prompt ?? source?.ownerText ?? latest.text ?? "",
  };
}

/** The latest completed compaction in context, which context starts from. */
export function latestCompaction(items: readonly ContextItem[]): LatestCompaction | undefined {
  const found = items.findLast((item) => item.type === "compaction" && item.status === "completed");
  return found ? { id: found.id, native: found.native !== undefined } : undefined;
}

/**
 * Whether phase 3 (the ledger, ranked notes and the checkpoint) applies: never after a native
 * compaction, which keeps phases 1 and 2 only.
 */
export const textMode = (items: readonly ContextItem[]) => latestCompaction(items)?.native !== true;

/** What a request adds, apart from the memory snapshot itself. */
export interface Composed {
  /** The checkpoint that goes first, the same text until the next compaction. */
  readonly head: ReturnType<typeof headFor>;
  /** The saved notes the memory snapshot lists. */
  readonly notes: ReturnType<typeof listedNotes>;
  /** Rows changed since the checkpoint, then the automatic recall block, for the tail. */
  readonly tail: string;
}

/**
 * Composes a request's memory layers from open-dot's database and the public context the caller
 * read, with no model and no OpenCode call. `cache` keeps one recall block per owner message; its
 * key changes with anything that would change the block: the session, the owner message, the
 * ledger's epoch, the settings, the latest compaction and the checkpoint.
 */
export function composeTurn(
  db: Db,
  dot: Dot,
  items: readonly ContextItem[],
  cache?: { key?: string; text?: string },
): Composed {
  const settings = settingsOf(db, dot.name);
  const owner = latestOwner(db, dot, items);
  const compaction = latestCompaction(items);
  const phase3 = compaction?.native !== true;
  const head = phase3 ? headFor(db, dot, compaction) : undefined;
  const since = head && settings.ledger ? sinceCheckpoint(db, dot.name, head) : undefined;
  const notes = listedNotes(db, dot.name, owner?.text ?? "", phase3 && settings.rankNotes);
  let recalled = "";
  if (settings.archive && settings.autoRecall && owner) {
    const state = stateOf(db, dot.name);
    const key = JSON.stringify([
      dot.sessionID,
      owner.id,
      state.epoch,
      // The switches themselves, not when they changed: two changes can share a millisecond.
      settings.archive,
      settings.autoRecall,
      settings.ledger,
      settings.frozenHead,
      settings.generation,
      compaction ?? null,
      head ? [state.headJob, head.at] : null,
    ]);
    if (cache?.key === key && cache.text !== undefined) recalled = cache.text;
    else {
      const shown = new Set([...(head?.rows ?? []), ...(since?.rows ?? [])]);
      const observed =
        phase3 && settings.ledger
          ? ledgerHits(db, dot.name, autoRecallWords(owner.text), shown, autoRecallHits, 2)
          : [];
      const visible = new Set(items.map((item) => item.id));
      recalled = recalledBlock(autoRecall(db, dot, owner.text, visible), observed);
      if (cache) {
        cache.key = key;
        cache.text = recalled;
      }
    }
  }
  return { head, notes, tail: (since?.text ?? "") + recalled };
}

/**
 * dot_recall's results: with the ledger on and phase 3 in force, the first page leads with up to
 * three matching current rows, then notes and archived messages.
 */
export function recallResults(
  db: Db,
  dot: Dot,
  words: readonly string[],
  limit: number,
  offset: number,
  phase3: boolean,
) {
  const found = recall(db, dot, words, limit, offset);
  if ("invalid" in found && typeof found.invalid === "string") return { invalid: found.invalid };
  const observed =
    offset === 0 && phase3 && settingsOf(db, dot.name).ledger
      ? ledgerHits(db, dot.name, words, new Set(), 3).map(({ kind: type, ...row }) => ({
          kind: "observed" as const,
          type,
          ...row,
        }))
      : [];
  return { results: [...observed, ...found.results], next: found.next, observed: observed.length };
}
