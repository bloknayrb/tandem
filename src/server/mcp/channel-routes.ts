import type { Express, Request, Response } from "express";
import { CTRL_ROOM, Y_MAP_AWARENESS, Y_MAP_CHAT } from "../../shared/constants.js";
import type { ClaudeAwareness } from "../../shared/types.js";
import { generateMessageId } from "../../shared/utils.js";
import { MCP_ORIGIN } from "../events/queue.js";
import { sseHandler } from "../events/sse.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import type { Handler } from "./api-routes.js";

const pendingPermissions = new Map<
  string,
  {
    requestId: string;
    toolName: string;
    description: string;
    inputPreview: string;
    createdAt: number;
  }
>();
const PERMISSION_TTL_MS = 30_000; // Stale after 30s (terminal answer already won)

/** Register channel-related routes (/api/events, /api/channel-*, /api/launch-claude) on the Express app. */
export function registerChannelRoutes(app: Express, apiMiddleware: Handler): void {
  // SSE event stream for channel shim
  app.get("/api/events", apiMiddleware, sseHandler);

  // Channel awareness: shim posts Claude's status for browser StatusBar
  app.options("/api/channel-awareness", apiMiddleware);
  app.post("/api/channel-awareness", apiMiddleware, (req: Request, res: Response) => {
    const { documentId, status, active, focusParagraph } = (req.body ?? {}) as Record<
      string,
      unknown
    >;
    if (typeof status !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "status is required" });
      return;
    }
    // Write to the document's Y.Map('awareness') so the browser StatusBar updates
    const docId = typeof documentId === "string" ? documentId : null;
    if (docId) {
      const doc = getOrCreateDocument(docId);
      const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
      const state: ClaudeAwareness = {
        status,
        timestamp: Date.now(),
        active: active === true,
        focusParagraph: typeof focusParagraph === "number" ? focusParagraph : null,
      };
      doc.transact(() => awarenessMap.set("claude", state), MCP_ORIGIN);
    }
    res.json({ ok: true, written: !!docId });
  });

  // Channel error: shim reports errors for browser display
  app.options("/api/channel-error", apiMiddleware);
  app.post("/api/channel-error", apiMiddleware, (req: Request, res: Response) => {
    const { error, message } = (req.body ?? {}) as Record<string, unknown>;
    console.error(`[Channel] Error: ${error} — ${message}`);
    // Could broadcast to browser via Y.Map in the future
    res.json({ ok: true });
  });

  // Channel reply: shim forwards Claude's chat replies
  app.options("/api/channel-reply", apiMiddleware);
  app.post("/api/channel-reply", apiMiddleware, (req: Request, res: Response) => {
    const { text, documentId, replyTo } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof text !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "text is required" });
      return;
    }
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
    const id = generateMessageId();
    const msg = {
      id,
      author: "claude" as const,
      text,
      timestamp: Date.now(),
      ...(typeof documentId === "string" ? { documentId } : {}),
      ...(typeof replyTo === "string" ? { replyTo } : {}),
      read: true,
    };
    ctrlDoc.transact(() => chatMap.set(id, msg), MCP_ORIGIN);
    res.json({ sent: true, messageId: id });
  });

  // Channel permission relay: shim forwards Claude Code's tool approval prompts
  // Pending requests stored for browser polling (SSE push to browser is a follow-up)
  app.options("/api/channel-permission", apiMiddleware);
  app.post("/api/channel-permission", apiMiddleware, (req: Request, res: Response) => {
    const { requestId, toolName, description, inputPreview } = (req.body ?? {}) as Record<
      string,
      unknown
    >;
    if (typeof requestId !== "string" || typeof toolName !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "requestId and toolName required" });
      return;
    }
    pendingPermissions.set(requestId, {
      requestId,
      toolName,
      description: (description as string) ?? "",
      inputPreview: (inputPreview as string) ?? "",
      createdAt: Date.now(),
    });
    console.error(`[Channel] Permission request: ${toolName} — ${description} (id: ${requestId})`);
    res.json({ ok: true });
  });

  // Browser polls for pending permission requests
  app.get("/api/channel-permission", apiMiddleware, (_req: Request, res: Response) => {
    // Evict stale requests before returning
    const now = Date.now();
    for (const [id, perm] of pendingPermissions) {
      if (now - perm.createdAt > PERMISSION_TTL_MS) pendingPermissions.delete(id);
    }
    res.json({ pending: Array.from(pendingPermissions.values()) });
  });

  // Browser submits verdict
  app.options("/api/channel-permission-verdict", apiMiddleware);
  app.post("/api/channel-permission-verdict", apiMiddleware, (req: Request, res: Response) => {
    const { requestId, approved } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof requestId !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "requestId is required" });
      return;
    }
    pendingPermissions.delete(requestId);
    // Store verdict for the channel shim to poll (or push via SSE in follow-up)
    console.error(`[Channel] Permission verdict: ${requestId} → ${approved ? "allow" : "deny"}`);
    res.json({ ok: true, requestId, behavior: approved ? "allow" : "deny" });
  });

  // Clear chat history
  app.options("/api/chat", apiMiddleware);
  app.delete("/api/chat", apiMiddleware, (_req: Request, res: Response) => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
    const count = chatMap.size;
    ctrlDoc.transact(() => {
      for (const key of Array.from(chatMap.keys())) {
        chatMap.delete(key);
      }
    }, MCP_ORIGIN);
    res.json({ ok: true, cleared: count });
  });

  // Claude Code launcher
  app.options("/api/launch-claude", apiMiddleware);
  app.post("/api/launch-claude", apiMiddleware, async (_req: Request, res: Response) => {
    try {
      const { launchClaude } = await import("./launcher.js");
      const result = launchClaude();
      res.json(result);
    } catch (err) {
      console.error("[Tandem] Failed to launch Claude:", err);
      res.status(500).json({
        error: "LAUNCH_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
