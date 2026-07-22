/**
 * HTTP API routes for the Models registry (#659 secrets; #1123 M1a registry).
 *
 * Routes:
 *   POST   /api/models                — replace the whole server-side registry
 *                                       file (`models.json`). The client's
 *                                       one-time localStorage→server migration
 *                                       (M1a) and future CRUD write-through (M2)
 *                                       target this.
 *   POST   /api/models/secrets/:ref   — store an outbound provider API key in
 *                                       the OS keychain under `ref` (service
 *                                       `tandem-models`).
 *   DELETE /api/models/secrets/:ref   — remove a stored key.
 *
 * **Secrets never travel back to the client.** There is intentionally no
 * `GET .../secrets/:ref` route — only server-side code reads the plaintext when
 * proxying an outbound request. Only the opaque `apiKeyRef` is persisted; the
 * registry file itself holds no plaintext (the schema is `.strict()`).
 *
 * All routes mirror `src/server/integrations/api-routes.ts`'s gating — origin
 * allowlist + loopback-for-mutation, and (registry route) a `.strict()`
 * safeParse defense-in-depth. `POST` (not `PUT`): `Access-Control-Allow-Methods`
 * omits PUT, so a PUT preflight from the cross-origin `tauri.localhost` client
 * would be rejected. The keychain is scoped to a separate service
 * (`tandem-models`, `KEYCHAIN_SERVICE_MODELS`) so refs can't cross over with
 * inbound MCP-client tokens.
 */

import type { Express, Request, Response } from "express";
import { ERROR_CODE_INVALID_SECRET } from "../../shared/integrations/contract.js";
import {
  API_MODELS,
  ERROR_CODE_INVALID_MODELS_FILE,
  ERROR_CODE_MODELS_WRITE_FAILED,
} from "../../shared/models/contract.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
  sendKeychainError,
} from "../integrations/api-routes.js";
import type { Keychain } from "../integrations/keychain.js";
import type { Handler } from "../mcp/routes/_shared.js";
import { persistModelsFile } from "./registry.js";
import { ModelsFileSchema } from "./schema.js";

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
  app.options(API_MODELS, mw);
  app.post(API_MODELS, mw, largeBody, makePostModelsHandler());
  app.options(API_MODELS_SECRET, mw);
  app.post(API_MODELS_SECRET, mw, largeBody, makePostSecretHandler(deps));
  app.delete(API_MODELS_SECRET, mw, makeDeleteSecretHandler(deps));
}

/**
 * Whole-file replace of the server-side registry. Gated origin → loopback →
 * `.strict()` safeParse (defense-in-depth), matching `POST /api/integrations`.
 * No nonce/mutex: an idempotent whole-file replace confined to the app-data
 * dir, unlike `apply` (which writes outside it behind a confirmation handshake).
 * Deliberately NOT license-gated — a registry-config write is not a
 * document/annotation content write (the local model's content mutations gate
 * separately at the `tools.ts` dispatch boundary).
 */
function makePostModelsHandler(): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_MODELS)) return;
    if (assertLoopbackForMutation(req, res)) return;
    const parsed = ModelsFileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "BAD_REQUEST",
        code: ERROR_CODE_INVALID_MODELS_FILE,
        message: "Body failed models-registry validation.",
      });
      return;
    }
    try {
      await persistModelsFile(parsed.data);
      res.status(200).json({ ok: true });
    } catch {
      // No path/detail leak — the registry write failed on disk.
      res.status(500).json({ error: "INTERNAL", code: ERROR_CODE_MODELS_WRITE_FAILED });
    }
  };
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
