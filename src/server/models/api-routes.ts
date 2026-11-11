/**
 * HTTP API routes for the Models registry (#659 secrets; #1123 M1a registry).
 *
 * Routes:
 *   GET    /api/models                — load the registry (+ a content-hash
 *                                       ETag). Loopback-full / LAN-scrubbed.
 *                                       The client store's load source (M2).
 *   POST   /api/models                — replace the whole server-side registry
 *                                       file (`models.json`). The client's
 *                                       localStorage→server reconcile and CRUD
 *                                       write-through (M2) target this.
 *   POST   /api/models/secrets/:ref   — store an outbound provider API key in
 *                                       the OS keychain under `ref` (service
 *                                       `tandem-models`).
 *   DELETE /api/models/secrets/:ref   — remove a stored key.
 *
 *   GET    /api/models/local-settings — whether local models may comment and
 *                                       suggest (#1123). Loopback only.
 *   POST   /api/models/local-settings — switch that setting. Body
 *                                       `{ editing: boolean }`.
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
import { BYO_MODELS_ENABLED } from "../../shared/constants.js";
import { ERROR_CODE_INVALID_SECRET } from "../../shared/integrations/contract.js";
import {
  API_MODELS,
  API_MODELS_LOCAL_SETTINGS,
  ERROR_CODE_INVALID_LOCAL_MODEL_SETTINGS,
  ERROR_CODE_INVALID_MODELS_FILE,
  ERROR_CODE_LOCAL_MODEL_SETTINGS_WRITE_FAILED,
  ERROR_CODE_MODELS_BUSY,
  ERROR_CODE_MODELS_STALE,
  ERROR_CODE_MODELS_WRITE_FAILED,
  type LocalModelSettingsPostResponse,
  type LocalModelSettingsResponse,
  type ModelsEntry,
  type ModelsFile,
  type ModelsGetResponse,
  type ModelsPostResponse,
} from "../../shared/models/contract.js";
import { isLoopback } from "../auth/middleware.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
  sendKeychainError,
} from "../integrations/api-routes.js";
import type { Keychain } from "../integrations/keychain.js";
import type { Handler } from "../mcp/routes/_shared.js";
import { isLocalModelEditingEnabled, setLocalModelEditing } from "./local-model-settings.js";
import {
  getCachedModelsFile,
  getModelsEtag,
  hashModelsFile,
  persistModelsFileIfMatch,
} from "./registry.js";
import { ModelsFileSchema } from "./schema.js";

/** Express route pattern. The client picks `:ref` (opaque base64url, 128 bits of entropy). */
export const API_MODELS_SECRET = "/api/models/secrets/:ref";

export interface ModelsRoutesDeps {
  keychain: Keychain;
  /**
   * Are the local-model settings routes live? Defaults to `BYO_MODELS_ENABLED`,
   * so in a release they answer 404 and neither read nor write anything while
   * the feature is dark. A test passes `true` to exercise them.
   */
  localModelSettingsEnabled?: boolean;
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
  app.get(API_MODELS, mw, makeGetModelsHandler());
  app.post(API_MODELS, mw, largeBody, makePostModelsHandler());
  app.options(API_MODELS_SECRET, mw);
  app.post(API_MODELS_SECRET, mw, largeBody, makePostSecretHandler(deps));
  app.delete(API_MODELS_SECRET, mw, makeDeleteSecretHandler(deps));
  // No `largeBody`: the body is one boolean, read by the app's default JSON
  // parser. The OPTIONS registration is what answers the preflight — the
  // desktop WebView's JSON POST is cross-origin, and the 204 comes from `mw`.
  const settingsLive = deps.localModelSettingsEnabled ?? BYO_MODELS_ENABLED;
  app.options(API_MODELS_LOCAL_SETTINGS, mw);
  app.get(API_MODELS_LOCAL_SETTINGS, mw, makeGetLocalSettingsHandler(settingsLive));
  app.post(API_MODELS_LOCAL_SETTINGS, mw, makePostLocalSettingsHandler(settingsLive));
}

/**
 * `GET /api/models/local-settings` (#1123). Loopback only: a non-loopback
 * caller is refused outright rather than scrubbed, so the non-loopback bind
 * (dark, ADR-056) would not expose the setting. 404 while the feature is dark.
 */
function makeGetLocalSettingsHandler(live: boolean): Handler {
  return (req: Request, res: Response) => {
    if (!live) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Loopback only." });
      return;
    }
    const body: LocalModelSettingsResponse = { editing: isLocalModelEditingEnabled() };
    res.status(200).json(body);
  };
}

/**
 * `POST /api/models/local-settings` (#1123) — body `{ editing: boolean }`.
 *
 * Origin, then loopback, before anything else (a `text/plain` simple request
 * carries no allowlisted Origin and no parsed body). The body must hold the
 * boolean itself; nothing is coerced. The server never trusts a client's word
 * per request for what the local model may do: this route is the only writer,
 * and the collaborator reads the result server-side.
 *
 * The answer always carries the EFFECTIVE value, including on a failed write,
 * so the page can show what the server is really doing: a failed Off is still
 * off for this run of Tandem (`editing: false, persisted: false`).
 *
 * Not licence-gated: it starts nothing and reaches no model. The local model
 * itself is refused per chat event in `collaborator.ts`.
 */
