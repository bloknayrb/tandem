import type { Express, Request, Response } from "express";
import {
  API_CHANNEL_AWARENESS,
  API_CHANNEL_ERROR,
  API_CHANNEL_REPLY,
  API_CHAT,
  API_EVENTS,
} from "../../shared/api-paths.js";
import { CLAUDE_SESSION_HEADER, normalizeSessionId } from "../../shared/cli-runtime.js";
import { CTRL_ROOM } from "../../shared/constants.js";
import { ChannelErrorCodeSchema } from "../../shared/types.js";
import { closeMessageDeliveryRound } from "../events/delivery-state.js";
import { recordPushConsumerEvent } from "../events/push-liveness.js";
import { sseHandler } from "../events/sse.js";
import { aiRefusal, sendAiRefusal } from "../license/ai-refusal.js";
import { sanitizeForLog } from "../log-sanitize.js";
import { clearCtrlChatDurably } from "../session/manager.js";
import { channelReplyGate, greetingTransportBound, type ReplyGate } from "../sessions/ownership.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import type { Handler } from "./api-routes.js";
import {
  appendClaudeChatMessage,
  markUserChatRead,
  notifyTandemReply,
  REPLY_TO_UNMATCHED_WARNING,
} from "./awareness.js";
import { getCurrentDoc, getOpenDocs } from "./document.js";
import { isGreetingReply } from "./greeting-reply.js";

/**
 * Licence admission for the AI-facing channel route (#1521): answer 403 with
 * the refusal envelope and report that the caller must stop. Checked before the
 * route touches any state. `channel-reply` is the one caller since the
 * permission relay routes were deleted (#1885). The shim's diagnostics
 * (`channel-awareness`, `channel-error`) stay open — they carry no AI content.
 */
function refuseIfUnlicensed(res: Response): boolean {
  const refusal = aiRefusal();
  if (!refusal) return false;
  sendAiRefusal(res, refusal);
  return true;
}

/**
 * The HTTP status of a refused channel reply (#2358 PR 4b; ownership design
 * §9.2): an ownership refusal is 409 with the `NOT_DOC_OWNER` body, which the
 * shim relays to the model with its status as the tool result; a contradicting
 * `documentId` is the caller's mistake (400); the rest is Tandem's (500).
 */
const REFUSAL_STATUS: Record<Extract<ReplyGate, { kind: "refused" }>["code"], number> = {
  NOT_DOC_OWNER: 409,
  INVALID_ARGUMENT: 400,
  INTERNAL_ERROR: 500,
};

/** The 500 answered when the permit itself throws: nothing was written. */
export const CHANNEL_REPLY_GATE_FAILED =
  "tandem_reply failed: Tandem could not check who may send this reply. Nothing was sent. This is a fault in Tandem, not something to retry with different arguments.";

