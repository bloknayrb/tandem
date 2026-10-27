import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";
import { z } from "zod";
import { CTRL_ROOM, Y_MAP_CHAT, Y_MAP_CHAT_STREAM } from "../../shared/constants.js";
import { crossBasename } from "../../shared/cross-basename.js";
import { CHAT_ACK_RULE } from "../../shared/launcher/contract.js";
import { withInternal, withMcp } from "../../shared/origins.js";
import { selectionFingerprint } from "../../shared/selection-fingerprint.js";
import type {
  AgentIdentity,
  Annotation,
  AnnotationReply,
  ChatMessage,
} from "../../shared/types.js";
import { generateMessageId } from "../../shared/utils.js";
import { isClaudeFacing } from "../annotations/projection.js";
import { isStoreReadOnly } from "../annotations/store.js";
import { clearStreamStaleness, noteStreamSidecar } from "../chat-stream-staleness.js";
import { recordInboxPoll, resolveDeliveryRound } from "../events/delivery-state.js";
import { getAnnotationEditedChannelKey, wasEmittedViaChannelInDocument } from "../events/queue.js";
import { type AiRefusal, aiRefusal } from "../license/ai-refusal.js";
import {
  hideFromAI,
  type ModeState,
  readModeProvenance,
  readModeState,
  reportedMode,
} from "../mode.js";
import { getCurrentSessionId } from "../sessions/context.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { channelVisibleReplies } from "./annotations.js";
import { getCurrentDoc, getOpenDocs } from "./document.js";
import { getDocumentStore } from "./document-store.js";
import {
  checkInboxOutputShape,
  inboxChatMessageSchema,
  inboxUserReplySchema,
  userActionSchema,
  userResponseSchema,
} from "./output-schemas.js";
import {
  mcpError,
  mcpStructured,
  mcpSuccess,
  noDocumentError,
  withErrorBoundary,
  withStructuredErrors,
} from "./response.js";
import { READ_ONLY_TOOL } from "./tool-annotations.js";
import { withTypingPresence } from "./typing-presence.js";

/**
 * Which annotations have been surfaced to Claude via checkInbox.
 * Value = lastSurfacedEditedAt (0 for unedited), so an edit re-surfaces.
 *
 * Keys are `${documentId}:${annotationId}` — DOCUMENT-SCOPED, and that is
 * load-bearing rather than defensive. Imported Word annotation ids are
 * deterministic across files by design: `importAnnotationId` hashes only
 * commentId + range + body text, with no path, so re-importing the same file
 * dedupes. The consequence is that the SAME Word comment living in two open
 * `.docx` files carries ONE id. Under a bare-id key, promoting it in document A
 * surfaced it and promoting it in document B was silently dropped — one client,
 * no restart, no multi-session involved. Promotion bumps `rev`, not `editedAt`,
 * so the re-surface hatch below never fired either.
 *
 * Scope on the document ID (the Hocuspocus room), never on `filePath` or
 * `docHash`: rename keeps the id and swaps the path, so a path-derived key would
 * strand the whole ledger and re-surface every annotation in the document.
 */
const surfacedIds = new Map<string, number>();

/**
 * WS-A2: separate ledger for user replies surfaced via the userReplies bucket.
 * Kept distinct from surfacedIds because reply IDs and annotation IDs share no
 * namespace guarantee and their surfacing rules differ.
 *
 * Same `${documentId}:${replyId}` scoping, for the same reason and MORE
 * urgently: `importReplyId` is deterministic across files exactly like
 * `importAnnotationId`, and this ledger is a plain Set with no edit dimension —
 * so a cross-document collision here has no escape hatch at all. The imported
 * Word thread in two files loses its replies in the second one for the whole
 * server run.
 */
const replySurfacedIds = new Set<string>();

/**
 * Appended to the `tandem_checkInbox` summary whenever chat is present. The inbox
 * is the one place every population converges (supervisor child, hand-launched
 * poller, monitor and ws wakes), so it is the carrier that cannot be missed; the
 * skill, the `tandem_reply` description and the supervisor prompts restate it.
 * The rule itself is `CHAT_ACK_RULE`, shared with those carriers; this adds a
 * leading reason (the user sees nothing until Claude replies) and the two
 * inbox-specific clauses about batches and repeats.
 */
export const CHAT_ACK_DIRECTIVE = `The user sees nothing in chat until you reply. ${CHAT_ACK_RULE} If several arrived together, reply to the latest. Skip any you have already answered`;

/** Ledger key. See `surfacedIds` for why the document scope is required. */
function ledgerKey(documentId: string, itemId: string): string {
  return `${documentId}:${itemId}`;
}

/**
 * The ANNOTATION ledger key (#1770), which adds a status dimension for Claude's
 * own records.
 *
 * The ledger keys on `editedAt` alone, and the client's Undo writes
 * `status: "pending"` without touching it (`useAnnotationReview.svelte.ts`). So
 * accept → poll → undo → dismiss → poll returned `userResponses: []`: the
 * dismissal was never reported, because the id had already been surfaced at a
 * newer-or-equal `editedAt`. Appending the status makes the dismissed record a
 * fresh key.
 *
 * Not `rev`: neither the client's resolve nor its undo write bumps it.
 *
 * Claude-authored only. A user COMMENT keeps the bare-id key — its bucket is
 * `userActions`, whose whole re-surface rule is the `editedAt` comparison, and
 * a status dimension there would re-report a comment on every status change.
 *
 * Known limit: accept → undo → accept is not re-reported, because the key
 * repeats. Claude's last report equals the final state, which is the property
 * that matters.
 */
function inboxLedgerKey(
  documentId: string,
  ann: Pick<Annotation, "id" | "author" | "status">,
): string {
  const base = ledgerKey(documentId, ann.id);
  return ann.author === "claude" ? `${base}#${ann.status}` : base;
}

/**
 * An edit this ledger has not accounted for — **including one on a record the
 * ledger has no entry for at all** (`?? 0`, not `!== undefined`).
 *
 * That second half is the whole point and it is NOT the `edited` re-surface
 * flag. A user comment can be resolved before it was ever surfaced — Claude can
 * learn of it from `tandem_getAnnotations` or the channel and call
 * `tandem_resolveAnnotation` without ever polling `tandem_checkInbox` — and a
 * record rejected by the `userActions` status gate takes no `surfaced.set`, so
 * it can never acquire the entry a "surfaced before, edited since" test needs.
 * Requiring one loses the user's subsequent edit for the life of the process
 * while the observer still emits `annotation:edited` on the channel: push and
 * pull disagree, permanently, which is the exact defect #1826 item 1 removed
 * from the accept path.
 *
 * Residual, and it is a duplicate rather than a loss: an already-edited,
 * resolved user comment surfaces once more after a server restart, because an
 * empty ledger and a never-surfaced record are indistinguishable without
 * durable state. The #1826 population — resolved comments never edited — stays
 * suppressed, since `editedAt` is then absent and `0 > 0` is false. Closing the
 * residual means a durable ledger.
 */
function hasUnaccountedEdit(
  ann: Pick<Annotation, "editedAt">,
  lastSurfacedEditedAt: number | undefined,
): boolean {
  return (ann.editedAt ?? 0) > (lastSurfacedEditedAt ?? 0);
}

/**
 * The two settled end states, enumerated — deliberately NOT spelled as a test
 * against `"pending"` in either direction (review round 3).
 *
 * `Annotation.status` types as the three-value enum, but the stored value is a
 * bare `string`: `sanitizeAnnotation` passes `status` straight through with no
 * normalization, and the annotations Y.Map is writable by any connected client,
 * so an unrecognized status is reachable on a record that reaches both callers
 * below. Both spellings of the `"pending"` test fail such a record CLOSED, and
 * closed here means permanently invisible rather than merely delayed:
 * `=== "pending"` is false, so the gate never admits the comment to
 * `tandem_checkInbox`; `!== "pending"` is true, so the mirror permanently
 * excludes it from range refresh as well. Enumerating the real end states makes
 * an unknown status read as UNSETTLED instead, whose cost is a duplicate.
 *
 * Both callers must go through this. The gate and its mirror have to agree, and
 * one shared predicate is the only thing that keeps them in step.
 */
function isSettledStatus(status: string): boolean {
  return status === "accepted" || status === "dismissed";
}

/**
 * A user comment the `userActions` gate below cannot admit: resolved, with no
 * unaccounted edit. Mirrors the gate — the two must be read together.
 *
 * Deliberately omits the `isClaudeFacing` half of the gate. A record withheld
 * for AUDIENCE is skipped in the loop and also takes no `surfaced.set`, so it
 * too re-enters the candidate set on every poll; excluding it here would key a
 * permanent skip on a field the loop is not the only writer of, and a stored
 * `{comment, private}` record healed to outbound must be able to come back.
 * Status is safe to key on because this predicate re-runs against the live
 * record on every poll and holds no state of its own.
 */
function isSettledUserComment(ann: Annotation, lastSurfacedEditedAt: number | undefined): boolean {
  return (
    ann.author === "user" &&
    ann.type === "comment" &&
    isSettledStatus(ann.status) &&
    !hasUnaccountedEdit(ann, lastSurfacedEditedAt)
  );
}

/**
 * Bumped by {@link resetInbox}. A quiet-document skip entry records the
 * generation it was taken under, so one recorded against a ledger that has since
 * been emptied never matches (see `quietDocs`).
 */
let ledgerGeneration = 0;

/** Reset surfaced IDs (exported for testing) */
export function resetInbox(): void {
  surfacedIds.clear();
  replySurfacedIds.clear();
  ledgerGeneration += 1;
}

/** What `appendClaudeChatMessage` returns: the new message id, or the licence refusal. */
export type ClaudeChatAppend = { ok: true; id: string } | { ok: false; refusal: AiRefusal };

