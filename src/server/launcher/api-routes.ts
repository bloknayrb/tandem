/**
 * HTTP routes for the Claude Code auto-launcher (#477 PR 4b).
 *
 * Nine handlers on eight paths, all under `/api/launcher/*`:
 *   - `GET /status` — read-only; loopback returns full struct (with
 *     `sessionId` redacted to "<set>"), non-loopback returns the minimal
 *     `{ available, running }` shape (mirrors `/health`'s redaction pattern).
 *     `cwd`, `resuming`, `reaperPid`, `busy`, `attached`, `standby`,
 *     `startsOnMessage` and `greetingLate` are loopback-only
 *     for the same reason as `/health`'s session-presence fields: `busy` in
 *     particular is an activity trace of the person at this machine, and the
 *     CORS allowlist admits any 127.0.0.1 port, so any local page can read
 *     it (docs/security.md#cors-allowlist).
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
 *   - `POST /start` — promote a `deferred-autostart` launcher (#1236), or,
 *     with `userInitiated: true` and a supervisor present, start Tandem's
 *     Claude from standby (#2195). `userInitiated` is a caller-asserted
 *     discriminator that keeps the Rust shell's presence POST from ever
 *     starting an on-click Claude; like the nonce, it is NOT proof that a
 *     human clicked anything.
 *   - `GET /settings` / `POST /settings` — the start mode and lifetime of
 *     Tandem's Claude (#2195). POST merges a partial patch; see
 *     `makeSettingsPostHandler`.
 *   - `POST /cwd-preview` — body `{ cwd }`. Read-only drift verdict (#1282);
 *     loopback-only, no nonce. See `makeCwdPreviewHandler`.
 *
 * The supervisor singleton is bridged via `() => Supervisor | null`. The
 * MUTATING routes return 503 + `NOT_AVAILABLE` when the getter returns null
 * (stdio mode, disabled-by-env, a deferred autostart, or a supervisor that
 * failed to start). A supervisor that exists but found no launchable
 * claude-code integration is NOT null: `GET /status` reports it as
 * `available: false, reason: "not-configured"`, and relaunch / start-fresh
 * answer 404 `NO_CLAUDE_INTEGRATION` (#2180). The two
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
  API_LAUNCHER_SETTINGS,
  API_LAUNCHER_START,
  API_LAUNCHER_START_FRESH,
  API_LAUNCHER_STATUS,
  API_LAUNCHER_WORKING_DIRECTORY,
} from "../../shared/api-paths.js";
import type { ClaudeCodeIntegration } from "../../shared/integrations/contract.js";
import {
  isTransientlyUnavailable,
  LAUNCHER_CWD_MAX_LENGTH,
  LAUNCHER_ERROR_CLI_UNUSABLE,
  LAUNCHER_ERROR_IN_PROGRESS,
  LAUNCHER_ERROR_INVALID_BODY,
  LAUNCHER_ERROR_INVALID_NONCE,
  LAUNCHER_ERROR_NO_INTEGRATION,
  LAUNCHER_ERROR_NOT_AVAILABLE,
  LAUNCHER_ERROR_OFF_NOT_SAVED,
  LAUNCHER_ERROR_PATH_REJECTED,
  LAUNCHER_ERROR_REAPER_NOT_FOUND,
  LAUNCHER_ERROR_SETTINGS_NEWER,
  LAUNCHER_ERROR_UNLICENSED,
  type LauncherCwdPreview,
  type LauncherSettingsResponse,
  type LauncherStatus,
  type LauncherUnavailableReason,
  parseLauncherSettingsPatch,
  REAPER_NOT_FOUND_MARKER,
  type SkillRefreshError,
} from "../../shared/launcher/contract.js";
import { isLoopback } from "../auth/middleware.js";
import { assertLoopbackForMutation, assertOriginAllowlisted } from "../integrations/api-routes.js";
import type { IntegrationConfig } from "../integrations/schema.js";
import type { IntegrationsStore } from "../integrations/storage.js";
import { type AiRefusal, sendAiRefusal } from "../license/ai-refusal.js";
import type { Handler } from "../mcp/routes/_shared.js";
import { previewCwdDrift } from "./cwd-preview.js";
import { readLauncherSettings, SettingsNewerError, updateLauncherSettings } from "./settings.js";
import {
  LicenseRefusedError,
  type RespawnResult,
  resolveRouteCwd,
  type Supervisor,
} from "./supervisor.js";

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
  /** Whether a live MCP connection from this Claude session id, opened at or
   * after `sinceMs`, is in the transport registry (`isClaudeSessionAttached` in
   * `mcp/server.ts`). Called with the supervisor's real UUID, which never leaves
   * the server: only the boolean is sent. */
  isClaudeSessionAttached: (claudeSessionId: string, sinceMs: number) => boolean;
  /** Reason the supervisor is null (stdio mode, disabled, deferred, failed to
   * start). Surfaced via GET /status. `not-configured` is NOT produced here: it
   * comes from a live supervisor's own status (#2180). */
  unavailableReason: () => LauncherUnavailableReason;
  /** Create + start the supervisor from null. Idempotent and single-flighted in
   * `src/server/index.ts`. Only reachable via `POST /start` and only in the
   * `deferred-autostart` state (#1236). */
  startSupervisor: () => Promise<void>;
  /** Reads/writes the integrations file. Same store passed to integrations routes. */
  store: IntegrationsStore;
  /** Directory holding `launcher-settings.json` (the app-data dir). Used
   * directly only while there is no supervisor (deferred, disabled, stdio):
   * otherwise writes go through `Supervisor.updateSettings`, so they are
   * serialized with the supervisor's own. */
  settingsBase: string;
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

  app.options(API_LAUNCHER_SETTINGS, mw);
  app.get(API_LAUNCHER_SETTINGS, mw, makeSettingsGetHandler(deps));
  app.post(API_LAUNCHER_SETTINGS, mw, makeSettingsPostHandler(deps));
}

