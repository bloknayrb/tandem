import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";
import { z } from "zod";
import { CTRL_ROOM, Y_MAP_CHAT, Y_MAP_CHAT_STREAM } from "../../shared/constants.js";
import { withInternal, withMcp } from "../../shared/origins.js";
import type {
  AgentIdentity,
  Annotation,
  AnnotationReply,
  ChatMessage,
} from "../../shared/types.js";
import { generateMessageId } from "../../shared/utils.js";
import { isStoreReadOnly } from "../annotations/store.js";
import { clearStreamStaleness, noteStreamSidecar } from "../chat-stream-staleness.js";
import { recordInboxPoll, resolveDeliveryRound } from "../events/delivery-state.js";
import { getAnnotationEditedChannelKey, wasEmittedViaChannel } from "../events/queue.js";
import { hideFromAI, type ModeState, readModeState, reportedMode } from "../mode.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { channelVisibleReplies } from "./annotations.js";
import { getCurrentDoc } from "./document.js";
import { getDocumentStore } from "./document-store.js";
import { checkInboxOutputShape } from "./output-schemas.js";
import {
  mcpStructured,
  mcpSuccess,
  noDocumentError,
  withErrorBoundary,
  withStructuredErrors,
} from "./response.js";
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

/** Ledger key. See `surfacedIds` for why the document scope is required. */
function ledgerKey(documentId: string, itemId: string): string {
  return `${documentId}:${itemId}`;
}

/** Reset surfaced IDs (exported for testing) */
export function resetInbox(): void {
  surfacedIds.clear();
  replySurfacedIds.clear();
}

/**
 * Append a Claude-authored chat message to CTRL_ROOM's chat map — the single
 * write path for `tandem_reply` AND the local-model collaborator's streamed
 * reply (#1123 M1.2). Tagged `withMcp` + `author:"claude"`, so the ctrl-chat
 * observer skips it on BOTH the origin gate (`mcp` ∈ CHANNEL_SKIP) and the
 * `author !== "user"` gate — a Claude/local write can never self-wake the
 * channel. Returns the new message id. Conditional spreads keep the on-wire
 * `ChatMessage` shape identical to the historical `tandem_reply` write.
 */
export function appendClaudeChatMessage(
  text: string,
  opts: { documentId?: string; replyTo?: string; agentIdentity?: AgentIdentity } = {},
): string {
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
    read: true,
  };
  withMcp(ctrlDoc, () => chatMap.set(id, msg));
  return id;
}

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