/**
 * Listeners told whenever a Claude Code session's `tandem_reply` lands a chat
 * message (#2197): how the launcher supervisor learns its one-time greeting
 * reached the chat. Two `tandem_reply` tools reach here — the MCP tool below,
 * and the channel shim's, through `/api/channel-reply` (the shim ships in the
 * plugin, so Tandem's own Claude can hold both). The local-model collaborator
 * also appends Claude chat but never notifies: it is not Tandem's Claude. The
 * listener gets the caller's `X-Claude-Session-Id` (undefined when the
 * transport sends none) and no content, so the supervisor can tell its own
 * child from another session. A seam rather than an import, because the
 * supervisor must not reach the MCP layer; `index.ts` wires the two. A
 * throwing listener is logged and never fails the reply.
 */
const tandemReplyListeners = new Set<(sessionId: string | undefined) => void>();

export function onTandemReply(cb: (sessionId: string | undefined) => void): () => void {
  tandemReplyListeners.add(cb);
  return () => tandemReplyListeners.delete(cb);
}

export function notifyTandemReply(sessionId: string | undefined): void {
  for (const cb of tandemReplyListeners) {
    try {
      cb(sessionId);
    } catch (err) {
      console.error("[Tandem] A chat listener failed:", err);
    }
  }
}

/**
 * Append a Claude-authored chat message to CTRL_ROOM's chat map — the single
 * write path for `tandem_reply` AND the local-model collaborator's streamed
 * reply (#1123 M1.2). Tagged `withMcp` + `author:"claude"`, so the ctrl-chat
 * observer skips it on BOTH the origin gate (`mcp` ∈ CHANNEL_SKIP) and the
 * `author !== "user"` gate — a Claude/local write can never self-wake the
 * channel. Conditional spreads keep the on-wire `ChatMessage` shape identical
 * to the historical `tandem_reply` write.
 *
 * **Licence admission point (#1521).** An AI chat write is refused, before any
 * Y.Doc access, when Tandem is unlicensed; the result says so rather than
 * returning a bare id, so every caller has to handle the refusal explicitly.
 * The user's own chat (browser writes over Hocuspocus) never comes through here.
 */
export function appendClaudeChatMessage(
  text: string,
  opts: {
    documentId?: string;
    replyTo?: string;
    agentIdentity?: AgentIdentity;
    inProgress?: boolean;
  } = {},
): ClaudeChatAppend {
  const refusal = aiRefusal();
  if (refusal) return { ok: false, refusal };
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
  const id = generateMessageId();
  const msg: ChatMessage = {
    id,
    author: "claude",
    text,
    timestamp: Date.now(),
    ...(opts.documentId ? { documentId: opts.documentId } : {}),
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    // #1123 M3: agent byline (local-model collaborator only). `tandem_reply`
    // omits it ⇒ real-Claude chat is byte-identical. The byline lives on the
    // chat row, which streaming leaves untouched (#1340 — deltas go to the
    // chatStream sidecar), and finalizeClaudeChatMessage's `{...existing}`
    // fold carries it into the final re-set.
    ...(opts.agentIdentity ? { agentIdentity: opts.agentIdentity } : {}),
    ...(opts.inProgress === true ? { inProgress: true as const } : {}),
    read: true,
  };
  withMcp(ctrlDoc, () => chatMap.set(id, msg));
  return { ok: true, id };
}

/**
 * Stamp a user chat message `read: true` because Claude answered it, so a session
 * that got the message PUSHED (never stamped by `tandem_checkInbox`) is not handed
 * it again on its next poll, and the editor's pickup row moves off "waiting".
 *
 * Called by `tandem_reply` and `/api/channel-reply` only — deliberately NOT folded
 * into `appendClaudeChatMessage`, whose third caller, the local-model collaborator,
 * replies to every chat in Tandem mode: stamping on its behalf would hide every
 * message from Claude's inbox the moment `BYO_MODELS_ENABLED` flips.
 *
 * Only an unread USER message is touched; an unknown id, a Claude row or an
 * already-read one writes nothing.
 *
 * @returns whether `messageId` names a user message at all (read or not), so a
 *   caller can tell Claude its `replyTo` pointed nowhere instead of letting the
 *   mismatch pass silently.
 */
export function markUserChatRead(messageId: string): boolean {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
  const target = chatMap.get(messageId) as ChatMessage | undefined;
  if (target?.author !== "user") return false;
  if (!target.read) withMcp(ctrlDoc, () => chatMap.set(messageId, { ...target, read: true }));
  return true;
}

/** Shown to Claude when a `replyTo` named no user chat message. */
export const REPLY_TO_UNMATCHED_WARNING =
  "replyTo did not match any user chat message, so the editor cannot tie this reply to " +
  "the message it answers. Pass the `id` from tandem_checkInbox's chatMessages (or a " +
  "channel event's message_id).";

/**
 * Stream the text of an existing Claude-authored chat message, for the
 * local-model collaborator's token streaming (#1123 M1.2, #1340). `text` is
 * always the FULL text so far; the write is the minimal diff-splice into a
 * per-message `Y.Text` in the `chatStream` sidecar map — pure append in the
 * common case — so a stream of final length L costs O(L) update bytes on the
 * wire instead of the old whole-value re-`set`'s O(L²). (Per-flush CPU is
 * still O(current length) — `toString()` + the prefix scan — bounded by the
 * producer's cap; the linearity claim is a WIRE claim.)
 *
 * While the sidecar entry exists it is AUTHORITATIVE over the chat row's
 * `text` — the row is deliberately stale mid-stream and readers compose (see
 * `Y_MAP_CHAT_STREAM` in shared/constants.ts). Callers MUST end the stream
 * with {@link finalizeClaudeChatMessage}, which folds the text back into the
 * row; the chat row itself is untouched here, so `id`, `author`, `timestamp`
 * (deliberately never re-stamped: ChatPanel sorts by timestamp), `read`,
 * `documentId`, `replyTo` and `agentIdentity` ride through streaming verbatim.
 *
 * No-op when the chat row is absent (doc closed / message GC'd / chat cleared
 * mid-stream) — and in that case any orphan sidecar entry is deleted, so a
 * `DELETE /api/chat` racing an in-flight stream converges instead of leaving
 * an erased message's `Y.Text` behind.
 *
 * The splice point is clamped to a code-point boundary: `Y.Text` splices at a
 * UTF-16 offset inside a surrogate pair make Yjs substitute U+FFFD on both
 * sides of the split — permanently. Never remove the clamp.
 */
export function updateClaudeChatMessage(id: string, text: string): void {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
  const streamMap = ctrlDoc.getMap(Y_MAP_CHAT_STREAM);
  const existing = chatMap.get(id) as ChatMessage | undefined;
  if (!existing) {
    if (streamMap.has(id)) {
      // Convergence cleanup after `DELETE /api/chat` raced a flush, not a
      // Claude-authored chat write — `withInternal`'s documented
      // "cleanup-after-failure" case (Critical Rule 2: the helper IS the
      // contract, and `audit:origins` reads it as a census of intent).
      withInternal(ctrlDoc, () => streamMap.delete(id));
      clearStreamStaleness(id);
    }
    return;
  }

  const entry = streamMap.get(id);
  const yText = entry instanceof Y.Text ? entry : null;
  const current = yText ? yText.toString() : "";
  // Covers both "unchanged text" and "no sidecar yet + empty text": no ops,
  // no empty broadcast, and never an empty-but-authoritative sidecar entry.
  if (current === text) return;
  // No sidecar and the row already holds exactly this text (a flushFinal
  // re-sending what the minting append committed): minting a sidecar just to
  // fold it back would cost two O(L) writes for nothing.
  if (!yText && text === existing.text) return;

  // Seed only. The age CHECK runs from `foldChatStream`'s sweep, which
  // enumerates live entries regardless of producer activity — the abandoned
  // producer this tripwire exists for stops calling this function entirely.
  noteStreamSidecar(id);

  withMcp(ctrlDoc, () => {
    let target = yText;
    if (!target) {
      target = new Y.Text();
      // Attach BEFORE populate: a detached Y.Text reverses segment order
      // (docs/gotchas.md, Y.js section). `set` integrates it in this txn.
      streamMap.set(id, target);
    }
    // Longest common prefix of the flushed text vs the new full text.
    let p = 0;
    const max = Math.min(current.length, text.length);
    while (p < max && current.charCodeAt(p) === text.charCodeAt(p)) p++;
    // Never split a surrogate pair: if the prefix ends on a high surrogate,
    // back off. A LOOP, not a single step — malformed input can carry a run of
    // consecutive unpaired high surrogates, and backing off exactly one unit
    // still lands the splice on a high surrogate ("\uD83D\uD83Dx" against a
    // "\uD83D…" prefix). The condition stays a bare `p > 0`: adding
    // `p < text.length` corrupts the `p === text.length` pure-shrink case.
    // (current[0..p-1] === text[0..p-1] and p <= min(length), so
    // charCodeAt(p-1) is in-bounds on both strings.)
    while (p > 0) {
      const c = text.charCodeAt(p - 1);
      if (c >= 0xd800 && c <= 0xdbff) p--;
      else break;
    }
    if (current.length > p) target.delete(p, current.length - p);
    if (text.length > p) target.insert(p, text.slice(p));
  });
}

/**
 * End a streamed chat message (#1340): fold the sidecar `Y.Text` back into the
 * plain chat row (`{...existing, text}` — one `update`-action re-`set`, which
 * the ctrl-chat observer drops at both the `mcp` origin gate and the
 * `action !== "add"` gate) and delete the sidecar entry. Idempotent — no-op
 * when no sidecar entry exists. If the chat row was deleted mid-stream (chat
 * cleared), the sidecar entry is deleted WITHOUT re-creating the row: the user
 * erased that message, and finalize must not resurrect it.
 *
 * Deliberately NOT ownership-gated by callers: it appends no new content, only
 * folds already-committed CRDT state, so even a superseded/aborted stream must
 * finalize or its sidecar entry (and its authority over the row) leaks.
 */
