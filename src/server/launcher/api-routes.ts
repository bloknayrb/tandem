/**
 * HTTP routes for the Claude Code auto-launcher (#477 PR 4b).
 *
 * Five endpoints, all under `/api/launcher/*`:
 *   - `GET /status` — read-only; loopback returns full struct (with
 *     `sessionId` redacted to "<set>"), non-loopback returns the minimal
 *     `{ available, running }` shape (mirrors `/health`'s redaction pattern).
 *   - `GET /nonce` — issues a one-shot single-use nonce that mutating
 *     routes require. Rotates on consumption (success or failure).
 *   - `POST /relaunch` — body `{ cwd, nonce }`. Origin + loopback gates,
 *     `resolveRouteCwd` validates cwd is under `os.homedir()`. 429 on
 *     overlapping operations.
 *   - `POST /start-fresh` — body `{ cwd?, nonce }`. Drops persisted
 *     session, respawns with a new session id.
 *   - `POST /working-directory` — body `{ workingDirectory: string | null }`.
 *     Narrow write to the first claude-code integration's
 *     `workingDirectory` field. Bypasses the integrations apply-nonce
 *     rotation that a full-array POST would trigger.
 *
 * The supervisor singleton is bridged via `() => Supervisor | null`. Routes
 * return 503 + `NOT_AVAILABLE` when the getter returns null (stdio mode,
 * disabled-by-env, or no claude-code integration).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Express, Request, Response } from "express";

import {
  API_LAUNCHER_NONCE,
  API_LAUNCHER_RELAUNCH,
  API_LAUNCHER_START_FRESH,
  API_LAUNCHER_STATUS,
  API_LAUNCHER_WORKING_DIRECTORY,
} from "../../shared/api-paths.js";
import type { ClaudeCodeIntegration } from "../../shared/integrations/contract.js";
import {
  LAUNCHER_CWD_MAX_LENGTH,
  LAUNCHER_ERROR_IN_PROGRESS,
  LAUNCHER_ERROR_INVALID_BODY,
  LAUNCHER_ERROR_INVALID_NONCE,
  LAUNCHER_ERROR_NO_INTEGRATION,
  LAUNCHER_ERROR_NOT_AVAILABLE,
  LAUNCHER_ERROR_PATH_REJECTED,
  type LauncherStatus,
  type LauncherUnavailableReason,
  type SkillRefreshError,
} from "../../shared/launcher/contract.js";
import { isLoopback } from "../auth/middleware.js";
import { assertLoopbackForMutation, assertOriginAllowlisted } from "../integrations/api-routes.js";
import type { IntegrationConfig } from "../integrations/schema.js";
import type { IntegrationsStore } from "../integrations/storage.js";
import type { Handler } from "../mcp/routes/_shared.js";
import { resolveRouteCwd, type Supervisor } from "./supervisor.js";

/**
 * Single-use nonce gate for mutating launcher routes.
 *
 * Each `GET /api/launcher/nonce` rotates the value (any in-flight nonce is
 * invalidated). Mutating routes consume the nonce — successful OR failed —
 * to prevent replay. This is defense-in-depth on top of the origin gate:
 * a malicious page on a loopback-resident dev tool that bypasses origin
 * checks still needs to read the nonce via a separate GET before it can
 * drive a destructive op.
 */
interface LauncherGateState {
  nonce: string;
}

function createGate(): LauncherGateState {
  return { nonce: randomBytes(32).toString("base64url") };
}

let gate: LauncherGateState | null = null;

function getGate(): LauncherGateState {
  if (gate === null) gate = createGate();
  return gate;
}

function rotateNonce(): void {
  gate = createGate();
}

/** Test-only nonce reset. Guarded on VITEST so production callers can't
 * reach this surface even via Express stack tricks. */
export function _resetLauncherGateForTests(): void {
  if (process.env.VITEST !== "true") {
    throw new Error("_resetLauncherGateForTests is test-only");
  }
  gate = createGate();
}

/**
 * Per-route in-flight flags. `relaunch` and `start-fresh` each have their own
 * because they're independently destructive — overlapping calls return 429
 * rather than queueing. The supervisor's `withLock` would queue them, but
 * the UX cost of two stop/spawn cycles back-to-back is worse than a clear
 * "already running" error.
 */
