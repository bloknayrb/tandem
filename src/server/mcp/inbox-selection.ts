/**
 * Waiting on a document (ownership design §8.5, as #2358 PR 3b-2b1b's brief
 * rules it; ADR-054's 3b-2b1b amendment): does document D hold work waiting
 * for Tandem's Claude?
 *
 * **The rule (Ruling K).** D has waiting work when it holds a user comment or
 * a user thread reply that a FRESH cursor reader for Tandem's Claude (cursor
 * `"start"`, so its mark is null) polling D now would be handed. A fresh
 * reader has seen exactly what some reader acknowledged (`seenBy` in
 * `inbox-cursor.ts`), so an item counts as handed when the delivery registry
 * holds a live ACKNOWLEDGED entry for any of its versions at or above its
 * current `editedAt`. An item handed but never acknowledged was never
 * confirmed received, so it still counts as waiting.
 *
 * **A separate pure function, not the collector.** The inbox's own collector
 * (`awareness.ts`) writes as it selects (ledgers, range refreshes, quiet
 * records), so this restates its selection over plain inputs and is held to
 * it by `tests/server/ownership-waiting.test.ts`'s agreement table, which
 * compares this answer with a real fresh poll, world by world.
 *
 * It receives no live object: `annotations` and `repliesOf`'s results are
 * copies, `handedAtOrAbove` answers from the registry without exposing it,
 * and nothing here writes. What it mirrors, record by record:
 *  - **Comments:** the collector's user-comment arm. `author === "user"`,
 *    `type === "comment"`, `isClaudeFacing`, and not settled (`accepted` or
 *    `dismissed`) unless it carries an edit no acknowledged version accounts
 *    for. No local-model term (the collector has none on this arm).
 *  - **Replies:** `collectInboxUserReplies`. Only what `channelVisibleReplies`
 *    returns for the parent (the caller applies it, in `repliesOf`, and this
 *    module restates its test, so a caller passing raw replies cannot count a
 *    private one), never on
 *    a local-model parent, and `author === "user"`. Registry kind `"r"`,
 *    version 0. No status gate: the collector ignores the parent's status.
 *  - **Solo:** both count only while the mode reads `"tandem"`; the push rule
 *    (`shouldForwardExternally`). Indeterminate never counts (the reviewing
 *    session's ruling; flip-blocker "the restart question").
 *  - **Schema:** each item is built as a poll would build it, with an empty
 *    `textSnippet` (the text is not read), and must pass its bucket's schema,
 *    the poll's last gate (`admit`).
 *
 * Accept and dismiss notices never count (ownership design §8.5): they are not answerable.
 *
 * **What `handedAtOrAbove` must be.** It compares over every live version
 * with `>=`, not one exact version: the settled term below asks it with
 * `-Infinity` to mean "any acknowledged version". And it is asked only about
 * user comments and user replies, whose registry key is the bare
 * `documentId:id` (a Claude record's key also carries its status).
 */

import type { Annotation, AnnotationReply } from "../../shared/types.js";
import { isClaudeFacing, replyPrivacyAllows } from "../annotations/projection.js";
import type { ModeState } from "../mode.js";
import { inboxUserReplySchema, userActionSchema } from "./output-schemas.js";

/** Everything {@link isDocumentWaiting} reads. No field is a live object. */
export interface DocumentWaitingInput {
  /** The document the items belong to (stamped on each built item). */
  readonly documentId: string;
  /** The document's sanitised annotations, as a copy. */
  readonly annotations: readonly Annotation[];
  /** The replies a Claude-facing read may return for `annotation`, as copies. */
  readonly repliesOf: (annotation: Annotation) => readonly AnnotationReply[];
  /** The mode, as the poll resolves it (`readModeState`). */
  readonly mode: ModeState;
  /**
   * Whether the delivery registry holds a live acknowledged entry of kind
   * `kind` for item `id` on this document at version `editedAt` or above.
   */
  readonly handedAtOrAbove: (kind: "a" | "r", id: string, editedAt: number) => boolean;
  /** `models/local-period.ts`'s predicate. */
  readonly isLocalModelRecord: (record: unknown) => boolean;
}

/** The two settled end states, enumerated as the collector enumerates them. */
function isSettled(status: string): boolean {
  return status === "accepted" || status === "dismissed";
}

/** Whether the user comment `ann` would be handed to a fresh reader now. */
function commentWaits(input: DocumentWaitingInput, ann: Annotation): boolean {
  if (ann.author !== "user" || ann.type !== "comment" || !isClaudeFacing(ann)) return false;
  const version = ann.editedAt ?? 0;
  if (input.handedAtOrAbove("a", ann.id, version)) return false;
  // Settled: only an edit no acknowledged version accounts for reopens it.
  // The collector's test is `version > (newest acknowledged ?? 0)`; with no
  // acknowledged version at or above `version`, that is "some acknowledged
  // version exists (all below it), or none does and `version > 0`".
  if (
    isSettled(ann.status) &&
    !(version > 0 || input.handedAtOrAbove("a", ann.id, Number.NEGATIVE_INFINITY))
  ) {
    return false;
  }
  return userActionSchema.safeParse({ ...ann, textSnippet: "", documentId: input.documentId })
    .success;
}

/** Whether the user reply `reply` on `parent` would be handed to a fresh reader now. */
function replyWaits(
  input: DocumentWaitingInput,
  parent: Annotation,
  reply: AnnotationReply,
): boolean {
  // `channelVisibleReplies`' gate, restated so the rule holds whatever
  // `repliesOf` returns (ADR-027): only a Claude-facing comment's replies,
  // and only one whose `private` is literally `false` or absent (#2460). The
  // adapter applies the same gate first, and that gate holds the author
  // allow-list; the user-only check below is this predicate's own rule.
  if (parent.type !== "comment" || !isClaudeFacing(parent) || !replyPrivacyAllows(reply)) {
    return false;
  }
  if (reply.author !== "user") return false;
  if (input.handedAtOrAbove("r", reply.id, 0)) return false;
  return inboxUserReplySchema.safeParse({
    id: reply.id,
    annotationId: parent.id,
    author: "user",
    text: reply.text,
    timestamp: reply.timestamp,
    textSnippet: "",
    documentId: input.documentId,
  }).success;
}

/**
 * Whether the document holds a user comment or user thread reply a fresh
 * cursor reader for Tandem's Claude would be handed now (see the module
 * docblock). Pure: it reads its input and writes nothing.
 */
export function isDocumentWaiting(input: DocumentWaitingInput): boolean {
  if (input.mode !== "tandem") return false;
  for (const ann of input.annotations) {
    if (commentWaits(input, ann)) return true;
  }
  for (const ann of input.annotations) {
    if (input.isLocalModelRecord(ann)) continue;
    for (const reply of input.repliesOf(ann)) {
      if (replyWaits(input, ann, reply)) return true;
    }
  }
  return false;
}