export function finalizeClaudeChatMessage(id: string): void {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
  const streamMap = ctrlDoc.getMap(Y_MAP_CHAT_STREAM);
  const entry = streamMap.get(id);
  // Unconditional: the sidecar entry may already be gone (clearCtrlChatDurably
  // deletes live entries directly), but the staleness ledger is module state
  // only this function retires.
  clearStreamStaleness(id);
  if (entry === undefined) return;
  withMcp(ctrlDoc, () => {
    const existing = chatMap.get(id) as ChatMessage | undefined;
    // `length > 0`: an EMPTY sidecar `Y.Text` is malformed state, not a
    // streamed empty reply (the update path returns before minting one). Folding
    // it would blank a chat row that holds real text; falling through to the
    // unconditional delete drops the sidecar and keeps the row.
    if (existing && entry instanceof Y.Text && entry.length > 0) {
      chatMap.set(id, { ...existing, text: entry.toString() });
    }
    streamMap.delete(id);
  });
}

/**
 * Leads `tandem_checkInbox`'s summary when the poll read no document: a named
 * one that is not open, or nothing open at all. Deliberately carries no "call
 * tandem_open" advice: opening a document is something Claude does only when
 * the user asks. (A default poll with tabs open but none ACTIVE is not here
 * any more — #2187 made it read every open document.)
 */
function noDocumentInboxNote(requestedId: string | undefined): string {
  return requestedId !== undefined
    ? `Document ${requestedId} is not open (tandem_listDocuments lists the open ones), so only chat is shown.`
    : "No document is open.";
}

type DocumentStore = NonNullable<ReturnType<typeof getDocumentStore>>;

/** The `activity` object `tandem_checkInbox` returns. */
interface InboxActivity {
  /** The document `activity` describes: the named one, or the active one on a default poll. */
  documentId: string | null;
  isTyping: boolean;
  cursor: number | null;
  lastEdit: number | null;
  selectedText: string | null;
  selectionAt: number | null;
}

interface DocumentInbox {
  userActions: InboxUserAction[];
  userResponses: InboxUserResponse[];
  userReplies: InboxUserReply[];
  activity: InboxActivity;
}

/** `activity` when no document supplied one. */
function emptyActivity(): InboxActivity {
  return {
    documentId: null,
    isTyping: false,
    cursor: null,
    lastEdit: null,
    selectedText: null,
    selectionAt: null,
  };
}

/**
 * The ledger surface the annotation collector reads and writes, and nothing
 * else (PR #2225 review). The collectors take THIS rather than `Map`, because
 * the staged overlay below buffers exactly `get`/`set`/`has`: a `Map` parameter
 * would let a collector reach `size`, iteration or `delete`, which on an overlay
 * answer for one pass's writes while looking like the whole ledger. A real
 * `Map<string, number>` satisfies it, so tests still pass one.
 */
export interface InboxLedger {
  get(key: string): number | undefined;
  set(key: string, value: number): unknown;
  has(key: string): boolean;
}

/** {@link InboxLedger} for the reply ledger. A real `Set<string>` satisfies it. */
export interface ReplyLedger {
  has(key: string): boolean;
  add(key: string): unknown;
}

/**
 * A per-document view of an inbox ledger that BUFFERS its writes (#2187).
 * Reads see the module ledger plus this pass's own writes; nothing reaches the
 * module ledger until `commit()`, which runs only once the whole poll's
 * response has validated (PR #2225 review). A default poll isolates a document
 * that throws, and a write that landed before the throw would mark items
 * delivered that the poll then discarded — lost for the server run. Buffering
 * makes that impossible whichever read throws, rather than relying on every
 * throwing read staying above the first stamp.
 *
 * A plain class over a private buffer, not a `Map` subclass: a subclass
 * inherited `size`, `forEach`, `entries` and `delete`, every one of which
 * silently answered for the buffer alone.
 */
class StagedInboxLedger implements InboxLedger {
  readonly #ledger: Map<string, number>;
  readonly #staged = new Map<string, number>();
  constructor(ledger: Map<string, number>) {
    this.#ledger = ledger;
  }
  get(key: string): number | undefined {
    return this.#staged.has(key) ? this.#staged.get(key) : this.#ledger.get(key);
  }
  set(key: string, value: number): void {
    this.#staged.set(key, value);
  }
  has(key: string): boolean {
    return this.#staged.has(key) || this.#ledger.has(key);
  }
  commit(): void {
    for (const [key, value] of this.#staged) this.#ledger.set(key, value);
  }
}

/** {@link StagedInboxLedger} for the reply ledger. */
class StagedReplyLedger implements ReplyLedger {
  readonly #ledger: Set<string>;
  readonly #staged = new Set<string>();
  constructor(ledger: Set<string>) {
    this.#ledger = ledger;
  }
  has(key: string): boolean {
    return this.#staged.has(key) || this.#ledger.has(key);
  }
  add(key: string): void {
    this.#staged.add(key);
  }
  commit(): void {
    for (const key of this.#staged) this.#ledger.add(key);
  }
}

/** The SDK's own schema for each document bucket — what `admit` checks an item against. */
const INBOX_BUCKET_SCHEMAS = {
  userActions: userActionSchema,
  userResponses: userResponseSchema,
  userReplies: inboxUserReplySchema,
} satisfies Record<InboxBucket, z.ZodTypeAny>;

/** The whole response, checked before anything is committed. Built once. */
const checkInboxOutputSchema = z.object(checkInboxOutputShape);

/**
 * What an id or a zod path segment must look like to be printed. Anything else
 * prints as a placeholder: a record id is client-written, and a log line is no
 * place for whatever a client chose to put in one.
 */
const PRINTABLE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

function printableId(id: unknown): string {
  return typeof id === "string" && PRINTABLE_ID.test(id) ? JSON.stringify(id) : "(unprintable)";
}

/**
 * Zod issues as `path code` pairs ONLY (PR #2225 review). Never `issue.message`,
 * `.format()` or the value: a message can quote the received value, and the
 * record can be a user's text.
 */
function describeIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path
        .map((seg) =>
          typeof seg === "number" || (typeof seg === "string" && PRINTABLE_ID.test(seg))
            ? String(seg)
            : "?",
        )
        .join(".");
      return `${path || "(root)"} ${issue.code}`;
    })
    .join(", ");
}

/**
 * Drop log lines already written, keyed `(scope, id, editedAt)`, so a record
 * that stays malformed is logged once per process rather than on every poll —
 * an edit re-logs it. Bounded: past the cap it starts over, which costs a
 * repeated line, never a missing one for a new record.
 */
const loggedInboxDrops = new Set<string>();
const LOGGED_INBOX_DROPS_CAP = 1_000;

function logInboxDrop(
  scope: string,
  what: string,
  item: { id?: unknown; editedAt?: unknown },
  issues: readonly z.ZodIssue[],
): void {
  const key = `${scope}\u0000${String(item.id)}\u0000${String(item.editedAt)}`;
  if (loggedInboxDrops.has(key)) return;
  if (loggedInboxDrops.size >= LOGGED_INBOX_DROPS_CAP) loggedInboxDrops.clear();
  loggedInboxDrops.add(key);
  console.error(
    `[Tandem] tandem_checkInbox left out a malformed ${what} ${printableId(item.id)} (${scope}): ${describeIssues(issues)}`,
  );
}

/**
 * The quiet-document skip (PR #2225 review). A default poll reads every open
 * document; most are quiet, and each pass costs a full annotation collection
 * plus a refresh of every still-unsurfaced record. This lets a BACKGROUND
 * document whose last pass was a quiet fixed point be skipped.
 *
 * Soundness — why a skipped document's re-run would be byte-identical: its last
 * recorded pass returned no item, refused none and did not throw, and it was a
 * FIXED POINT — no transaction changed the document while it ran, so the refresh
 * it performed had nothing left to write. Since then:
 *  - no transaction has changed this Y.Doc INSTANCE (`epoch`). A change counter,
 *    not the state vector: a delete advances no clock, so a state-vector
 *    comparison misses a deleted reply or a deletion that changes what a record
 *    resolves to. A swapped or reopened document is a new instance, so a miss;
 *  - the mode is the same, so the Solo hold decides every record as before;
 *  - the ledger was not reset (`ledgerGeneration`). Between resets it only ever
 *    GAINS entries — named polls of this document included — and an entry can
 *    only remove an item from a pass, never add one.
 * Everything else the pass reads is in that Y.Doc (annotations, replies), and
 * `admit` is a pure schema check. So the pass would produce nothing again, and
 * write nothing. Never cached: the active document (it supplies `activity`) and
 * any named poll.
 *
 * A record that is refused every poll keeps its document out of the cache, so
 * it stays a refresh candidate on every poll — a cost, never a loss.
 */
interface QuietRecord {
  epoch: number;
  mode: ModeState;
  ledgerGeneration: number;
}

interface QuietDocState {
  /** Transactions that changed this Y.Doc instance since the listener attached. */
  epoch: number;
  /** The last quiet fixed point a default poll committed, if any. */
  quiet: QuietRecord | null;
}

const quietDocs = new WeakMap<Y.Doc, QuietDocState>();

/**
 * The document's change counter, attaching it on first sight. `afterTransaction`
 * rather than `update`: `changed` / `deleteSet` say whether a transaction changed
 * anything at all, local writes included, and an empty transaction leaves the
 * counter alone — so a refresh with nothing to write does not defeat the
 * fixed-point test.
 */