// --- Handlers -------------------------------------------------------------

function makeStatusHandler(deps: LauncherRoutesDeps): Handler {
  return (req: Request, res: Response) => {
    const sup = deps.getSupervisor();
    const loopback = isLoopback(req.socket.remoteAddress);
    const skillRefresh = loopback ? (deps.getSkillRefreshError?.() ?? null) : undefined;
    if (sup === null) {
      // `reason` is loopback-only. `deferred-autostart` in particular is a live
      // presence oracle — it says "this machine auto-booted at login and the
      // human hasn't opened the window yet." Omitting the field entirely
      // (rather than filtering that one value) also future-proofs the enum
      // against the next reason that turns out to leak something.
      const body: LauncherStatus = loopback
        ? {
            available: false,
            reason: deps.unavailableReason(),
            ...(skillRefresh ? { skillRefresh } : {}),
          }
        : { available: false };
      res.json(body);
      return;
    }
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
    // Loopback-only, beside both stopped shapes below (#2195, #2196, #2197).
    const standbyFields = raw.running
      ? {}
      : {
          ...(raw.standby ? { standby: raw.standby } : {}),
          ...(raw.startsOnMessage ? { startsOnMessage: true as const } : {}),
          ...(raw.greetingLate ? { greetingLate: true as const } : {}),
        };
    if (raw.running) {
      if (!loopback) {
        res.json({ available: true, running: true });
        return;
      }
      // Green beside "Tandem's Claude" hangs on this, so a throw reads as "not
      // attached" (an honest neutral) rather than escaping with the UUID in hand.
      let attached = false;
      try {
        attached = deps.isClaudeSessionAttached(raw.sessionId, raw.spawnedAt);
      } catch {
        // stays false
      }
      // An explicit field list, never `{ ...raw }`: that copy is the only thing
      // keeping a future internal `SupervisorStatus` field off the wire, and
      // `raw.sessionId` is the real UUID (`raw.spawnedAt` stays internal too).
      const body: LauncherStatus = {
        available: true,
        running: true,
        reaperPid: raw.reaperPid,
        cwd: raw.cwd,
        sessionId: "<set>",
        resuming: raw.resuming,
        busy: raw.busy,
        attached,
        ...(raw.greetingLate ? { greetingLate: true as const } : {}),
        skillRefresh,
      };
      res.json(body);
      return;
    }
    // A restart in progress outranks "not configured": a start or relaunch
    // in flight is re-planning, so don't flash "Connect AI" meanwhile.
    if (raw.restartPending) {
      const body: LauncherStatus = loopback
        ? {
            available: true,
            running: false,
            lastError: raw.lastError,
            restartPending: true,
            // A Start from standby in progress (#2195): "Starting", not "Restarting".
            ...standbyFields,
            skillRefresh,
          }
        : { available: true, running: false };
      res.json(body);
      return;
    }
    if (raw.configured === false) {
      // No launchable claude-code entry: there is nothing to restart, so this
      // reads as unavailable and the client offers setup (#2180). Same
      // loopback-only `reason` as the null-supervisor branch above.
      const body: LauncherStatus = loopback
        ? {
            available: false,
            reason: "not-configured",
            ...(skillRefresh ? { skillRefresh } : {}),
          }
        : { available: false };
      res.json(body);
      return;
    }
    // `standby` (#2195) rides on the plain stopped shape, loopback-only. The
    // supervisor never emits it beside a `lastError`.
    const body: LauncherStatus = loopback
      ? {
          available: true,
          running: false,
          lastError: raw.lastError,
          ...standbyFields,
          skillRefresh,
        }
      : { available: true, running: false };
    res.json(body);
  };
}

