/**
 * HTTP routes for the Claude Code auto-launcher (#477 PR 4b).
 *
 * Seven endpoints, all under `/api/launcher/*`:
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
 *   - `POST /start` — promote a `deferred-autostart` launcher (#1236).
 *   - `POST /cwd-preview` — body `{ cwd }`. Read-only drift verdict (#1282);
 *     loopback-only, no nonce. See `makeCwdPreviewHandler`.
 *
 * The supervisor singleton is bridged via `() => Supervisor | null`. The
 * MUTATING routes return 503 + `NOT_AVAILABLE` when the getter returns null
 * (stdio mode, disabled-by-env, or no claude-code integration). The two
 * read-only ones do not: `GET /status` answers `{ available: false }`, and
 * `POST /cwd-preview` answers `{ drifted: false }` — for both, "there is no
 * launcher" is a fact worth reporting rather than an error.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Express, Request, Response } from "express";

import {
  API_LAUNCHER_CWD_PREVIEW,
  API_LAUNCHER_NONCE,
  API_LAUNCHER_RELAUNCH,
  API_LAUNCHER_START,
  API_LAUNCHER_START_FRESH,
  API_LAUNCHER_STATUS,
  API_LAUNCHER_WORKING_DIRECTORY,
} from "../../shared/api-paths.js";
import type { ClaudeCodeIntegration } from "../../shared/integrations/contract.js";
import {
  isTransientlyUnavailable,
  LAUNCHER_CWD_MAX_LENGTH,
  LAUNCHER_ERROR_IN_PROGRESS,
  LAUNCHER_ERROR_INVALID_BODY,
  LAUNCHER_ERROR_INVALID_NONCE,
  LAUNCHER_ERROR_NO_INTEGRATION,
  LAUNCHER_ERROR_NOT_AVAILABLE,
  LAUNCHER_ERROR_PATH_REJECTED,
  LAUNCHER_ERROR_REAPER_NOT_FOUND,
  type LauncherCwdPreview,
  type LauncherStatus,
  type LauncherUnavailableReason,
  REAPER_NOT_FOUND_MARKER,
  type SkillRefreshError,
} from "../../shared/launcher/contract.js";
import { isLoopback } from "../auth/middleware.js";
import { assertLoopbackForMutation, assertOriginAllowlisted } from "../integrations/api-routes.js";
import type { IntegrationConfig } from "../integrations/schema.js";
import type { IntegrationsStore } from "../integrations/storage.js";
import type { Handler } from "../mcp/routes/_shared.js";
import { previewCwdDrift } from "./cwd-preview.js";
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
  /** #1236. Shares the relaunch/start-fresh exclusion group rather than
   * standing alone: a `start` racing a `relaunch` mid-stop is the double-spawn
   * case, and two supervisors means an orphaned reaper child. */
  start: boolean;
}

const inflight: InflightState = {
  relaunch: false,
  startFresh: false,
  workingDirectory: false,
  start: false,
};

/** True while any stop/spawn-shaped operation is running. */
function spawnOpInFlight(): boolean {
  return inflight.relaunch || inflight.startFresh || inflight.start;
}

