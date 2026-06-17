import type { Express, NextFunction, Request, Response } from "express";

import {
  API_ANNOTATION_REPLY,
  API_APPLY_CHANGES,
  API_BACKUPS,
  API_BACKUPS_RESTORE,
  API_CLOSE,
  API_CONVERT,
  API_DIAGNOSTICS,
  API_DOCUMENT_RAW,
  API_DOCUMENT_RELOAD,
  API_DOCX_CONFLICT_RESOLVE,
  API_INFO,
  API_MODE,
  API_NOTIFY_STREAM,
  API_OPEN,
  API_REMOVE_ANNOTATION,
  API_RENAME,
  API_ROTATE_TOKEN,
  API_SAVE,
  API_SCRATCHPAD,
  API_SESSIONS,
  API_SESSIONS_CLEAR,
  API_SESSIONS_DELETE,
  API_SHUTDOWN,
  API_STORE_RECLAIM_LOCK,
  API_UPLOAD,
} from "../../shared/api-paths.js";
import { TAURI_HOSTNAME, TAURI_LINUX_ORIGIN } from "../../shared/constants.js";
import type { Handler } from "./routes/_shared.js";
import { handleAnnotationReply } from "./routes/annotation-reply.js";
import { handleApplyChanges } from "./routes/apply-changes.js";
import { handleListBackups, handleRestoreBackup } from "./routes/backups.js";
import { handleClose } from "./routes/close.js";
import { handleConvert } from "./routes/convert.js";
import { makeDiagnosticsHandler } from "./routes/diagnostics.js";
import { handleGetDocumentRaw } from "./routes/document-raw.js";
import { handleReloadFromMarkdown } from "./routes/document-reload.js";
import { handleResolveDocxConflict } from "./routes/docx-conflict.js";
import { makeInfoHandler } from "./routes/info.js";
import { handleMode } from "./routes/mode.js";
import { handleNotifyStream } from "./routes/notify-stream.js";
import { handleOpen } from "./routes/open.js";
import { handleRemoveAnnotation } from "./routes/remove-annotation.js";
import { handleRename } from "./routes/rename.js";
import { makeRotateTokenHandler } from "./routes/rotate-token.js";
import { handleSave } from "./routes/save.js";
import { handleScratchpad } from "./routes/scratchpad.js";
import { handleClearSessions, handleDeleteSession, handleListSessions } from "./routes/sessions.js";
import { makeShutdownHandler, type ShutdownRouteDeps } from "./routes/shutdown.js";
import { handleStoreReclaimLock } from "./routes/store-reclaim.js";
import { handleUpload } from "./routes/upload.js";

export type { Handler } from "./routes/_shared.js";
// Re-export shared utilities that tests and other modules import from here
export { errorCodeToHttpStatus, isValidNodeBinary } from "./routes/_shared.js";

/**
 * Check if a Host header value is allowed (127.0.0.1 + tauri.localhost + optional extra hosts).
 *
 * Narrowed in #477 PR 2: the `localhost` hostname is no longer accepted on its own.
 * Tauri sends `Host: tauri.localhost`; the sidecar health checks use `127.0.0.1`.
 * Exported for testing.
 *
 * @param host - The Host header value (may include port).
 * @param extraHosts - Additional hosts to allow (e.g. a LAN IP when
 *   TANDEM_BIND_HOST is non-loopback). Always empty for loopback binds.
 */
