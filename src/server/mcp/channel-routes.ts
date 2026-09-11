import type { Express, Request, Response } from "express";
import {
  API_CHANNEL_AWARENESS,
  API_CHANNEL_ERROR,
  API_CHANNEL_PERMISSION,
  API_CHANNEL_PERMISSION_VERDICT,
  API_CHANNEL_REPLY,
  API_CHAT,
  API_EVENTS,
} from "../../shared/api-paths.js";
import { CTRL_ROOM } from "../../shared/constants.js";
import { ChannelErrorCodeSchema } from "../../shared/types.js";
import { recordPushConsumerEvent } from "../events/push-liveness.js";
import { sseHandler } from "../events/sse.js";
import { clearCtrlChatDurably } from "../session/manager.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import type { Handler } from "./api-routes.js";
import { appendClaudeChatMessage } from "./awareness.js";

/**
 * Characters kept from any request-supplied field written to the operator's log.
 *
 * Exported so the specs clamp against the real bound rather than a copy of it.
 */
export const LOG_FIELD_MAX = 200;

/**
 * Render an untrusted request-body field safe to interpolate into a log line.
 *
 * Every channel route below is reachable without a loopback source address —
 * the whole `/api/channel-*` family is carved out of `enforceLoopbackMutation`
 * in `NON_LOOPBACK_ALLOWED` (`api-routes.ts`), because the shim and the plugin
 * monitor run against a non-loopback `TANDEM_URL`. Under a Cowork bind a
 * bearer-authenticated LAN peer therefore writes straight into the operator's
 * terminal, and `console.error` is the only sink there is (stdout is the MCP
 * wire — Critical Rule 3 redirects every `console.*` to stderr). Unstripped, an
 * ESC/OSC-0 sequence retitles that terminal and a bare LF forges a whole log
 * line.
 *
 * **Total before it strips.** Two of the call sites pass a field with no type
 * guard at all (`message` and `error` on `/api/channel-error`), and
 * `String(value)` *throws* on a JSON-craftable object: `String(JSON.parse(
 * '{"toString":1,"valueOf":2}'))` is a `TypeError`. That throw would happen in
 * an outer-app route handler, past every sub-app error handler, so it would
 * land on Express's HTML error page complete with the install path. The
 * `try`/`catch` is what stops that; it is not defensive decoration.
 *
 * Modelled on `stripControlChars` (`src/client/utils/diagnostics.ts`) and
 * deliberately NOT imported from it: `src/server` imports nothing from
 * `src/client` today, and this copy also strips LF, CR and TAB, which that one
 * keeps — a bare LF is the line-forging half of this finding.
 */
function sanitizeForLog(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : String(value);
  } catch {
    // A body object whose `toString` and `valueOf` are both non-callable.
    return "[unstringifiable]";
  }
  const stripped = s
    // C0 (LF, CR and TAB included), DEL and C1 — the escape-sequence introducers.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    // Trojan-Source bidi overrides. Not control characters, so the strip above
    // does not see them, and they reorder the rendered line all the same.
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g, "");
  return stripped.length > LOG_FIELD_MAX ? `${stripped.slice(0, LOG_FIELD_MAX)}\u2026` : stripped;
}

const pendingPermissions = new Map<
  string,
  {
    requestId: string;
    toolName: string;
    description: string;
    createdAt: number;
  }
>();
const PERMISSION_TTL_MS = 30_000; // Stale after 30s (terminal answer already won)

/**
 * Evict pending entries older than the TTL.
 *
 * Called from BOTH channel-permission routes, and the POST is the load-bearing
 * one. The sweep used to live only inside the GET, which reads well until you
 * pair it with #1794's own finding that NO client polls that route: with no
 * reader and no timer, nothing ever ran it, so every request an armed shim
 * forwarded stayed resident — with its `description` — for the life of the
 * server process, and the map grew without bound. The POST is the only thing
 * that grows the map, so sweeping there is what makes "held for 30 seconds"
 * true. Nothing sweeps on a timer, deliberately: an idle server has nothing to
 * sweep, and a timer would be a second thing to reason about at shutdown.
 */
function sweepStalePermissions(): void {
  const now = Date.now();
  for (const [id, perm] of pendingPermissions) {
    if (now - perm.createdAt > PERMISSION_TTL_MS) pendingPermissions.delete(id);
  }
}

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
    const { text, documentId, replyTo } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof text !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "text is required" });
      return;
    }
    // Narrow the untrusted body fields, then route through the shared Claude-chat
    // write path that `tandem_reply` and the local-model collaborator also use.
    const id = appendClaudeChatMessage(text, {
      ...(typeof documentId === "string" ? { documentId } : {}),
      ...(typeof replyTo === "string" ? { replyTo } : {}),
    });
    res.json({ sent: true, messageId: id });
  });

  // Channel permission relay: the shim forwards Claude Code's tool approval
  // prompt. There is no return leg — see docs/architecture.md and ADR-047 §3.
  // The prompt's `input_preview` (file bodies, command lines) is discarded on
  // arrival — the shim no longer sends it either (#1884) — while `description`,
  // the tool-level summary line, IS stored and served by the GET below. It
  // stays resident until a later request's sweep evicts it: `PERMISSION_TTL_MS`
  // is the age at which a sweep evicts, not a residency bound, because nothing
  // sweeps on a timer (see `sweepStalePermissions`).
  app.options(API_CHANNEL_PERMISSION, apiMiddleware);
  app.post(API_CHANNEL_PERMISSION, apiMiddleware, (req: Request, res: Response) => {
    const { requestId, toolName, description } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof requestId !== "string" || typeof toolName !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "requestId and toolName required" });
      return;
    }
    // Before the insert, so the map holds one TTL window rather than the whole
    // session — see `sweepStalePermissions`.
    sweepStalePermissions();
    pendingPermissions.set(requestId, {
      requestId,
      toolName,
      description: (description as string) ?? "",
      createdAt: Date.now(),
    });
    // `toolName`/`requestId` are `typeof … === "string"`-guarded above, so the
    // residue here is control characters and unbounded length only — which is
    // exactly what `sanitizeForLog` is for.
    console.error(
      `[Channel] Permission request: ${sanitizeForLog(toolName)} (id: ${sanitizeForLog(requestId)})`,
    );
    res.json({ ok: true });
  });

  // Browser polls for pending permission requests
  app.get(API_CHANNEL_PERMISSION, apiMiddleware, (_req: Request, res: Response) => {
    sweepStalePermissions();
    res.json({ pending: Array.from(pendingPermissions.values()) });
  });

  // Browser submits verdict
  app.options(API_CHANNEL_PERMISSION_VERDICT, apiMiddleware);
  app.post(API_CHANNEL_PERMISSION_VERDICT, apiMiddleware, (req: Request, res: Response) => {
    const { requestId, approved } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof requestId !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "requestId is required" });
      return;
    }
    pendingPermissions.delete(requestId);
    // Deletion is the only effect: no return leg — see docs/architecture.md and
    // ADR-047 §3. The verdict is echoed to the browser that submitted it and
    // never reaches Claude Code.
    console.error(
      `[Channel] Permission verdict: ${sanitizeForLog(requestId)} → ${approved ? "allow" : "deny"}`,
    );
    res.json({ ok: true, requestId, behavior: approved ? "allow" : "deny" });
  });

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
