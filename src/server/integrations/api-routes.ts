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
 *   GET    /api/integrations/claude-cli-status   — `{ presence }` binary probe.
 *                                                  Read-only, no gates (enum-only
 *                                                  output — never the resolved path).
 *   POST   /api/integrations/install-claude-code — download + run the native
 *                                                  installer. Origin + loopback
 *                                                  gates + mutex, NO nonce (S3).
 *
 * **Secrets never travel back to the client.** There is no `GET .../secrets/:ref`
 * route — only the server reads secrets when proxying to MCP clients. The
 * client only ever sees `tokenSecretRef`, never the actual token.
 *
 * **Apply endpoint security gates** (all enforced before any FS write):
 * - Origin allowlist (CSRF mitigation against same-origin drive-by).
 * - Confirmation nonce — issued by GET /first-run-needed and POST /integrations.
 * - Loopback-only, in every configuration (#1293) — the flag does not relax it.
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

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Express, Request, Response } from "express";
import { TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV } from "../../shared/constants.js";
import {
  API_INTEGRATIONS,
  API_INTEGRATIONS_APPLY,
  API_INTEGRATIONS_CLAUDE_CLI_STATUS,
  API_INTEGRATIONS_EXISTING,
  API_INTEGRATIONS_FIRST_RUN,
  API_INTEGRATIONS_INSTALL_CLAUDE_CODE,
  type ApplyItemErrorCode,
  type ApplyItemResult,
  type ClaudeCliStatusResponse,
  ERROR_CODE_APPLY_IN_PROGRESS,
  ERROR_CODE_BAD_ORIGIN,
  ERROR_CODE_INSTALL_FAILED,
  ERROR_CODE_INSTALL_IN_PROGRESS,
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
  ERROR_CODE_UNSUPPORTED_PLATFORM,
  ERROR_CODE_WRITE_FAILED,
  type InstallClaudeCodeResponse,
} from "../../shared/integrations/contract.js";
import { isLoopback } from "../auth/middleware.js";
import { isLocalhostOrigin } from "../mcp/api-routes.js";
import {
  type Handler,
  isLoopbackRequest,
  type PeerRequest,
  scrubPathForCaller,
} from "../mcp/routes/_shared.js";
import {
  type ApplyOps,
  applyConfig,
  buildMcpEntries,
  CHANNEL_DIST,
  detectClaudeCli,
  detectTargets,
  installSkill,
  isBareNameLaunchable,
  type McpEntry,
  PathRejectedError,
  type RemovableEntry,
  shouldRegisterChannelShim,
} from "./apply.js";
import {
  type EntryValidation,
  type ExistingMcpInstall,
  hasExistingTandemEntry,
  type readExistingTandemEntries,
} from "./existing-config.js";
import {
  ClaudeInstallError,
  installClaudeCli,
  UnsupportedPlatformError,
} from "./install-claude-cli.js";
import { type Keychain, KeychainUnavailableError } from "./keychain.js";
import { type IntegrationConfig, IntegrationsFileSchema } from "./schema.js";
import type { IntegrationsStore } from "./storage.js";