interface InflightState {
  relaunch: boolean;
  startFresh: boolean;
  workingDirectory: boolean;
}

const inflight: InflightState = {
  relaunch: false,
  startFresh: false,
  workingDirectory: false,
};

export function _resetInflightForTests(): void {
  if (process.env.VITEST !== "true") {
    throw new Error("_resetInflightForTests is test-only");
  }
  inflight.relaunch = false;
  inflight.startFresh = false;
  inflight.workingDirectory = false;
}

export interface LauncherRoutesDeps {
  /**
   * The supervisor singleton lives in `src/server/index.ts` and is only
   * created inside `Promise.all([startMcpServerHttp, startHocuspocus])`,
   * *after* `createMcpHttpServer()` returns. Static deps injection isn't
   * possible — the getter is the explicit "late-bound" handshake.
   * Returns `null` in stdio mode, when `TANDEM_DISABLE_LAUNCHER=1`, or
   * when `claude-code` integration is absent.
   */
  getSupervisor: () => Supervisor | null;
  /** Reason the supervisor is unavailable (stdio mode, disabled, no integration).
   * Surfaced via GET /status. */
  unavailableReason: () => LauncherUnavailableReason;
  /** Reads/writes the integrations file. Same store passed to integrations routes. */
  store: IntegrationsStore;
  /** Loopback-only side-channel for skill refresh failures. `null` when the
   * last refresh succeeded or the helper is not wired (test mode). */
  getSkillRefreshError?: () => SkillRefreshError | null;
  /** Test-only seam: hook fires inside try, immediately after `inflight.X = true`,
   * before the supervisor call. Used to hold an operation in-flight so concurrent
   * requests exercise the 429 gate. */
  relaunchHook?: () => Promise<void>;
  startFreshHook?: () => Promise<void>;
  workingDirHook?: () => Promise<void>;
}

export function registerLauncherRoutes(app: Express, mw: Handler, deps: LauncherRoutesDeps): void {
  app.options(API_LAUNCHER_STATUS, mw);
  app.get(API_LAUNCHER_STATUS, mw, makeStatusHandler(deps));

  app.options(API_LAUNCHER_NONCE, mw);
  app.get(API_LAUNCHER_NONCE, mw, makeNonceHandler());

  app.options(API_LAUNCHER_RELAUNCH, mw);
  app.post(API_LAUNCHER_RELAUNCH, mw, makeRelaunchHandler(deps));

  app.options(API_LAUNCHER_START_FRESH, mw);
  app.post(API_LAUNCHER_START_FRESH, mw, makeStartFreshHandler(deps));

  app.options(API_LAUNCHER_WORKING_DIRECTORY, mw);
  app.post(API_LAUNCHER_WORKING_DIRECTORY, mw, makeWorkingDirHandler(deps));
}

// --- Handlers -------------------------------------------------------------

function makeStatusHandler(deps: LauncherRoutesDeps): Handler {
  return (req: Request, res: Response) => {
    const sup = deps.getSupervisor();
    const loopback = isLoopback(req.socket.remoteAddress);
    if (sup === null) {
      const body: LauncherStatus = { available: false, reason: deps.unavailableReason() };
      res.json(body);
      return;
    }
    const skillRefresh = loopback ? (deps.getSkillRefreshError?.() ?? null) : undefined;
    let raw: ReturnType<Supervisor["status"]>;
    try {
      raw = sup.status();
    } catch {
      // sup.status() should never throw, but if it does we must not return a
      // generic 500 — the client maps that to "not active in this Tandem build"
      // which is wrong. Degrade to a structured `lastError: "status-check-failed"`.
      const body: LauncherStatus = loopback
        ? { available: true, running: false, lastError: "status-check-failed", skillRefresh }
        : { available: true, running: false };
      res.json(body);
      return;
    }
    if (raw.running) {
      if (!loopback) {
        res.json({ available: true, running: true });
        return;
      }
      const body: LauncherStatus = {
        available: true,
        running: true,
        reaperPid: raw.reaperPid,
        cwd: raw.cwd,
        sessionId: "<set>",
        resuming: raw.resuming,
        skillRefresh,
      };
      res.json(body);
      return;
    }
    const body: LauncherStatus = loopback
      ? { available: true, running: false, lastError: raw.lastError, skillRefresh }
      : { available: true, running: false };
    res.json(body);
  };
}

