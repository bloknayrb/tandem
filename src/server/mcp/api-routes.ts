import type { Express, NextFunction, Request, Response } from "express";

import {
  applyConfig,
  buildMcpEntries,
  type DetectedTarget,
  detectTargets,
  installSkill,
} from "../../cli/setup.js";
import {
  CHANNEL_SSE_KEEPALIVE_MS,
  CTRL_ROOM,
  TANDEM_MODE_DEFAULT,
  TAURI_HOSTNAME,
  Y_MAP_ANNOTATIONS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import type { TandemNotification } from "../../shared/types.js";
import { TandemModeSchema } from "../../shared/types.js";
import { subscribe as subscribeNotifications } from "../notifications.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { addReplyToAnnotation } from "./annotations.js";
import { convertToMarkdown } from "./convert.js";
import { getCurrentDoc } from "./document.js";
import { detectFormat } from "./document-model.js";
import { closeDocumentById, getActiveDocId, saveDocumentToDisk } from "./document-service.js";
import { applyChangesCore } from "./docx-apply.js";
import { openFileByPath, openFileFromContent } from "./file-opener.js";

/** Express middleware/handler function type (Express 5 compatible). */
export type Handler = (req: Request, res: Response, next: NextFunction) => void;

/** Check if a Host header value is allowed (localhost only). Exported for testing. */
export function isHostAllowed(host: string | undefined): boolean {
  const reqHost = (host ?? "").split(":")[0];
  return reqHost === "localhost" || reqHost === "127.0.0.1" || reqHost === TAURI_HOSTNAME;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Check if an Origin header is a localhost URL. Exported for testing. */
export const LOCALHOST_ORIGIN_RE = new RegExp(
  `^https?://(localhost|127\\.0\\.0\\.1|${escapeRegExp(TAURI_HOSTNAME)})(:\\d+)?$`,
);
export function isLocalhostOrigin(origin: string | undefined): boolean {
  return LOCALHOST_ORIGIN_RE.test(origin ?? "");
}

/** Reject UNC paths (both backslash and forward-slash variants) to prevent NTLM hash leaks. */
function hasUncPrefix(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

/** basename() on Linux doesn't treat `\` as a separator, so Windows-style paths
 *  like `C:\Program Files\node.exe` return the whole string. Split on both. */
function crossBasename(p: string): string {
  return p.split(/[/\\]/).pop() || "";
}

/** Validate that a nodeBinary path points to a Node.js binary, not an arbitrary executable. */
const VALID_NODE_BASENAME_RE = /^node(-sidecar(-[a-z0-9_-]+)?)?(\.exe)?$/;
export function isValidNodeBinary(nodeBinary: string): boolean {
  if (!nodeBinary) return false;
  if (nodeBinary.includes("..")) return false;
  if (hasUncPrefix(nodeBinary)) return false;
  return VALID_NODE_BASENAME_RE.test(crossBasename(nodeBinary));
}

/** Validate that a channelPath points to a JS file without traversal or UNC paths. */
export function isValidChannelPath(channelPath: string): boolean {
  if (!channelPath) return false;
  if (!crossBasename(channelPath).endsWith(".js")) return false;
  if (channelPath.includes("..")) return false;
  if (hasUncPrefix(channelPath)) return false;
  return true;
}

interface SetupResult {
  status: number;
  body: {
    error?: string;
    message?: string;
    data?: {
      targets: DetectedTarget[];
      configured: string[];
      errors: string[];
      skillInstalled: boolean;
    };
  };
}

export async function runSetupHandler(
  input: Record<string, unknown>,
  homeOverride?: string,
): Promise<SetupResult> {
  const { nodeBinary, channelPath } = input;

  if (!nodeBinary || typeof nodeBinary !== "string") {
    return { status: 400, body: { error: "BAD_REQUEST", message: "nodeBinary is required" } };
  }
  if (!channelPath || typeof channelPath !== "string") {
    return { status: 400, body: { error: "BAD_REQUEST", message: "channelPath is required" } };
  }
  if (!isValidNodeBinary(nodeBinary)) {
    return {
      status: 400,
      body: { error: "BAD_REQUEST", message: "nodeBinary must be a node binary" },
    };
  }
  if (!isValidChannelPath(channelPath)) {
    return {
      status: 400,
      body: {
        error: "BAD_REQUEST",
        message: "channelPath must be a .js file without path traversal",
      },
    };
  }

  const targets = detectTargets({ homeOverride });
  const entries = buildMcpEntries(channelPath, nodeBinary);

  const configured: string[] = [];
  const errors: string[] = [];

  for (const target of targets) {
    try {
      await applyConfig(target.configPath, entries);
      configured.push(target.label);
    } catch (err) {
      errors.push(`${target.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let skillInstalled = false;
  try {
    await installSkill({ homeOverride });
    skillInstalled = true;
  } catch (err) {
    errors.push(`Skill install: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    status: 200,
    body: { data: { targets, configured, errors, skillInstalled } },
  };
}

/** Map error code to HTTP status. Exported for testing. */
export function errorCodeToHttpStatus(code: string | undefined): number {
  switch (code) {
    case "ENOENT":
    case "FILE_NOT_FOUND":
    case "NO_DOCUMENT":
      return 404;
    case "INVALID_PATH":
    case "UNSUPPORTED_FORMAT":
    case "NO_SUGGESTIONS":
      return 400;
    case "FILE_TOO_LARGE":
      return 413;
    case "EBUSY":
    case "EPERM":
      return 423;
    case "EACCES":
      return 403;
    case "BACKUP_FAILED":
      return 500;
    default:
      return 500;
  }
}

/** CORS + DNS rebinding protection middleware for /api/* routes */
export function apiMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isHostAllowed(req.headers.host as string | undefined)) {
    res.status(403).json({ error: "FORBIDDEN", message: "Host not allowed." });
    return;
  }
  const origin = req.headers.origin as string | undefined;
  res.header("Access-Control-Allow-Origin", isLocalhostOrigin(origin) ? origin! : "null");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}

/** Map a Node/custom error code to a JSON-body error label. */
function errorCodeToLabel(code: string): string {
  switch (code) {
    case "ENOENT":
    case "FILE_NOT_FOUND":
    case "NO_DOCUMENT":
      return "NOT_FOUND";
    case "INVALID_PATH":
      return "INVALID_PATH";
    case "UNSUPPORTED_FORMAT":
    case "NO_SUGGESTIONS":
      return "BAD_REQUEST";
    case "FILE_TOO_LARGE":
      return "FILE_TOO_LARGE";
    case "EBUSY":
    case "EPERM":
      return "FILE_LOCKED";
    case "EACCES":
      return "PERMISSION_DENIED";
    case "BACKUP_FAILED":
      return "INTERNAL";
    default:
      return "INTERNAL";
  }
}

/** Map error codes from file-opener to HTTP responses */
function sendApiError(res: Response, err: unknown): void {
  const e = err as NodeJS.ErrnoException;
  const code = e.code ?? "";
  const status = errorCodeToHttpStatus(code);
  const label = errorCodeToLabel(code);
  const msg =
    label === "FILE_LOCKED" ? "File is locked by another program." : (e.message ?? String(err));
  if (status === 500) console.error("[Tandem] Unhandled API error:", err);
  res.status(status).json({ error: label, message: msg });
}

/** SSE endpoint for streaming notifications to the browser. */
function notifyStreamHandler(req: Request, res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(": connected\n\n");

  function cleanup(): void {
    clearInterval(keepalive);
    unsubscribe();
  }

  const unsubscribe = subscribeNotifications((notification: TandemNotification) => {
    try {
      res.write(`data: ${JSON.stringify(notification)}\n\n`);
    } catch (err) {
      console.error(
        "[NotifyStream] Write failed, cleaning up:",
        err instanceof Error ? err.message : err,
      );
      cleanup();
    }
  });

  const keepalive = setInterval(() => {
    try {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    } catch (err) {
      console.error(
        "[NotifyStream] Keepalive write failed, cleaning up:",
        err instanceof Error ? err.message : err,
      );
      cleanup();
    }
  }, CHANNEL_SSE_KEEPALIVE_MS);

  req.on("close", () => {
    cleanup();
    console.error("[NotifyStream] Client disconnected from /api/notify-stream");
  });

  console.error("[NotifyStream] Client connected to /api/notify-stream");
}

/** Register /api/open, /api/upload, and /api/notify-stream routes on the Express app. */
export function registerApiRoutes(app: Express, largeBody: Handler): void {
  // SSE notification stream for browser toasts
  app.get("/api/notify-stream", apiMiddleware, notifyStreamHandler);
  app.options("/api/open", apiMiddleware);
  app.post("/api/open", apiMiddleware, largeBody, async (req: Request, res: Response) => {
    const { filePath, force } = (req.body ?? {}) as Record<string, unknown>;
    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "filePath is required" });
      return;
    }
    try {
      const result = await openFileByPath(filePath, { force: force === true });
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  });

  app.options("/api/close", apiMiddleware);
  app.post("/api/close", apiMiddleware, largeBody, async (req: Request, res: Response) => {
    const { documentId } = (req.body ?? {}) as Record<string, unknown>;
    if (!documentId || typeof documentId !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "documentId is required" });
      return;
    }
    try {
      const result = await closeDocumentById(documentId);
      if (!result.success) {
        res.status(404).json({ error: "NOT_FOUND", message: result.error });
        return;
      }
      res.json({
        data: { closedPath: result.closedPath, activeDocumentId: result.activeDocumentId },
      });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  });

  app.options("/api/save", apiMiddleware);
  app.post("/api/save", apiMiddleware, largeBody, async (req: Request, res: Response) => {
    const { documentId } = (req.body ?? {}) as Record<string, unknown>;
    if (documentId !== undefined && typeof documentId !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
      return;
    }
    const targetId = (documentId as string | undefined) ?? getActiveDocId();
    if (!targetId) {
      res.status(404).json({ error: "NOT_FOUND", message: "No document to save." });
      return;
    }
    try {
      const result = await saveDocumentToDisk(targetId, "manual");
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  });

  app.options("/api/upload", apiMiddleware);
  app.post("/api/upload", apiMiddleware, largeBody, async (req: Request, res: Response) => {
    const { fileName, content } = (req.body ?? {}) as Record<string, unknown>;
    if (!fileName || typeof fileName !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "fileName is required" });
      return;
    }
    if (content === undefined || content === null) {
      res.status(400).json({ error: "BAD_REQUEST", message: "content is required" });
      return;
    }
    if (typeof content !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "content must be a base64 string" });
      return;
    }
    try {
      const format = detectFormat(fileName);
      const decoded = format === "docx" ? Buffer.from(content, "base64") : String(content);
      const result = await openFileFromContent(fileName, decoded);
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  });

  app.options("/api/convert", apiMiddleware);
  app.post("/api/convert", apiMiddleware, largeBody, async (req: Request, res: Response) => {
    const { documentId, outputPath } = (req.body ?? {}) as Record<string, unknown>;
    if (documentId !== undefined && typeof documentId !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
      return;
    }
    if (outputPath !== undefined && typeof outputPath !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "outputPath must be a string" });
      return;
    }

    try {
      const result = await convertToMarkdown(
        documentId as string | undefined,
        outputPath as string | undefined,
      );
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  });

  app.get("/api/mode", apiMiddleware, (_req: Request, res: Response) => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    res.json({ mode });
  });

  app.options("/api/apply-changes", apiMiddleware);
  app.post("/api/apply-changes", apiMiddleware, largeBody, async (req: Request, res: Response) => {
    const { documentId, author, backupPath } = (req.body ?? {}) as Record<string, unknown>;
    if (documentId !== undefined && typeof documentId !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
      return;
    }
    if (author !== undefined && typeof author !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "author must be a string" });
      return;
    }
    if (backupPath !== undefined && typeof backupPath !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "backupPath must be a string" });
      return;
    }

    try {
      const result = await applyChangesCore(
        documentId as string | undefined,
        author as string | undefined,
        backupPath as string | undefined,
      );
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  });

  app.options("/api/setup", apiMiddleware);
  app.post("/api/setup", apiMiddleware, largeBody, async (req: Request, res: Response) => {
    try {
      const result = await runSetupHandler((req.body ?? {}) as Record<string, unknown>);
      res.status(result.status).json(result.body);
    } catch (err: unknown) {
      console.error("[Tandem] Setup handler threw:", err);
      res.status(500).json({
        error: "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Annotation reply: browser user posts a reply to an annotation thread
  app.options("/api/annotation-reply", apiMiddleware);
  app.post("/api/annotation-reply", apiMiddleware, largeBody, (req: Request, res: Response) => {
    const { annotationId, text, documentId } = (req.body ?? {}) as Record<string, unknown>;
    if (!annotationId || typeof annotationId !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "annotationId is required" });
      return;
    }
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "text is required" });
      return;
    }

    const doc = getCurrentDoc(typeof documentId === "string" ? documentId : undefined);
    if (!doc) {
      res.status(404).json({ error: "NOT_FOUND", message: "No document open" });
      return;
    }
    const ydoc = getOrCreateDocument(doc.docName);
    const annotationsMap = ydoc.getMap(Y_MAP_ANNOTATIONS);

    // No origin tag — allows event emission so Claude sees user replies
    const result = addReplyToAnnotation(ydoc, annotationsMap, annotationId, text, "user");
    if (!result.ok) {
      const status = result.code === "ANNOTATION_RESOLVED" ? 409 : 404;
      res.status(status).json({ error: result.code, message: result.error });
      return;
    }
    res.json({ data: { replyId: result.replyId, annotationId } });
  });
}
