import type { Express, NextFunction, Request, Response } from "express";

import { TAURI_HOSTNAME } from "../../shared/constants.js";
import type { Handler } from "./routes/_shared.js";
import { handleAnnotationReply } from "./routes/annotation-reply.js";
import { handleApplyChanges } from "./routes/apply-changes.js";
import { handleClose } from "./routes/close.js";
import { handleConvert } from "./routes/convert.js";
import { handleMode } from "./routes/mode.js";
import { handleNotifyStream } from "./routes/notify-stream.js";
import { handleOpen } from "./routes/open.js";
import { handleRemoveAnnotation } from "./routes/remove-annotation.js";
import { makeRotateTokenHandler } from "./routes/rotate-token.js";
import { handleSave } from "./routes/save.js";
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
 */
export function registerApiRoutes(
  app: Express,
  largeBody: Handler,
  token: string | undefined,
  mw: Handler,
  setCurrentToken: (t: string) => void,
  getCurrentToken: () => string | null,
): void {
  // SSE notification stream for browser toasts
  app.get("/api/notify-stream", mw, handleNotifyStream);

  // NOTE: /api/mode is GET-only — no OPTIONS registration
  app.get("/api/mode", mw, handleMode);

  app.options("/api/open", mw);
  app.post("/api/open", mw, largeBody, handleOpen);

  app.options("/api/close", mw);
  app.post("/api/close", mw, largeBody, handleClose);

  app.options("/api/save", mw);
  app.post("/api/save", mw, largeBody, handleSave);

  app.options("/api/upload", mw);
  app.post("/api/upload", mw, largeBody, handleUpload);

  app.options("/api/convert", mw);
  app.post("/api/convert", mw, largeBody, handleConvert);

  app.options("/api/apply-changes", mw);
  app.post("/api/apply-changes", mw, largeBody, handleApplyChanges);

  app.options("/api/setup", mw);
  app.post("/api/setup", mw, largeBody, makeSetupHandler({ token }));

  // Annotation reply: browser user posts a reply to an annotation thread
  app.options("/api/annotation-reply", mw);
  app.post("/api/annotation-reply", mw, largeBody, handleAnnotationReply);

  app.options("/api/remove-annotation", mw);
  app.post("/api/remove-annotation", mw, largeBody, handleRemoveAnnotation);

  // Token rotation: CLI calls this to activate the 60-second grace window and swap the
  // in-memory current token to the NEW token that was already written to disk.
  // Auth is handled by app.use("/api", authMiddleware) — request must carry Bearer <OLD token>.
  // previousToken is NOT accepted from the request body — the handler captures it from
  // getCurrentToken() to prevent callers from injecting arbitrary strings into the grace slot.
  app.options("/api/rotate-token", mw);
  app.post(
    "/api/rotate-token",
    mw,
    largeBody,
    makeRotateTokenHandler({ setCurrentToken, getCurrentToken }),
  );
}