export function _resetInflightForTests(): void {
  if (process.env.VITEST !== "true") {
    throw new Error("_resetInflightForTests is test-only");
  }
  inflight.relaunch = false;
  inflight.startFresh = false;
  inflight.workingDirectory = false;
  inflight.start = false;
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
  /** Create + start the supervisor from null. Idempotent and single-flighted in
   * `src/server/index.ts`. Only reachable via `POST /start` and only in the
   * `deferred-autostart` state (#1236). */
  startSupervisor: () => Promise<void>;
  /** Reads/writes the integrations file. Same store passed to integrations routes. */
  store: IntegrationsStore;
  /** Directories holding Tandem's own auto-opened documents, excluded from the
   * drift preview. Injected rather than imported: the paths are resolved in
   * `mcp/server.ts` (which registers these routes), and passing them keeps the
   * exclusion list testable without a real install layout. See
   * `CwdPreviewDeps.bundledDocDirs` for why the exclusion exists at all. */
  bundledDocDirs?: readonly string[];
  /** Loopback-only side-channel for skill refresh failures. `null` when the
   * last refresh succeeded or the helper is not wired (test mode). */
  getSkillRefreshError?: () => SkillRefreshError | null;
  /** Test-only seam: hook fires inside try, immediately after `inflight.X = true`,
   * before the supervisor call. Used to hold an operation in-flight so concurrent
   * requests exercise the 429 gate. */
  relaunchHook?: () => Promise<void>;
  startFreshHook?: () => Promise<void>;
  workingDirHook?: () => Promise<void>;
  /** Same seam for the preview route: holds a probe in-flight so concurrent
   * requests exercise the shed path. Fires INSIDE the counted region. */
  cwdPreviewHook?: () => Promise<void>;
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

  app.options(API_LAUNCHER_START, mw);
  app.post(API_LAUNCHER_START, mw, makeStartHandler(deps));

  app.options(API_LAUNCHER_WORKING_DIRECTORY, mw);
  app.post(API_LAUNCHER_WORKING_DIRECTORY, mw, makeWorkingDirHandler(deps));

  app.options(API_LAUNCHER_CWD_PREVIEW, mw);
  app.post(API_LAUNCHER_CWD_PREVIEW, mw, makeCwdPreviewHandler(deps));
}

// --- Handlers -------------------------------------------------------------

