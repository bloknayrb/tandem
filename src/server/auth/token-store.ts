import crypto from "crypto";
import envPaths from "env-paths";
import fs from "fs";
import path from "path";
import { TOKEN_FILE_NAME } from "../../shared/constants.js";

export function getTokenFilePath(): string {
  return path.join(envPaths("tandem", { suffix: "" }).data, TOKEN_FILE_NAME);
}

export async function readTokenFromFile(): Promise<string | null> {
  const filePath = getTokenFilePath();
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeTokenToFile(token: string): Promise<string> {
  const filePath = getTokenFilePath();
  const dir = path.dirname(filePath);

  await fs.promises.mkdir(dir, { recursive: true });

  // Warn on Windows when data dir is not under %LOCALAPPDATA% — NTFS ACL
  // inheritance may not restrict access to the current user the way 0600 does.
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const normalizedDir = path.resolve(dir).toLowerCase();
      const normalizedLocal = path.resolve(localAppData).toLowerCase();
      if (!normalizedDir.startsWith(normalizedLocal)) {
        console.warn(
          `[Tandem] auth token dir is outside %LOCALAPPDATA% (${dir}); NTFS ACL inheritance may not restrict access to current user`,
        );
      }
    }
  }

  // O_EXCL first-write: on EEXIST, adopt the winner's token instead of overwriting.
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(filePath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Concurrent start won the race — read and adopt their token.
      const existing = await readTokenFromFile();
      if (existing) return existing;
      // File exists but is empty (degenerate race) — fall through to overwrite below.
      fh = await fs.promises.open(filePath, "w");
    } else {
      throw err;
    }
  }

  try {
    await fh.writeFile(token, "utf8");
  } finally {
    await fh.close();
  }

  // Restrict read/write to owner on POSIX. On Windows, the mkdir + NTFS warning
  // above is the extent of our access control — chmod is a no-op there.
  if (process.platform !== "win32") {
    await fs.promises.chmod(filePath, 0o600);
  }

  return token;
}

// Priority: env var (Tauri injects before sidecar spawn) → existing file → generate+persist.
// Exits with code 1 on crypto failure or unwritable dir — non-recoverable in Tauri/Cowork mode.
// Returns string | null: PR a never produces null; null is reserved for PR b's CLI loopback gating.
export async function loadOrCreateToken(): Promise<string | null> {
  // Tauri passes the token via env before spawning the sidecar.
  const envToken = process.env.TANDEM_AUTH_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    console.error("[Tandem] auth token loaded from env");
    return envToken.trim();
  }

  const existing = await readTokenFromFile();
  if (existing) {
    console.error("[Tandem] auth token loaded from file");
    return existing;
  }

  // Generate exactly 32 bytes of CSPRNG — no fallback to pseudorandom.
  let raw: Buffer;
  try {
    raw = crypto.randomBytes(32);
  } catch (err) {
    console.error("[Tandem] FATAL: crypto.randomBytes failed:", err);
    process.exit(1);
  }

  const token = raw.toString("base64url");

  try {
    const written = await writeTokenToFile(token);
    console.error("[Tandem] auth token written to file");
    return written;
  } catch (err) {
    console.error("[Tandem] FATAL: cannot write auth token:", err);
    process.exit(1);
  }
}
