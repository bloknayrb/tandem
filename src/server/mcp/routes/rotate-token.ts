import type { Request, Response } from "express";
import { setPreviousToken } from "../../auth/middleware.js";
import { readTokenFromFile } from "../../auth/token-store.js";
import type { Handler } from "../api-routes.js";

export function makeRotateTokenHandler(deps: {
  setCurrentToken: (t: string) => void;
  getCurrentToken: () => string | null;
}): Handler {
  return async (_req: Request, res: Response) => {
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
      console.error("[tandem] rotate-token: failed to read new token from disk:", err);
      res.status(500).json({ error: "INTERNAL", message: "Could not read new token from disk." });
      return;
    }

    if (!newToken) {
      res
        .status(500)
        .json({ error: "INTERNAL", message: "No token found on disk after rotation." });
      return;
    }

    if (oldToken) {
      setPreviousToken(oldToken, 60_000);
    }

    deps.setCurrentToken(newToken);

    console.error("[tandem] auth token rotated; 60-second grace window active for old token");
    res.json({ ok: true });
  };
}