/** A start that spawned nothing: no integration, or (#2199) no Claude Code
 * program to start (409, a running Claude left alone). */
function sendNotSpawned(
  res: Response,
  why: Extract<RespawnResult, { spawned: false }>["why"],
): void {
  if (why === "cli-unusable") {
    res.status(409).json({
      error: "CONFLICT",
      code: LAUNCHER_ERROR_CLI_UNUSABLE,
      message: "Tandem can't find Claude Code to start. Install it from Connect AI.",
    });
    return;
  }
  sendNoIntegration(res);
}

/** 404 for a relaunch / start-fresh whose plan found no launchable claude-code
 * entry (#2180). The message is shown to the user verbatim by the client's
 * launcher toast, so it says what to do. */
function sendNoIntegration(res: Response): void {
  res.status(404).json({
    error: "NOT_FOUND",
    code: LAUNCHER_ERROR_NO_INTEGRATION,
    message: "Claude Code isn't set up in Tandem yet. Use Connect AI to set it up.",
  });
}

/**
 * The nonce GET's origin check. `assertOriginAllowlisted`, plus one case it
 * cannot see: a browser sends NO `Origin` on a same-origin GET (measured
 * against Chromium 2026-10-13: no `Origin`, `Sec-Fetch-Site: same-origin`; the
 * same-origin POST carries `Origin`). The npm build serves the editor from the
 * API's own origin (`tandem start` opens `http://127.0.0.1:<mcp port>`), so its
 * every launcher action — Relaunch, Start fresh, and #2195's Start, Turn off
 * and Settings save — failed here with a 403 before any of them could run.
 *
 * The `Sec-Fetch-*` headers are forbidden headers: a page cannot set them. A
 * cross-site `<img>` probe (which also sends no `Origin`) says `cross-site`.
 * A SAME-origin `<img>` — which a document opened in the npm build's editor
 * can make, since its CSP allows `img-src 'self'` and root-relative image
 * paths survive sanitizing — or a link the user clicks says `same-origin`
 * too, so the admission also requires what only a script's `fetch()` sends:
 * `Sec-Fetch-Dest: empty` with mode `cors` or `same-origin` (measured
 * 2026-10-14: `<img>` is `no-cors`/`image`, an iframe `navigate`/`iframe`, a
 * link `navigate`/`document`). Without that, document content could rotate the
 * nonce between the client's GET and its POST and fail the user's action. A
 * local non-browser process could forge all of these, but could equally forge
 * `Origin`, so this widens nothing. Scoped to this one read rather than the
 * shared gate.
 */