function makeStatusHandler(deps: LauncherRoutesDeps): Handler {
  return (req: Request, res: Response) => {
    const sup = deps.getSupervisor();
    const loopback = isLoopback(req.socket.remoteAddress);
    if (sup === null) {
      // `reason` is loopback-only. `deferred-autostart` in particular is a live
      // presence oracle — it says "this machine auto-booted at login and the
      // human hasn't opened the window yet." Omitting the field entirely
      // (rather than filtering that one value) also future-proofs the enum
      // against the next reason that turns out to leak something.
      const body: LauncherStatus = loopback
        ? { available: false, reason: deps.unavailableReason() }
        : { available: false };
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

/** The `LAUNCHER_NOT_AVAILABLE` 503 shape, emitted from two places
 * (`requireSupervisor` and the deferred-start route). One definition so the
 * `reason` field's disclosure posture is decided once rather than drifting
 * between them. */
function sendNotAvailable(res: Response, reason: LauncherUnavailableReason, message: string): void {
  res.status(503).json({
    error: "SERVICE_UNAVAILABLE",
    code: LAUNCHER_ERROR_NOT_AVAILABLE,
    reason,
    message,
  });
}

function sendInProgress(res: Response, message: string): void {
  res.status(429).json({
    error: "TOO_MANY_REQUESTS",
    code: LAUNCHER_ERROR_IN_PROGRESS,
    message,
  });
}

type CwdPrecheck = { ok: true; cwd: string } | { ok: false; reason: "not-a-string" | "too-long" };

/**
 * The I/O-free half of the cwd-field predicate: type, then length cap.
 *
 * Shared — not restated — by the mutating routes and the read-only preview, and
 * shared at exactly this seam because the two halves cannot be shared as one.
 * The mutating routes resolve the path synchronously; the preview runs at
 * tab-switch frequency and must resolve it asynchronously (`statSync` on a
 * disconnected mapped drive blocks the event loop). So the fs half necessarily
 * forks, and the pre-checks must not, or the preview would green-light a
 * 2000-character dirname that the relaunch it advertises then rejects. A
 * predicate that answers differently on the query path and the action path is
 * the defect #1282 was filed for; keeping this function the only home for the
 * cap means deleting it breaks the relaunch tests, not just the preview's.
 */
function precheckCwdField(raw: unknown): CwdPrecheck {
  if (typeof raw !== "string") return { ok: false, reason: "not-a-string" };
  if (raw.length > LAUNCHER_CWD_MAX_LENGTH) return { ok: false, reason: "too-long" };
  return { ok: true, cwd: raw };
}

/** Validate a string cwd field: type, length cap, and home-confined resolution.
 * The mutating half of the split above — `precheckCwdField` plus the synchronous
 * fs resolution. `fieldName` parameterizes the error messages — "cwd" for
 * request bodies, "workingDirectory" for the POST /working-directory route. */
function validateCwdString(
  raw: unknown,
  res: Response,
  fieldName: "cwd" | "workingDirectory",
): string | null {
  const pre = precheckCwdField(raw);
  if (!pre.ok) {
    const message =
      pre.reason === "not-a-string"
        ? `${fieldName} must be a string`
        : `${fieldName} exceeds ${LAUNCHER_CWD_MAX_LENGTH} chars`;
    sendBadRequest(res, LAUNCHER_ERROR_INVALID_BODY, message);
    return null;
  }
  const resolved = resolveRouteCwd(pre.cwd);
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
    sendNotAvailable(
      res,
      deps.unavailableReason(),
      "Auto-launcher is not available in this runtime",
    );
    return null;
  }
  return sup;
}

/**
 * Where the respawn actually landed, for the caller's success toast.
 *
 * With `cwd` now omittable, echoing the request field back would report `null`
 * for exactly the calls that most need an answer — the user asked to restart
 * "wherever you're configured", and the only other way to find out where that
 * was is to open Settings. The supervisor knows, so ask it; fall back to the
 * requested value if the spawn resolved but the process has already exited.
 */
function landedCwd(sup: Supervisor, requested: string | undefined): string | null {
  const st = sup.status();
  return st.running ? st.cwd : (requested ?? null);
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
    // Absence and garbage are different: an omitted cwd means "restart where
    // you're configured to run" (the chip CTAs, which can fire with no document
    // open), while a present-but-invalid one is still a 400. Mirrors the
    // start-fresh handler below — the two operations differ only in whether the
    // conversation survives, so their bodies should not differ in strictness.
    let cwd: string | undefined;
    if (body.cwd !== undefined) {
      const resolved = validateCwdString(body.cwd, res, "cwd");
      if (resolved === null) return;
      cwd = resolved;
    }
    const sup = requireSupervisor(deps, res);
    if (sup === null) return;
    // relaunch and startFresh are mutually exclusive — they're two flavors
    // of the same destructive stop+respawn operation.
    if (spawnOpInFlight()) {
      sendInProgress(res, "another launcher start/relaunch is in progress");
      return;
    }
    inflight.relaunch = true;
    try {
      if (deps.relaunchHook) await deps.relaunchHook();
      await sup.relaunch(cwd, { persistCwd: parsePersistCwd(body) });
      res.json({ ok: true, cwd: landedCwd(sup, cwd) });
    } catch (err) {
      sendUnexpected(res, err, "relaunch failed");
    } finally {
      inflight.relaunch = false;
    }
  };
}

/**
 * Did the caller explicitly ask for this folder to STICK?
 *
 * Strict `=== true`, and absence means false. A cwd in the body is not evidence
 * of intent: the recovery chip sends `dirname(activeDocumentPath)` whenever a
 * tab is open, and durably repointing Claude off that guess is exactly the
 * silent state change the launcher-relocate work exists to stop. Only the
 * palette's explicit "relaunch here" sets the flag.
 *
 * Deliberately NOT a 400 on a non-boolean: this is an additive, optional field,
 * and the safe reading of garbage is "the user did not ask to persist".
 */
function parsePersistCwd(body: Record<string, unknown>): boolean {
  return body.persistCwd === true;
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
    if (spawnOpInFlight()) {
      sendInProgress(res, "another launcher start/relaunch is in progress");
      return;
    }
    inflight.startFresh = true;
    try {
      if (deps.startFreshHook) await deps.startFreshHook();
      await sup.startFresh(cwd, { persistCwd: parsePersistCwd(body) });
      res.json({ ok: true, cwd: landedCwd(sup, cwd) });
    } catch (err) {
      sendUnexpected(res, err, "start-fresh failed");
    } finally {
      inflight.startFresh = false;
    }
  };
}