export function registerAwarenessTools(server: McpServer): void {
  server.tool(
    "tandem_getActivity",
    "Check if the user is actively editing and where their cursor is",
    {
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_getActivity", async ({ documentId }) => {
      const store = getDocumentStore(documentId);
      if (!store) return noDocumentError();

      const { activity } = store.getUserAwareness();

      if (!activity) {
        return mcpSuccess({
          active: false,
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
        "Check for user actions you haven't seen yet — new comments, chat messages, and responses to your annotations. You cannot tell whether real-time push is reaching you, so poll at a steady cadence: every 2-3 tool calls, after completing any task, between steps, and whenever you pause. Items already returned by a previous poll are de-duplicated, so frequent calls are cheap. An item flagged `alreadyPushed` was also emitted as a real-time event — if you recognize it and already responded, don't respond twice. Low token cost — when in doubt, call it.",
      inputSchema: {
        documentId: z
          .string()
          .optional()
          .describe("Target document ID (defaults to active document)"),
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
        const store = getDocumentStore(documentId);
        if (!store) return noDocumentError();
        // The join closes HERE, below the guard — a separate fact from the
        // stamp above. The poll that bailed out collected nothing, marked no
        // chat message read, and touched no ledger, so the user's message is
        // still unseen; closing the round there would report a delivery that
        // did not happen. Past this line the full pass runs.
        resolveDeliveryRound();
        const allAnnotations = store.listAnnotations();
        const fullText = store.getText();

        // WS-A2: single live read of the three-state mode, used both to gate
        // the Solo privacy hold (`hideFromAI` in the surfacer) and to report
        // the two-state `mode` below. Read once so the gate and the reported
        // value can never disagree within a single poll.
        const modeState = readModeState();

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
        // `modeState` and `wasEmittedViaChannel` are passed EXPLICITLY. Both
        // default, and the `modeState` default is the fail-closed-sounding
        // `"indeterminate"`, which is not fail-closed for an unmarked record:
        // `hideFromAI` then holds only records already stamped `heldInSolo`.
        const { userActions, userResponses } = processInboxAnnotations(
          allAnnotations,
          fullText,
          surfacedIds,
          (anns) => store.refreshAnnotations(anns),
          store.documentId,
          modeState,
          wasEmittedViaChannel,
        );

        // WS-A2 userReplies bucket — new user replies on comment threads, held in
        // Solo and released on the flip. Uses the full annotation set (not just
        // `unsurfaced`) since a reply can arrive on a long-surfaced comment.
        const userReplies = collectInboxUserReplies(
          allAnnotations,
          fullText,
          (id) => store.listReplies(id),
          replySurfacedIds,
          modeState,
          store.documentId,
          wasEmittedViaChannel,
        );

        // Bucket 3: unread chat messages from CTRL_ROOM
        const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
        const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
        const chatMessages: Array<Omit<ChatMessage, "read" | "author">> = [];

        chatMap.forEach((value) => {
          const msg = value as ChatMessage;
          if (msg.author === "user" && !msg.read) {
            chatMessages.push({
              id: msg.id,
              text: msg.text,
              timestamp: msg.timestamp,
              ...(msg.documentId ? { documentId: msg.documentId } : {}),
              ...(msg.anchor ? { anchor: msg.anchor } : {}),
              ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
            });
            // Mark as read
            withMcp(ctrlDoc, () => chatMap.set(msg.id, { ...msg, read: true }));
          }
        });

        // Current user activity. `getUserAwareness()` is typed rather than a
        // `getMap` returning the raw Y.Map — a map accessor would be the `ydoc`
        // hatch under a new name.
        const { selection, activity } = store.getUserAwareness();

        // Reported mode is the two-state view of the same live read used for
        // the hold gate: indeterminate (mode key absent, e.g. restart) collapses
        // to the default, matching the pre-WS-A2 `.catch(TANDEM_MODE_DEFAULT)`.
        const mode = reportedMode(modeState);

        const hasSelection = selection && selection.from !== selection.to;
        const selectedText = hasSelection
          ? safeSlice(fullText, selection!.from, selection!.to)
          : null;

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
        }
        const summary = parts.length > 0 ? parts.join(". ") + "." : "No new actions.";

        const hasNew =
          userActions.length > 0 ||
          userResponses.length > 0 ||
          userReplies.length > 0 ||
          chatMessages.length > 0;

        return mcpStructured({
          summary,
          hasNew,
          mode,
          storeReadOnly: isStoreReadOnly(),
          userActions,
          userResponses,
          userReplies,
          chatMessages,
          activity: {
            isTyping: activity?.isTyping ?? false,
            cursor: activity?.cursor ?? null,
            lastEdit: activity?.lastEdit ?? null,
            selectedText,
          },
        });
      }),
    ),
  );
  server.tool(
    "tandem_reply",
    "Send a chat message to the user in the Tandem sidebar. Use this to respond to chat messages from tandem_checkInbox.",
    {
      text: z.string().describe("Your message to the user"),
      replyTo: z.string().optional().describe("ID of the user message you are replying to"),
      documentId: z
        .string()
        .optional()
        .describe("Document context for this reply (defaults to active document)"),
    },
    withErrorBoundary("tandem_reply", async ({ text, replyTo, documentId }) => {
      // #651 presence: tandem_reply is a chat send — no annotationId — so the
      // marker is the generic "Claude is working" status-bar indicator.
      return withTypingPresence({ tool: "tandem_reply", documentId }, async () => {
        const current = getCurrentDoc(documentId);
        const docId = documentId ?? current?.id ?? undefined;
        const id = appendClaudeChatMessage(text, { documentId: docId, replyTo });
        return mcpSuccess({ sent: true, messageId: id });
      });
    }),
  );
}

/** Safely slice text and truncate to 100 chars. Exported for testing. */
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
 * **`modeState` and `wasChannelEmitted` are REQUIRED, and were briefly not.**
 * The first draft of this unit gave both defaults and warned about them in
 * prose. Review defeated the warning twice over. `modeState` defaulted to
 * `"indeterminate"`, under which `hideFromAI` holds only records already
 * stamped `heldInSolo` — so a call that stopped at `documentId` (required, and
 * positionally AHEAD of both) surfaced unmarked user records in a live Solo
 * session, with exactly one killer spec. `wasChannelEmitted` defaulted to
 * `() => false` and had NO killer: deleting it from the call site left every
 * spec in the repo green while production silently stopped stamping
 * `alreadyPushed` for every channel-connected session. `collectInboxUserReplies`
 * below already takes `modeState` required, with the same privacy gate; this is
 * now consistent with it. A required parameter is the only version of that
 * warning a compiler enforces.
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
  surfaced: Map<string, number>,
  refreshAll: (anns: Annotation[]) => Annotation[],
  /**
   * Scopes the ledger key. Required — a bare-id key silently drops the same
   * imported Word comment in a second document. See `surfacedIds`.
   */
  documentId: string,
  /** Privacy gate. Required — see the docblock; `"indeterminate"` is NOT fail-closed. */
  modeState: ModeState,
  wasChannelEmitted: (payloadId: string) => boolean,
): {
  userActions: Array<InboxUserAction>;
  userResponses: Array<Annotation & { textSnippet: string }>;
} {
  // Select first, refresh once. The two halves are separable because the
  // selection reads only the pre-refresh records and a stable ledger — a refresh
  // of one annotation cannot change another's selection outcome — so batching
  // costs no fidelity against the per-item loop this replaces.
  const candidates = allAnnotations.filter((raw) => {
    const lastSurfacedEditedAt = surfaced.get(ledgerKey(documentId, raw.id));
    return lastSurfacedEditedAt === undefined || (raw.editedAt ?? 0) > lastSurfacedEditedAt;
  });

  // **`candidates` is the answer; `refreshAll` only gets to improve the ranges
  // in it.** Re-keying by id means a refresher that returns extra records cannot
  // add them to the inbox, and one that drops a record degrades to that record's
  // pre-refresh (correct, possibly stale) range rather than losing the surface
  // and the ledger entry for it. Without this the callback decides what Claude
  // sees, which is not what its name or its docblock claims.
  const refreshedById = new Map(refreshAll(candidates).map((a) => [a.id, a]));
  const unsurfaced = candidates.map((c) => refreshedById.get(c.id) ?? c);

  return processUnsurfacedInboxAnnotations(
    unsurfaced,
    fullText,
    surfaced,
    modeState,
    wasChannelEmitted,
    documentId,
  );
}