function refuseNonceOrigin(req: Request, res: Response): boolean {
  const mode = req.headers["sec-fetch-mode"];
  if (
    req.headers.origin === undefined &&
    req.headers["sec-fetch-site"] === "same-origin" &&
    req.headers["sec-fetch-dest"] === "empty" &&
    (mode === "cors" || mode === "same-origin")
  ) {
    return false;
  }
  return assertOriginAllowlisted(req, res, API_LAUNCHER_NONCE);
}

function makeNonceHandler(): Handler {
  return (req: Request, res: Response) => {
    if (refuseNonceOrigin(req, res)) return;
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

/** The bare loopback check the read-shaped routes use (`cwd-preview`,
 * `GET /settings`): `enforceLoopbackMutation` does not cover them. Returns true
 * when it answered 403. */
function refuseNonLoopbackRead(req: Request, res: Response): boolean {
  if (isLoopback(req.socket.remoteAddress)) return false;
  res.status(403).json({ error: "FORBIDDEN", message: "Loopback only." });
  return true;
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
      const result = await sup.relaunch(cwd, { persistCwd: parsePersistCwd(body) });
      if (!result.spawned) {
        sendNotSpawned(res, result.why);
        return;
      }
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
      const result = await sup.startFresh(cwd, { persistCwd: parsePersistCwd(body) });
      if (!result.spawned) {
        sendNotSpawned(res, result.why);
        return;
      }
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
 * Guard posture is the same as `relaunch`, deliberately. This comment used to
 * be the only honest description of the gate in the codebase — it recorded that
 * `assertLoopbackForMutation` was a no-op in the default configuration. #1293
 * fixed the code instead, so it now rejects every non-loopback caller in every
 * configuration. `assertOriginAllowlisted` still reads a forgeable header and is
 * a CSRF control, not an authorization one; the loopback bind plus Bearer auth
 * remains the primary protection, with the loopback gate covering the one case
 * neither does — a token-holder who is not on this machine.
 */
function makeStartHandler(deps: LauncherRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_LAUNCHER_START)) return;
    if (assertLoopbackForMutation(req, res)) return;

    const existing = deps.getSupervisor();
    if (existing !== null) {
      // The Start control (#2195). Read through a guarded access, not
      // `parseJsonObjectBody`: a body-less or `text/plain` POST (no preflight,
      // `req.body` undefined) must keep getting the answer below, byte for
      // byte, and must consume no nonce.
      const raw = req.body as { userInitiated?: unknown; nonce?: unknown } | undefined;
      if (raw !== null && typeof raw === "object" && raw.userInitiated === true) {
        await startExistingByUser(existing, raw.nonce, res);
        return;
      }
      // Idempotent: an already-started launcher is a success, not an error.
      // The Rust shell posts this once per presence release, so a call that
      // finds the supervisor already created must not surface as a failure.
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
      // Licence (#1521): NOT refused at the top. Refusing there would leave the
      // supervisor null and the reason `deferred-autostart` forever, which the
      // client reads as "booting" — and Rust posts this route exactly once,
      // dropping a non-2xx. Instead the supervisor is created, `startInternal`
      // refuses by returning, and `resumeAfterLicence` can bring it back after
      // activation. What this route must not do is claim `started: true`.
      const sup = deps.getSupervisor();
      const refusal = sup?.licenceRefusal();
      if (refusal) {
        sendUnlicensed(res, refusal);
        return;
      }
      // `started` reports that the launcher was PROMOTED (a supervisor now
      // exists), not that Claude is running: a boot the start-mode setting
      // holds back (#2195) creates the supervisor and spawns nothing, and the
      // Rust caller only needs to know the deferral is over.
      res.json({ ok: true, started: sup !== null });
    } catch (err) {
      sendUnexpected(res, err, "launcher start failed");
    } finally {
      inflight.start = false;
    }
  };
}

