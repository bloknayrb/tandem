/**
 * HTTP API routes for the integration setup wizard.
 *
 * Routes:
 *   GET    /api/integrations/existing            — list existing Tandem MCP entries
 *                                                  detected in `~/.claude.json` etc.
 *   GET    /api/integrations                     — read the persisted `integrations.json`.
 *   POST   /api/integrations                     — write a new integrations file (Zod-validated).
 *   GET    /api/integrations/first-run-needed    — `{ needed, serverVersion, confirmationNonce }`.
 *                                                  Wizard auto-opens when `needed === true`.
 *                                                  Nonce is consumed by apply.
 *   POST   /api/integrations/apply               — write persisted entries to Claude's config.
 *                                                  Separates intent (POST /api/integrations) from
 *                                                  side-effect (apply) per ADR-038 §2b.
 *   POST   /api/integrations/secrets/:ref        — store a secret in the OS keychain under `ref`.
 *   DELETE /api/integrations/secrets/:ref        — remove a secret.
 *
 * **Secrets never travel back to the client.** There is no `GET .../secrets/:ref`
 * route — only the server reads secrets when proxying to MCP clients. The
 * client only ever sees `tokenSecretRef`, never the actual token.
 *
 * **Apply endpoint security gates** (all enforced before any FS write):
 * - Origin allowlist (CSRF mitigation against same-origin drive-by).
 * - Confirmation nonce — issued by GET /first-run-needed and POST /integrations.
 * - LAN auth fail-closed even with `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1`.
 * - Concurrency mutex (429 on overlap).
 * - `homeOverride` body field asserted-absent.
 *
 * **Apply handler logic:**
 * - Re-validates the persisted file via `IntegrationsFileSchema.safeParse`.
 * - Filters `other-mcp` (Tandem can't apply third-party MCP configs).
 * - Resolves `tokenSecretRef` via `deps.keychain.getSecret(ref)` per entry.
 * - Calls `applyConfig` with explicit `{ create, remove }` ops built from
 *   the user's confirmation diff (passed via the wizard's persist call).
 * - Calls `installSkill()` exactly once after the per-integration loop.
 * - Response never echoes entries / headers / tokens.
 */

import { randomBytes } from "node:crypto";

import type { Express, Request, Response } from "express";
import { TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV } from "../../shared/constants.js";
import {
  API_INTEGRATIONS,
  API_INTEGRATIONS_APPLY,
  API_INTEGRATIONS_EXISTING,
  API_INTEGRATIONS_FIRST_RUN,
  type ApplyItemErrorCode,
  type ApplyItemResult,
  ERROR_CODE_APPLY_IN_PROGRESS,
  ERROR_CODE_BAD_ORIGIN,
  ERROR_CODE_INVALID_APPLY_REQUEST,
  ERROR_CODE_INVALID_INTEGRATIONS_FILE,
  ERROR_CODE_INVALID_NONCE,
  ERROR_CODE_INVALID_PERSISTED_FILE,
  ERROR_CODE_INVALID_SECRET,
  ERROR_CODE_KEYCHAIN_UNAVAILABLE,
  ERROR_CODE_OTHER_MCP_NOT_APPLICABLE,
  ERROR_CODE_PATH_REJECTED,
  ERROR_CODE_SECRET_MISSING,
  ERROR_CODE_TARGET_NOT_DETECTED,
  ERROR_CODE_WRITE_FAILED,
} from "../../shared/integrations/contract.js";
import { isLoopback } from "../auth/middleware.js";
import { isLocalhostOrigin } from "../mcp/api-routes.js";
import type { Handler } from "../mcp/routes/_shared.js";
import {
  type ApplyOps,
  applyConfig,
  buildMcpEntries,
  CHANNEL_DIST,
  detectTargets,
  installSkill,
  PathRejectedError,
  type RemovableEntry,
} from "./apply.js";
import { hasExistingTandemEntry, type readExistingTandemEntries } from "./existing-config.js";
import { type Keychain, KeychainUnavailableError } from "./keychain.js";
import { type IntegrationConfig, IntegrationsFileSchema } from "./schema.js";
import type { IntegrationsStore } from "./storage.js";