export function isHostAllowed(host: string | undefined, extraHosts: string[] = []): boolean {
  const reqHost = (host ?? "").split(":")[0];
  if (reqHost === "127.0.0.1" || reqHost === TAURI_HOSTNAME) {
    return true;
  }
  return extraHosts.includes(reqHost);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if an Origin header is an allowed local URL. Exported for testing.
 *
 * Narrowed in #477 PR 2: only `127.0.0.1` and `tauri.localhost` are accepted; the
 * bare `localhost` hostname is rejected to align with the browser-distribution
 * deprecation and remove a DNS-resolution attack surface.
 */
export const LOCALHOST_ORIGIN_RE = new RegExp(
  `^https?://(127\\.0\\.0\\.1|${escapeRegExp(TAURI_HOSTNAME)})(:\\d+)?$`,
);
export function isLocalhostOrigin(origin: string | undefined): boolean {
  // The Linux Tauri WebView origin is the custom scheme `tauri://localhost`
  // (Windows uses `http://tauri.localhost`, matched by the regex above). It is
  // unforgeable by remote content, so an exact-string match is the precise
  // Linux analog — never a `tauri://*` wildcard.
  return origin === TAURI_LINUX_ORIGIN || LOCALHOST_ORIGIN_RE.test(origin ?? "");
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
    // DELETE added in #477 PR 3c-i for /api/integrations/secrets/:ref — Tauri's
    // tauri.localhost origin sends preflight for cross-origin requests, and
    // omitting DELETE here silently breaks secret deletion.
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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
 * @param diagnosticsHandlerDeps - Dependencies for GET /api/diagnostics (live ports,
 *   version, transport).
 * @param shutdownDeps - Graceful-shutdown wiring for POST /api/shutdown (#1088).
 *   Provided by the entry point in HTTP mode; when omitted (tests), the route
 *   is not registered and callers get a 404.
 */
export function registerApiRoutes(
  app: Express,
  largeBody: Handler,
  // Formerly threaded into the (now-removed) /api/setup handler; auth-token
  // wiring for rotate-token flows through setCurrentToken/getCurrentToken.
  // Kept positionally so the caller signature is unchanged (#477 PR 3c-ii-c).
  _token: string | undefined,
  mw: Handler,
  setCurrentToken: (t: string) => void,
  getCurrentToken: () => string | null,
  infoHandlerDeps: Parameters<typeof makeInfoHandler>[0],
  diagnosticsHandlerDeps: Parameters<typeof makeDiagnosticsHandler>[0],
  shutdownDeps?: ShutdownRouteDeps,
): void {
  // App metadata endpoint — consumed by the client's About panel
  app.get(API_INFO, mw, makeInfoHandler(infoHandlerDeps));

  // Embedded doctor report for the About panel's "Copy diagnostics" button.
  // The handler additionally gates on loopback (the report embeds local paths).
  app.get(API_DIAGNOSTICS, mw, makeDiagnosticsHandler(diagnosticsHandlerDeps));

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

  // Rename is gated on origin allowlist + loopback inside the handler (#1121 F6).
  app.options(API_RENAME, mw);
  app.post(API_RENAME, mw, largeBody, handleRename);

  app.options(API_UPLOAD, mw);
  app.post(API_UPLOAD, mw, largeBody, handleUpload);

  app.options(API_SCRATCHPAD, mw);
  app.post(API_SCRATCHPAD, mw, handleScratchpad);

  app.options(API_CONVERT, mw);
  app.post(API_CONVERT, mw, largeBody, handleConvert);

  app.options(API_APPLY_CHANGES, mw);
  app.post(API_APPLY_CHANGES, mw, largeBody, handleApplyChanges);

  // Raw-markdown source view/edit (#1021). GET is loopback-only (full doc
  // content must not be disclosed to LAN peers, #1121 F5); POST is gated on
  // origin allowlist + loopback inside the handler (#1121 F6).
  app.get(API_DOCUMENT_RAW, mw, handleGetDocumentRaw);
  app.options(API_DOCUMENT_RELOAD, mw);
  app.post(API_DOCUMENT_RELOAD, mw, largeBody, handleReloadFromMarkdown);

  // Pre-overwrite document backups (#1086). GET strips absolute filePath to
  // basename for non-loopback callers (#1121 F5); POST is gated on origin
  // allowlist + loopback inside the handler (#1121 F6).
  app.get(API_BACKUPS, mw, handleListBackups);
  app.options(API_BACKUPS_RESTORE, mw);
  app.post(API_BACKUPS_RESTORE, mw, largeBody, handleRestoreBackup);

  // .docx external-conflict resolution (#1069). Gated on origin allowlist +
  // loopback inside the handler (#1121 F6).
  app.options(API_DOCX_CONFLICT_RESOLVE, mw);
  app.post(API_DOCX_CONFLICT_RESOLVE, mw, largeBody, handleResolveDocxConflict);

  // Annotation reply: browser user posts a reply to an annotation thread
  app.options(API_ANNOTATION_REPLY, mw);
  app.post(API_ANNOTATION_REPLY, mw, largeBody, handleAnnotationReply);

  app.options(API_REMOVE_ANNOTATION, mw);
  app.post(API_REMOVE_ANNOTATION, mw, largeBody, handleRemoveAnnotation);

  // Stale store.lock reclaim (#1077). Mutating: the handler gates on origin
  // allowlist + loopback before touching the lockfile (same posture as the
  // session-management mutations).
  app.options(API_STORE_RECLAIM_LOCK, mw);
  app.post(API_STORE_RECLAIM_LOCK, mw, handleStoreReclaimLock);

  // Persisted-session management UI (#103): list (strips filePath to basename for
  // non-loopback callers, #1121 F5); mutating routes gate on origin + loopback.
  app.get(API_SESSIONS, mw, handleListSessions);

  app.options(API_SESSIONS_DELETE, mw);
  app.post(API_SESSIONS_DELETE, mw, largeBody, handleDeleteSession);

  app.options(API_SESSIONS_CLEAR, mw);
  app.post(API_SESSIONS_CLEAR, mw, largeBody, handleClearSessions);

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

  // Graceful shutdown (#1088): the Tauri shell POSTs here before falling back
  // to a hard kill, so the Node shutdown sequence (dirty-doc flush + session
  // save) runs on restart/update. No body parser — the route takes no request
  // body. Gating (unconditional loopback + Origin allowlist when present)
  // lives inside the handler.
  if (shutdownDeps) {
    app.options(API_SHUTDOWN, mw);
    app.post(API_SHUTDOWN, mw, makeShutdownHandler(shutdownDeps));
  }
}
