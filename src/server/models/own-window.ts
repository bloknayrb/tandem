/**
 * Who may change the local-model settings (#2404, Bryan's decision 2026-11-11:
 * "only Tandem's own window can change them").
 *
 * `POST /api/models` and `POST /api/models/local-settings` decide which local
 * model answers chat and whether it may comment. The shared origin allowlist
 * (`isLocalhostOrigin`) admits `127.0.0.1` and `tauri.localhost` on ANY port,
 * so a web page served from another port on this computer passed it. The one
 * thing such a page cannot choose is the `Origin` its browser sets, so these
 * two routes accept a request only when that header is EXACTLY one of Tandem's
 * own page origins:
 *
 *  - the page this server serves, as a browser serialises its origin:
 *    `http://127.0.0.1:<the port actually bound>` — and only when the listener
 *    really is on `127.0.0.1`. On a `::1` bind another server could hold
 *    `127.0.0.1:<the same port>`, and its pages would otherwise be "own";
 *  - the desktop WebView, with no port: `http://tauri.localhost`,
 *    `https://tauri.localhost`, `tauri://localhost`.
 *
 * A missing `Origin` is refused. Nothing here reads `Host` (the Host allowlist
 * runs in front, in `apiMiddleware`), and nothing here uses the allowlist's
 * pattern. Do not loosen this test to make something else work.
 *
 * **The development allowance.** The Vite dev client (`:5173`), the
 * `dev:tauri` window and the E2E client are not Tandem's own page by that
 * rule. `TANDEM_MODELS_DEV_ORIGIN` names exactly ONE extra origin, read from
 * the server's environment at start — which a web page cannot set. A write it
 * admits is NOT an own-window write: it still raises the notices, because any
 * page served on that port gets it, and the desktop app's server inherits the
 * environment of whatever started the app.
 *
 * What this does not stop is in docs/security.md (#2410): a process running as
 * the user, content on port 80 or 443 presenting `tauri.localhost`, script in
 * Tandem's own origin, a browser extension.
 *
 * Lives in `models/` so the routes can import it; it imports nothing from
 * `local-model/`.
 */

import type { Request, Response } from "express";

import { TAURI_HOSTNAME, TAURI_LINUX_ORIGIN } from "../../shared/constants.js";
import {
  ERROR_CODE_OWN_WINDOW_ONLY,
  MODELS_DEV_ORIGIN_ENV,
  OWN_WINDOW_ONLY_MESSAGE,
} from "../../shared/models/contract.js";
import type { Handler } from "../mcp/routes/_shared.js";

/** How an accepted write got in. Only `own-window` is the user's own change. */
export type ModelsWriteSource = "own-window" | "allowance";

/** Where the HTTP server is actually listening, or null before it is. */
export interface BoundAddress {
  address: string;
  port: number;
}

/** The desktop WebView's origins. Exact strings, never a port. */
const TAURI_ORIGINS: readonly string[] = [
  `http://${TAURI_HOSTNAME}`,
  `https://${TAURI_HOSTNAME}`,
  TAURI_LINUX_ORIGIN,
];

/** Every origin that is Tandem's own page for a server bound at `bound`. */
export function ownWindowOrigins(bound: BoundAddress | null): string[] {
  const origins = [...TAURI_ORIGINS];
  if (
    bound !== null &&
    bound.address === "127.0.0.1" &&
    Number.isInteger(bound.port) &&
    bound.port >= 1 &&
    bound.port <= 65535
  ) {
    // The way a browser serialises it: the default port is omitted.
    origins.push(bound.port === 80 ? "http://127.0.0.1" : `http://127.0.0.1:${bound.port}`);
  }
  return origins;
}

export interface OwnWindowPolicy {
  /** How this request may write, or null when it may not. */
  classify(req: Pick<Request, "headers">): ModelsWriteSource | null;
}

export interface OwnWindowPolicyOptions {
  /** The listener's real address and port; null until it is listening. */
  getBound: () => BoundAddress | null;
  /** The one extra origin from {@link resolveModelsDevOrigin}, or null. */
  allowance?: string | null;
}

export function createOwnWindowPolicy(opts: OwnWindowPolicyOptions): OwnWindowPolicy {
  const allowance = opts.allowance ?? null;
  return {
    classify(req) {
      // One header, one string. Node joins repeated `Origin` headers with
      // ", ", which matches nothing below.
      const origin = req.headers?.origin;
      if (typeof origin !== "string" || origin.length === 0) return null;
      if (ownWindowOrigins(opts.getBound()).includes(origin)) return "own-window";
      if (allowance !== null && origin === allowance) return "allowance";
      return null;
    },
  };
}

/** A policy for a server that is not listening: the WebView origins only. */
export function webViewOnlyPolicy(): OwnWindowPolicy {
  return createOwnWindowPolicy({ getBound: () => null });
}

/** Answer the refusal. Says why in words a person can act on. */
export function refuseNotOwnWindow(res: Response): void {
  res.status(403).json({
    error: "FORBIDDEN",
    code: ERROR_CODE_OWN_WINDOW_ONLY,
    message: OWN_WINDOW_ONLY_MESSAGE,
  });
}

/**
 * The same decision as a middleware, for the body pre-parser: it runs before
 * any body is read, so a refused request's body is never parsed. The handlers
 * decide again for themselves — that call is the authoritative one.
 */
export function ownWindowGate(policy: OwnWindowPolicy): Handler {
  return (req, res, next) => {
    if (policy.classify(req) === null) {
      refuseNotOwnWindow(res);
      return;
    }
    next();
  };
}

const LOOPBACK_DEV_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

export interface ModelsDevOrigin {
  /** The one extra origin, or null when the allowance is not active. */
  origin: string | null;
  /** One line for the server log; null when the variable is unset. */
  log: string | null;
}

/**
 * Read `TANDEM_MODELS_DEV_ORIGIN`. Exactly one origin: a loopback page
 * (`http://127.0.0.1:<port>`, an explicit port from 1 to 65535 other than 80,
 * which a browser never writes) or one of the WebView forms. `*`, `null`, a
 * list, a port range, a prefix, a path, `localhost`, another host: refused,
 * and the allowance is not active. A refused value never stops the server.
 */
export function resolveModelsDevOrigin(raw: string | undefined): ModelsDevOrigin {
  if (raw === undefined) return { origin: null, log: null };
  const shown = JSON.stringify(raw.length > 80 ? `${raw.slice(0, 80)}…` : raw);
  const refused = (why: string): ModelsDevOrigin => ({
    origin: null,
    log: `[Tandem] ${MODELS_DEV_ORIGIN_ENV}=${shown} was refused (${why}). The development allowance is NOT active: local-model settings can be changed from Tandem's own window only.`,
  });
  if (TAURI_ORIGINS.includes(raw)) {
    return {
      origin: raw,
      log: `[Tandem] ${MODELS_DEV_ORIGIN_ENV}=${shown} names the desktop window, which is already accepted; it has no effect.`,
    };
  }
  const match = LOOPBACK_DEV_ORIGIN.exec(raw);
  if (!match) {
    return refused(
      "it must be exactly one origin of the form http://127.0.0.1:<port>, with no path, list, range or wildcard",
    );
  }
  const port = Number(match[1]);
  if (port > 65535) return refused("the port is out of range");
  if (port === 80) return refused("a browser never writes port 80 in an origin");
  return {
    origin: raw,
    log: `[Tandem] ${MODELS_DEV_ORIGIN_ENV} is set: local-model settings can also be changed from ${raw}. This is for development and tests only; any page served there can change them.`,
  };
}