export {
  API_INTEGRATIONS,
  API_INTEGRATIONS_APPLY,
  API_INTEGRATIONS_CLAUDE_CLI_STATUS,
  API_INTEGRATIONS_EXISTING,
  API_INTEGRATIONS_FIRST_RUN,
  API_INTEGRATIONS_INSTALL_CLAUDE_CODE,
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
  /**
   * Optional target detector override. Production routes leave this undefined
   * and call the real `detectTargets()` (reads ~/.claude.json etc). Tests
   * inject a stub that returns tmpdir-anchored paths so apply-path coverage
   * doesn't require the test process to own a real Claude install.
   */
  detectTargets?: typeof detectTargets;
  /**
   * Optional channel-shim decision override. Production leaves this undefined
   * and calls the real `shouldRegisterChannelShim()`, which probes the disk
   * (`existsSync(dist/channel/index.js)`). Tests inject a deterministic stub so
   * apply-path assertions don't depend on whether the channel bundle happens to
   * be built in the working tree.
   */
  shouldRegisterChannelShim?: typeof shouldRegisterChannelShim;
  /**
   * Optional Claude-CLI binary detector override. Production leaves this
   * undefined and calls the real `detectClaudeCli()`. Tests inject a stub so
   * the status route's response doesn't depend on whether the test process
   * happens to have the `claude` binary on PATH.
   */
  detectClaudeCli?: typeof detectClaudeCli;
  /**
   * Optional launchability-probe override, injected for the same reason as
   * `detectClaudeCli`: the real one reads the test process's own PATH.
   */
  isBareNameLaunchable?: typeof isBareNameLaunchable;
  /**
   * Optional installer-runner override. Production leaves this undefined.
   * Tests inject a stub so the install route never downloads + executes the
   * real installer.
   */
  installClaudeCli?: typeof installClaudeCli;
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

/**
 * Test-only: reset the apply gate between cases. Guarded on `VITEST`
 * (set by Vitest itself, not user-controllable in production) rather
 * than `NODE_ENV` — a misconfigured runner / container default should
 * not be able to expose this surface.
 */
export function _resetApplyGateForTests(): void {
  if (process.env.VITEST !== "true") {
    throw new Error("_resetApplyGateForTests is test-only");
  }
  applyGate = createApplyGate();
}

/**
 * Concurrency mutex for `POST /api/integrations/install-claude-code`. Unlike
 * {@link ApplyGateState} this carries NO nonce (S3): there's no persisted
 * intent to bind the call to, the install is host-pinned + idempotent, and a
 * loopback-origin attacker who could read a GET-exposed nonce could already
 * run the installer directly. Origin + loopback gates + this mutex are the
 * full protection.
 */
let installInFlight = false;

function getInstallGate(): { inFlight: boolean } {
  return {
    get inFlight() {
      return installInFlight;
    },
    set inFlight(v: boolean) {
      installInFlight = v;
    },
  };
}

/** Test-only: clear the install mutex between cases. */
export function _resetInstallGateForTests(): void {
  if (process.env.VITEST !== "true") {
    throw new Error("_resetInstallGateForTests is test-only");
  }
  installInFlight = false;
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

  app.options(API_INTEGRATIONS_CLAUDE_CLI_STATUS, mw);
  app.get(API_INTEGRATIONS_CLAUDE_CLI_STATUS, mw, makeGetClaudeCliStatusHandler(deps));

  app.options(API_INTEGRATIONS_INSTALL_CLAUDE_CODE, mw);
  // No body parser — the install route takes no request body.
  app.post(API_INTEGRATIONS_INSTALL_CLAUDE_CODE, mw, makePostInstallClaudeCodeHandler(deps));
}

/**
 * Mutating routes fail closed for non-loopback callers, in every configuration.
 *
 * Until #1293 this check was conditional on `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1`,
 * which inverted it: the stricter posture applied only in the *more permissive*
 * configuration, and the gate was dead code in every shipped build. The exposed
 * configuration was never the flag — it was `TANDEM_BIND_HOST=<lan>` **with** a
 * token, which `bind-check.ts:74` permits and which left this function returning
 * `false` unconditionally. A token-holding LAN peer reached every mutator.
 *
 * What this is and is not:
 *
 * - It is **not** the protection. The loopback bind plus Bearer auth is; see
 *   CLAUDE.md's Security section. `assertOriginAllowlisted`, its usual partner,
 *   reads a forgeable header and is a CSRF control, not an authorization one.
 * - It **is** the layer that stops a caller who holds the token but is not on
 *   this machine — the one case the other two do not cover.
 *
 * The cost of making it unconditional is nil for the shipped client: `API_BASE`
 * (`src/client/utils/fileUpload.ts`) is `MCP_BASE_URL` from
 * `src/client/utils/backend-ports.ts`, whose **host is the hardcoded literal
 * `127.0.0.1`** — only the port is configurable, and only at build time, via a
 * `VITE_TANDEM_MCP_PORT` no shipped build ever carries (#1492;
 * `scripts/build-client.mjs` strips it). So a browser served from a LAN address
 * still resolves it to the *viewer's* machine and has never been able to reach
 * `/api` remotely. If remote `/api` access ever becomes a goal, that host
 * literal is the thing to change first, deliberately.
 *
 * Scope: this governs the routes that call it — and since #1320 that is no
 * longer the same question as whether `/api` is loopback-only. That property now
 * holds structurally, from `enforceLoopbackMutation` mounted `app.use("/api", …)`
 * in `server.ts`, which covers every non-GET request including the nine routes
 * that call neither helper. The 23 call sites here are the second layer, kept
 * because they carry route-specific copy (the license route's buyer-facing 403)
 * and because a single mounted middleware is a single thing to get wrong.
 *
 * So: a route calling this is doubly covered; a route not calling it is covered
 * once. Neither is uncovered, and neither fact is visible at a registration site
 * — which is exactly why the invariant was moved to the mount.
 */
export function assertLoopbackForMutation(
  req: Request,
  res: Response,
  // Optional user-facing override. The decision is unchanged — this only
  // replaces the copy, so a route whose caller is a *person* (license
  // activation) doesn't hand them a sentence about integration routes and an
  // env var they've never heard of.
  friendlyMessage?: string,
): boolean {
  if (!isLoopback(req.socket.remoteAddress)) {
    res.status(403).json({
      error: "FORBIDDEN",
      code: ERROR_CODE_BAD_ORIGIN,
      message:
        friendlyMessage ??
        // Deliberately no longer names TANDEM_ALLOW_UNAUTHENTICATED_LAN. The flag
        // is not part of this decision any more, and naming it invited the reader
        // to think setting or clearing it would change the outcome.
        "This route is loopback-only: it must be called from the computer running Tandem. Holding an auth token is not sufficient.",
    });
    return true;
  }
  return false;
}

/**
 * CSRF gate for mutating integration routes. A same-origin malicious page
 * on loopback can otherwise drive POST /integrations and the secrets routes
 * (it can't drive apply because apply already gates on origin, but it can
 * stage a payload). The check is the same `isLocalhostOrigin` allowlist
 * apply uses — loopback + Tauri WebView.
 *
 * Returns true if the response was sent (caller should `return`).
 */
export function assertOriginAllowlisted(
  req: Request,
  res: Response,
  routeLabel: string,
  /** Optional user-facing override; see `assertLoopbackForMutation`. */
  friendlyMessage?: string,
): boolean {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!isLocalhostOrigin(origin)) {
    res.status(403).json({
      error: "FORBIDDEN",
      code: ERROR_CODE_BAD_ORIGIN,
      message: friendlyMessage ?? `Origin not allowlisted for ${routeLabel}`,
    });
    return true;
  }
  return false;
}