function processUnsurfacedInboxAnnotations(
  unsurfaced: Annotation[],
  fullText: string,
  surfaced: Map<string, number>,
  modeState: ModeState,
  wasChannelEmitted: (payloadId: string) => boolean,
  /** Scopes the ledger key — see `surfacedIds`. */
  documentId: string,
): {
  userActions: Array<InboxUserAction>;
  userResponses: Array<Annotation & { textSnippet: string }>;
} {
  const userActions: Array<InboxUserAction> = [];
  const userResponses: Array<Annotation & { textSnippet: string }> = [];

  for (const ann of unsurfaced) {
    // WS-A2 Solo hold — the gate-before-ledger. A held user record must be
    // skipped BEFORE any `surfaced.set` below; otherwise the dedup ledger is
    // poisoned and the item would be permanently dedup-skipped after release.
    // Held items stay "unsurfaced" and re-appear on the first poll once mode
    // reads tandem (pull-driven release — no explicit replay needed here).
    if (hideFromAI(ann, modeState)) continue;

    const snippet = safeSlice(fullText, ann.range.from, ann.range.to);
    if (ann.author === "user" && ann.type === "comment") {
      const lastSurfacedEditedAt = surfaced.get(ledgerKey(documentId, ann.id));
      const alreadySurfaced = lastSurfacedEditedAt !== undefined;
      const edited = alreadySurfaced && (ann.editedAt ?? 0) > lastSurfacedEditedAt;
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
      userActions.push({
        ...ann,
        textSnippet: snippet,
        ...(edited ? { edited: true } : {}),
        ...(wasChannelEmitted(channelKey) ? { alreadyPushed: true } : {}),
      });
      surfaced.set(ledgerKey(documentId, ann.id), ann.editedAt ?? 0);
    } else if (ann.author === "claude" && ann.type !== "note" && ann.status !== "pending") {
      userResponses.push({ ...ann, textSnippet: snippet });
      surfaced.set(ledgerKey(documentId, ann.id), ann.editedAt ?? 0);
    }
  }

  return { userActions, userResponses };
}