export {
  API_INTEGRATIONS,
  API_INTEGRATIONS_APPLY,
  API_INTEGRATIONS_EXISTING,
  API_INTEGRATIONS_FIRST_RUN,
} from "../../shared/integrations/contract.js";
/** Express route pattern — `:ref` is filled in by the client via {@link apiIntegrationsSecretPath}. */
export const API_INTEGRATIONS_SECRET = "/api/integrations/secrets/:ref";

export interface IntegrationsRoutesDeps {
  store: IntegrationsStore;
  keychain: Keychain;
  /** Injected so tests can swap the detector without filesystem fixtures. */
  readExisting: typeof readExistingTandemEntries;
  /** Server `package.json` version — surfaced in first-run-needed responses. */
  serverVersion: string;
}

/**
 * Per-process nonce + mutex state for `POST /api/integrations/apply`.
 * Module-scoped (not per-handler) so concurrent requests across handler
 * instances still serialize. Each successful apply rotates the nonce so a
 * captured value can't be replayed.
 */
interface ApplyGateState {
  /** Currently-valid confirmation nonce. Rotates on every successful apply. */
  nonce: string;
  /** True while an apply request is mid-flight. Concurrent requests get 429. */
  inFlight: boolean;
}

function createApplyGate(): ApplyGateState {
  return { nonce: randomBytes(32).toString("base64url"), inFlight: false };
}

/** Module state — shared across all routes of this server instance. */
let applyGate: ApplyGateState | null = null;

function getApplyGate(): ApplyGateState {
  if (applyGate === null) applyGate = createApplyGate();
  return applyGate;
}

/** Test-only: reset the apply gate between cases. */
export function _resetApplyGateForTests(): void {
  applyGate = createApplyGate();
}

export function registerIntegrationsRoutes(
  app: Express,
  largeBody: Handler,
  mw: Handler,
  deps: IntegrationsRoutesDeps,
): void {
  app.options(API_INTEGRATIONS_EXISTING, mw);
  app.get(API_INTEGRATIONS_EXISTING, mw, makeGetExistingHandler(deps));

  app.options(API_INTEGRATIONS, mw);
  app.get(API_INTEGRATIONS, mw, makeGetIntegrationsHandler(deps));
  app.post(API_INTEGRATIONS, mw, largeBody, makePostIntegrationsHandler(deps));

  app.options(API_INTEGRATIONS_FIRST_RUN, mw);
  app.get(API_INTEGRATIONS_FIRST_RUN, mw, makeFirstRunHandler(deps));

  app.options(API_INTEGRATIONS_APPLY, mw);
  app.post(API_INTEGRATIONS_APPLY, mw, largeBody, makeApplyHandler(deps));

  app.options(API_INTEGRATIONS_SECRET, mw);
  app.post(API_INTEGRATIONS_SECRET, mw, largeBody, makePostSecretHandler(deps));
  app.delete(API_INTEGRATIONS_SECRET, mw, makeDeleteSecretHandler(deps));
}

/**
 * Defense-in-depth: even with `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1`,
 * /api/integrations/apply fails closed for non-loopback callers — this
 * endpoint mutates files outside Tandem's data dir.
 */
function rejectUnauthLan(req: Request, res: Response): boolean {
  const allowUnauthLan = process.env[TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV] === "1";
  if (allowUnauthLan && !isLoopback(req.socket.remoteAddress)) {
    res.status(403).json({
      error: "FORBIDDEN",
      code: ERROR_CODE_BAD_ORIGIN,
      message:
        "/api/integrations/apply is loopback-only; TANDEM_ALLOW_UNAUTHENTICATED_LAN does not relax this endpoint",
    });
    return true;
  }
  return false;
}

function makeGetExistingHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (_req: Request, res: Response) => {
    try {
      const installs = await deps.readExisting();
      res.json({ installs });
    } catch (err) {
      sendInternal(res, err, "Failed to read existing integration entries");
    }
  };
}

function makeGetIntegrationsHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (_req: Request, res: Response) => {
    try {
      const file = await deps.store.read();
      res.json(file);
    } catch (err) {
      sendInternal(res, err, "Failed to read integrations file");
    }
  };
}

function makePostIntegrationsHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    const parsed = IntegrationsFileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "BAD_REQUEST",
        code: ERROR_CODE_INVALID_INTEGRATIONS_FILE,
        message: parsed.error.message,
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      await deps.store.write(parsed.data);
      // Rotate the confirmation nonce so the wizard's next apply call must
      // pull the fresh value (binds the apply to the persist that immediately
      // preceded it). Also returned in the response so the wizard doesn't
      // need to GET /first-run-needed between persist and apply.
      const gate = getApplyGate();
      gate.nonce = randomBytes(32).toString("base64url");
      res.status(200).json({
        ok: true,
        ids: parsed.data.integrations.map((i) => i.id),
        confirmationNonce: gate.nonce,
      });
    } catch (err) {
      sendInternal(res, err, "Failed to write integrations file");
    }
  };
}

/**
 * GET /api/integrations/first-run-needed
 *
 * Server-authoritative "do we need to auto-open the wizard?" check.
 * Returns `{ needed, serverVersion, confirmationNonce }`. Client uses
 * `needed` as a hard gate (localStorage dismissal is advisory — a stomped
 * localStorage value can never prevent the wizard from re-prompting when
 * the server says it's needed).
 *
 * Nonce in the response binds the *next* apply call to the user-visible
 * UI session that fetched it. The wizard caches this and passes it in
 * `POST /api/integrations/apply.confirmationNonce`.
 */
function makeFirstRunHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (_req: Request, res: Response) => {
    try {
      // `TANDEM_DISABLE_FIRST_RUN_WIZARD=1` short-circuits auto-open without
      // touching `integrations.json`. Used by the E2E test harness — the
      // wizard auto-open would otherwise cover unrelated editor surfaces on
      // every `page.goto()`. The integration-wizard.spec.ts test does NOT
      // set this var (it explicitly exercises the manual-reopen affordance).
      const forceDisable = process.env.TANDEM_DISABLE_FIRST_RUN_WIZARD === "1";
      const gate = getApplyGate();
      if (forceDisable) {
        res.json({
          needed: false,
          serverVersion: deps.serverVersion,
          confirmationNonce: gate.nonce,
        });
        return;
      }
      const file = await deps.store.read();
      const installs = await deps.readExisting();
      const needed = file.integrations.length === 0 && !hasExistingTandemEntry(installs);
      res.json({
        needed,
        serverVersion: deps.serverVersion,
        confirmationNonce: gate.nonce,
      });
    } catch (err) {
      sendInternal(res, err, "Failed to compute first-run-needed");
    }
  };
}

/**
 * Body shape for `POST /api/integrations/apply`. Validation is hand-rolled
 * (no Zod) because the shape is small and we want explicit messages for
 * each field.
 */
interface ApplyRequestBody {
  /** IDs of persisted integrations to apply. Server iterates `integrations.json`
   *  and applies entries whose `id` is in this set AND `apply !== "skip"`. */
  ids: string[];
  /** Must match the current confirmation nonce. CSRF + replay mitigation. */
  confirmationNonce: string;
  /** Per-integration explicit removals — keys to delete from existing mcpServers
   *  if present. The wizard pre-resolves these via its confirmation diff. */
  removals?: Record<string, RemovableEntry[]>;
}