function makePostLocalSettingsHandler(live: boolean): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_MODELS_LOCAL_SETTINGS)) return;
    if (assertLoopbackForMutation(req, res)) return;
    if (!live) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    const editing = (req.body as { editing?: unknown } | undefined)?.editing;
    if (typeof editing !== "boolean") {
      res.status(400).json({
        error: "BAD_REQUEST",
        code: ERROR_CODE_INVALID_LOCAL_MODEL_SETTINGS,
        message: "Body must be { editing: <boolean> }.",
      });
      return;
    }
    const result = await setLocalModelEditing(editing);
    const body: LocalModelSettingsPostResponse = result.persisted
      ? result
      : { ...result, code: ERROR_CODE_LOCAL_MODEL_SETTINGS_WRITE_FAILED };
    res.status(result.persisted ? 200 : 500).json(body);
  };
}

/**
 * Fields disclosed to a NON-loopback (LAN) `GET /api/models` caller. An
 * **allowlist**, not a denylist (security review): `endpoint` (reveals which
 * inference servers/ports run on the host) and `apiKeyRef` never cross to LAN,
 * and any field added later (an M3 authorship field, a `params` proxy URL) is
 * non-disclosed by default until explicitly promoted here. Loopback callers get
 * the full entry. Mirrors the `GET /api/sessions` basename-scrub contract.
 */
function scrubEntryForLan(entry: ModelsEntry): ModelsEntry {
  return {
    id: entry.id,
    provider: entry.provider,
    displayName: entry.displayName,
    modelId: entry.modelId,
    enabled: entry.enabled,
  };
}

/**
 * `GET /api/models` (#1123 M2) — the client's load source. Serves the warm
 * cache synchronously with a content-hash ETag the client echoes as `ifMatch`
 * on its next write. Loopback → full file; non-loopback authenticated LAN →
 * per-entry allowlist scrub (see `scrubEntryForLan`). Read-only: no
 * origin/loopback mutation gate, no license gate — consistent with the other
 * `GET` routes and M1a's read posture. The route is live-callable while dark
 * (like `POST /api/models` since M1a); only the client's *fetch* is
 * `BYO_MODELS_ENABLED`-gated, and the registry holds no plaintext.
 */
function makeGetModelsHandler(): Handler {
  return (req: Request, res: Response) => {
    const full = getCachedModelsFile();
    if (isLoopback(req.socket.remoteAddress)) {
      const body: ModelsGetResponse = { file: full, etag: getModelsEtag() };
      res.status(200).json(body);
      return;
    }
    // LAN: return the allowlist-scrubbed file AND an etag hashed over THAT file —
    // not the full cache — so the etag can't act as a change-detector for the
    // hidden `endpoint`/`apiKeyRef` fields (security review Q5). A LAN caller can
    // never POST (loopback-gated), so it has no use for the full-file precondition.
    const scrubbed: ModelsFile = { ...full, models: full.models.map(scrubEntryForLan) };
    const body: ModelsGetResponse = { file: scrubbed, etag: hashModelsFile(scrubbed) };
    res.status(200).json(body);
  };
}

/**
 * Whole-file replace of the server-side registry (#1123 M2). Body is an
 * envelope `{ file, ifMatch }`: gated origin → loopback → `.strict()` safeParse
 * of `file` (defense-in-depth) → optimistic-concurrency check on `ifMatch`
 * (matching `POST /api/integrations`'s gating shape). `ifMatch` is the ETag the
 * client last saw from `GET`; a stale token → 409 so the client reconciles
 * instead of clobbering (the server never returns the file body on 409 — the
 * client re-GETs through the LAN-scrubbed read path). A concurrent in-flight
 * write → 429. Deliberately NOT license-gated — a registry-config write is not
 * an AI action (the local model itself is refused per run in
 * `collaborator.ts`, #1521).
 */
function makePostModelsHandler(): Handler {
  return async (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_MODELS)) return;
    if (assertLoopbackForMutation(req, res)) return;
    const envelope = req.body as { file?: unknown; ifMatch?: unknown };
    if (typeof envelope?.ifMatch !== "string") {
      res.status(400).json({
        error: "BAD_REQUEST",
        code: ERROR_CODE_INVALID_MODELS_FILE,
        message: "Body must be { file, ifMatch: <etag string> }.",
      });
      return;
    }
    const parsed = ModelsFileSchema.safeParse(envelope.file);
    if (!parsed.success) {
      res.status(400).json({
        error: "BAD_REQUEST",
        code: ERROR_CODE_INVALID_MODELS_FILE,
        message: "Body failed models-registry validation.",
      });
      return;
    }
    try {
      const result = await persistModelsFileIfMatch(parsed.data, envelope.ifMatch);
      if (result.ok) {
        const ok: ModelsPostResponse = { etag: result.etag };
        res.status(200).json(ok);
      } else if (result.reason === "stale") {
        // No file body — the client re-GETs through the scrubbed read path.
        res.status(409).json({ code: ERROR_CODE_MODELS_STALE, etag: result.currentEtag });
      } else {
        res.status(429).json({ code: ERROR_CODE_MODELS_BUSY });
      }
    } catch (err) {
      // Log the real cause server-side (stderr is safe) — a persistent failure
      // (ENOSPC, read-only store) is otherwise undebuggable. The client response
      // stays generic: no path/detail leak to a possibly-LAN caller.
      console.error(
        `[tandem] POST ${API_MODELS} write failed (${
          err instanceof Error ? err.message : String(err)
        }).`,
      );
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
