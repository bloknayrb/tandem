import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CTRL_ROOM,
  Y_MAP_ACTIVITY,
  Y_MAP_CHAT,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import { withMcp } from "../../shared/origins.js";
import type {
  AgentIdentity,
  Annotation,
  AnnotationReply,
  ChatMessage,
  FlatOffset,
} from "../../shared/types.js";
import { generateMessageId } from "../../shared/utils.js";
import { isStoreReadOnly } from "../annotations/store.js";
import { recordInboxPoll, resolveDeliveryRound } from "../events/delivery-state.js";
import { getAnnotationEditedChannelKey, wasEmittedViaChannel } from "../events/queue.js";
import { hideFromAI, type ModeState, readModeState, reportedMode } from "../mode.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { channelVisibleReplies } from "./annotations.js";
import { extractText, getCurrentDoc } from "./document.js";
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
    // omits it ⇒ real-Claude chat is byte-identical. updateClaudeChatMessage's
    // `{...existing, text}` re-set carries it through every streamed delta.
    ...(opts.agentIdentity ? { agentIdentity: opts.agentIdentity } : {}),
    read: true,
  };
  withMcp(ctrlDoc, () => chatMap.set(id, msg));
  return id;
}

/**
 * Update the text of an existing Claude-authored chat message, for the
 * local-model collaborator's token streaming (#1123 M1.2). Re-`set`s a FRESH
 * object so the value read from the map is never mutated in place; ONLY `text`
 * changes — `id`, `author`, `timestamp` (deliberately NOT re-stamped: ChatPanel
 * sorts by timestamp, so a bump would re-sort the live bubble on every flush),
 * `read`, `documentId`, `replyTo` carry verbatim. No-op when the id is absent
 * (doc closed / message GC'd). The re-`set` is an `update` action, which the
 * ctrl-chat observer additionally drops at its `action !== "add"` gate — so a
 * streamed delta self-wakes even less than the initial append.
 */
export function updateClaudeChatMessage(id: string, text: string): void {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
  const existing = chatMap.get(id) as ChatMessage | undefined;
  if (!existing) return;
  withMcp(ctrlDoc, () => chatMap.set(id, { ...existing, text }));
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
      const current = getCurrentDoc(documentId);
      if (!current) return noDocumentError();

      const doc = getOrCreateDocument(current.docName);
      const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
      const activity = userAwareness.get(Y_MAP_ACTIVITY) as
        | {
            isTyping: boolean;
            cursor: number;
            lastEdit: number;
          }
        | undefined;

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
        const doc = store.ydoc;
        const allAnnotations = store.listAnnotations();
        const fullText = extractText(doc);

        // WS-A2: single live read of the three-state mode, used both to gate
        // the Solo privacy hold (`hideFromAI` in the surfacer) and to report
        // the two-state `mode` below. Read once so the gate and the reported
        // value can never disagree within a single poll.
        const modeState = readModeState();

        // Refresh only unsurfaced annotations; batch Y.Map writes.
        // refreshAnnotation returns the refreshed annotation (the underlying
        // refreshRange yields a tagged RefreshResult per ADR-032); the inbox
        // surfacer doesn't currently distinguish refresh outcomes. A future
        // enhancement could route `degraded` / `failed` annotations into a
        // separate notification.
        const unsurfaced: Annotation[] = [];
        store.transactMcp(() => {
          for (const raw of allAnnotations) {
            const lastSurfacedEditedAt = surfacedIds.get(ledgerKey(store.documentId, raw.id));
            // Not yet surfaced
            if (lastSurfacedEditedAt === undefined) {
              unsurfaced.push(store.refreshAnnotation(raw));
              continue;
            }
            // Already surfaced — check if it's been edited since
            if ((raw.editedAt ?? 0) > lastSurfacedEditedAt) {
              unsurfaced.push(store.refreshAnnotation(raw));
            }
          }
        });

        const { userActions, userResponses } = processUnsurfacedInboxAnnotations(
          unsurfaced,
          fullText,
          surfacedIds,
          modeState,
          wasEmittedViaChannel,
          store.documentId,
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

        // Current user activity
        const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
        const selection = userAwareness.get(Y_MAP_SELECTION) as
          | { from: FlatOffset; to: FlatOffset; timestamp: number }
          | undefined;
        const activity = userAwareness.get(Y_MAP_ACTIVITY) as
          | {
              isTyping: boolean;
              cursor: number;
              lastEdit: number;
            }
          | undefined;

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
 * Process annotations into inbox buckets. Exported for testing.
 * Mutates surfacedIds to track which annotations have been surfaced.
 */
export function processInboxAnnotations(
  allAnnotations: Annotation[],
  fullText: string,
  surfaced: Map<string, number>,
  refreshFn: (ann: Annotation) => Annotation,
  /**
   * Scopes the ledger key. Required — a bare-id key silently drops the same
   * imported Word comment in a second document. See `surfacedIds`.
   */
  documentId: string,
  // Privacy gate: default to the fail-CLOSED value, not "tandem". The real
  // caller always passes live mode; a caller that forgets should hold held
  // items, never surface them.
  modeState: ModeState = "indeterminate",
  wasChannelEmitted: (payloadId: string) => boolean = () => false,
): {
  userActions: Array<InboxUserAction>;
  userResponses: Array<Annotation & { textSnippet: string }>;
} {
  const unsurfaced: Annotation[] = [];
  for (const raw of allAnnotations) {
    const lastSurfacedEditedAt = surfaced.get(ledgerKey(documentId, raw.id));
    if (lastSurfacedEditedAt === undefined) {
      unsurfaced.push(refreshFn(raw));
    } else if ((raw.editedAt ?? 0) > lastSurfacedEditedAt) {
      unsurfaced.push(refreshFn(raw));
    }
  }

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
    } else if (ann.author === "claude" && ann.status !== "pending") {
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