/**
 * A user comment in the checkInbox `userActions` bucket.
 *
 * Both optional flags are `true`-only, matching `z.literal(true).optional()` in
 * `output-schemas.ts`. That is load-bearing, not cosmetic: the MCP SDK hard-
 * validates structured output against the declared schema and throws
 * `McpError(InvalidParams)` on a mismatch, which fails the WHOLE checkInbox
 * response rather than dropping the field. Widening either to `boolean` would let
 * `edited: false` typecheck and then blow up at runtime — and tests would not
 * catch it, since tsconfig includes only `src/`.
 */
export type InboxUserAction = Annotation & {
  textSnippet: string;
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
  /** Also emitted as a channel event. A hint, not proof of delivery. */
  alreadyPushed?: true;
}

/**
 * WS-A2: collect NEW user replies for the checkInbox userReplies bucket — the
 * pull-release path for a reply that was held from the push channel in Solo.
 * Exported for testing.
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
  replySurfaced: Set<string>,
  modeState: ModeState,
  /** Scopes the ledger key — see `replySurfacedIds`. */
  documentId: string,
  wasChannelEmitted: (payloadId: string) => boolean = () => false,
): InboxUserReply[] {
  const out: InboxUserReply[] = [];
  for (const ann of allAnnotations) {
    const visible = channelVisibleReplies(ann, loadReplies);
    if (visible.length === 0) continue;
    const snippet = safeSlice(fullText, ann.range.from, ann.range.to);
    for (const reply of visible) {
      if (reply.author !== "user") continue; // Claude's own replies aren't inbox items
      if (hideFromAI(reply, modeState)) continue; // Solo hold — no ledger write
      if (replySurfaced.has(ledgerKey(documentId, reply.id))) continue; // already surfaced
      // Disclose, never suppress — see the annotation surfacer for the full
      // rationale. This branch was strictly worse than the comment one:
      // `replySurfaced` is a plain Set with no edit dimension, so a poisoned
      // entry had no `editedAt` escape hatch and the reply was lost for the
      // whole server run with certainty.
      out.push({
        id: reply.id,
        annotationId: ann.id,
        author: "user",
        text: reply.text,
        timestamp: reply.timestamp,
        textSnippet: snippet,
        ...(wasChannelEmitted(reply.id) ? { alreadyPushed: true } : {}),
      });
      replySurfaced.add(ledgerKey(documentId, reply.id));
    }
  }
  return out;
}
