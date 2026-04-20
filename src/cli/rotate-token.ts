import { createHash, randomBytes } from "node:crypto";
import { getTokenFilePath, readTokenFromFile } from "../server/auth/token-store.js";
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
  const newToken = generateToken();
  const { promises: fsPromises } = await import("node:fs");
  const tokenPath = getTokenFilePath();
  await fsPromises.writeFile(tokenPath, newToken, { encoding: "utf8", mode: 0o600 });

  const serverUrl = `http://localhost:${DEFAULT_MCP_PORT}`;
  let graceWindowActive = false;
  try {
    const resp = await fetch(`${serverUrl}/api/rotate-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${oldToken}`,
      },
      body: JSON.stringify({ previousToken: oldToken }),
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      graceWindowActive = true;
    } else {
      const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      console.error(
        `[tandem] Warning: server responded with ${resp.status} to rotate-token request.`,
        body.message ?? "",
      );
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
