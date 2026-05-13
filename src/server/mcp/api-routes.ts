import type { Express, NextFunction, Request, Response } from "express";

import {
  API_ANNOTATION_REPLY,
  API_APPLY_CHANGES,
  API_CLOSE,
  API_CONVERT,
  API_INFO,
  API_MODE,
  API_NOTIFY_STREAM,
  API_OPEN,
  API_REMOVE_ANNOTATION,
  API_ROTATE_TOKEN,
  API_SAVE,
  API_SCRATCHPAD,
  API_SETUP,
  API_UPLOAD,
} from "../../shared/api-paths.js";
import { TAURI_HOSTNAME } from "../../shared/constants.js";
import type { Handler } from "./routes/_shared.js";
import { handleAnnotationReply } from "./routes/annotation-reply.js";
import { handleApplyChanges } from "./routes/apply-changes.js";
import { handleClose } from "./routes/close.js";
import { handleConvert } from "./routes/convert.js";
import { makeInfoHandler } from "./routes/info.js";
import { handleMode } from "./routes/mode.js";
import { handleNotifyStream } from "./routes/notify-stream.js";
import { handleOpen } from "./routes/open.js";
import { handleRemoveAnnotation } from "./routes/remove-annotation.js";
import { makeRotateTokenHandler } from "./routes/rotate-token.js";
import { handleSave } from "./routes/save.js";
import { handleScratchpad } from "./routes/scratchpad.js";
import { makeSetupHandler } from "./routes/setup.js";
import { handleUpload } from "./routes/upload.js";

export type { Handler } from "./routes/_shared.js";
// Re-export shared utilities that tests and other modules import from here
export { errorCodeToHttpStatus, isValidChannelPath, isValidNodeBinary } from "./routes/_shared.js";
export { runSetupHandler } from "./routes/setup.js";

/**
 * Check if a Host header value is allowed (localhost + optional extra hosts).
 * Exported for testing.
 *
 * @param host - The Host header value (may include port).
 * @param extraHosts - Additional hosts to allow (e.g. a LAN IP when
 *   TANDEM_BIND_HOST is non-loopback). Always empty for loopback binds.
 */
export function isHostAllowed(host: string | undefined, extraHosts: string[] = []): boolean {
  const reqHost = (host ?? "").split(":")[0];
  if (reqHost === "localhost" || reqHost === "127.0.0.1" || reqHost === TAURI_HOSTNAME) {
    return true;
  }
  return extraHosts.includes(reqHost);
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

/**
 * Create a CORS + DNS rebinding protection middleware for /api/* routes.
 *
 * @param extraHosts - Additional hosts to allow beyond localhost/127.0.0.1/tauri.localhost.
 *   Pass the resolved LAN IP when TANDEM_BIND_HOST is non-loopback so that
 *   browsers on the LAN (which send e.g. `Host: 192.168.1.50:3479`) are not
 *   blocked by the DNS-rebinding check.
 */
export function createApiMiddleware(extraHosts: string[] = []): Handler {
  return function apiMiddlewareFn(req: Request, res: Response, next: NextFunction): void {
    if (!isHostAllowed(req.headers.host as string | undefined, extraHosts)) {
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
  };
}

/** Default CORS + DNS rebinding protection middleware (loopback-only allowlist). */
export const apiMiddleware: Handler = createApiMiddleware();

/**
 * Register /api/* routes on the Express app.
 *
 * @param mw - The DNS-rebinding middleware to use. Pass `createApiMiddleware([lanIP])`
 *   when TANDEM_BIND_HOST is non-loopback so LAN Host headers are allowed.
 *   Defaults to the standard loopback-only `apiMiddleware`.
 * @param setCurrentToken - Required callback invoked by `POST /api/rotate-token` to
 *   update the in-memory current-token slot in the auth middleware after rotation.
 * @param getCurrentToken - Required callback that returns the current in-memory token
 *   before rotation; used to register the grace-window slot from a trusted source
 *   rather than from the request body.
 * @param infoHandlerDeps - Dependencies for GET /api/info (version, toolCount, etc.).
 */
export function registerApiRoutes(
  app: Express,
  largeBody: Handler,
  token: string | undefined,
  mw: Handler,
  setCurrentToken: (t: string) => void,
  getCurrentToken: () => string | null,
  infoHandlerDeps: Parameters<typeof makeInfoHandler>[0],
): void {
  // App metadata endpoint — consumed by the client's About panel
  app.get(API_INFO, mw, makeInfoHandler(infoHandlerDeps));

  // SSE notification stream for browser toasts
  app.get(API_NOTIFY_STREAM, mw, handleNotifyStream);

  // NOTE: /api/mode is GET-only — no OPTIONS registration
  app.get(API_MODE, mw, handleMode);

  app.options(API_OPEN, mw);
  app.post(API_OPEN, mw, largeBody, handleOpen);

  app.options(API_CLOSE, mw);
  app.post(API_CLOSE, mw, largeBody, handleClose);

  app.options(API_SAVE, mw);
  app.post(API_SAVE, mw, largeBody, handleSave);

  app.options(API_UPLOAD, mw);
  app.post(API_UPLOAD, mw, largeBody, handleUpload);

  app.options(API_SCRATCHPAD, mw);
  app.post(API_SCRATCHPAD, mw, handleScratchpad);

  app.options(API_CONVERT, mw);
  app.post(API_CONVERT, mw, largeBody, handleConvert);

  app.options(API_APPLY_CHANGES, mw);
  app.post(API_APPLY_CHANGES, mw, largeBody, handleApplyChanges);

  app.options(API_SETUP, mw);
  app.post(API_SETUP, mw, largeBody, makeSetupHandler({ token }));

  // Annotation reply: browser user posts a reply to an annotation thread
  app.options(API_ANNOTATION_REPLY, mw);
  app.post(API_ANNOTATION_REPLY, mw, largeBody, handleAnnotationReply);

  app.options(API_REMOVE_ANNOTATION, mw);
  app.post(API_REMOVE_ANNOTATION, mw, largeBody, handleRemoveAnnotation);

  // Token rotation: CLI calls this to activate the 60-second grace window and swap the
  // in-memory current token to the NEW token that was already written to disk.
  // Auth is handled by app.use("/api", authMiddleware) — request must carry Bearer <OLD token>.
  // previousToken is NOT accepted from the request body — the handler captures it from
  // getCurrentToken() to prevent callers from injecting arbitrary strings into the grace slot.
  app.options(API_ROTATE_TOKEN, mw);
  app.post(
    API_ROTATE_TOKEN,
    mw,
    largeBody,
    makeRotateTokenHandler({ setCurrentToken, getCurrentToken }),
  );
}
