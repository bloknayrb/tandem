import envPaths from "env-paths";
import fs from "fs";
import path from "path";
import { TOKEN_FILE_NAME } from "../constants.js";

export function getTokenFilePath(): string {
  return path.join(envPaths("tandem", { suffix: "" }).data, TOKEN_FILE_NAME);
}

export async function readTokenFromFile(): Promise<string | null> {
  const filePath = getTokenFilePath();
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    // Remediate insecure permissions if a previous chmod failed (e.g., process crashed).
    if (process.platform !== "win32") {
      try {
        const stat = await fs.promises.stat(filePath);
        if ((stat.mode & 0o077) !== 0) {
          console.error("[tandem] auth token file has insecure permissions; attempting chmod 0600");
          await fs.promises.chmod(filePath, 0o600);
        }
      } catch {
        // Non-fatal: stat/chmod failure doesn't invalidate the token we already read
      }
    }
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