function validateApplyBody(
  body: unknown,
): { ok: true; data: ApplyRequestBody } | { ok: false; message: string } {
  if (body === null || typeof body !== "object") {
    return { ok: false, message: "Body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (
    !Array.isArray(b.ids) ||
    !b.ids.every((x): x is string => typeof x === "string" && x.length > 0)
  ) {
    return { ok: false, message: "`ids` must be a non-empty string array" };
  }
  if (b.ids.length === 0) {
    return { ok: false, message: "`ids` must be non-empty" };
  }
  if (typeof b.confirmationNonce !== "string" || b.confirmationNonce.length === 0) {
    return { ok: false, message: "`confirmationNonce` is required" };
  }
  let removals: Record<string, RemovableEntry[]> | undefined;
  if (b.removals !== undefined) {
    if (typeof b.removals !== "object" || b.removals === null || Array.isArray(b.removals)) {
      return { ok: false, message: "`removals` must be a record" };
    }
    const r: Record<string, RemovableEntry[]> = {};
    for (const [id, value] of Object.entries(b.removals)) {
      if (!Array.isArray(value)) {
        return { ok: false, message: `removals.${id} must be an array` };
      }
      const valid: RemovableEntry[] = [];
      for (const entry of value) {
        if (entry !== "tandem" && entry !== "tandem-channel") {
          return {
            ok: false,
            message: `removals.${id} entries must be 'tandem' or 'tandem-channel'; got '${String(entry)}'`,
          };
        }
        valid.push(entry);
      }
      r[id] = valid;
    }
    removals = r;
  }
  // Defense-in-depth: forbid `homeOverride` in the body so a tampered
  // request can't redirect `installSkill`'s write target.
  if ("homeOverride" in b) {
    return { ok: false, message: "`homeOverride` is not accepted in apply request body" };
  }
  return {
    ok: true,
    data: { ids: b.ids, confirmationNonce: b.confirmationNonce, ...(removals ? { removals } : {}) },
  };
}

/**
 * POST /api/integrations/apply
 *
 * Writes the persisted entries (filtered by `ids`) to Claude's config.
 * Security gates run before any FS access:
 *   1. Origin allowlist (CSRF).
 *   2. Confirmation nonce equality.
 *   3. LAN unauth fail-closed (even with `TANDEM_ALLOW_UNAUTHENTICATED_LAN`).
 *   4. Concurrency mutex (in-flight check → 429).
 *   5. `homeOverride` forbidden in body.
 *   6. Persisted file re-validated through `IntegrationsFileSchema`.
 *
 * Per-integration loop:
 *   - `other-mcp` entries → status: "error", code: "OTHER_MCP_NOT_APPLICABLE".
 *   - Entries without a matching detected target → "error", code: "TARGET_NOT_DETECTED".
 *   - `apply: "skip"` → status: "skipped".
 *   - Otherwise: resolve `tokenSecretRef` via keychain, build entries, apply.
 *
 * `installSkill()` runs exactly once after the loop (per-user side effect).
 *
 * Response never echoes `entries`, `headers`, `env`, or any token-bearing
 * field — only `{ id, status, code?, message? }` per integration.
 */
function makeApplyHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    // 1. Origin allowlist.
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!isLocalhostOrigin(origin)) {
      res.status(403).json({
        error: "FORBIDDEN",
        code: ERROR_CODE_BAD_ORIGIN,
        message: "Origin not allowlisted for /api/integrations/apply",
      });
      return;
    }

    // 2. LAN unauth fail-closed.
    if (rejectUnauthLan(req, res)) return;

    // 3. Body validation (includes `homeOverride` rejection).
    const body = validateApplyBody(req.body);
    if (!body.ok) {
      res.status(400).json({
        error: "BAD_REQUEST",
        code: ERROR_CODE_INVALID_APPLY_REQUEST,
        message: body.message,
      });
      return;
    }

    // 4. Confirmation nonce.
    const gate = getApplyGate();
    if (body.data.confirmationNonce !== gate.nonce) {
      res.status(403).json({
        error: "FORBIDDEN",
        code: ERROR_CODE_INVALID_NONCE,
        message: "confirmationNonce does not match current server nonce",
      });
      return;
    }

    // 5. Concurrency mutex.
    if (gate.inFlight) {
      res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        code: ERROR_CODE_APPLY_IN_PROGRESS,
        message: "Another apply is in progress",
      });
      return;
    }
    gate.inFlight = true;
    try {
      // 6. Re-validate persisted file (defense-in-depth against disk tampering).
      let file;
      try {
        file = await deps.store.read();
      } catch (err) {
        sendInternal(res, err, "Failed to read integrations file for apply");
        return;
      }
      const parsed = IntegrationsFileSchema.safeParse(file);
      if (!parsed.success) {
        res.status(400).json({
          error: "BAD_REQUEST",
          code: ERROR_CODE_INVALID_PERSISTED_FILE,
          message: "Persisted integrations file fails validation",
        });
        return;
      }
      const persisted = parsed.data;

      // Server-side detection — request body never controls write paths.
      const targets = detectTargets();
      const targetByKind = new Map<string, (typeof targets)[number]>();
      for (const t of targets) {
        // Detected paths are server-built; assertPathSafe will run again
        // inside applyConfig as a final guard, but pre-checking here lets
        // us surface a clearer per-integration error if something is off.
        if (!targetByKind.has(t.kind)) targetByKind.set(t.kind, t);
      }

      const wantedIds = new Set(body.data.ids);
      const removals = body.data.removals ?? {};
      const results: ApplyItemResult[] = [];
      let anyApplied = false;

      const errorResult = (
        id: string,
        code: ApplyItemErrorCode,
        message: string,
      ): ApplyItemResult => ({ id, status: "error", code, message });

      for (const entry of persisted.integrations as IntegrationConfig[]) {
        if (!wantedIds.has(entry.id)) continue;

        // Server-side `other-mcp` filter — explicit even though the v3
        // schema already constrains other-mcp.apply to "skip".
        if (entry.kind === "other-mcp") {
          results.push(
            errorResult(
              entry.id,
              ERROR_CODE_OTHER_MCP_NOT_APPLICABLE,
              "Tandem cannot apply third-party MCP configs",
            ),
          );
          continue;
        }

        if (entry.apply === "skip") {
          results.push({ id: entry.id, status: "skipped" });
          continue;
        }

        const target = targetByKind.get(entry.kind);
        if (!target) {
          results.push(
            errorResult(
              entry.id,
              ERROR_CODE_TARGET_NOT_DETECTED,
              `${entry.kind} not installed on this machine`,
            ),
          );
          continue;
        }

        // Resolve token via keychain. Missing secret → per-integration
        // error, doesn't fail the batch.
        let token: string | undefined;
        if (entry.tokenSecretRef !== undefined) {
          try {
            const secret = await deps.keychain.getSecret(entry.tokenSecretRef);
            if (secret === null) {
              results.push(
                errorResult(
                  entry.id,
                  ERROR_CODE_SECRET_MISSING,
                  `Keychain has no secret for tokenSecretRef=${entry.tokenSecretRef}`,
                ),
              );
              continue;
            }
            token = secret;
          } catch (err) {
            if (err instanceof KeychainUnavailableError) {
              results.push(
                errorResult(entry.id, ERROR_CODE_SECRET_MISSING, "Keychain unavailable"),
              );
              continue;
            }
            results.push(
              errorResult(
                entry.id,
                ERROR_CODE_WRITE_FAILED,
                "Failed to resolve token from keychain",
              ),
            );
            console.error("[Tandem] apply: keychain error:", err);
            continue;
          }
        }

        const create = buildMcpEntries(CHANNEL_DIST, {
          token,
          targetKind: entry.kind,
          // Channel shim is opt-in only via removals; never auto-included.
        });
        const ops: ApplyOps = {
          create,
          remove: removals[entry.id] ?? [],
        };

        try {
          await applyConfig(target.configPath, ops);
          results.push({ id: entry.id, status: "applied" });
          anyApplied = true;
        } catch (err) {
          if (err instanceof PathRejectedError) {
            results.push(errorResult(entry.id, ERROR_CODE_PATH_REJECTED, err.message));
            continue;
          }
          results.push(
            errorResult(
              entry.id,
              ERROR_CODE_WRITE_FAILED,
              err instanceof Error ? err.message : String(err),
            ),
          );
          // Log full error server-side; response gets only the bare message.
          console.error(`[Tandem] apply: ${entry.id} → ${target.configPath} failed:`, err);
        }
      }

      // Skill install runs once if anything applied (per-user side effect).
      if (anyApplied) {
        try {
          await installSkill();
        } catch (err) {
          // Non-fatal; log only.
          console.error("[Tandem] apply: skill install failed:", err);
        }
      }

      // Rotate nonce on every successful apply (rejected calls don't burn the nonce).
      gate.nonce = randomBytes(32).toString("base64url");

      res.status(200).json({ results, nextNonce: gate.nonce });
    } finally {
      gate.inFlight = false;
    }
  };
}