function makeNonceHandler(): Handler {
  return (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_LAUNCHER_NONCE)) return;
    if (assertLoopbackForMutation(req, res)) return;
    rotateNonce();
    res.json({ nonce: getGate().nonce });
  };
}

/** Constant-time nonce check + rotate on consumption (success or failure). */
function consumeNonce(received: unknown, res: Response): boolean {
  if (typeof received !== "string" || received.length === 0) {
    rotateNonce();
    res.status(403).json({
      error: "FORBIDDEN",
      code: LAUNCHER_ERROR_INVALID_NONCE,
      message: "nonce missing",
    });
    return false;
  }
  const expected = Buffer.from(getGate().nonce);
  const got = Buffer.from(received);
  const ok = got.length === expected.length && timingSafeEqual(got, expected);
  rotateNonce();
  if (!ok) {
    res.status(403).json({
      error: "FORBIDDEN",
      code: LAUNCHER_ERROR_INVALID_NONCE,
      message: "nonce mismatch (single-use; fetch a fresh one from GET /api/launcher/nonce)",
    });
  }
  return ok;
}

function sendBadRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ error: "BAD_REQUEST", code, message });
}

function sendInProgress(res: Response, message: string): void {
  res.status(429).json({
    error: "TOO_MANY_REQUESTS",
    code: LAUNCHER_ERROR_IN_PROGRESS,
    message,
  });
}

/** Validate a string cwd field: type, length cap, and home-confined resolution.
 * `fieldName` parameterizes the error messages — "cwd" for request bodies,
 * "workingDirectory" for the POST /working-directory route. */
function validateCwdString(
  raw: unknown,
  res: Response,
  fieldName: "cwd" | "workingDirectory",
): string | null {
  if (typeof raw !== "string") {
    sendBadRequest(res, LAUNCHER_ERROR_INVALID_BODY, `${fieldName} must be a string`);
    return null;
  }
  if (raw.length > LAUNCHER_CWD_MAX_LENGTH) {
    sendBadRequest(
      res,
      LAUNCHER_ERROR_INVALID_BODY,
      `${fieldName} exceeds ${LAUNCHER_CWD_MAX_LENGTH} chars`,
    );
    return null;
  }
  const resolved = resolveRouteCwd(raw);
  if (resolved === null) {
    sendBadRequest(
      res,
      LAUNCHER_ERROR_PATH_REJECTED,
      `${fieldName} must be an absolute path inside the user's home directory`,
    );
    return null;
  }
  return resolved;
}

/** Parse + validate that the request body is a non-null JSON object.
 * Returns the body cast to a loose record on success; sends 400 and returns
 * null on failure. */
function parseJsonObjectBody(req: Request, res: Response): Record<string, unknown> | null {
  const body = req.body as unknown;
  if (!body || typeof body !== "object") {
    sendBadRequest(res, LAUNCHER_ERROR_INVALID_BODY, "request body must be a JSON object");
    return null;
  }
  return body as Record<string, unknown>;
}

function requireSupervisor(deps: LauncherRoutesDeps, res: Response): Supervisor | null {
  const sup = deps.getSupervisor();
  if (sup === null) {
    res.status(503).json({
      error: "SERVICE_UNAVAILABLE",
      code: LAUNCHER_ERROR_NOT_AVAILABLE,
      reason: deps.unavailableReason(),
      message: "Auto-launcher is not available in this runtime",
    });
    return null;
  }
  return sup;
}

