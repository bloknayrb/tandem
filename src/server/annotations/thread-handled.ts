/**
 * The handled rule for a comment thread (#2360; ADR-054's #2360 PR A
 * amendment; ownership design §6.4 as reworked by `docs/plans/2360-thread-replies.md`
 * §3). The twin of `mcp/chat-handled.ts`. **Pure**: it reads the values it is
 * handed and nothing else — no Y.Doc, no registry, no flag, no clock.
 *
 * A thread entry is the user's comment at one version (`c:<editedAt>`) or one
 * user reply (`r:<replyId>`). An entry is **handled** when a FINAL Claude reply
 * on its thread lists its key in `answers`. No timestamp is compared: a reply
 * lists only what was visible to, handed to and acknowledged by the owner that
 * wrote it (the reply seam, `lifecycle.ts`), so a reply written during Solo, a
 * reply arriving while Claude worked, and an entry another session was handed
 * are never listed.
 *
 * PR A writes `answers` and uses {@link settledThreadKeys} to avoid listing a
 * key twice; PR B's handled filter (`mcp/awareness.ts`, `mcp/inbox-selection.ts`)
 * reads {@link settledKeysByThread} so a handled entry is neither handed out,
 * re-owed at a handover nor counted as waiting, and the reply observer
 * (`events/observers/replies.ts`) reads {@link threadHoldsFinalClaudeReply} to
 * make a user's follow-up start-worthy (Bryan's Q6).
 */

import { THREAD_ANSWER_KEY_MAX, THREAD_ANSWERS_MAX } from "../../shared/constants.js";
import { isHeldInSoloMarker } from "../../shared/sanitize.js";
import type { AnnotationReply } from "../../shared/types.js";
import { hideFromAI, type ModeState } from "../mode.js";

/** A finite number, or null. `Number.isFinite`, not `typeof`: NaN is a number. */
export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One entry of a thread, with the delivery registry's coordinates for it:
 * kind `"a"` at version `editedAt` for the comment (the user-comment item's
 * registry key), kind `"r"` at version 0 for a user reply.
 */
export interface ThreadEntry {
  readonly key: string;
  readonly kind: "a" | "r";
  readonly id: string;
  readonly version: number;
}

/** The key of the user's comment at version `editedAt` (a non-finite one keys as 0). */
export function commentEntryKey(editedAt: unknown): string {
  return `c:${finiteOrNull(editedAt) ?? 0}`;
}

/** The key of a user reply. The same string the answered-once item uses. */
export function replyEntryKey(replyId: string): string {
  return `r:${replyId}`;
}

/** The parent fields the rule reads. */
export interface ThreadParent {
  readonly id: string;
  readonly author: string;
  readonly editedAt?: unknown;
  readonly heldInSolo?: unknown;
}

/**
 * The thread entries Claude can see, in thread order (the comment first, then
 * the user replies in the order `visibleReplies` holds them).
 *
 * `visibleReplies` must already have passed `channelVisibleReplies` (the
 * ADR-027 gates: a Claude-facing comment parent, the author allow-list, no
 * `private` reply), and the parent must already have passed the channel
 * narrow; this adds the gates `threadItemAnsweredBy` adds and nothing else:
 * the Solo hold on the parent (`hideFromAI` in `mode`), and per reply
 * `author === "user"` and no `heldInSolo` marker in any mode
 * (`isHeldInSoloMarker`, so a reply written during Solo stays out until its
 * release clears the marker). The comment itself is an entry only when it is
 * user-authored.
 */
export function visibleThreadEntries(
  parent: ThreadParent,
  visibleReplies: readonly Pick<AnnotationReply, "id" | "author" | "heldInSolo">[],
  mode: ModeState,
): ThreadEntry[] {
  if (hideFromAI(parent, mode)) return [];
  const entries: ThreadEntry[] = [];
  if (parent.author === "user") {
    const version = finiteOrNull(parent.editedAt) ?? 0;
    entries.push({ key: commentEntryKey(version), kind: "a", id: parent.id, version });
  }
  for (const reply of visibleReplies) {
    if (reply.author !== "user" || isHeldInSoloMarker(reply.heldInSolo)) continue;
    entries.push({ key: replyEntryKey(reply.id), kind: "r", id: reply.id, version: 0 });
  }
  return entries;
}

/**
 * Whether a stored reply row is a FINAL Claude reply, whose `answers` count:
 * Claude's (not the local model's: no `agentIdentity`), not an in-progress
 * acknowledgement, and carrying an `answers` array. A row written before
 * #2360, with no `answers`, settles nothing. Mirrors `isFinalClaudeReply` in
 * `mcp/chat-handled.ts`.
 */
export function isFinalClaudeThreadReply(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const reply = row as Partial<AnnotationReply>;
  return (
    reply.author === "claude" &&
    reply.agentIdentity === undefined &&
    reply.inProgress !== true &&
    Array.isArray(reply.answers)
  );
}

/**
 * Bound `answers` exactly as the durable schema does (#1295 L3): a key longer
 * than {@link THREAD_ANSWER_KEY_MAX} is not listed, and past
 * {@link THREAD_ANSWERS_MAX} the earliest keys in thread order are kept. What
 * is left out stays owed (fails safe). The reply seam's write and the second
 * step's append both go through this.
 */
export function boundThreadAnswers(keys: readonly string[]): string[] {
  return keys.filter((key) => key.length <= THREAD_ANSWER_KEY_MAX).slice(0, THREAD_ANSWERS_MAX);
}

/**
 * The keys settled on one thread: every string listed in `answers` by a final
 * Claude reply among `rows` whose `annotationId` is `annotationId`.
 */
export function settledThreadKeys(rows: Iterable<unknown>, annotationId: string): Set<string> {
  const settled = new Set<string>();
  for (const row of rows) {
    if (!isFinalClaudeThreadReply(row)) continue;
    const reply = row as AnnotationReply;
    if (reply.annotationId !== annotationId) continue;
    for (const key of reply.answers ?? []) if (typeof key === "string") settled.add(key);
  }
  return settled;
}

/**
 * The keys settled on every thread among `rows`, by `annotationId`, in one
 * pass (#2360 PR B, the handled filter): the same rule as
 * {@link settledThreadKeys}, for a reader that asks about many threads.
 */
export function settledKeysByThread(rows: Iterable<unknown>): Map<string, Set<string>> {
  const byThread = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!isFinalClaudeThreadReply(row)) continue;
    const reply = row as AnnotationReply;
    if (typeof reply.annotationId !== "string") continue;
    let settled = byThread.get(reply.annotationId);
    for (const key of reply.answers ?? []) {
      if (typeof key !== "string") continue;
      if (!settled) {
        settled = new Set();
        byThread.set(reply.annotationId, settled);
      }
      settled.add(key);
    }
  }
  return byThread;
}

/**
 * Whether the thread `annotationId` holds a final Claude reply among `rows`
 * (#2360 PR B; Bryan's Q6, "Yes, start it"): the user is then talking to
 * Claude in that thread, so their follow-up may start a stopped Tandem's
 * Claude. A row written before #2360 (no `answers`), an in-progress
 * acknowledgement and the local model's reply do not count.
 */
export function threadHoldsFinalClaudeReply(
  rows: Iterable<unknown>,
  annotationId: string,
): boolean {
  for (const row of rows) {
    if (isFinalClaudeThreadReply(row) && (row as AnnotationReply).annotationId === annotationId) {
      return true;
    }
  }
  return false;
}