function quietDocState(ydoc: Y.Doc): QuietDocState {
  const known = quietDocs.get(ydoc);
  if (known) return known;
  const state: QuietDocState = { epoch: 0, quiet: null };
  ydoc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.changed.size > 0 || tr.deleteSet.clients.size > 0) state.epoch += 1;
  });
  quietDocs.set(ydoc, state);
  return state;
}

function isQuietSkip(state: QuietDocState, modeState: ModeState): boolean {
  const quiet = state.quiet;
  return (
    quiet !== null &&
    quiet.epoch === state.epoch &&
    quiet.mode === modeState &&
    quiet.ledgerGeneration === ledgerGeneration
  );
}

/**
 * The document-scoped half of a `tandem_checkInbox` pass: the three annotation
 * buckets and, when `withActivity`, `activity` — all read from `store`. Chat is
 * NOT here — it lives in CTRL_ROOM and is read by the handler whether or not a
 * document is open.
 *
 * `withActivity` is false for the background documents of a default poll
 * (#2187): only the active document's activity is returned. `admit` is the last
 * gate on every item (see `InboxPollContext.admit`).
 *
 * Ledger writes are staged; the caller applies them with `commitLedgers` once
 * the whole response has validated, so a throw anywhere stamps nothing.
 */
function collectDocumentInbox(
  store: DocumentStore,
  modeState: ModeState,
  withActivity: boolean,
  admit: InboxPollContext["admit"],
): DocumentInbox & { commitLedgers: () => void } {
  const surfaced = new StagedInboxLedger(surfacedIds);
  const replySurfaced = new StagedReplyLedger(replySurfacedIds);
  const commitLedgers = (): void => {
    surfaced.commit();
    replySurfaced.commit();
  };

  const allAnnotations = store.listAnnotations();
  // Nothing to surface and no activity wanted: skip the full-text walk. A
  // default poll reaches every open document, most of them quiet.
  if (!withActivity && allAnnotations.length === 0) {
    return {
      userActions: [],
      userResponses: [],
      userReplies: [],
      activity: emptyActivity(),
      commitLedgers,
    };
  }
  const fullText = store.getText();

  // Refresh only unsurfaced annotations, in the one batch
  // `YDocStore.refreshAnnotations` owns the transaction for (its docblock
  // carries why the callee owns it). The inbox surfacer doesn't currently
  // distinguish refresh outcomes; a future enhancement could route
  // `degraded` / `failed` annotations into a separate notification.
  //
  // **This calls the exported function rather than the private one, and
  // that is the point of Unit 8j-2's A2.** The selection loop used to be
  // duplicated here, inline inside a `store.transactMcp`, while every
  // ledger/Solo/dedup spec drove the exported copy. One loop now.
  //
  // ONE context object for both collectors (#1702). `modeState` is the
  // mode resolved for THIS poll, so the Solo hold reflects the user's
  // current setting and not a fallback; handing the same object to both
  // buckets is what keeps them from drifting apart. See `InboxPollContext`.
  const pollCtx: InboxPollContext = {
    modeState,
    documentId: store.documentId,
    // Scoped to THIS document (PR #2225 review): since #2187 the same imported
    // comment open in two files arrives twice, and a bare-id lookup stamped
    // `alreadyPushed` on the copy nothing had pushed.
    wasChannelEmitted: (payloadId) => wasEmittedViaChannelInDocument(payloadId, store.documentId),
    admit,
  };
  const { userActions, userResponses } = processInboxAnnotations(
    allAnnotations,
    fullText,
    surfaced,
    (anns) => store.refreshAnnotations(anns),
    pollCtx,
  );

  // WS-A2 userReplies bucket — new user replies on comment threads, held in
  // Solo and released on the flip. Uses the full annotation set (not just
  // `unsurfaced`) since a reply can arrive on a long-surfaced comment.
  const userReplies = collectInboxUserReplies(
    allAnnotations,
    fullText,
    (id) => store.listReplies(id),
    replySurfaced,
    pollCtx,
  );

  return {
    userActions,
    userResponses,
    userReplies,
    activity: withActivity ? readActivity(store, fullText) : emptyActivity(),
    commitLedgers,
  };
}

/** A finite number, or null. `Number.isFinite`, not `typeof`: NaN is a number. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The span `[from, to)` of `text` a selection record names, or null unless it
 * is a non-empty span lying wholly inside `text`. Narrowed BEFORE hashing so
 * the span #1997's check hashes is exactly the span reported: `slice` wraps a
 * negative start and truncates a fraction where `safeSlice` clamps, so a
 * forged record could otherwise pass the check on one span and report
 * another. The editor never writes such values.
 */
function recordedSpan(
  text: string,
  from: unknown,
  to: unknown,
): { from: number; to: number; text: string } | null {
  if (typeof from !== "number" || typeof to !== "number") return null;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 0 || from >= to || to > text.length) return null;
  return { from, to, text: text.slice(from, to) };
}

/** The `activity` object for `store`, whose flat text is `fullText`. */
function readActivity(store: DocumentStore, fullText: string): InboxActivity {
  // Current user activity. `getUserAwareness()` is typed rather than a
  // `getMap` returning the raw Y.Map — a map accessor would be the `ydoc`
  // hatch under a new name.
  //
  // Its types are a CAST, not a check: both records are client-written. So
  // every field below is narrowed to what the output schema declares (PR #2225
  // review) — a bad value fails the SDK's validation of the WHOLE response,
  // the chat and every document's items with it, not just this field.
  const { selection, activity } = store.getUserAwareness();

  const span = recordedSpan(fullText, selection?.from, selection?.to);
  // #1997: report the selection only while the text at the recorded offsets
  // is still the text the user selected. Nothing re-records the selection of
  // a document no editor is showing (a background tab, no browser open), so
  // an edit there used to slice whatever had moved under the old offsets. The
  // record's own `selectedText` is NOT the snapshot: it is `textBetween`,
  // truncated, and omits heading prefixes (#1631), so it disagrees with the
  // flat slice on ordinary selections. The editor stores a fingerprint of the
  // flat slice instead. Hash the WHOLE span — never `safeSlice`'s truncated
  // copy. A record with no fingerprint (saved before #1997) fails closed.
  const holds =
    span !== null &&
    typeof selection?.textFingerprint === "string" &&
    selection.textFingerprint === selectionFingerprint(span.text);
  const selectedText = holds ? safeSlice(fullText, span.from, span.to) : null;
  // #1624: the selection record's own timestamp. `cursor`/`lastEdit` come
  // from a DIFFERENT record (`Y_MAP_ACTIVITY`), so without this the two
  // halves of `activity` read as one snapshot while having independent
  // ages. Null whenever `selectedText` is null — including when #1997's
  // check withholds it — but NOT only then: a record with no numeric
  // `timestamp` yields a real `selectedText` beside a null `selectionAt`, so
  // a null here must never be read as "no selection".
  const selectionAt = holds ? finiteOrNull(selection?.timestamp) : null;

  return {
    documentId: store.documentId,
    isTyping: activity?.isTyping === true,
    cursor: finiteOrNull(activity?.cursor),
    lastEdit: finiteOrNull(activity?.lastEdit),
    selectedText,
    selectionAt,
  };
}

/** Everything document-scoped one `tandem_checkInbox` call returns. */
interface InboxDocumentsPass extends DocumentInbox {
  /** The document `activity` describes (named, or active); null if none. */
  activityDocumentId: string | null;
  /** Whether any open document was read; false means only chat is shown. */
  readAnyDocument: boolean;
  /** Ids of documents a default poll skipped because their pass threw. */
  unreadable: string[];
  /** Per document, how many items `admit` refused (PR #2225 review). */
  dropped: Map<string, number>;
  /**
   * Apply every read document's staged ledger writes and quiet-skip records.
   * Call only once the whole response has validated.
   */
  commit: () => void;
}

/**
 * Read the documents one `tandem_checkInbox` call covers: the named one, or —
 * with no id (#2187) — every open document, the active one first.
 *
 * A default poll used to read only the active document, so a comment on a
 * background tab came back as "No new actions." — indistinguishable from a
 * quiet poll — and the supervisor's wake for it landed on an empty inbox.
 *
 * On a default poll a document whose pass throws is skipped — resolving its
 * store included (PR #2225 review) — so one document that cannot be read no
 * longer takes every other document's items AND the chat down with it. Its
 * staged ledger writes are dropped with it. The id is reported and the error
 * goes to stderr alone: it can carry record text, notes included (ADR-027). A
 * named poll rethrows to the error boundary, as before.
 *
 * Nothing here is durable until the caller runs `commit()`.
 */
