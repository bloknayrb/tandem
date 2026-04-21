import { createHash, randomBytes } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { getTokenFilePath, readTokenFromFile } from "../shared/auth/token-file.js";
import { DEFAULT_MCP_PORT } from "../shared/constants.js";
import { applyConfigWithToken } from "./setup.js";

/** SHA-256 fingerprint — first 8 hex chars. Never logs the full token value. */
function fingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function rotateToken(): Promise<void> {
  console.error("\n[tandem] Rotating auth token...\n");

  // Refuse to rotate when token comes from env — Tauri injects it before sidecar
  // spawn and we have no way to update the launcher. Rotating the file would create
  // a mismatch with what Tauri passes in on the next launch.
  if (process.env.TANDEM_AUTH_TOKEN) {
    console.error(
      "[tandem] Error: TANDEM_AUTH_TOKEN is set in the environment.\n" +
        "  Token rotation is not supported in env-token mode (used by Tauri).\n" +
        "  Unset the variable and let Tandem manage the token file, or rotate\n" +
        "  via your Tauri app's token management instead.",
    );
    process.exit(1);
  }

  const oldToken = await readTokenFromFile();
  if (!oldToken) {
    console.error(
      "[tandem] Error: no token file found. Run `tandem setup` first to initialize the token.",
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

  const serverUrl = `http://localhost:${DEFAULT_MCP_PORT}`;

  // Three distinct outcomes:
  //   graceWindowActive = true  → server accepted the rotation; grace window is live
  //   serverRejected = true     → server reachable but returned non-2xx
  //   (neither)                 → fetch threw; server was not running
  let graceWindowActive = false;
  let serverRejected = false;
  let serverRejectedStatus = 0;
  try {
    const resp = await fetch(`${serverUrl}/api/rotate-token`, {
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

  if (serverRejected) {
    // Configs now reference the new token but the server still holds the old one.
    // Print a strong warning — do NOT print "Rotated auth token" as that implies success.
    console.error(
      `[tandem] WARNING: server rejected the rotation request (status: ${serverRejectedStatus}).`,
    );
    if (updatedCount > 0) {
      console.error(
        `  ${updatedCount} config file(s) updated to the new token, but the server still\n` +
          "  holds the old token. Restart the server to complete rotation.",
      );
    }
    console.error(`  Old fingerprint: ${fingerprint(oldToken)}`);
    console.error(`  New fingerprint: ${fingerprint(newToken)}`);
    for (const e of configErrors) {
      console.error(`  Warning: could not update config — ${e}`);
    }
    console.error("");
    return;
  }

  console.error("[tandem] Rotated auth token.");
  console.error(`  Old fingerprint: ${fingerprint(oldToken)}`);
  console.error(`  New fingerprint: ${fingerprint(newToken)}`);
  console.error(`  Updated ${updatedCount} config file(s).`);

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
