/**
 * Route-sized `/api` body parsing, ahead of the SDK sub-app (#1981).
 *
 * **Why this exists.** `createMcpExpressApp` installs a bare `express.json()`
 * (body-parser's 100 kB default) inside the SDK sub-app, and server.ts mounts
 * that sub-app at the ROOT, above every `/api` registrar. body-parser skips a
 * request whose stream has already been read, so whichever parser runs first
 * owns the body. Before this module the SDK's parser was first for every
 * `/api` body: the registrations' `largeBody` (70 MB) never ran, browser
 * upload failed over ~100 kB, the scratchpad's own 1 MiB parser was capped at
 * 100 kB, and `rejectOversizeLicenseBody` ran after the parse it was meant to
 * precede.
 *
 * **What it is.** A router mounted directly above the SDK sub-app mount, after
 * `authMiddleware`, `enforceLoopbackMutation` and the `/health` / well-known
 * GETs. It is NOT a registrar: it never answers a success. The only responses
 * it produces are a Host gate's 403, a parse error (forwarded to the outer
 * `bodyErrorHandler`), or the scratchpad / licence 413s, which are existing
 * route code reused. Each route chain ends in a parser, which calls `next()`,
 * so routing continues into the SDK sub-app and then the real registration.
 * On those later passes the SDK's `express.json()` and the registration's own
 * parser see a finished stream and skip it. The `largeBody` argument the
 * registrars still take is therefore a backstop: while this router is mounted,
 * the limit each route really gets is its row in
 * {@link ROUTE_OWNED_BODY_PARSERS}.
 *
 * **Both Host checks stay in front of the parse, on purpose.** The router's
 * first layer is a path-less `use` of {@link sdkHostValidationFor} — a copy of
 * the SDK sub-app's own first layer — so it runs before any route layer
 * decodes a `:ref` param, and every request reaching it would have hit the
 * identical check one layer later anyway: no Host refusal changes. Then each
 * route runs `lanAwareApiMiddleware` before its parser. The two accept sets
 * cannot be compared: the SDK's `localhostHostValidation` rejects
 * `tauri.localhost`, while `isHostAllowed` rejects `localhost` and `[::1]`.
 * Neither is redundant — do not "simplify" one away.
 *
 * **Who can impose the larger ceilings.** A foreign-origin `application/json`
 * POST needs a CORS preflight, which `mw` answers without granting; a
 * `text/plain` body is not parsed by `express.json` at all. But
 * `LOCALHOST_ORIGIN_RE` admits `http://127.0.0.1` on ANY port, so a local
 * process or a page served from 127.0.0.1 can make a route buffer up to its
 * row's limit (70 MB on upload, 8 MB on reload). That is not a new trust
 * boundary — that origin can already open, save and convert files — and the
 * handler-level `assertOriginAllowlisted` / `assertLoopbackForMutation` still
 * run after the parse, exactly as before.
 *
 * Pinned by `tests/server/api-body-limit.test.ts` (runtime limits, gate
 * ordering, the router's shape, and this table against the registrations).
 */
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express, { type Router } from "express";

import {
  API_ANNOTATION_REPLY,
  API_APPLY_CHANGES,
  API_BACKUPS_RESTORE,
  API_CLOSE,
  API_CONVERT,
  API_DOCUMENT_RELOAD,
  API_EXTERNAL_CONFLICT_RESOLVE,
  API_LICENSE_ACTIVATE,
  API_MODE_RELEASE,
  API_OPEN,
  API_READ_ONLY_FILE_RESOLVE,
  API_REMOVE_ANNOTATION,
  API_RENAME,
  API_ROTATE_TOKEN,
  API_SAVE,
  API_SCRATCHPAD,
  API_SESSIONS_CLEAR,
  API_SESSIONS_DELETE,
  API_UPLOAD,
} from "../../shared/api-paths.js";
import { API_INTEGRATIONS, API_INTEGRATIONS_APPLY } from "../../shared/integrations/contract.js";
import { API_MODELS } from "../../shared/models/contract.js";
import { API_INTEGRATIONS_SECRET } from "../integrations/api-routes.js";
import { API_MODELS_SECRET } from "../models/api-routes.js";
import { rejectOversizeLicenseBody, scratchpadJsonBody } from "./api-routes.js";
import type { Handler } from "./routes/_shared.js";

/**
 * The SDK sub-app's Host check, rebuilt from the same inputs.
 *
 * A line-for-line copy of `createMcpExpressApp`'s branch
 * (`@modelcontextprotocol/sdk/server/express.js`): `allowedHosts` given →
 * `hostHeaderValidation(allowedHosts)`; else a localhost bind →
 * `localhostHostValidation()`; else nothing. The SDK has already logged its
 * own all-interfaces warning for `0.0.0.0` / `::`, so this does not repeat it.
 *
 * It is a copy, and a copy can drift: `tests/server/api-body-limit.test.ts`
 * builds both for every config and asserts identical answers, so an SDK
 * upgrade that changes the branch fails that suite instead of silently
 * changing which Host the pre-parse router admits. The pass-through arm is
 * kept for parity only — under `LAN_BIND_ENABLED = false` the bind backstop
 * limits `host` to a loopback name, so the shipped path is always one of the
 * two validators.
 */
