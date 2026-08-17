import { createHash, randomBytes } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { applyConfigWithToken } from "../server/integrations/apply.js";
import { API_ROTATE_TOKEN } from "../shared/api-paths.js";
import { getTokenFilePath, readTokenFromFile } from "../shared/auth/token-file.js";
import { resolveAuthTokenCandidate, resolveTandemUrl } from "../shared/cli-runtime.js";

/** SHA-256 fingerprint — first 8 hex chars. Never logs the full token value. */
function fingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function rotateToken(): Promise<void> {
  console.error("\n[tandem] Rotating auth token...\n");

  // Refuse to rotate when token comes from env — Tauri injects TANDEM_AUTH_TOKEN
  // before sidecar spawn, and Claude Code's plugin host injects
  // CLAUDE_PLUGIN_OPTION_AUTH_TOKEN from userConfig. In either case we have no
  // way to update the launcher; rotating the file would desync with what's
  // re-injected on the next launch.
  const { source: envAuthSource } = resolveAuthTokenCandidate();
  if (
    envAuthSource === "TANDEM_AUTH_TOKEN" ||
    envAuthSource === "CLAUDE_PLUGIN_OPTION_AUTH_TOKEN"
  ) {
    console.error(
      `[tandem] Error: ${envAuthSource} is set in the environment.\n` +
        "  Token rotation is not supported in env-token mode (used by Tauri\n" +
        "  and Claude Code's plugin host). Unset the variable and let Tandem\n" +
        "  manage the token file, or rotate via the launcher's token management.",
    );
    process.exit(1);
  }

  const oldToken = await readTokenFromFile();
  if (!oldToken) {
    console.error(
      "[tandem] Error: no token file found. Start the server once with `tandem` — it creates the token on first launch.",
    );
    process.exit(1);
  }

  // writeTokenToFile uses O_EXCL; bypass it here — rotation is an intentional overwrite.
  // Use atomic write: write to a temp file first, then rename() into place.
  // rename() is atomic on the same filesystem — power-loss mid-write cannot leave an empty file.
  const newToken = generateToken();
  const tokenPath = getTokenFilePath();
  const dir = path.dirname(tokenPath);
  const tmpPath = path.join(dir, `.auth-token-tmp-${randomBytes(4).toString("hex")}`);
  try {
    await fsPromises.writeFile(tmpPath, newToken, { encoding: "utf8", mode: 0o600 });
    await fsPromises.rename(tmpPath, tokenPath);
  } catch (err) {
    await fsPromises.unlink(tmpPath).catch(() => {});
    throw err;
  }

  const serverUrl = resolveTandemUrl();

  // Three distinct outcomes:
  //   graceWindowActive = true  → server accepted the rotation; grace window is live
  //   serverRejected = true     → server reachable but returned non-2xx
  //   (neither)                 → fetch threw; server was not running
  let graceWindowActive = false;
  let serverRejected = false;
  let serverRejectedStatus = 0;
  try {
    const resp = await fetch(`${serverUrl}${API_ROTATE_TOKEN}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${oldToken}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      graceWindowActive = true;
    } else {
      serverRejected = true;
      serverRejectedStatus = resp.status;
    }
  } catch {
    console.error(
      "[tandem] Warning: server is not reachable. The new token is written to disk.\n" +
        "  Restart the server to activate the grace window; reconnect Claude Code after.",
    );
  }

  // A reachable server that REFUSED is the one outcome where persisting is
  // wrong. The unreachable case above deliberately keeps the new token — that
  // is offline rotation, and restarting the server activates it. But a refusal
  // means the server is running and still holds the old token, so leaving the
  // new one on disk (and worse, writing it into every MCP config) strands the
  // client on a credential nothing will ever accept, with no grace window.
  //
  // #1320 made this reachable in practice rather than theoretically: `/api` is
  // now loopback-only for non-GET, so `tandem rotate-token` against a remote
  // `TANDEM_URL` gets a 403 here every time.
  if (serverRejected) {
    let restored = true;
    try {
      await fsPromises.writeFile(tmpPath, oldToken, { encoding: "utf8", mode: 0o600 });
      await fsPromises.rename(tmpPath, tokenPath);
    } catch (err) {
      restored = false;
      await fsPromises.unlink(tmpPath).catch(() => {});
      console.error(
        `[tandem] Error: server refused the rotation AND the token file could not be restored: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(`  The token file at ${tokenPath} holds a token the server will not accept.`);
      console.error(`  Restore it by hand — old fingerprint: ${fingerprint(oldToken)}`);
    }
    console.error(
      `[tandem] Error: server rejected the rotation request (status: ${serverRejectedStatus}).`,
    );
    if (serverRejectedStatus === 403) {
      // #1320: /api is loopback-only for non-GET. Naming the resolved URL rather
      // than saying "run it on the server" is the difference between actionable
      // and infuriating: on a TANDEM_BIND_HOST=0.0.0.0 host whose shell exports
      // TANDEM_URL=http://<lan-ip>:3479 — how Cowork and the shim are configured
      // — the CLI IS on the server machine and still presents a LAN peer address.
      console.error(
        `  Token rotation is loopback-only, and this ran against ${serverUrl}.\n` +
          "  Run it on the computer hosting the server, and unset TANDEM_URL (or\n" +
          "  point it at 127.0.0.1) so the request originates from loopback.",
      );
    }
    // Only claim nothing changed when nothing did. The restore-failure path
    // above describes the opposite state, and this line is the one a user skims.
    if (restored) {
      console.error("  No token was rotated and no config file was changed.");
    }
    console.error("");
    if (!restored) {
      // A half-rotated token file is a hard failure, not a warning: the server
      // will reject every subsequent request from this client until a human
      // fixes the file. Exiting 0 here would tell a script it succeeded.
      process.exit(1);
    }
    return;
  }

  let updatedCount = 0;
  let configErrors: string[] = [];
  try {
    const result = await applyConfigWithToken(newToken);
    updatedCount = result.updated;
    configErrors = result.errors;
  } catch (err) {
    console.error(
      `[tandem] Warning: failed to update MCP configs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // TODO(v0.8.1): After rotation, re-walk Cowork workspaces to rewrite
  // env.TANDEM_AUTH_TOKEN so post-rotation Cowork sessions don't 401
  // (security invariant §6 — silent-failure H1). The Tauri IPC dynamic import
  // approach is inert here: this CLI runs as a Node subprocess with no WebView,
  // so `@tauri-apps/api/core`'s `invoke()` has no bridge to Rust. The fix is
  // an HTTP bridge — add a POST /api/cowork-apply-token endpoint in the server
  // (guarded by the auth middleware) and call it from here after the server
  // accepts the rotation.

  console.error("[tandem] Rotated auth token.");
  console.error(`  Old fingerprint: ${fingerprint(oldToken)}`);
  console.error(`  New fingerprint: ${fingerprint(newToken)}`);
  console.error(`  Updated ${updatedCount} config file(s).`);

  // Zero updated with zero errors is the quietest bad outcome this command has:
  // the server now only accepts the new token, every client config still holds
  // the old one, and nothing above says so. It is what a detection refusal
  // looks like from here (#1417 rejects the home root and `detectTargets`
  // returns an empty list), so name the state rather than letting a clean-looking
  // exit 0 imply the clients were re-pointed.
  if (updatedCount === 0 && configErrors.length === 0) {
    console.error(
      "  Warning: no config file was updated, so every client still holds the OLD\n" +
        "  token and will be rejected. Re-point them with: tandem setup --apply",
    );
  }

  for (const e of configErrors) {
    console.error(`  Warning: could not update config — ${e}`);
  }

  if (graceWindowActive) {
    console.error(
      "  Old token remains valid for 60 seconds; reconnect Claude Code within that window.",
    );
  } else {
    console.error(
      "  Server was not running — start it with `tandem` and reconnect Claude Code with the new token.",
    );
  }

  console.error("");
}
