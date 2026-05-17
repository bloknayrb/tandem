/**
 * HTTP API routes for the integration setup wizard (#477 PR 3c-i).
 *
 * Routes:
 *   GET    /api/integrations/existing   — list existing Tandem MCP entries detected
 *                                          in `~/.claude.json` and Claude Desktop config.
 *                                          Non-mutating (PR 3a `readExistingTandemEntries`).
 *   GET    /api/integrations            — read the persisted `integrations.json` file.
 *   POST   /api/integrations            — write a new integrations file (Zod-validated).
 *   POST   /api/integrations/secrets/:ref — store a secret in the OS keychain under `ref`.
 *                                            Body: `{ secret: string }`.
 *   DELETE /api/integrations/secrets/:ref — remove a secret.
 *
 * **Secrets never travel back to the client.** There is no `GET .../secrets/:ref`
 * route — only the server reads secrets when proxying to MCP clients. The
 * client only ever sees `tokenSecretRef`, never the actual token.
 *
 * **Keychain failures degrade gracefully.** `KeychainUnavailableError` from
 * `keychain.ts` maps to HTTP 503 with a `code: "KEYCHAIN_UNAVAILABLE"` body
 * so the wizard can surface env-var fallback guidance to the user.
 */

import type { Express, Request, Response } from "express";

import {
  API_INTEGRATIONS,
  API_INTEGRATIONS_EXISTING,
  ERROR_CODE_INVALID_INTEGRATIONS_FILE,
  ERROR_CODE_INVALID_SECRET,
  ERROR_CODE_KEYCHAIN_UNAVAILABLE,
} from "../../shared/integrations/contract.js";
import type { Handler } from "../mcp/routes/_shared.js";
import type { readExistingTandemEntries } from "./existing-config.js";
import { type Keychain, KeychainUnavailableError } from "./keychain.js";
import { IntegrationsFileSchema } from "./schema.js";
import type { IntegrationsStore } from "./storage.js";

export { API_INTEGRATIONS, API_INTEGRATIONS_EXISTING } from "../../shared/integrations/contract.js";
/** Express route pattern — `:ref` is filled in by the client via {@link apiIntegrationsSecretPath}. */
export const API_INTEGRATIONS_SECRET = "/api/integrations/secrets/:ref";

export interface IntegrationsRoutesDeps {
  store: IntegrationsStore;
  keychain: Keychain;
  /** Injected so tests can swap the detector without filesystem fixtures. */
  readExisting: typeof readExistingTandemEntries;
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

  app.options(API_INTEGRATIONS_SECRET, mw);
  app.post(API_INTEGRATIONS_SECRET, mw, largeBody, makePostSecretHandler(deps));
  app.delete(API_INTEGRATIONS_SECRET, mw, makeDeleteSecretHandler(deps));
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
      res.status(204).end();
    } catch (err) {
      sendInternal(res, err, "Failed to write integrations file");
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
