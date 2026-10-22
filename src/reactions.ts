import { and, desc, eq, inArray, max, notInArray } from "drizzle-orm";
import type { Db } from "./db";
import {
  type Dot,
  outbox,
  type Reaction,
  reactionEmojis,
  reactions,
  recentReactions,
} from "./schema";

/**
 * Exactly one emoji as Unicode's RGI_Emoji set defines it: a fully qualified emoji, keycap, flag,
 * tag sequence, skin-tone sequence or recommended ZWJ sequence. Text, an unqualified symbol such as
 * a bare ❤, a lone regional indicator, several emoji or an unrecommended ZWJ join all fail. Bun's
 * JavaScriptCore and bundled ICU decide which Unicode version's emoji count.
 */
const singleEmoji = /^\p{RGI_Emoji}$/v;

/**
 * A reaction value: one emoji, or null to remove. The match must be the whole string, so nothing,
 * not even a line break, may follow the emoji. The length cap only bounds the regex's work.
 */
export const isReactionEmoji = (value: unknown): value is Reaction["emoji"] =>
  value === null ||
  (typeof value === "string" && value.length <= 64 && singleEmoji.exec(value)?.[0] === value);

const isClassic = (emoji: string) => reactionEmojis.some((classic) => classic === emoji);

/** Fills the notch's second row until the owner has chosen five non-classic emoji of their own. */
export const fallbackEmojis = ["🧐", "✋", "👀", "🧠", "🔥"] as const;

/** The second row: the owner's five latest non-classic choices, newest first, then fallbacks. */
export const recentEmojis = (db: Db) => {
  const used = db
    .select({ emoji: recentReactions.emoji })
    .from(recentReactions)
    .orderBy(desc(recentReactions.seq))
    .limit(5)
    .all()
    .map((row) => row.emoji);
  return [...used, ...fallbackEmojis.filter((emoji) => !used.includes(emoji))].slice(0, 5);
};

/** The notch and the plugin use the same provenance, scoped to the bound conversation. */
export const messageSources = (db: Db, sessionID: string, ids: string[]) =>
  new Map(
    (ids.length
      ? db
          .select()
          .from(outbox)
          .where(and(eq(outbox.sessionID, sessionID), inArray(outbox.messageID, ids)))
          .all()
      : []
    ).map((row) => [row.messageID, row]),
  );

export const messageKind = (role: "user" | "assistant", row?: typeof outbox.$inferSelect) => {
  if (role === "assistant") return "dot";
  if (!row || row.fromOwner) return "owner";
  return row.fromDot ? "peer" : "notice";
};

export const currentReactions = (db: Db, dot: Dot, ids: string[]) =>
  ids.length
    ? db
        .select()
        .from(reactions)
        .where(
          and(
            eq(reactions.dot, dot.name),
            eq(reactions.sessionID, dot.sessionID),
            inArray(reactions.messageID, ids),
          ),
        )
        .all()
    : [];

/** A repeated PUT preserves even the timestamp. Null is a durable removal, not a deleted row. */
export const saveReaction = (
  db: Db,
  dot: Dot,
  messageID: string,
  actor: Reaction["actor"],
  emoji: Reaction["emoji"],
  text: string,
) =>
  db.transaction((tx) => {
    const key = and(
      eq(reactions.dot, dot.name),
      eq(reactions.sessionID, dot.sessionID),
      eq(reactions.messageID, messageID),
      eq(reactions.actor, actor),
    );
    const previous = tx.select().from(reactions).where(key).get();
    if (previous?.emoji === emoji) return previous;
    const value = { emoji, excerpt: text.slice(0, 240), updatedAt: Date.now() };
    // Only the owner's own choices become recent, never a dot's, and they outlive the reaction.
    if (actor === "owner" && emoji !== null && !isClassic(emoji)) {
      const last = tx
        .select({ seq: max(recentReactions.seq) })
        .from(recentReactions)
        .get();
      const seq = (last?.seq ?? 0) + 1;
      tx.insert(recentReactions)
        .values({ emoji, seq })
        .onConflictDoUpdate({ target: recentReactions.emoji, set: { seq } })
        .run();
      const kept = tx
        .select({ emoji: recentReactions.emoji })
        .from(recentReactions)
        .orderBy(desc(recentReactions.seq))
        .limit(5)
        .all()
        .map((row) => row.emoji);
      tx.delete(recentReactions).where(notInArray(recentReactions.emoji, kept)).run();
    }
    return tx
      .insert(reactions)
      .values({ dot: dot.name, sessionID: dot.sessionID, messageID, actor, ...value })
      .onConflictDoUpdate({
        target: [reactions.dot, reactions.sessionID, reactions.messageID, reactions.actor],
        set: value,
      })
      .returning()
      .get();
  });