/** Register channel-related routes (/api/events, /api/channel-*, /api/chat) on the Express app. */
export function registerChannelRoutes(app: Express, apiMiddleware: Handler): void {
  // SSE event stream for channel shim
  app.get(API_EVENTS, apiMiddleware, sseHandler);

  // Push-consumer heartbeat: a channel shim / plugin monitor reports that it
  // received an SSE event. Recorded for diagnostics only — see the comment in
  // the handler and `events/push-liveness.ts`.
  //
  // Unknown keys in the body are ignored. Worth stating because an earlier
  // version of this comment claimed `focusParagraph`/`focusOffset` were kept for
  // compatibility with pinned shim versions — no shim has ever sent them
  // (`git log --all -S` across src/channel, src/monitor and sse-consumer.ts
  // returns nothing). They described Claude's cursor, which this caller has
  // never had first-hand knowledge of.
  app.options(API_CHANNEL_AWARENESS, apiMiddleware);
  app.post(API_CHANNEL_AWARENESS, apiMiddleware, (req: Request, res: Response) => {
    const { documentId, status, active } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof status !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "status is required" });
      return;
    }
    // This is a PUSH-CONSUMER heartbeat, not Claude's presence.
    //
    // It used to write `ClaudeAwareness` into the document's Y.Map('awareness'),
    // which drives the status pill's `· {status}` suffix and the chat panel's
    // thinking line. But the caller is the channel shim / plugin monitor, and
    // `sse-consumer.ts` fires it on EVENT RECEIPT — not on Claude doing
    // anything. A shim whose host never negotiated the channel still receives
    // SSE, so it kept stamping `status: "processing: …"` and then the 3s
    // auto-clear `status: "idle"` for a process no model was attached to. The
    // pill read "AI connected · idle", refreshed on every document touch, with
    // nothing on the other end. Claude's real presence comes from
    // `tandem_status` (explicit) and typing-presence's `working` marker
    // (per tool call); both are written by Claude's own dispatches.
    //
    // The signal is still worth keeping — it is the only positive evidence that
    // the server→consumer leg of the push path works end to end — so it is
    // recorded here for diagnostics (`/health`, `tandem doctor`) and never
    // rendered as Claude's state. It does NOT prove delivery to a model.
    const docId = typeof documentId === "string" ? documentId : null;
    recordPushConsumerEvent({ status, active: active === true, documentId: docId });
    // `{ ok: true }` only. The handler writes nothing now, so the old `written`
    // field meant no more than "your body carried a string documentId" — and
    // docs/mcp-tools.md documented this response as `{ ok: true }` all along.
    res.json({ ok: true });
  });

  // Channel error: shim reports errors for browser display
  app.options(API_CHANNEL_ERROR, apiMiddleware);
  app.post(API_CHANNEL_ERROR, apiMiddleware, (req: Request, res: Response) => {
    const { error, message } = (req.body ?? {}) as Record<string, unknown>;
    // Validate the code so a future caller can't smuggle a free-form string
    // through unfiltered logs. Out-of-schema codes are logged as UNKNOWN_CODE
    // (keeps the diagnostic trail) and reported as 400 so the caller notices.
    //
    // The rejected value IS logged, before the 400 — deliberately, because that
    // diagnostic trail is the only reason this branch logs at all. What makes
    // it safe is `sanitizeForLog`, not the rejection: `error` and `message` are
    // both unvalidated body fields here, so each is stripped of control
    // characters and clamped to LOG_FIELD_MAX before it reaches the line.
    const parsed = ChannelErrorCodeSchema.safeParse(error);
    if (!parsed.success) {
      console.error(
        `[Channel] Error: UNKNOWN_CODE (${sanitizeForLog(error)}) — ${sanitizeForLog(message)}`,
      );
      res
        .status(400)
        .json({ error: "BAD_REQUEST", message: "error must be a known ChannelErrorCode" });
      return;
    }
    console.error(`[Channel] Error: ${parsed.data} — ${sanitizeForLog(message)}`);
    // Could broadcast to browser via Y.Map in the future
    res.json({ ok: true });
  });

  // Channel reply: shim forwards Claude's chat replies
  app.options(API_CHANNEL_REPLY, apiMiddleware);
  app.post(API_CHANNEL_REPLY, apiMiddleware, (req: Request, res: Response) => {
    // Refusal first, before body validation, like every other AI channel
    // route: an unlicensed caller hears why it is refused, not a 400 about its
    // body. `appendClaudeChatMessage` refuses again below, as defence.
    if (refuseIfUnlicensed(res)) return;
    const { text, documentId, replyTo, inProgress } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof text !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "text is required" });
      return;
    }
    // Strict, unlike the lenient pre-existing fields: a dropped `inProgress` would
    // silently turn an acknowledgement into what reads as the final answer.
    if (inProgress !== undefined && typeof inProgress !== "boolean") {
      res.status(400).json({ error: "BAD_REQUEST", message: "inProgress must be a boolean" });
      return;
    }
    // The shim forwards its session id (`withClaudeSessionHeader`). Read once:
    // the greeting classifier (#2227) and the notify below must agree on it.
    const sessionId = normalizeSessionId(req.headers[CLAUDE_SESSION_HEADER.toLowerCase()]);
    // The permit (#2358 PR 4b; ownership design §9.2): after the body checks
    // and before the greeting classifier and the append, the shim's session
    // id is mapped to a record and judged by `tandem_reply`'s rule, writing
    // nothing; a refusal returns here with no row, no notify, no round closed
    // and nothing stamped read. Off, `legacy`, and master's path runs.
    // A throw from ownership code (reachable only flag on: the gate answers
    // `legacy` at its first line while dark) is answered as the structured
    // 500 `tandem_reply`'s error boundary would give, never Express's default
    // HTML page, which the shim could only relay as "Non-JSON response".
    let gate: ReplyGate;
    try {
      gate = channelReplyGate(
        sessionId,
        {
          ...(typeof replyTo === "string" ? { replyTo } : {}),
          ...(inProgress === true ? { inProgress: true } : {}),
          ...(typeof documentId === "string" ? { documentId } : {}),
        },
        {
          isOpen: (id) => getOpenDocs().has(id),
          activeDocumentId: () => getCurrentDoc(undefined)?.id ?? undefined,
        },
      );
    } catch (err) {
      console.error(
        `[Channel] channel-reply ownership check failed: ${sanitizeForLog(
          err instanceof Error ? err.message : String(err),
        )}`,
      );
      res.status(REFUSAL_STATUS.INTERNAL_ERROR).json({
        error: "INTERNAL_ERROR",
        message: CHANNEL_REPLY_GATE_FAILED,
      });
      return;
    }
    if (gate.kind === "refused") {
      res.status(REFUSAL_STATUS[gate.code]).json({
        error: gate.code,
        message: gate.message,
        ...(gate.details !== undefined ? { details: gate.details } : {}),
      });
      return;
    }
    // Ownership on, a channel reply is never the greeting (#2358 PR 3b-2c;
    // ownership design §7.3): the greeting is the bound transport's. Off,
    // absent, and the session id decides as before.
    const bound = greetingTransportBound("channel");
    const greeting = isGreetingReply({
      sessionId,
      replyTo: typeof replyTo === "string" ? replyTo : undefined,
      inProgress: inProgress === true,
      ...(bound !== undefined ? { bound } : {}),
    });
    // Narrow the untrusted body fields, then route through the shared Claude-chat
    // write path that `tandem_reply` and the local-model collaborator also use.
    // An accepted reply is stamped with its message's document, or none; an
    // accepted post with what its gate decided (ownership design §7.3), as
    // `tandem_reply` stamps them. Off, the body's `documentId`, as before.
    const docId =
      gate.kind === "accepted"
        ? gate.documentId
        : typeof documentId === "string"
          ? documentId
          : undefined;
    const appended = appendClaudeChatMessage(text, {
      ...(docId !== undefined ? { documentId: docId } : {}),
      ...(typeof replyTo === "string" ? { replyTo } : {}),
      ...(inProgress === true ? { inProgress: true } : {}),
      ...(greeting ? { greeting: true } : {}),
    });
    // Licence (#1521): `appendClaudeChatMessage` refuses before touching the
    // Y.Doc, and this answers before `markUserChatRead`, so a refused reply
    // writes nothing and stamps nothing read.
    if (!appended.ok) {
      sendAiRefusal(res, appended.refusal);
      return;
    }
    // The message's delivery round closes once the reply's row is appended
    // (#2358, the delivery-rounds PR, R2.2): a shim Claude that just answers
    // sends only a final. Since the permit (PR 4b) only an accepted reply
    // reaches here, flag on. Nothing while rounds are not keyed.
    if (typeof replyTo === "string") closeMessageDeliveryRound(replyTo);
    // The reply's claim, per-message owner, answerer and `settles` (ownership
    // design §5.5, §7.1), once the append landed, with no `await` since the
    // gate, before the notify and the read stamp, as `tandem_reply` runs it.
    if (gate.kind === "accepted") gate.apply(appended.id);
    // The shim's `tandem_reply` is a Claude Code session's reply like the MCP
    // tool's, so it can be Tandem's own Claude saying hello (#2197).
    notifyTandemReply(sessionId, bound);
    const unmatched = typeof replyTo === "string" && !markUserChatRead(replyTo);
    res.json({
      sent: true,
      messageId: appended.id,
      ...(unmatched ? { warning: REPLY_TO_UNMATCHED_WARNING } : {}),
    });
  });

  // The channel permission relay (`/api/channel-permission` and
  // `/api/channel-permission-verdict`) lived here until #1885. It had no return
  // leg — nothing could answer Claude Code's approval prompt — and its holding
  // map served each prompt's `description` to any local caller (#1884). The
  // shim no longer declares `claude/channel/permission`, so the routes were
  // deleted rather than hardened. See ADR-047's 2026-10-28 update.

  // Clear chat history
  app.options(API_CHAT, apiMiddleware);
  app.delete(API_CHAT, apiMiddleware, async (_req: Request, res: Response) => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    try {
      const cleared = await clearCtrlChatDurably(ctrlDoc);
      res.json({ ok: true, cleared });
    } catch (err) {
      console.error("[Tandem] Failed to durably clear chat:", err);
      res.status(500).json({
        error: "CHAT_CLEAR_FAILED",
        message: "Chat history could not be cleared. Your messages were left untouched.",
      });
    }
  });

  // NOTE: `POST /api/launch-claude` (and its `src/server/mcp/launcher.ts`
  // spawner) lived here until #1267. It had zero callers in the client, tests
  // or E2E — every launch path goes through the supervisor
  // (`src/server/launcher/`), which owns reaping, session resume and the
  // stream-json protocol. Keeping a second, unsupervised spawner alive meant
  // maintaining a dead copy of the CLI wire contract; it was deleted rather
  // than taught the new protocol.
}