function collectInboxDocuments(
  requestedId: string | undefined,
  modeState: ModeState,
): InboxDocumentsPass {
  // `getCurrentDoc` resolves only an OPEN document, so this is open or null.
  const activityDocumentId = requestedId ?? getCurrentDoc()?.id ?? null;
  const order =
    requestedId !== undefined
      ? [requestedId]
      : [
          ...(activityDocumentId !== null ? [activityDocumentId] : []),
          ...[...getOpenDocs().keys()].filter((id) => id !== activityDocumentId),
        ];

  const commits: Array<() => void> = [];
  const pass: InboxDocumentsPass = {
    userActions: [],
    userResponses: [],
    userReplies: [],
    activity: emptyActivity(),
    activityDocumentId,
    readAnyDocument: false,
    unreadable: [],
    dropped: new Map(),
    commit: () => {
      for (const commit of commits) commit();
    },
  };
  for (const id of order) {
    const isActivityDocument = id === activityDocumentId;
    // Refusals are merged into the pass only if this document's pass returns:
    // one that throws is reported as unreadable, whole.
    let refused = 0;
    const admit: InboxPollContext["admit"] = (bucket, item) => {
      const checked = INBOX_BUCKET_SCHEMAS[bucket].safeParse(item);
      if (checked.success) return true;
      logInboxDrop(`document ${id}`, `${bucket} item`, item, checked.error.issues);
      refused += 1;
      return false;
    };
    let inbox: ReturnType<typeof collectDocumentInbox>;
    let commitQuiet: (() => void) | undefined;
    try {
      const store = getDocumentStore(id);
      if (!store) continue;
      pass.readAnyDocument = true;
      if (requestedId === undefined && !isActivityDocument) {
        // The quiet skip — see `quietDocs`. Resolved AFTER the store, so it
        // never creates a document, and this one reference serves both epoch
        // reads and the cache key.
        const ydoc = getOrCreateDocument(id);
        const state = quietDocState(ydoc);
        if (isQuietSkip(state, modeState)) continue;
        const epochBefore = state.epoch;
        const outsideTransaction = ydoc._transaction === null;
        inbox = collectDocumentInbox(store, modeState, false, admit);
        const produced =
          inbox.userActions.length + inbox.userResponses.length + inbox.userReplies.length;
        // A fixed point: nothing changed the document while the pass ran. Never
        // recorded from inside an open transaction, where the counter cannot
        // move until it closes and so proves nothing. (Recording the BEFORE
        // epoch would refuse a pass that wrote on its own; the test is stated
        // rather than left to that coincidence.)
        const fixedPoint =
          outsideTransaction && ydoc._transaction === null && state.epoch === epochBefore;
        const record: QuietRecord | null =
          fixedPoint && produced === 0 && refused === 0
            ? { epoch: epochBefore, mode: modeState, ledgerGeneration }
            : null;
        commitQuiet = () => {
          state.quiet = record;
        };
      } else {
        inbox = collectDocumentInbox(store, modeState, isActivityDocument, admit);
      }
    } catch (err) {
      if (requestedId !== undefined) throw err;
      console.error(`[Tandem] tandem_checkInbox could not read document ${id}:`, err);
      pass.unreadable.push(id);
      // Still the document `activity` describes — empty because it could not
      // be read, not because none is active.
      if (isActivityDocument) pass.activity = { ...emptyActivity(), documentId: id };
      continue;
    }
    const { commitLedgers } = inbox;
    commits.push(() => {
      commitLedgers();
      commitQuiet?.();
    });
    pass.userActions.push(...inbox.userActions);
    pass.userResponses.push(...inbox.userResponses);
    pass.userReplies.push(...inbox.userReplies);
    if (refused > 0) {
      pass.dropped.set(id, refused);
    }
    if (isActivityDocument) pass.activity = inbox.activity;
  }
  return pass;
}

/** A user chat message as `tandem_checkInbox` returns it. */
type InboxChatMessage = Omit<ChatMessage, "read" | "author">;

/** The unread user chat one poll returns, and how to mark it read once committed. */
interface UnreadChat {
  messages: InboxChatMessage[];
  /** Messages refused as malformed: not returned, not marked read. */
  dropped: number;
  /** Stamp the returned messages read. Call only once the response validated. */
  markRead: () => void;
}

/**
 * Collect the unread user chat from CTRL_ROOM WITHOUT stamping it (PR #2225
 * review): the stamp waits until the whole response validates.
 *
 * Each message is admitted against the SDK's own chat schema, as the document
 * items are. The chat map is client-writable, and one malformed entry used to
 * fail the WHOLE response — every document's items with it — after this loop
 * had already marked the healthy messages read. A refused message is neither
 * returned nor stamped, so it stays unread; it does not set `hasNew`, and the
 * summary counts it.
 */