/**
 * Scrub the two GET responses below for non-loopback callers (#1294).
 *
 * Both routes are ungated — no origin check, no loopback check — deliberately,
 * so the wizard can read them; that makes them the widest-reaching disclosure
 * of the four surfaces in #1294. `readOneTarget` has no request context at all
 * and neither handler used to keep one, which is exactly how the existing
 * basename convention was missed here.
 *
 * `errorMessage` is replaced wholesale rather than pattern-scrubbed: it is a
 * raw `readFile` failure, and Node's formatting embeds the path it was reading.
 * `status` already carries the actionable signal, so the enum loses nothing a
 * caller can act on.
 *
 * `configPath` is not the only path here. The surfaced `tandemEntry` /
 * `channelEntry` are what Tandem itself wrote — `{ command: <absolute node
 * binary>, args: [<absolute dist/channel/index.js>] }` (apply.ts
 * `buildMcpEntries`) — so leaving them raw discloses the username and the whole
 * install layout on exactly the route this scrub exists for. `extractEntry`
 * strips only `env`/`headers`; it is a secrets filter, not a path filter.
 * Validation `reason` strings embed the same paths (`JSON.stringify(args)`,
 * `got '<command>'`), so they are replaced by status-derived copy the way
 * `errorMessage` is — `status` is the field the wizard actually branches on.
 */
function scrubExistingInstalls(req: PeerRequest, installs: ExistingMcpInstall[]) {
  if (isLoopbackRequest(req)) return installs;
  return installs.map((install) => ({
    ...install,
    target: { ...install.target, configPath: scrubPathForCaller(req, install.target.configPath) },
    ...(install.tandemEntry === undefined
      ? {}
      : { tandemEntry: scrubMcpEntry(req, install.tandemEntry) }),
    ...(install.channelEntry === undefined
      ? {}
      : { channelEntry: scrubMcpEntry(req, install.channelEntry) }),
    ...(install.tandemValidation === undefined
      ? {}
      : { tandemValidation: scrubValidation(install.tandemValidation) }),
    ...(install.channelValidation === undefined
      ? {}
      : { channelValidation: scrubValidation(install.channelValidation) }),
    ...(install.errorMessage === undefined
      ? {}
      : { errorMessage: "Could not read the configuration file." }),
  }));
}