/**
 * `POST /api/launcher/start` (#1236) — promote a deferred launcher to a live
 * supervisor once a human opens the window.
 *
 * This is the only route that can create a supervisor from null; every other
 * one funnels through `requireSupervisor()`, which 503s in exactly this state.
 * That makes it a genuinely new capability, so the reason check comes FIRST:
 *
 * Ordering matters. If the nonce were checked first, a caller who can reach the
 * API could burn nonces probing for the deferred state; more importantly, if
 * the reason check were skipped or ordered after the supervisor call, this route
 * would be an HTTP **bypass of `TANDEM_DISABLE_LAUNCHER=1`** — a kill switch
 * that today cannot be defeated remotely at all.
 *
 * Guard posture is the same as `relaunch`, deliberately. Note that
 * `assertLoopbackForMutation` only rejects when
 * `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1`; in the default configuration it is a
 * no-op, and `assertOriginAllowlisted` reads a forgeable header. The real
 * protection is the loopback bind plus Bearer auth for non-loopback callers.
 */
function makeStartHandler(deps: LauncherRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_LAUNCHER_START)) return;
    if (assertLoopbackForMutation(req, res)) return;

    // Idempotent: an already-started launcher is a success, not an error. The
    // client fires this on every visibility change, so a second call after the
    // first one won must not surface as a failure toast.
    if (deps.getSupervisor() !== null) {
      res.json({ ok: true, started: false });
      return;
    }

    const reason = deps.unavailableReason();
    if (!isTransientlyUnavailable(reason)) {
      sendNotAvailable(res, reason, "Auto-launcher is not in a deferred state");
      return;
    }

    const body = parseJsonObjectBody(req, res);
    if (body === null) return;
    if (!consumeNonce(body.nonce, res)) return;

    if (spawnOpInFlight()) {
      sendInProgress(res, "another launcher start/relaunch is in progress");
      return;
    }
    inflight.start = true;
    try {
      await deps.startSupervisor();
      res.json({ ok: true, started: deps.getSupervisor() !== null });
    } catch (err) {
      sendUnexpected(res, err, "launcher start failed");
    } finally {
      inflight.start = false;
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

/**
 * `POST /api/launcher/cwd-preview` (#1282) — read-only drift verdict.
 *
 * Gates, and why they are these gates:
 *
 *   - **Origin allowlist**, like every other launcher route.
 *   - **A bare loopback check, NOT `assertLoopbackForMutation`.** That helper
 *     only rejects when `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1`, so in the default
 *     configuration it is a no-op — using it here would read as a gate while
 *     enforcing nothing. The response reconstructs the launcher `cwd` that
 *     `makeStatusHandler` deliberately withholds off-loopback, and adds a second
 *     path under the user's home directory, so it needs the unconditional
 *     posture `GET /api/document/raw` and `/api/diagnostics` use (#1121).
 *   - **No nonce.** Nonces exist to stop replayed *destructive* calls. This route
 *     starts nothing, stops nothing and writes nothing; consuming a nonce would
 *     also rotate it out from under a relaunch the user is about to confirm.
 *
 * A `503` is impossible here on purpose: "the launcher isn't available" is a
 * perfectly good answer to "is Claude in the wrong folder", and it is `no`.
 */
function makeCwdPreviewHandler(deps: LauncherRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_LAUNCHER_CWD_PREVIEW)) return;
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Loopback only." });
      return;
    }
    const body = parseJsonObjectBody(req, res);
    if (body === null) return;
    // A non-string `cwd` is a caller bug and gets a 400. Every other rejection —
    // over-length, outside home, non-existent, UNC — is a legitimate answer to
    // the question asked, and the answer is "no drift". The client probes this
    // on every settled tab switch; a document on an external drive is not an
    // error the user committed.
    const pre = precheckCwdField(body.cwd);
    if (!pre.ok) {
      if (pre.reason === "not-a-string") {
        sendBadRequest(res, LAUNCHER_ERROR_INVALID_BODY, "cwd must be a string");
        return;
      }
      res.json({ drifted: false } satisfies LauncherCwdPreview);
      return;
    }

    // Shed load rather than queue it. This is the only launcher route doing
    // unbounded filesystem work, and the hazard is the same one the async
    // resolvers were written for, one level down: `fsp.realpath` keeps the event
    // loop free but holds a libuv THREADPOOL slot (default 4) for the full SMB
    // timeout, and it takes no AbortSignal — so an aborted request keeps its
    // thread. Four concurrent probes against a hung mapped drive would starve
    // the pool that atomic saves, session writes and the annotation writer share,
    // and the symptom would be saves hanging with nothing pointing here.
    // Shedding costs nothing: every failure on this route is already "no drift".
    if (cwdPreviewInFlight >= MAX_CONCURRENT_CWD_PREVIEWS) {
      res.json({ drifted: false } satisfies LauncherCwdPreview);
      return;
    }
    cwdPreviewInFlight += 1;

    try {
      if (deps.cwdPreviewHook) await deps.cwdPreviewHook();
      const preview = await previewCwdDrift({
        candidate: pre.cwd,
        claudeCwd: runningCwd(deps.getSupervisor()),
        bundledDocDirs: deps.bundledDocDirs ?? [],
      });
      res.json(preview);
    } catch (err) {
      // Deliberately NOT a 500. This endpoint's contract is "should I nudge?",
      // and a failed check answers that as well as a successful one does. Logged
      // so a systematically failing probe is discoverable rather than silently
      // suppressing the whole feature.
      console.error("[Launcher routes] cwd-preview failed:", err);
      res.json({ drifted: false } satisfies LauncherCwdPreview);
    } finally {
      cwdPreviewInFlight -= 1;
    }
  };
}