function collectUnreadChat(): UnreadChat {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
  const messages: InboxChatMessage[] = [];
  const keys: string[] = [];
  let dropped = 0;

  chatMap.forEach((value, key) => {
    if (typeof value !== "object" || value === null) return;
    const msg = value as Partial<ChatMessage>;
    if (msg.author !== "user" || msg.read) return;
    const item = {
      id: msg.id,
      text: msg.text,
      timestamp: msg.timestamp,
      ...(msg.documentId ? { documentId: msg.documentId } : {}),
      ...(msg.anchor ? { anchor: msg.anchor } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    };
    const checked = inboxChatMessageSchema.safeParse(item);
    if (!checked.success) {
      logInboxDrop("chat", "chat message", item, checked.error.issues);
      dropped += 1;
      return;
    }
    messages.push(item as InboxChatMessage);
    keys.push(key);
  });

  return {
    messages,
    dropped,
    markRead: () => {
      if (keys.length === 0) return;
      // ONE transaction for every stamp, each against the LIVE value: re-read
      // rather than spread from the copy collected above, so the stamp writes
      // back exactly what is stored now, and only while it is still an unread
      // user message.
      withMcp(ctrlDoc, () => {
        for (const key of keys) {
          const live = chatMap.get(key);
          if (typeof live !== "object" || live === null) continue;
          const msg = live as ChatMessage;
          if (msg.author === "user" && !msg.read) chatMap.set(key, { ...msg, read: true });
        }
      });
    },
  };
}

/**
 * How the summary names each document: its file's basename, or — when two of
 * the documents in play share one (PR #2225 review) — `<basename>
 * (<documentId>)`, so "notes.md" never stands for two files. The active
 * document joins the collision set though it is never listed: a background
 * `notes.md` must not read as the active one.
 */
function documentLabels(
  ids: Iterable<string>,
  activityDocumentId: string | null,
): Map<string, string> {
  const openDocs = getOpenDocs();
  const basename = (id: string): string => {
    const doc = openDocs.get(id);
    return (doc && crossBasename(doc.filePath)) || id;
  };
  const named = new Set(ids);
  const counts = new Map<string, number>();
  const inPlay = new Set([...named, ...(activityDocumentId !== null ? [activityDocumentId] : [])]);
  for (const id of inPlay) {
    const name = basename(id);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map(
    [...named].map((id): [string, string] => {
      const name = basename(id);
      return [id, (counts.get(name) ?? 0) > 1 ? `${name} (${id})` : name];
    }),
  );
}

export function registerAwarenessTools(server: McpServer): void {
  server.tool(
    "tandem_getActivity",
    "Report whether the user is currently typing (`isTyping`) and where their cursor is, in " +
      "the target document. Call it before annotating or editing near the user's cursor — " +
      "annotating text someone is mid-sentence on is disruptive, and the range is likely to " +
      "move under you. Returns four fields — `active`, `isTyping`, `cursor`, `lastEdit` — and " +
      "no selection: use tandem_checkInbox's `activity.selectedText` for the most recent " +
      "selection (see `activity.selectionAt`). " +
      "`cursor` is a flat text offset in UTF-16 code units — the same coordinate system as " +
      "annotation ranges. It is a proximity hint, not an edit anchor: only a document change " +
      "triggers a write, the last of those publishes wherever the caret is by then, and it " +
      "carries no snapshot — so take ranges from tandem_resolveRange or tandem_search. " +
      "An edit you make yourself shifts the user's caret too, and the editor showing that " +
      "document refreshes `cursor` in place a moment later; `isTyping` and `lastEdit` stay " +
      "as the user left them and never report your own edit as their activity. That refresh " +
      "needs a mounted editor and is debounced, so for a background tab, a document no " +
      "browser is showing, or a read taken right after your own edit, `cursor` is still the " +
      "PRE-edit offset — re-read it after a moment rather than trusting it to have moved. " +
      "Returns presence only; " +
      "it does not return document content or pending user messages (use tandem_checkInbox " +
      "for those).",
    {
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    READ_ONLY_TOOL,
    withErrorBoundary("tandem_getActivity", async ({ documentId }) => {
      const store = getDocumentStore(documentId);
      if (!store) return noDocumentError();

      const { activity } = store.getUserAwareness();

      if (!activity) {
        // `isTyping` is present on BOTH branches. The tool description names it
        // as the headline field, and a caller reading `data.isTyping` on the
        // no-activity branch used to get `undefined` — falsy, so the common
        // `if (!isTyping)` read happened to work, and a `typeof` or a strict
        // `=== false` check silently did not. Never seen: awareness is absent
        // only before the first client write.
        return mcpSuccess({
          active: false,
          isTyping: false,
          cursor: null,
          lastEdit: null,
          message: "No activity detected",
        });
      }

      // Consider user active if last edit was within 10 seconds
      const isActive = activity.isTyping || Date.now() - activity.lastEdit < 10000;

      return mcpSuccess({
        active: isActive,
        isTyping: activity.isTyping,
        cursor: activity.cursor,
        lastEdit: activity.lastEdit,
      });
    }),
  );

  server.registerTool(
    "tandem_checkInbox",
    {
      description:
        "Return user actions not yet returned by a previous poll — new comments, chat messages, and replies to your annotations — plus the current collaboration `mode` and `activity`. Call it with no `documentId` to cover every open document: each comment, response and reply carries its `documentId` (the same imported comment open in two files arrives twice, told apart by it), so pass that id when acting on an item: the id-keyed tools (tandem_resolveAnnotation, tandem_editAnnotation, tandem_removeAnnotation, tandem_annotationReply) find the item's document themselves, but the range-keyed ones (tandem_comment, tandem_edit) target the active document when called without one, and a range from one document applied to another lands on the wrong text. Passing a `documentId` limits comments, replies and accept/dismiss responses to that document. An item whose stored record is malformed is left out, counted in `summary` and retried on the next poll. `activity` describes only the active document (`activity.documentId`). `chatMessages` holds every unread user chat message across all documents (with its documentId when it was sent from a document), and returning them marks them read. Works with no document open: chat and `mode` are still returned, and the document fields are empty. This is the authoritative delivery path: real-time push cannot be confirmed to have reached a client, so nothing here is suppressed on the strength of a push, and steady polling is the only reliable way to see user activity. Repeat calls de-duplicate against what was already returned, so frequent polling never double-reports. An item carries `alreadyPushed: true` when it was also emitted as a real-time event; that describes the server's side only. Does not return user notes or any other record the user has kept private — user highlights never appear here at all. In solo mode the user's comments and replies are held back until the mode returns to tandem. `activity.selectedText` is the most recent non-empty selection, not necessarily the current one — it is not cleared when focus leaves the editor — and `activity.selectionAt` is when the user last made it. If the text at that selection has changed since it was recorded (e.g. you edited a document no editor is showing), `selectedText` and `selectionAt` are null.",
      inputSchema: {
        documentId: z
          .string()
          .optional()
          .describe(
            "Limit the poll to one document. Omit it to poll every open document — the usual call",
          ),
      },
      outputSchema: checkInboxOutputShape,
    },
    withStructuredErrors(
      withErrorBoundary("tandem_checkInbox", async ({ documentId }) => {
        // Stamped BEFORE the document check, deliberately. The fact being
        // recorded is "a model reached for the inbox" — the only signal in the
        // server written by a model rather than by a transport — and that is
        // equally true when the poll lands on a closed document. Moving it
        // below the guard would make the pull path look dead during exactly the
        // window a user is most likely to be told it is.
        recordInboxPoll();
        // `""` is treated as omitted: `getCurrentDoc("")` would otherwise
        // resolve to no document even with one active.
        const requestedId = documentId || undefined;
        // No document is NOT an error here. Chat lives in CTRL_ROOM, not on a
        // document, and returning NO_DOCUMENT is how a chat sent with every tab
        // closed went unanswered: the supervisor's Claude polled, got the
        // error, and never reached the chat loop. That held for an explicit id
        // naming a closed tab too. So the poll always runs; with nothing read
        // the document buckets are empty and the summary says why.

        // WS-A2: single live read of the three-state mode, used both to gate
        // the Solo privacy hold (`hideFromAI` in the surfacer) and to report
        // the two-state `mode` below. Read once so the gate and the reported
        // value can never disagree within a single poll.
        const modeState = readModeState();

        // PR #2225 review: NOTHING durable happens until the whole response
        // has validated. The documents' ledgers are staged, the chat is
        // collected unstamped, the response is built and checked against the
        // output schema the SDK enforces, and only then are the ledgers
        // committed, the chat marked read and the delivery round resolved. A
        // response the SDK would reject used to be rejected AFTER every item in
        // it was stamped delivered — so the next poll skipped them all.
        //
        // This section MUST stay synchronous — `safeParse`, never
        // `safeParseAsync`, and no `await` anywhere from here to the commit. An
        // await would let another poll, or a user edit, interleave between what
        // was validated and what is committed.

        // Every document-scoped field — the three annotation buckets and
        // `activity` — comes from `collectDocumentInbox`, whose per-record
        // filters (notes, private records, the Solo hold) are the same for
        // every document it reads.
        const docs = collectInboxDocuments(requestedId, modeState);
        const { userActions, userResponses, userReplies, activity, activityDocumentId } = docs;

        // Bucket 3: unread chat messages from CTRL_ROOM, not yet marked read.
        const chat = collectUnreadChat();
        const chatMessages = chat.messages;

        // Reported mode is the two-state view of the same live read used for
        // the hold gate: indeterminate (mode key absent, e.g. restart) collapses
        // to the default, matching the pre-WS-A2 `.catch(TANDEM_MODE_DEFAULT)`.
        const mode = reportedMode(modeState);

        // Build summary
        const parts: string[] = [];
        if (userActions.length > 0) {
          const typeCounts: Record<string, number> = {};
          for (const a of userActions) {
            typeCounts[a.type] = (typeCounts[a.type] || 0) + 1;
          }
          const typeList = Object.entries(typeCounts)
            .map(([t, n]) => `${n} ${t}${n > 1 ? "s" : ""}`)
            .join(", ");
          parts.push(`${userActions.length} new: ${typeList}`);
        }
        if (userResponses.length > 0) {
          const statusCounts: Record<string, number> = {};
          for (const r of userResponses) {
            statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
          }
          const statusList = Object.entries(statusCounts)
            .map(([s, n]) => `${n} ${s}`)
            .join(", ");
          parts.push(statusList);
        }
        if (userReplies.length > 0) {
          parts.push(`${userReplies.length} new repl${userReplies.length > 1 ? "ies" : "y"}`);
        }
        if (chatMessages.length > 0) {
          parts.push(
            `${chatMessages.length} new chat message${chatMessages.length > 1 ? "s" : ""}`,
          );
          parts.push(CHAT_ACK_DIRECTIVE);
        }
        let actions = parts.length > 0 ? parts.join(". ") + "." : "No new actions.";
        // #2187: items from a background document are exactly the ones a
        // follow-up call without `documentId` would aim at the WRONG document —
        // a range-keyed write lands in the active one at another document's
        // offsets. Named by file so no tandem_listDocuments round trip is needed.
        const elsewhere = new Set(
          [...userActions, ...userResponses, ...userReplies]
            .map((item) => item.documentId)
            .filter((id) => id !== activityDocumentId),
        );
        const labels = documentLabels([...elsewhere, ...docs.dropped.keys()], activityDocumentId);
        if (elsewhere.size > 0) {
          const names = [...elsewhere].map((id) => labels.get(id) ?? id);
          actions +=
            ` Some items are from ${activityDocumentId === null ? "open documents (none is active)" : "documents other than the active one"}: ${names.join(", ")}.` +
            " Pass each item's documentId when acting on it.";
        }
        if (docs.unreadable.length > 0) {
          const { unreadable } = docs;
          actions += ` Could not read ${unreadable.length === 1 ? "document" : "documents"} ${unreadable.join(", ")}; ${unreadable.length === 1 ? "its" : "their"} items are missing from this poll (the error is in Tandem's log).`;
        }
        // PR #2225 review: refused records are counted, never described — the
        // record is client-written and its text stays out of the response.
        // They are retried on every poll, and they do not set `hasNew`: there
        // is nothing in this response to act on.
        for (const [id, n] of docs.dropped) {
          actions += ` ${n} ${n === 1 ? "item" : "items"} in ${labels.get(id) ?? id} could not be returned (malformed record; details in Tandem's log).`;
        }
        if (chat.dropped > 0) {
          actions += ` ${chat.dropped} chat ${chat.dropped === 1 ? "message" : "messages"} could not be returned (malformed record; details in Tandem's log).`;
        }
        // Leads, so a model reading only the summary knows why the document
        // buckets are empty. Not counted in `hasNew`: it is a state, not an ask.
        const summary = docs.readAnyDocument
          ? actions
          : `${noDocumentInboxNote(requestedId)} ${actions}`;

        const hasNew =
          userActions.length > 0 ||
          userResponses.length > 0 ||
          userReplies.length > 0 ||
          chatMessages.length > 0;

        const response = {
          summary,
          hasNew,
          mode,
          // #1733: who last wrote the mode key. Diagnostic only — compare its
          // `value` against `mode` above; under a lost concurrent tie they can
          // disagree.
          modeProvenance: readModeProvenance(),
          storeReadOnly: isStoreReadOnly(),
          userActions,
          userResponses,
          userReplies,
          chatMessages,
          activity,
        };

        // The backstop. With every client-written value admitted or narrowed
        // above, a failure here is a server-built field — a code bug — so
        // failing the poll and retrying everything next time is the right
        // trade: nothing is committed, nothing stamped, the round stays open.
        const checked = checkInboxOutputSchema.safeParse(response);
        if (!checked.success) {
          console.error(
            `[Tandem] tandem_checkInbox built a response that fails its output schema; nothing was marked returned: ${describeIssues(checked.error.issues)}`,
          );
          return mcpError(
            "INTERNAL_ERROR",
            "tandem_checkInbox could not build a valid response, so nothing was marked as returned and the next poll returns the same items (details in Tandem's log).",
          );
        }

        docs.commit();
        chat.markRead();
        // The join closes only now, once what was returned is committed — a
        // claim about the USER's message, kept apart from the poll stamp above.
        // It stays OPEN while a document the round is waiting on could not be
        // read at all; that held round is re-timed to its oldest item still
        // undelivered (`resolveDeliveryRound`). A record `admit` refused does
        // NOT hold it: the summary just told Claude about it, and holding would
        // leave a permanently malformed record pinning the round at
        // `awaiting-poll` for the life of the process (PR #2225 review). The round is process-wide, so a poll naming
        // a different document still closes one whose forward was elsewhere —
        // `polled` was never proof that that annotation was delivered.
        resolveDeliveryRound(Date.now(), {
          documents: new Set(docs.unreadable),
          items: new Set(),
        });

        return mcpStructured(response);
      }),
    ),
  );
  server.tool(
    "tandem_reply",
    `Send a chat message to the user in the Tandem sidebar. For a chat message you received (from tandem_checkInbox or a channel event): ${CHAT_ACK_RULE}`,
    {
      text: z.string().describe("Your message to the user"),
      replyTo: z
        .string()
        .optional()
        .describe(
          "The `id` of the user message you are answering (a channel event's message_id). " +
            "If several arrived together, use the latest one's id.",
        ),
      inProgress: z
        .boolean()
        .optional()
        .describe(
          "true when this reply acknowledges work you are about to do; the editor shows the " +
            "user it is in progress until you send the result without it.",
        ),
      documentId: z
        .string()
        .optional()
        .describe("Document context for this reply (defaults to active document)"),
    },
    withErrorBoundary("tandem_reply", async ({ text, replyTo, inProgress, documentId }) => {
      // #651 presence: tandem_reply is a chat send — no annotationId — so the
      // marker is the generic "Claude is working" status-bar indicator.
      return withTypingPresence({ tool: "tandem_reply", documentId }, async () => {
        const current = getCurrentDoc(documentId);
        const docId = documentId ?? current?.id ?? undefined;
        const appended = appendClaudeChatMessage(text, {
          documentId: docId,
          replyTo,
          inProgress,
        });
        // Unreachable while the `/mcp` handshake refuses first; kept as defence.
        if (!appended.ok) {
          return mcpError(appended.refusal.error, appended.refusal.message, {
            kind: appended.refusal.kind,
          });
        }
        notifyTandemReply(getCurrentSessionId());
        const unmatched = replyTo !== undefined && !markUserChatRead(replyTo);
        return mcpSuccess({
          sent: true,
          messageId: appended.id,
          ...(unmatched ? { warning: REPLY_TO_UNMATCHED_WARNING } : {}),
        });
      });
    }),
  );
}

/**
 * Safely slice text and truncate to 100 chars.
 *
 * **Not test-only.** Three production callers, all on the inbox poll path: the
 * `selectedText` in `collectDocumentInbox` above, and both collectors below.
 */
export function safeSlice(text: string, from: number, to: number): string {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  const snippet = text.slice(start, end);
  return snippet.length > 100 ? snippet.slice(0, 97) + "..." : snippet;
}

/** Determine if user is active based on activity data. Exported for testing. */
export function isUserActive(
  activity: { isTyping: boolean; lastEdit: number } | undefined,
): boolean {
  if (!activity) return false;
  return activity.isTyping || Date.now() - activity.lastEdit < 10000;
}

/**
 * Process annotations into inbox buckets.
 * Mutates surfacedIds to track which annotations have been surfaced.
 *
 * **This is the `tandem_checkInbox` handler's own path, not a mirror of it
 * (ADR-035 Unit 8j-2).** Until this unit it was labelled "exported for testing"
 * and had **zero production callers**: the handler called the private
 * {@link processUnsurfacedInboxAnnotations} directly and re-implemented the
 * selection-and-refresh loop below inline, inside its own `store.transactMcp`.
 * 21 call sites across 16 specs drove this copy — a count of CALLS is not a
 * count of specs, and an earlier draft of this line conflated them. A mutation to the handler's *selection* half would
 * still have reddened `annotation-promote-pull-surface.test.ts`, which drives
 * the real tool — but the refresh half was observed by nothing at all.
 *
 * **`refreshAll` is a BATCH, and that is the load-bearing part.** A
 * per-annotation `refreshFn` cannot preserve the single origin-tagged
 * transaction the handler used to open around the whole loop: the natural
 * wiring, `(a) => store.refreshAnnotation(a)`, opens one transaction per record,
 * and the shape one step further — an unwrapped call — is an untagged `map.set`
 * that `audit:origins` cannot see, because it cannot follow a write reached
 * through a helper. Making the callee own the boundary is what removes that as a
 * caller's choice. `YDocStore.refreshAnnotations` is the production
 * implementation; `refreshAnnotation` (singular) no longer exists.
 *
 * **The per-poll values arrive as one {@link InboxPollContext}, every field
 * required (#1702)** — Units 8j-2 and 8j-3 each silently lost one of them while
 * they were positional, defaulted and ordered differently on the two collectors,
 * and the interface plus the tuple pin in `awareness-tools.test.ts` are what
 * now make that drift a type error rather than a reading exercise.
 *
 * **`refreshAll` cannot change the selection, and that is enforced here rather
 * than asked for.** The signature `(anns: Annotation[]) => Annotation[]` says
 * nothing about the relationship between input and output, and the wrong
 * implementations are the plausible ones: `(anns) => store.refreshAnnotations(anns)`
 * is correct, while `(anns) => store.listAnnotationsRefreshed()` — one method
 * along on the same object, same return type, typechecks — hands back the WHOLE
 * collection. The consuming loop does not re-apply the ledger gate (it re-reads
 * `surfaced` only to compute `edited`), so that would re-surface and re-stamp
 * every already-delivered comment on every poll, with no error. Master could not
 * express this: its refresher was per-record and fused into the loop, so set
 * membership was not a callback's to change. The re-key below restores that
 * property.
 */
export function processInboxAnnotations(
  allAnnotations: Annotation[],
  fullText: string,
  surfaced: InboxLedger,
  refreshAll: (anns: Annotation[]) => Annotation[],
  ctx: InboxPollContext,
): {
  userActions: Array<InboxUserAction>;
  userResponses: Array<InboxUserResponse>;
} {
  // Select first, refresh once. The two halves are separable because the
  // selection reads only the pre-refresh records and a stable ledger — a refresh
  // of one annotation cannot change another's selection outcome — so batching
  // costs no fidelity against the per-item loop this replaces.
  const candidates = allAnnotations.filter((raw) => {
    const lastSurfacedEditedAt = surfaced.get(inboxLedgerKey(ctx.documentId, raw));
    // The dedup: already surfaced, nothing new since.
    if (lastSurfacedEditedAt !== undefined && !hasUnaccountedEdit(raw, lastSurfacedEditedAt)) {
      return false;
    }
    // The user arm's status gate, mirrored. Without it a resolved user comment
    // — which fails that gate and therefore takes no `surfaced.set` — re-enters
    // this set on every poll for the life of the process and is re-handed to
    // `refreshAll`, in production a `withMcp` transaction over
    // `refreshAllRanges` that persists range repairs. Mirrored, not moved: the
    // loop keeps its own copy (both are pinned by
    // `tests/server/inbox-ledger-undo.test.ts`) and every other reason a record
    // is skipped stays there. Sound to evaluate pre-refresh because a refresh
    // only improves ranges — it never changes `author`, `type`, `status` or
    // `editedAt`, which is the same property that makes the split legal at all.
    return !isSettledUserComment(raw, lastSurfacedEditedAt);
  });

  // **`candidates` is the answer; `refreshAll` only gets to improve the ranges
  // in it.** Re-keying by id means a refresher that returns extra records cannot
  // add them to the inbox, and one that drops a record degrades to that record's
  // pre-refresh (correct, possibly stale) range rather than losing the surface
  // and the ledger entry for it. Without this the callback decides what Claude
  // sees, which is not what its name or its docblock claims.
  const refreshedById = new Map(refreshAll(candidates).map((a) => [a.id, a]));
  const unsurfaced = candidates.map((c) => refreshedById.get(c.id) ?? c);

  return processUnsurfacedInboxAnnotations(unsurfaced, fullText, surfaced, ctx);
}

/**
 * The private helper's parameter tuple, exported as a TYPE only so
 * `awareness-tools.test.ts` can pin it (#1702). This function is where
 * `modeState` and `wasChannelEmitted` are actually read for userActions and
 * userResponses, and its one caller would compile unchanged against a new
 * defaulted trailing parameter — the 8j-2 shape again, one call deeper than the
 * exported pins reach.
 */
export type ProcessUnsurfacedInboxAnnotationsParameters = Parameters<
  typeof processUnsurfacedInboxAnnotations
>;

function processUnsurfacedInboxAnnotations(
  unsurfaced: Annotation[],
  fullText: string,
  surfaced: InboxLedger,
  ctx: InboxPollContext,
): {
  userActions: Array<InboxUserAction>;
  userResponses: Array<InboxUserResponse>;
} {
  const userActions: Array<InboxUserAction> = [];
  const userResponses: Array<InboxUserResponse> = [];

  for (const ann of unsurfaced) {
    // WS-A2 Solo hold — the gate-before-ledger. A held user record must be
    // skipped BEFORE any `surfaced.set` below; otherwise the dedup ledger is
    // poisoned and the item would be permanently dedup-skipped after release.
    // Held items stay "unsurfaced" and re-appear on the first poll once mode
    // reads tandem (pull-driven release — no explicit replay needed here).
    if (hideFromAI(ann, ctx.modeState)) continue;

    const snippet = safeSlice(fullText, ann.range.from, ann.range.to);
    // The ledger read is hoisted above the bucket branch so the user arm's
    // status gate can consult `edited` as a term of its own condition.
    const key = inboxLedgerKey(ctx.documentId, ann);
    const lastSurfacedEditedAt = surfaced.get(key);
    // Two names, and collapsing them into one is a bug in whichever direction
    // you collapse. `edited` is the WIRE claim — "you were shown this and the
    // user has changed it since" — so it needs a prior surfacing and is false on
    // a record with no ledger entry. `unaccountedEdit` is the GATE term and
    // treats a missing entry as `0`; see `hasUnaccountedEdit`.
    const edited = lastSurfacedEditedAt !== undefined && (ann.editedAt ?? 0) > lastSurfacedEditedAt;
    const unaccountedEdit = hasUnaccountedEdit(ann, lastSurfacedEditedAt);

    // #1619: `isClaudeFacing` is the audience half — a stored
    // `{comment, audience: "private"}` record is withheld from the channel and
    // must be withheld here too, and a user HIGHLIGHT (always private per
    // ADR-027) never enters either bucket. Before any `surfaced.set`, for the
    // same reason the Solo hold is.
    //
    // #1826: the status gate. Without it a resolved user comment re-entered
    // this bucket on every server restart — `surfacedIds` is module-level, so a
    // restart empties the ledger and every dismissed or accepted user comment
    // surfaced again as a fresh user action. The term enumerates the two end
    // states via `isSettledStatus` rather than testing `"pending"` directly:
    // `!== "dismissed"` would miss `accepted`, which `transitionPending`
    // reaches for a user comment (it refuses an accept only for a claude author
    // or a suggestion-bearing record), and a positive `=== "pending"` fails an
    // unrecognized stored status closed. See that predicate.
    //
    // This narrows the bucket against master, intentionally: a user comment
    // resolved BEFORE Claude's first poll used to be returned once, because the
    // old gate carried no status term at all. It is now filtered out, so the
    // observer's `annotation:created` push has no pull-path counterpart for
    // that record. Accepted — the push already fired with the content, and the
    // alternative is the restart storm above, where every previously resolved
    // comment re-enters the bucket as if it were new.
    //
    // `|| unaccountedEdit` is what stops this gate creating item 1's own defect
    // class in the edit path: the observer emits `annotation:edited` on any
    // `editedAt` advance with no status test, and Dismiss stays open to a
    // user's comment, so the status term ALONE would push an
    // edit-after-dismiss on the channel while `tandem_checkInbox` returned
    // nothing. The term is deliberately NOT the `edited` flag above it — that
    // one needs a prior ledger entry, which a comment resolved before it was
    // ever surfaced can never acquire here, making the suppression permanent
    // rather than restart-bounded (review round 1). Its residual and the reason
    // this is a duplicate rather than a loss are in `hasUnaccountedEdit`.
    if (
      ann.author === "user" &&
      ann.type === "comment" &&
      isClaudeFacing(ann) &&
      (!isSettledStatus(ann.status) || unaccountedEdit)
    ) {
      const channelKey = edited ? getAnnotationEditedChannelKey(ann.id, ann.editedAt ?? 0) : ann.id;

      // Disclose, never suppress. `wasChannelEmitted` means "handed to >=1 SSE
      // consumer and still buffered", NOT "delivered to a model" — an attached
      // consumer may be inert, and the server cannot observe what a host did
      // with a notification. Suppressing on it silently dropped the comment for
      // the whole server run; the ledger below stays the sole dedup, exactly as
      // the chat bucket already works. The flag is advisory in BOTH directions:
      // it can be true for an item no model saw, and absent for one that was
      // pushed (ids are untracked on buffer eviction). Never gate on it.
      // Cost: one duplicate per comment in channel-connected sessions.
      const item: InboxUserAction = {
        ...ann,
        textSnippet: snippet,
        documentId: ctx.documentId,
        ...(edited ? { edited: true } : {}),
        ...(ctx.wasChannelEmitted(channelKey) ? { alreadyPushed: true } : {}),
      };
      // Last, after every privacy and status gate, directly before the push
      // and the stamp (PR #2225 review). A refused item is neither: it stays
      // unsurfaced and is retried next poll, never marked delivered.
      if (!ctx.admit("userActions", item)) continue;
      userActions.push(item);
      surfaced.set(key, ann.editedAt ?? 0);
    } else if (
      ann.author === "claude" &&
      isClaudeFacing(ann) &&
      ann.status !== "pending" &&
      // #1770: Claude's own resolves are not the user's decisions. This bucket is
      // documented as "the USER's accept/dismiss decisions", and before the stamp
      // a Claude dismiss was indistinguishable from one.
      ann.resolvedBy !== "claude"
    ) {
      const item: InboxUserResponse = { ...ann, textSnippet: snippet, documentId: ctx.documentId };
      if (!ctx.admit("userResponses", item)) continue; // see the userActions arm
      userResponses.push(item);
      surfaced.set(key, ann.editedAt ?? 0);
    }
  }

  return { userActions, userResponses };
}

/**
 * The per-poll values BOTH inbox collectors need, passed as one object (#1702).
 *
 * Every field is required: an optional field would be the Unit 8j-2 default
 * under a new name. A new value both buckets need goes HERE, never as a
 * positional parameter on one collector. `tests/server/awareness-tools.test.ts`
 * holds three `expectTypeOf` pins that turn `typecheck:tests` red: the exact
 * shape of this interface (so a new OPTIONAL field fails, as does any field
 * added without updating the pin), and the parameter tuples of both exported
 * collectors plus the private `processUnsurfacedInboxAnnotations` (so a
 * defaulted positional parameter on any of them fails). Values that belong to
 * one collector (`surfaced`, `refreshAll`, `loadReplies`, `replySurfaced`) stay
 * positional.
 */
export interface InboxPollContext {
  /**
   * The mode resolved for THIS poll — the Solo privacy gate (`hideFromAI`).
   * `"indeterminate"` is NOT fail-closed: it holds only records already stamped
   * `heldInSolo`, so a fallback here surfaces unmarked user records in Solo.
   */
  modeState: ModeState;
  /**
   * Scopes both ledger keys. A bare-id key silently drops the same imported Word
   * comment or reply in a second document. See `surfacedIds`.
   */
  documentId: string;
  /**
   * Stamps `alreadyPushed` — advisory, never a gate. Production passes
   * `wasEmittedViaChannelInDocument` bound to THIS document (PR #2225 review):
   * the bare `wasEmittedViaChannel` answers for a push in ANY document, and
   * since #2187 the same imported comment arrives once per document. A
   * `() => false` stand-in silently stops the stamp for every
   * channel-connected session.
   */
  wasChannelEmitted: (payloadId: string) => boolean;
  /**
   * The last gate on every item, run after the privacy and status gates and
   * directly before the push and the ledger stamp (PR #2225 review). `false`
   * means the item is neither returned nor stamped, so it is retried on the
   * next poll and never marked delivered. Production checks the item against
   * the bucket's own output schema — the one the SDK validates the whole
   * response with, which is why a single malformed client-written record used
   * to fail every item in the poll after they had all been stamped. Because it
   * runs after the gates, a held or private record is never counted. Tests
   * pass `() => true`.
   */
  admit: (bucket: InboxBucket, item: InboxItem) => boolean;
}

/** The three document-scoped `tandem_checkInbox` buckets an item is admitted to. */
export type InboxBucket = "userActions" | "userResponses" | "userReplies";

/** An item of one of those buckets. */
export type InboxItem = InboxUserAction | InboxUserResponse | InboxUserReply;

/**
 * A user comment in the checkInbox `userActions` bucket.
 *
 * Both optional flags are `true`-only, matching `z.literal(true).optional()` in
 * `output-schemas.ts`. That is load-bearing, not cosmetic: the MCP SDK hard-
 * validates structured output against the declared schema and throws
 * `McpError(InvalidParams)` on a mismatch, which fails the WHOLE checkInbox
 * response rather than dropping the field. Widening either to `boolean` would let
 * `edited: false` typecheck and then blow up at runtime.
 *
 * A note here used to add that tests could not catch it either, "since tsconfig
 * includes only `src/`". That was true when it was written and is not now:
 * #1616 put the test tree under `tsconfig.tests.{node,client,e2e}.json` and
 * gated it in CI as `typecheck:tests`, so a `{ edited: false }` literal in a
 * spec now fails the build before it can run. The narrowing still earns its
 * place; it is the backstop behind it that changed.
 */
export type InboxUserAction = Annotation & {
  textSnippet: string;
  /** The document this item belongs to (#2187: a default poll spans every open one). */
  documentId: string;
  /** Set when re-surfaced after a user edit. Never `false` — omitted instead. */
  edited?: true;
  /** Also emitted as a channel event. A hint, not proof of delivery. */
  alreadyPushed?: true;
};

export interface InboxUserReply {
  id: string;
  annotationId: string;
  author: "user";
  text: string;
  timestamp: number;
  textSnippet: string;
  /** The document this item belongs to (#2187). */
  documentId: string;
  /** Also emitted as a channel event. A hint, not proof of delivery. */
  alreadyPushed?: true;
}

/** A user accept/dismiss in the checkInbox `userResponses` bucket. */
export type InboxUserResponse = Annotation & { textSnippet: string; documentId: string };

/**
 * WS-A2: collect NEW user replies for the checkInbox userReplies bucket — the
 * pull-release path for a reply that was held from the push channel in Solo.
 * The `tandem_checkInbox` handler calls this directly to build that bucket; it
 * is exported because it is the handler's, not because a test needed it.
 *
 * Routes through `channelVisibleReplies` so the ADR-027 private/note-thread gate
 * is enforced exactly as the getAnnotations read and the SSE observer do — this
 * bucket can't drift from them. Mirrors the annotation surfacer's discipline:
 * `hideFromAI` holds in Solo BEFORE the ledger write (poison-free release), and
 * `wasChannelEmitted` stamps `alreadyPushed` as a hint without ever suppressing.
 */
export function collectInboxUserReplies(
  allAnnotations: Annotation[],
  fullText: string,
  loadReplies: (annotationId: string) => AnnotationReply[],
  replySurfaced: ReplyLedger,
  ctx: InboxPollContext,
): InboxUserReply[] {
  const out: InboxUserReply[] = [];
  for (const ann of allAnnotations) {
    const visible = channelVisibleReplies(ann, loadReplies);
    if (visible.length === 0) continue;
    const snippet = safeSlice(fullText, ann.range.from, ann.range.to);
    for (const reply of visible) {
      if (reply.author !== "user") continue; // Claude's own replies aren't inbox items
      if (hideFromAI(reply, ctx.modeState)) continue; // Solo hold — no ledger write
      if (replySurfaced.has(ledgerKey(ctx.documentId, reply.id))) continue; // already surfaced
      // Disclose, never suppress — see the annotation surfacer for the full
      // rationale. This branch was strictly worse than the comment one:
      // `replySurfaced` is a plain Set with no edit dimension, so a poisoned
      // entry had no `editedAt` escape hatch and the reply was lost for the
      // whole server run with certainty.
      const item: InboxUserReply = {
        id: reply.id,
        annotationId: ann.id,
        author: "user",
        text: reply.text,
        timestamp: reply.timestamp,
        textSnippet: snippet,
        documentId: ctx.documentId,
        ...(ctx.wasChannelEmitted(reply.id) ? { alreadyPushed: true } : {}),
      };
      // Last, directly before the push and the stamp — see the annotation
      // surfacer (PR #2225 review).
      if (!ctx.admit("userReplies", item)) continue;
      out.push(item);
      replySurfaced.add(ledgerKey(ctx.documentId, reply.id));
    }
  }
  return out;
}