/** The `userInitiated` half of `POST /start` (#2195): a supervisor exists and
 * the client's Start control asks for its Claude. Same nonce and exclusion
 * group as relaunch, because it is the same stop+spawn underneath. */
async function startExistingByUser(sup: Supervisor, nonce: unknown, res: Response): Promise<void> {
  if (!consumeNonce(nonce, res)) return;
  if (spawnOpInFlight()) {
    sendInProgress(res, "another launcher start/relaunch is in progress");
    return;
  }
  inflight.start = true;
  try {
    const result = await sup.startByUser();
    if (!result.spawned) {
      sendNotSpawned(res, result.why);
      return;
    }
    res.json({ ok: true, started: true });
  } catch (err) {
    sendUnexpected(res, err, "start failed");
  } finally {
    inflight.start = false;
  }
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
 * `GET /api/launcher/settings` (#2195) — the start mode and lifetime of
 * Tandem's Claude.
 *
 * Bare loopback check, like `cwd-preview`: `enforceLoopbackMutation` does not
 * cover GET, and the answer — two enums and an integer, no paths — is still a
 * fact about the person at this machine. **No origin gate**: a browser sends no
 * `Origin` on a same-origin GET, so the gate would refuse the npm build's own
 * editor, and it adds nothing here — the read has no side effect, and CORS
 * already keeps a cross-origin page from reading the answer. Answers with no
 * supervisor (deferred, disabled, stdio) so Settings can show the choice in
 * every runtime. Reads the file each call; nothing polls it.
 */
function makeSettingsGetHandler(deps: LauncherRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (refuseNonLoopbackRead(req, res)) return;
    const read = await readLauncherSettings(deps.settingsBase);
    const body: LauncherSettingsResponse = { settings: read.settings };
    if (read.source === "file" && read.newer) body.readOnly = true;
    // The file could not be read, so these are not a saved choice — and
    // Settings must say so. Show what Tandem is actually acting on: the
    // supervisor's last good read when it has one (a file that broke mid-run
    // leaves Claude on the mode it had), else the fallback.
    if (read.source === "fallback") {
      body.unreadable = true;
      const applied = deps.getSupervisor()?.appliedSettings() ?? null;
      if (applied) {
        body.settings = applied;
        body.keptLastGood = true;
      }
    }
    res.json(body);
  };
}

/**
 * `POST /api/launcher/settings` (#2195) — body `{ nonce, patch }`, where
 * `patch` holds any non-empty subset of `startMode`, `lifetime`, `idleMinutes`.
 *
 * **A partial patch, never a whole object.** Every writer used to have to send
 * all three fields, so a stale snapshot — a second window, a Settings tab
 * opened before the chat panel's Turn off — put back a start mode the user had
 * just changed. Merged server-side under one queue (`updateLauncherSettings`).
 *
 * With a supervisor the patch goes through `Supervisor.updateSettings`, under
 * its op lock, which also applies it — switching to `off` stops Claude
 * whatever state it is in. Without one it only writes the file. Neither path
 * ever starts Claude: this route is `open` in the licence table because
 * nothing here is an AI start, and turning Claude off must never be refused.
 *
 * Gates as `relaunch`: origin, `assertLoopbackForMutation`, a JSON object body
 * (a `text/plain` simple request arrives as `undefined` and is a 400), and the
 * single-use nonce, because the off switch stops a process.
 */
function makeSettingsPostHandler(deps: LauncherRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_LAUNCHER_SETTINGS)) return;
    if (assertLoopbackForMutation(req, res)) return;
    const body = parseJsonObjectBody(req, res);
    if (body === null) return;
    if (!consumeNonce(body.nonce, res)) return;
    const parsed = parseLauncherSettingsPatch(body.patch);
    if (!parsed.ok) {
      sendBadRequest(
        res,
        LAUNCHER_ERROR_INVALID_BODY,
        `patch.${parsed.field} is missing or invalid`,
      );
      return;
    }
    // No in-flight 429: writes queue behind the supervisor's lock and the
    // settings module's queue, which is safe, so a second save waits rather
    // than failing.
    // Read once: the catch must speak for the supervisor that ran the patch,
    // not one a concurrent Start promoted while this save was failing.
    const sup = deps.getSupervisor();
    try {
      const settings = sup
        ? await sup.updateSettings(parsed.patch)
        : await updateLauncherSettings(deps.settingsBase, parsed.patch);
      res.json({ ok: true, settings });
    } catch (err) {
      // `updateSettings` stops Claude for an Off even when the save fails, so
      // the answer is "off now, not saved", never "couldn't turn off".
      if (parsed.patch.startMode === "off" && sup) {
        console.error("[Launcher] Turned Tandem's Claude off but could not save it:", err);
        res.status(409).json({
          error: "CONFLICT",
          code: LAUNCHER_ERROR_OFF_NOT_SAVED,
          message:
            "Tandem's Claude is off now, but Tandem couldn't save that, so it may start again the next time Tandem starts.",
        });
        return;
      }
      if (err instanceof SettingsNewerError) {
        res.status(409).json({
          error: "CONFLICT",
          code: LAUNCHER_ERROR_SETTINGS_NEWER,
          message:
            "These settings were saved by a newer version of Tandem. Update Tandem to change them.",
        });
        return;
      }
      sendUnexpected(res, err, "failed to save launcher settings");
    }
  };
}

