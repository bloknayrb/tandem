import type { Request, Response } from "express";
import { setPreviousToken } from "../../auth/middleware.js";
import { getTokenFilePath, readTokenFromFile } from "../../auth/token-store.js";
import type { Handler } from "./_shared.js";

export function makeRotateTokenHandler(deps: {
  setCurrentToken: (t: string) => void;
  getCurrentToken: () => string | null;
}): Handler {
  return async (req: Request, res: Response) => {
    // Require a PARSED body, which is this route's CSRF control.
    //
    // The handler used to take `_req` and never read the request at all, so
    // there was nothing to fail closed on. That made it reachable from any page
    // the user visits:
    //
    //   fetch('http://127.0.0.1:3479/api/rotate-token', {method:'POST',
    //         mode:'no-cors', headers:{'Content-Type':'text/plain'}})
    //
    // A `text/plain` POST is a SIMPLE request, so no preflight fires and the
    // origin allowlist never gets a say; the socket is loopback, so
    // `enforceLoopbackMutation` passes and `authMiddleware` skips the token
    // check entirely (loopback is exempted before it). The attacker cannot read
    // the response, but the swap and the 60-second grace window happen, and the
    // call can be looped to keep a window permanently armed.
    //
    // The fix is NOT `assertOriginAllowlisted`, and that distinction is the
    // whole point: this route's only caller is the CLI via Node `fetch`
    // (src/cli/rotate-token.ts:73-80), which sends no `Origin` header at all.
    // That gate fails closed on a missing Origin, so it would 403 every
    // legitimate rotation — and the CLI reads a non-2xx as `serverRejected` and
    // ROLLS THE NEW TOKEN BACK OFF DISK (:105-109). Applying the sibling
    // routes' fix here would break token rotation outright.
    //
    // Requiring a parsed body works instead because it is a POSITIVE proof that
    // a preflight was passed rather than a header check: `express.json()` is
    // mounted with no `type` option, so it parses `application/json` only.
    // Measured against this repo's express 5.2.1 — `text/plain`,
    // `application/x-www-form-urlencoded`, `multipart/form-data` (the three
    // CORS-safelisted types) and a missing Content-Type ALL leave `req.body`
    // undefined; only `application/json` yields an object. The CLI already
    // sends `Content-Type: application/json` with `{}`, so it is unaffected,
    // and `application/json` is not safelisted, so a page cannot send it
    // cross-origin without a preflight the allowlist refuses.
    if (req.body === undefined) {
      res.status(400).json({
        error: "BAD_REQUEST",
        message: "rotate-token requires a JSON body (send {} with Content-Type: application/json).",
      });
      return;
    }

    // Fix 4: Tauri-launched servers use env-injected tokens; rotation would diverge
    // the disk token from what Tauri passes on next launch, breaking auth.
    if (process.env.TANDEM_AUTH_TOKEN) {
      res.status(409).json({ error: "Token is managed by Tauri; rotate via the app." });
      return;
    }

    // Capture the current token BEFORE swapping — this is the grace-window credential.
    // If null (server started without a token), there's nothing to preserve.
    const oldToken = deps.getCurrentToken();

    let newToken: string | null;
    try {
      newToken = await readTokenFromFile();
    } catch (err) {
      console.error("[Tandem] rotate-token: failed to read new token from disk:", err);
      res.status(500).json({ error: "INTERNAL", message: "Could not read new token from disk." });
      return;
    }

    if (!newToken) {
      console.error(
        "[Tandem] rotate-token: no token found on disk after rotation at:",
        getTokenFilePath(),
      );
      res
        .status(500)
        .json({ error: "INTERNAL", message: "No token found on disk after rotation." });
      return;
    }

    if (oldToken) {
      setPreviousToken(oldToken, 60_000);
    }

    deps.setCurrentToken(newToken);

    console.error("[Tandem] auth token rotated; 60-second grace window active for old token");
    res.json({ ok: true });
  };
}
