/**
 * Waiting for Tandem's Claude (ownership design §8.5 as #2358 PR 3b-2b1b's
 * and 3b-2b1b-chat's briefs rule it; ADR-054's 3b-2b1b and 3b-2b1b-chat
 * amendments). Two pure rules, one per half: does document D hold work
 * waiting ({@link isDocumentWaiting}), and which user chat rows would a fresh
 * reader be handed if it may have them ({@link chatRowsOwedToFreshReader};
 * the chat half, below the document half).
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
 *
 * **The chat half (Ruling K applied to chat).** A user chat message is
 * waiting when a fresh cursor reader for Tandem's Claude would be handed it.
 * The cursor collector (`collectCursorChat` in `awareness.ts`) tests, in
 * order: the author, the handled set (`settledChatIds`), local-period chat,
 * the ownership scope, "owed" (for a null mark and an empty `held`, that is
 * `!msg.read`: no registry entry is consulted) and the item schema
 * (`admitChatItem`). {@link chatRowsOwedToFreshReader} restates every test
 * but the scope, which only the ownership module can answer: it decides from
 * the rows the chat side's `owedToFreshReader` member (on `ownershipChatSide`)
 * passes as copies, and the ownership module applies the scope to its
 * answer. No Solo or mode term: the poll hands chat in Solo too. The schema
 * check is a bare `safeParse` of the item built as `admitChatItem` builds
 * it, because `admitChatItem` logs a drop and this must not.
 */

import type { Annotation, AnnotationReply, ChatMessage } from "../../shared/types.js";
import { isClaudeFacing, replyPrivacyAllows } from "../annotations/projection.js";
import type { ModeState } from "../mode.js";
import {
  inboxChatMessageSchema,
  inboxUserReplySchema,
  userActionSchema,
} from "./output-schemas.js";

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

// ---------------------------------------------------------------------------
// The chat half (#2358 PR 3b-2b1b-chat).

/** Everything {@link chatRowsOwedToFreshReader} reads. No field is a live object. */
export interface ChatRowsInput {
  /** The chat map's rows in map order, each `row` a copy of the stored value. */
  readonly rows: ReadonlyArray<{ readonly key: string; readonly row: unknown }>;
  /** The handled keys (`settledChatIds` over the same map). */
  readonly handled: ReadonlySet<string>;
  /** `models/local-period.ts`'s local-period chat predicate, by map key. */
  readonly isLocalPeriodChat: (key: string) => boolean;
}

/** Whether the chat row `msg` passes the item schema, built as `admitChatItem` builds it. Logs nothing. */
function chatItemAdmitted(msg: Partial<ChatMessage>): boolean {
  return inboxChatMessageSchema.safeParse({
    id: msg.id,
    text: msg.text,
    timestamp: msg.timestamp,
    ...(msg.documentId ? { documentId: msg.documentId } : {}),
    ...(msg.anchor ? { anchor: msg.anchor } : {}),
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
  }).success;
}

/**
 * The keys of the user chat rows a fresh cursor reader would be handed if
 * the ownership scope lets it have them, in input order (see the module
 * docblock): an object row with `author === "user"`, not handled, not
 * local-period chat, not read (`!msg.read`), and admitted by the chat item
 * schema. Pure: it reads its input and writes nothing.
 */
export function chatRowsOwedToFreshReader(input: ChatRowsInput): string[] {
  const keys: string[] = [];
  for (const { key, row } of input.rows) {
    if (typeof row !== "object" || row === null) continue;
    const msg = row as Partial<ChatMessage>;
    if (msg.author !== "user" || input.handled.has(key)) continue;
    if (input.isLocalPeriodChat(key)) continue;
    if (msg.read) continue;
    if (!chatItemAdmitted(msg)) continue;
    keys.push(key);
  }
  return keys;
}