/**
 * Validate the `:ref` path parameter. Express decodes URL-encoded params
 * before the handler sees them, so an attacker could pass arbitrary
 * bytes through `encodeURIComponent`. We constrain to a conservative
 * character class — alphanumeric, `-`, `_`, `~`, `.` — and a 256-char
 * upper bound. Native keychains accept much more, but the wizard only
 * ever generates short UUID-derived refs.
 */
const REF_CHAR_CLASS = /^[\w\-~.]+$/;
const REF_MAX_LENGTH = 256;
/** Practical upper bound for an auth token. Largest realistic API key is well under 4 KB. */
const SECRET_MAX_LENGTH = 8192;

function isValidRef(ref: unknown): ref is string {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= REF_MAX_LENGTH &&
    REF_CHAR_CLASS.test(ref)
  );
}

function makePostSecretHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (!isValidRef(req.params.ref)) {
      res.status(400).json({ error: "BAD_REQUEST", message: "Invalid :ref" });
      return;
    }
    const ref = req.params.ref;
    const secret = (req.body as { secret?: unknown }).secret;
    if (typeof secret !== "string" || secret.length === 0 || secret.length > SECRET_MAX_LENGTH) {
      res.status(400).json({
        error: "BAD_REQUEST",
        code: ERROR_CODE_INVALID_SECRET,
        message: `Body must include { secret: <non-empty string up to ${SECRET_MAX_LENGTH} chars> }`,
      });
      return;
    }
    try {
      await deps.keychain.setSecret(ref, secret);
      res.status(204).end();
    } catch (err) {
      sendKeychainError(res, err, "Failed to store secret");
    }
  };
}

function makeDeleteSecretHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (!isValidRef(req.params.ref)) {
      res.status(400).json({ error: "BAD_REQUEST", message: "Invalid :ref" });
      return;
    }
    try {
      const existed = await deps.keychain.deleteSecret(req.params.ref);
      res.status(200).json({ existed });
    } catch (err) {
      sendKeychainError(res, err, "Failed to delete secret");
    }
  };
}

/**
 * Internal-error response. The full error is logged server-side; the client
 * gets only a generic message. Other routes in this codebase follow the
 * same pattern — leaking filesystem paths or stack traces through the
 * response body is a no-no even on a loopback-only server.
 */
function sendInternal(res: Response, err: unknown, label: string): void {
  console.error(`[Tandem] ${label}:`, err);
  res.status(500).json({
    error: "INTERNAL",
    message: "Internal server error",
  });
}

/**
 * Map `KeychainUnavailableError` to HTTP 503 so the wizard can branch into the
 * env-var fallback UX. Other errors fall through to a generic 500.
 */
function sendKeychainError(res: Response, err: unknown, label: string): void {
  if (err instanceof KeychainUnavailableError) {
    res.status(503).json({
      error: "SERVICE_UNAVAILABLE",
      code: ERROR_CODE_KEYCHAIN_UNAVAILABLE,
      message: err.message,
    });
    return;
  }
  sendInternal(res, err, label);
}