/**
 * Basename `command` and every `args` element of a surfaced MCP entry.
 *
 * `url` is deliberately left alone: it is a loopback http URL by construction
 * and carries no filesystem layout.
 *
 * Rebuilt from an explicit field list rather than `{...entry, command, args}`,
 * because `entry` is not a validated `McpEntry` — `extractEntry` casts whatever
 * `mcpServers.<name>` held in the user's config file, minus `env`/`headers`. A
 * spread therefore re-exports every key that file happened to carry (a
 * hand-added `cwd` is an absolute path, and `env`/`headers` would come back the
 * day `extractEntry` stops stripping them). An allowlist cannot regress that
 * way; the four keys below are the whole of what any consumer reads.
 */
function scrubMcpEntry(req: PeerRequest, entry: McpEntry): McpEntry {
  return {
    ...(entry.type === undefined ? {} : { type: entry.type }),
    ...(entry.url === undefined ? {} : { url: entry.url }),
    ...(typeof entry.command === "string"
      ? { command: scrubPathForCaller(req, entry.command) }
      : {}),
    ...(Array.isArray(entry.args)
      ? { args: entry.args.map((a) => (typeof a === "string" ? scrubPathForCaller(req, a) : a)) }
      : {}),
  };
}

/** Path-free replacement for an {@link EntryValidation} reason. */
function scrubValidation(v: EntryValidation): EntryValidation {
  if (v.reason === undefined) return v;
  return { status: v.status, reason: VALIDATION_REASON[v.status] };
}

const VALIDATION_REASON: Record<EntryValidation["status"], string> = {
  valid: "Entry matches the expected shape.",
  "invalid-shape": "Entry does not match the expected shape.",
  "invalid-url": "Entry url is not a loopback http URL.",
  "invalid-command": "Entry command is not the expected launcher.",
  "invalid-args": "Entry arguments do not match the expected shape.",
};

function makeGetExistingHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    try {
      const installs = await deps.readExisting();
      res.json({ installs: scrubExistingInstalls(req, installs) });
    } catch (err) {
      sendInternal(res, err, "Failed to read existing integration entries");
    }
  };
}

function makeGetIntegrationsHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    try {
      const file = await deps.store.read();
      // #1294 names this route alongside /existing. Every claude-code and
      // claude-desktop entry carries `configPath` (and optionally
      // `workingDirectory`) as an AbsolutePath, and this handler returned the
      // stored file verbatim through a discarded `_req`.
      if (isLoopbackRequest(req)) {
        res.json(file);
        return;
      }
      res.json({
        ...file,
        integrations: file.integrations.map((entry) => ({
          ...entry,
          ...("configPath" in entry && typeof entry.configPath === "string"
            ? { configPath: scrubPathForCaller(req, entry.configPath) }
            : {}),
          ...("workingDirectory" in entry && typeof entry.workingDirectory === "string"
            ? { workingDirectory: scrubPathForCaller(req, entry.workingDirectory) }
            : {}),
        })),
      });
    } catch (err) {
      sendInternal(res, err, "Failed to read integrations file");
    }
  };
}

function makePostIntegrationsHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_INTEGRATIONS)) return;
    if (assertLoopbackForMutation(req, res)) return;
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
 * Nonce in the response binds the next apply call to the most recent
 * persist or first-run-needed response. (A subsequent
 * `POST /api/integrations` rotates the nonce, so persist → persist →
 * apply uses the second persist's nonce.) The wizard caches the value
 * and passes it in `POST /api/integrations/apply.confirmationNonce`.
 */
function makeFirstRunHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (_req: Request, res: Response) => {
    try {
      // `TANDEM_DISABLE_FIRST_RUN_WIZARD=1` short-circuits auto-open without
      // touching `integrations.json`. Used by the E2E test harness — the
      // wizard auto-open would otherwise cover unrelated editor surfaces on
      // every `page.goto()`. The integration-wizard.spec.ts test does NOT
      // set this var (it explicitly exercises the manual-reopen affordance).
      const forceDisable = process.env[TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV] === "1";
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
      // Intentional: a 500 here lets the client default to "wizard not
      // needed" (see useFirstRunNeeded.svelte.ts's catch branch). The
      // safer fail-mode is to NOT auto-open the wizard over the user's
      // editor session when something on the server side is wedged.
      // Manual reopen via Settings remains available. Don't "fix" this
      // path by surfacing a structured `{ needed: false }` body — the
      // client already gets that behaviour from any non-OK response.
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
 *   - Origin allowlist (CSRF).
 *   - Loopback-only, in every configuration (#1293).
 *   - `homeOverride` forbidden in body (validated in `validateApplyBody`).
 *   - Constant-time confirmation-nonce comparison.
 *   - Concurrency mutex (in-flight check → 429).
 *   - Persisted file re-validated through `IntegrationsFileSchema`.
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
    if (assertOriginAllowlisted(req, res, API_INTEGRATIONS_APPLY)) return;
    if (assertLoopbackForMutation(req, res)) return;

    const body = validateApplyBody(req.body);
    if (!body.ok) {
      res.status(400).json({
        error: "BAD_REQUEST",
        code: ERROR_CODE_INVALID_APPLY_REQUEST,
        message: body.message,
      });
      return;
    }

    // timingSafeEqual matches the auth-middleware precedent — string `!==`
    // short-circuits at the first differing byte. The 256-bit randomness
    // makes a realistic timing attack negligible; the constant-time compare
    // is one line for consistency with `auth/middleware.ts`.
    const gate = getApplyGate();
    const received = Buffer.from(body.data.confirmationNonce);
    const expected = Buffer.from(gate.nonce);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.status(403).json({
        error: "FORBIDDEN",
        code: ERROR_CODE_INVALID_NONCE,
        message: "confirmationNonce does not match current server nonce",
      });
      return;
    }

    if (gate.inFlight) {
      res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        code: ERROR_CODE_APPLY_IN_PROGRESS,
        message: "Another apply is in progress",
      });
      return;
    }
    try {
      // Set inside the try so a throw between `inFlight = true` and `try {`
      // can't strand the mutex.
      gate.inFlight = true;
      // Re-validate the persisted file at apply time: catches disk
      // tampering or schema drift since the last persist.
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
      const targets = (deps.detectTargets ?? detectTargets)();
      const targetByKind = new Map<string, (typeof targets)[number]>();
      for (const t of targets) {
        // Detected paths are server-built; assertPathSafe will run again
        // inside applyConfig as a final guard, but pre-checking here lets
        // us surface a clearer per-integration error if something is off.
        //
        // Duplicate-target collapse: when multiple MSIX packages match,
        // only the first one wins per kind. The detector's label already
        // disambiguates by suffixing `(${pkg.slice(0,12)}…)`, so the
        // user-visible picker shows which install was selected.
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
        // `apply: "update"` is reserved for a planned diff-confirmation UX
        // (the wizard will preview the merged config before commit). Until
        // that ships, "update" behaves identically to "create" — both fall
        // through to `applyConfig` here. Don't "clean up" the apparently-
        // dead alternative; the schema would have to bump to add it back.

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
              // Static client-facing message: echoing the ref value back
              // would confirm to a wire observer which refs exist on the
              // host. The ref itself is opaque, but a leak still aids
              // cross-request correlation.
              console.error(
                `[Tandem] apply: keychain has no secret for tokenSecretRef=${entry.tokenSecretRef}`,
              );
              results.push(
                errorResult(
                  entry.id,
                  ERROR_CODE_SECRET_MISSING,
                  "Secret not available for this integration",
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

        // No third argument, so this is always false since Track E made the
        // shim opt-in — the wizard writes the tandem HTTP entry and nothing
        // else. There is deliberately NO wizard checkbox: the CLI flag is the
        // only opt-in, and any docs claiming otherwise are wrong (that claim
        // was in three places until 2026-08-09).
        //
        // This route never REMOVES the shim either — `remove` below comes from
        // the user's confirmed diff, not from `applyOpsForCli` — so an existing
        // entry survives a wizard apply. That is the intended asymmetry.
        const withChannelShim = (deps.shouldRegisterChannelShim ?? shouldRegisterChannelShim)(
          entry.kind,
          CHANNEL_DIST,
        );
        const create = buildMcpEntries(CHANNEL_DIST, {
          token,
          targetKind: entry.kind,
          withChannelShim,
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
            // err.message embeds the resolved realpath — keep it for the
            // server log but return a static client-facing message.
            console.error(
              `[Tandem] apply: ${entry.id} → ${target.configPath} path-rejected:`,
              err.message,
            );
            results.push(
              errorResult(
                entry.id,
                ERROR_CODE_PATH_REJECTED,
                "Refused to operate on a symlinked, network, or out-of-tree config path",
              ),
            );
            continue;
          }
          // Node's ENOENT formatting embeds the offending path; echoing
          // err.message back to the client would leak filesystem layout.
          console.error(`[Tandem] apply: ${entry.id} → ${target.configPath} failed:`, err);
          results.push(
            errorResult(
              entry.id,
              ERROR_CODE_WRITE_FAILED,
              "Failed to apply config — see server logs",
            ),
          );
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
    if (assertOriginAllowlisted(req, res, API_INTEGRATIONS_SECRET)) return;
    if (assertLoopbackForMutation(req, res)) return;
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
    if (assertOriginAllowlisted(req, res, API_INTEGRATIONS_SECRET)) return;
    if (assertLoopbackForMutation(req, res)) return;
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
 * GET /api/integrations/claude-cli-status
 *
 * Read-only binary probe. Intentionally NO origin / loopback gate (mirrors
 * `GET .../existing`) — it's reachable from LAN under
 * `TANDEM_ALLOW_UNAUTHENTICATED_LAN`, so the response is **enum-only**: the
 * `ClaudeCliStatusResponse` type carries no path field, and the handler must
 * never widen it (F6 — a path would leak the home layout / username).
 */
function makeGetClaudeCliStatusHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (_req: Request, res: Response) => {
    try {
      const presence = (deps.detectClaudeCli ?? detectClaudeCli)();
      const body: ClaudeCliStatusResponse = {
        presence,
        bareNameLaunchable: (deps.isBareNameLaunchable ?? isBareNameLaunchable)(),
      };
      res.json(body);
    } catch (err) {
      sendInternal(res, err, "Failed to probe Claude CLI status");
    }
  };
}

/**
 * POST /api/integrations/install-claude-code
 *
 * Downloads + runs the official native installer. Gated by origin allowlist +
 * loopback-only (the install touches files outside Tandem's data dir) + a
 * concurrency mutex. NO confirmation nonce (S3): there's no persisted intent
 * to bind, the install is host-pinned + idempotent, and the protection the
 * nonce gives elsewhere (intent-binding for persist→apply) doesn't apply.
 */
function makePostInstallClaudeCodeHandler(deps: IntegrationsRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_INTEGRATIONS_INSTALL_CLAUDE_CODE)) return;
    if (assertLoopbackForMutation(req, res)) return;

    const gate = getInstallGate();
    if (gate.inFlight) {
      res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        code: ERROR_CODE_INSTALL_IN_PROGRESS,
        message: "Another install is in progress",
      });
      return;
    }

    try {
      // Set inside the try so a throw between the check and the body can't
      // strand the mutex (mirrors makeApplyHandler).
      gate.inFlight = true;
      const presence = await (deps.installClaudeCli ?? installClaudeCli)();
      const body: InstallClaudeCodeResponse = {
        ok: true,
        presence,
        bareNameLaunchable: (deps.isBareNameLaunchable ?? isBareNameLaunchable)(),
      };
      res.status(200).json(body);
    } catch (err) {
      if (err instanceof UnsupportedPlatformError) {
        res.status(400).json({
          error: "BAD_REQUEST",
          code: ERROR_CODE_UNSUPPORTED_PLATFORM,
          message: err.message,
        });
        return;
      }
      if (err instanceof ClaudeInstallError) {
        // `stderrTail` is the one intentional detail-in-response exception
        // (honest-failure-surfacing); the runner already scrubbed the temp
        // path and the env never reached the script (F1).
        res.status(500).json({
          error: "INTERNAL",
          code: ERROR_CODE_INSTALL_FAILED,
          message: "Claude installer failed",
          exitCode: err.exitCode,
          stderrTail: err.stderrTail,
        });
        return;
      }
      sendInternal(res, err, "Failed to install Claude Code");
    } finally {
      gate.inFlight = false;
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
export function sendKeychainError(res: Response, err: unknown, label: string): void {
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