/**
 * Concurrency cap for the drift preview. Small on purpose: the client issues at
 * most one probe per settled tab switch, so anything above a couple in flight is
 * either a burst of very fast switching or a caller that is not the UI.
 */
const MAX_CONCURRENT_CWD_PREVIEWS = 3;
let cwdPreviewInFlight = 0;

/** Test-only reset of the preview concurrency counter. */
export function _resetCwdPreviewInFlightForTests(): void {
  if (process.env.VITEST !== "true") {
    throw new Error("_resetCwdPreviewInFlightForTests is test-only");
  }
  cwdPreviewInFlight = 0;
}

/**
 * Where the supervised Claude is running right now, or `null` when nothing is.
 *
 * Deliberately does NOT catch a throwing `status()`. It is called inside the
 * handler's `try`, which already answers with the identical `{ drifted: false }`
 * — and logs. A local catch here would change exactly one thing: it would delete
 * the only diagnostic this route has, for the failure it is least prepared for.
 * "Should never throw" is the reason to log it, not the reason to swallow it.
 *
 * Contrast `landedCwd`, which lets `status()` throw through to `sendUnexpected`
 * and a 500. Same call, opposite contracts: there the caller asked to *change*
 * something and deserves an error; here it asked a question a failed check can
 * still answer.
 */
function runningCwd(sup: Supervisor | null): string | null {
  if (sup === null) return null;
  const st = sup.status();
  return st.running ? st.cwd : null;
}

/** Cap on the error detail surfaced over the wire. These routes are loopback +
 * origin-gated, so the caller is the same user on the same machine — the detail
 * (including a checked filesystem path) is safe to return, but bound it anyway. */
const MAX_ERROR_DETAIL = 300;

function sendUnexpected(res: Response, err: unknown, label: string): void {
  // Full error (stack, etc.) stays server-side; the wire gets a bounded message.
  console.error(`[Launcher routes] ${label}:`, err);
  if (res.headersSent) return;
  const detail = err instanceof Error ? err.message : String(err);
  // The missing-reaper throw is the one well-known, user-actionable failure.
  // Give it a stable code + friendly hint rather than a raw path.
  if (detail.includes(REAPER_NOT_FOUND_MARKER)) {
    res.status(500).json({
      error: "INTERNAL_ERROR",
      code: LAUNCHER_ERROR_REAPER_NOT_FOUND,
      message: "Claude launcher binary missing — reinstall Tandem to restore it.",
    });
    return;
  }
  const truncated =
    detail.length > MAX_ERROR_DETAIL ? `${detail.slice(0, MAX_ERROR_DETAIL)}…` : detail;
  // The client renders `${failPrefix}: ${message}`, so send the detail only —
  // not `label` (it already supplies the prefix). Fall back to `label` when the
  // error carries no message.
  res.status(500).json({
    error: "INTERNAL_ERROR",
    code: "INTERNAL_ERROR",
    message: truncated || label,
  });
}
