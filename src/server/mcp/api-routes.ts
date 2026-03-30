import type { Express, Request, Response, NextFunction } from "express";

import { detectFormat } from "./document-model.js";
import { openFileByPath, openFileFromContent } from "./file-opener.js";

/** Express middleware/handler function type (Express 5 compatible). */
export type Handler = (req: Request, res: Response, next: NextFunction) => void;

/** Check if a Host header value is allowed (localhost only). Exported for testing. */
export function isHostAllowed(host: string | undefined): boolean {
  const reqHost = (host ?? "").split(":")[0];
  return reqHost === "localhost" || reqHost === "127.0.0.1";
}

/** Check if an Origin header is a localhost URL. Exported for testing. */
export const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
export function isLocalhostOrigin(origin: string | undefined): boolean {
  return LOCALHOST_ORIGIN_RE.test(origin ?? "");
}

/** Map error code to HTTP status. Exported for testing. */
export function errorCodeToHttpStatus(code: string | undefined): number {
  switch (code) {
    case "ENOENT":
    case "FILE_NOT_FOUND":
      return 404;
    case "INVALID_PATH":
    case "UNSUPPORTED_FORMAT":
      return 400;
    case "FILE_TOO_LARGE":
      return 413;
    case "EBUSY":
    case "EPERM":
      return 423;
    case "EACCES":
      return 403;
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
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
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
      return "FILE_NOT_FOUND";
    case "INVALID_PATH":
      return "INVALID_PATH";
    case "UNSUPPORTED_FORMAT":
      return "UNSUPPORTED_FORMAT";
    case "FILE_TOO_LARGE":
      return "FILE_TOO_LARGE";
    case "EBUSY":
    case "EPERM":
      return "FILE_LOCKED";
    case "EACCES":
      return "PERMISSION_DENIED";
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

/** Register /api/open and /api/upload routes on the Express app. */
export function registerApiRoutes(app: Express, largeBody: Handler): void {
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
}