/**
 * `POST /api/launcher/cwd-preview` (#1282) — read-only drift verdict.
 *
 * Gates, and why they are these gates:
 *
 *   - **Origin allowlist**, like every other launcher route.
 *   - **A bare loopback check, not `assertLoopbackForMutation`** — and the
 *     reason is now naming, not strength. When this route was written that
 *     helper rejected only under `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1`, making it
 *     a no-op in the default configuration; **#1293 made it unconditional**, so
 *     the two are behaviourally equivalent today. What remains is that this
 *     route mutates nothing: it is a read whose response reconstructs the
 *     launcher `cwd` that `makeStatusHandler` deliberately withholds
 *     off-loopback, plus a second path under the user's home directory. That
 *     puts it with `GET /api/document/raw` and `/api/diagnostics` (#1121), which
 *     use the same bare check for the same reason.
 *
 *     If #1320 lands its `/api`-wide loopback invariant, this hand-rolled check
 *     should fold into it rather than persist as an exception.
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
    if (refuseNonLoopbackRead(req, res)) return;
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

/**
 * 403 for a launcher action the licence refused (#1521): the refusal envelope
 * the supervisor recorded, plus the route's own `code`. The supervisor holds
 * the refusal, so this module never makes the licence decision itself.
 */
function sendUnlicensed(res: Response, refusal: AiRefusal): void {
  sendAiRefusal(res, refusal, { code: LAUNCHER_ERROR_UNLICENSED });
}

function sendUnexpected(res: Response, err: unknown, label: string): void {
  if (err instanceof LicenseRefusedError) {
    // Not unexpected, and not a 500: the relaunch was refused before anything
    // was stopped. One line, no stack.
    console.error(`[Launcher routes] ${label}: AI features are unlicensed`);
    if (!res.headersSent) sendUnlicensed(res, err.refusal);
    return;
  }
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