export function sdkHostValidationFor(host: string, allowedHosts?: string[]): Handler {
  if (allowedHosts) return hostHeaderValidation(allowedHosts);
  if (["127.0.0.1", "localhost", "::1"].includes(host)) return localhostHostValidation();
  return (_req, _res, next) => next();
}

/** How a listed route's body is parsed. See {@link ROUTE_OWNED_BODY_PARSERS}. */
export type RouteBodyKind = "upload" | "reload" | "scratchpad" | "license" | "small";

/**
 * Every `/api` POST route whose registration carries its own body parser, and
 * the parser this router actually gives it. POST only — the router registers
 * no other method, and the test pins that every matched registration is a POST.
 *
 * - `upload` (70 MB, the `largeBody` passed in): `/api/upload` only. The
 *   browser sends whole files as JSON, base64 for binary formats, and
 *   `MAX_FILE_SIZE` is 50 MB; `openFromUpload` still enforces that.
 * - `reload` (8 MB): the source-view commit. The handler caps markdown at
 *   1,000,000 UTF-8 bytes, and JSON escaping can expand that up to 6x.
 * - `scratchpad`: the route's own `scratchpadJsonBody` (1 MiB, own 413/400).
 * - `license`: the declared-length check, then a 64 KB parse, so a chunked
 *   body is capped at the same 64 KB the declared-length check refuses.
 * - `small` (100 kB): ids, flags, a path, a config or an 8 KiB secret.
 *   100 kB is the ceiling these routes already had under the SDK's parser, so
 *   they see no change. Listed explicitly rather than left to the SDK, so the
 *   limit does not depend on an SDK default and this table stays complete.
 *
 * Adding a route-level parser to a registration without a row here makes it
 * dead code; the test fails on that.
 */
export const ROUTE_OWNED_BODY_PARSERS: Readonly<Record<string, RouteBodyKind>> = Object.freeze({
  [API_UPLOAD]: "upload",
  [API_DOCUMENT_RELOAD]: "reload",
  [API_SCRATCHPAD]: "scratchpad",
  [API_LICENSE_ACTIVATE]: "license",
  [API_MODE_RELEASE]: "small",
  [API_OPEN]: "small",
  [API_CLOSE]: "small",
  [API_SAVE]: "small",
  [API_RENAME]: "small",
  [API_CONVERT]: "small",
  [API_APPLY_CHANGES]: "small",
  [API_BACKUPS_RESTORE]: "small",
  [API_EXTERNAL_CONFLICT_RESOLVE]: "small",
  [API_READ_ONLY_FILE_RESOLVE]: "small",
  [API_ANNOTATION_REPLY]: "small",
  [API_REMOVE_ANNOTATION]: "small",
  [API_SESSIONS_DELETE]: "small",
  [API_SESSIONS_CLEAR]: "small",
  [API_ROTATE_TOKEN]: "small",
  [API_INTEGRATIONS]: "small",
  [API_INTEGRATIONS_APPLY]: "small",
  [API_INTEGRATIONS_SECRET]: "small",
  [API_MODELS]: "small",
  [API_MODELS_SECRET]: "small",
});

export const reloadBodyParser: Handler = express.json({ limit: "8mb" });
export const smallBodyParser: Handler = express.json({ limit: "100kb" });
export const licenseBodyParser: Handler = express.json({ limit: "64kb" });

function pathsOf(kind: RouteBodyKind): string[] {
  return Object.entries(ROUTE_OWNED_BODY_PARSERS)
    .filter(([, k]) => k === kind)
    .map(([path]) => path);
}

export interface ApiBodyPreParserDeps {
  /** {@link sdkHostValidationFor} over the SDK sub-app's own `host` / `allowedHosts`. */
  sdkHostGate: Handler;
  /** The same `lanAwareApiMiddleware` the registrations use. */
  mw: Handler;
  /** The 70 MB parser — given to `/api/upload` only. */
  largeBody: Handler;
}

export function createApiBodyPreParser({
  sdkHostGate,
  mw,
  largeBody,
}: ApiBodyPreParserDeps): Router {
  const router = express.Router();
  // First layer, path-less: no param is decoded before the SDK Host check.
  router.use(sdkHostGate);
  router.post(pathsOf("upload"), mw, largeBody);
  router.post(pathsOf("reload"), mw, reloadBodyParser);
  router.post(pathsOf("scratchpad"), mw, scratchpadJsonBody);
  router.post(pathsOf("license"), mw, rejectOversizeLicenseBody, licenseBodyParser);
  router.post(pathsOf("small"), mw, smallBodyParser);
  return router;
}