function makeRelaunchHandler(deps: LauncherRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_LAUNCHER_RELAUNCH)) return;
    if (assertLoopbackForMutation(req, res)) return;
    const body = parseJsonObjectBody(req, res);
    if (body === null) return;
    // Nonce consumption MUST precede cwd validation — the nonce rotates on
    // every mutating attempt (good or bad) to prevent replay.
    if (!consumeNonce(body.nonce, res)) return;
    const cwd = validateCwdString(body.cwd, res, "cwd");
    if (cwd === null) return;
    const sup = requireSupervisor(deps, res);
    if (sup === null) return;
    // relaunch and startFresh are mutually exclusive — they're two flavors
    // of the same destructive stop+respawn operation.
    if (inflight.relaunch || inflight.startFresh) {
      sendInProgress(res, "another relaunch/start-fresh is in progress");
      return;
    }
    inflight.relaunch = true;
    try {
      if (deps.relaunchHook) await deps.relaunchHook();
      await sup.relaunch(cwd);
      res.json({ ok: true, cwd });
    } catch (err) {
      sendUnexpected(res, err, "relaunch failed");
    } finally {
      inflight.relaunch = false;
    }
  };
}

function makeStartFreshHandler(deps: LauncherRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_LAUNCHER_START_FRESH)) return;
    if (assertLoopbackForMutation(req, res)) return;
    const body = parseJsonObjectBody(req, res);
    if (body === null) return;
    if (!consumeNonce(body.nonce, res)) return;
    let cwd: string | undefined;
    if (body.cwd !== undefined) {
      const resolved = validateCwdString(body.cwd, res, "cwd");
      if (resolved === null) return;
      cwd = resolved;
    }
    const sup = requireSupervisor(deps, res);
    if (sup === null) return;
    if (inflight.relaunch || inflight.startFresh) {
      sendInProgress(res, "another relaunch/start-fresh is in progress");
      return;
    }
    inflight.startFresh = true;
    try {
      if (deps.startFreshHook) await deps.startFreshHook();
      await sup.startFresh(cwd);
      res.json({ ok: true, cwd: cwd ?? null });
    } catch (err) {
      sendUnexpected(res, err, "start-fresh failed");
    } finally {
      inflight.startFresh = false;
    }
  };
}

function makeWorkingDirHandler(deps: LauncherRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_LAUNCHER_WORKING_DIRECTORY)) return;
    if (assertLoopbackForMutation(req, res)) return;
    const body = parseJsonObjectBody(req, res);
    if (body === null) return;
    // workingDirectory is `string | null`: null means "clear (use default)";
    // string means "validate + persist". Anything else is rejected.
    const wd = body.workingDirectory;
    let validated: string | null;
    if (wd === null) {
      validated = null;
    } else if (typeof wd === "string") {
      const resolved = validateCwdString(wd, res, "workingDirectory");
      if (resolved === null) return;
      validated = resolved;
    } else {
      sendBadRequest(res, LAUNCHER_ERROR_INVALID_BODY, "workingDirectory must be a string or null");
      return;
    }
    // workingDirectory has its OWN inflight flag — it doesn't block relaunch
    // or start-fresh because it only rewrites integrations.json (not the
    // running supervisor).
    if (inflight.workingDirectory) {
      sendInProgress(res, "another working-directory update is in progress");
      return;
    }
    inflight.workingDirectory = true;
    try {
      if (deps.workingDirHook) await deps.workingDirHook();
      const file = await deps.store.read();
      const idx = file.integrations.findIndex(
        (i): i is ClaudeCodeIntegration => i.kind === "claude-code",
      );
      if (idx === -1) {
        res.status(404).json({
          error: "NOT_FOUND",
          code: LAUNCHER_ERROR_NO_INTEGRATION,
          message: "no claude-code integration in integrations.json",
        });
        return;
      }
      const current = file.integrations[idx] as ClaudeCodeIntegration;
      const updated: ClaudeCodeIntegration = { ...current };
      if (validated === null) {
        delete (updated as { workingDirectory?: string }).workingDirectory;
      } else {
        updated.workingDirectory = validated;
      }
      const newFile = {
        ...file,
        integrations: file.integrations.map(
          (entry, i): IntegrationConfig => (i === idx ? updated : entry),
        ),
      };
      await deps.store.write(newFile);
      res.json({ ok: true, workingDirectory: validated });
    } catch (err) {
      sendUnexpected(res, err, "failed to write workingDirectory");
    } finally {
      inflight.workingDirectory = false;
    }
  };
}

function sendUnexpected(res: Response, err: unknown, label: string): void {
  console.error(`[Launcher routes] ${label}:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: "INTERNAL_ERROR", code: "INTERNAL_ERROR", message: label });
}
