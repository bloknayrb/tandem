/**
 * HTTP API routes for the Models registry's keychain secrets (#659).
 *
 * Routes:
 *   POST   /api/models/secrets/:ref   — store an outbound provider API key in
 *                                       the OS keychain under `ref` (service
 *                                       `tandem-models`).
 *   DELETE /api/models/secrets/:ref   — remove a stored key.
 *
 * **Secrets never travel back to the client.** There is intentionally no
 * `GET .../secrets/:ref` route — only server-side code (a future LLM client
 * wired in `src/server/`) will read the plaintext when proxying an outbound
 * request. The client persists only the opaque `apiKeyRef` in `tandem:settings`.
 *
 * Mirrors `src/server/integrations/api-routes.ts`'s secret-route shape — same
 * security gates (origin allowlist + loopback-for-mutation), same ref
 * validation, same 503 mapping for `KeychainUnavailableError`. The keychain
 * instance passed in here is scoped to a separate service (`tandem-models`,
 * see `KEYCHAIN_SERVICE_MODELS`) so refs cannot accidentally cross over
 * with inbound MCP-client tokens.
 */

import type { Express, Request, Response } from "express";
import { ERROR_CODE_INVALID_SECRET } from "../../shared/integrations/contract.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
  sendKeychainError,
} from "../integrations/api-routes.js";
import type { Keychain } from "../integrations/keychain.js";
import type { Handler } from "../mcp/routes/_shared.js";

/** Express route pattern. The client picks `:ref` (opaque base64url, 128 bits of entropy). */
export const API_MODELS_SECRET = "/api/models/secrets/:ref";

export interface ModelsRoutesDeps {
  keychain: Keychain;
}

// Ref / secret bounds. Refs are client-chosen but server-validated against
// `REF_CHAR_CLASS` so a malformed value (path traversal, oversized blob) is
// rejected before reaching the native keychain backend.
const REF_CHAR_CLASS = /^[A-Za-z0-9_-]+$/;
const REF_MAX_LENGTH = 64;
const SECRET_MAX_LENGTH = 8192;

function isValidRef(ref: unknown): ref is string {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= REF_MAX_LENGTH &&
    REF_CHAR_CLASS.test(ref)
  );
}

export function registerModelsRoutes(
  app: Express,
  largeBody: Handler,
  mw: Handler,
  deps: ModelsRoutesDeps,
): void {
  app.options(API_MODELS_SECRET, mw);
  app.post(API_MODELS_SECRET, mw, largeBody, makePostSecretHandler(deps));
  app.delete(API_MODELS_SECRET, mw, makeDeleteSecretHandler(deps));
}

function makePostSecretHandler(deps: ModelsRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_MODELS_SECRET)) return;
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
      sendKeychainError(res, err, "Failed to store model secret");
    }
  };
}

function makeDeleteSecretHandler(deps: ModelsRoutesDeps): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_MODELS_SECRET)) return;
    if (assertLoopbackForMutation(req, res)) return;
    if (!isValidRef(req.params.ref)) {
      res.status(400).json({ error: "BAD_REQUEST", message: "Invalid :ref" });
      return;
    }
    try {
      const existed = await deps.keychain.deleteSecret(req.params.ref);
      res.status(200).json({ existed });
    } catch (err) {
      sendKeychainError(res, err, "Failed to delete model secret");
    }
  };
}
