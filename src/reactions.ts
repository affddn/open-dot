import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./db";
import { type Dot, outbox, type Reaction, reactionEmojis, reactions } from "./schema";

export const isReactionEmoji = (value: unknown): value is Reaction["emoji"] =>
  value === null || reactionEmojis.some((emoji) => emoji === value);

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
