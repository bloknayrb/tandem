/**
 * Storage layer for `IntegrationsFile`.
 *
 * Atomic-write semantics + 0o600 file mode mirror `src/server/auth/token-store.ts`.
 * The factory requires an explicit base path — production callers wrap it with
 * `resolveAppDataDir()`; tests pass a `mkdtempSync` path. No silent default.
 *
 * Read recovery:
 *   ENOENT          → empty config
 *   malformed JSON  → backup to `<file>.broken-<ts>` (0o600), empty config, stderr warning
 *   migration error → preserve original on disk, surface error to caller
 *   dangling defaultIntegrationId → null with stderr warning
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { setRestrictiveAcl } from "./acl-win.js";
import { migrateUp } from "./migrations.js";
import {
  emptyIntegrationsFile,
  INTEGRATIONS_SCHEMA_VERSION,
  type IntegrationsFile,
  IntegrationsFileSchema,
} from "./schema.js";

export const INTEGRATIONS_FILE_NAME = "integrations.json";

export interface IntegrationsStore {
  read(): Promise<IntegrationsFile>;
  write(file: IntegrationsFile): Promise<void>;
  readonly filePath: string;
}

export function createIntegrationsStore(basePath: string): IntegrationsStore {
  if (!basePath || basePath.length === 0) {
    throw new Error("createIntegrationsStore: basePath is required");
  }
  if (!path.isAbsolute(basePath)) {
    throw new Error(`createIntegrationsStore: basePath must be absolute (got "${basePath}")`);
  }
  const filePath = path.join(basePath, INTEGRATIONS_FILE_NAME);

  return {
    filePath,
    read: () => readIntegrationsFile(filePath),
    write: (file) => writeIntegrationsFile(filePath, file),
  };
}

async function readIntegrationsFile(filePath: string): Promise<IntegrationsFile> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyIntegrationsFile();
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await backupBrokenFile(filePath);
    return emptyIntegrationsFile();
  }

  const version = readSchemaVersion(parsed);
  if (version === null) {
    await backupBrokenFile(filePath);
    return emptyIntegrationsFile();
  }
  if (version > INTEGRATIONS_SCHEMA_VERSION) {
    throw new Error(
      `integrations.json schemaVersion ${version} is newer than this Tandem build supports (${INTEGRATIONS_SCHEMA_VERSION}). Update Tandem or remove ${filePath}.`,
    );
  }

  const migrated = migrateUp(parsed, version, INTEGRATIONS_SCHEMA_VERSION);
  // Normalize legacy http://localhost URLs to http://127.0.0.1 before schema
  // validation. The LoopbackUrl validator accepts only 127.0.0.1; files written
  // before this tightening may carry localhost URLs (auto-config always wrote
  // 127.0.0.1, but manual edits could differ). Normalize silently here; the
  // corrected value is persisted on the next write.
  const normalized = normalizeLocalhostUrls(migrated);
  const result = IntegrationsFileSchema.safeParse(normalized);
  if (!result.success) {
    throw new Error(
      `integrations.json failed validation after migration (${result.error.message}). Original file preserved at ${filePath}.`,
    );
  }

  return enforceReferentialIntegrity(result.data);
}

async function writeIntegrationsFile(filePath: string, file: IntegrationsFile): Promise<void> {
  IntegrationsFileSchema.parse(file);

  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  warnIfWindowsDataDirOutsideLocalAppData(dir);

  const content = JSON.stringify(file, null, 2) + "\n";
  const tmp = path.join(dir, `.${INTEGRATIONS_FILE_NAME}.${randomUUID()}.tmp`);

  const fh = await fs.promises.open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(content, "utf8");
  } finally {
    await fh.close();
  }

  try {
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await writeViaOpen(filePath, content);
      await fs.promises.unlink(tmp).catch(() => {
        /* best-effort tmp cleanup */
      });
    } else {
      await fs.promises.unlink(tmp).catch(() => {
        /* best-effort tmp cleanup */
      });
      throw err;
    }
  }

  if (process.platform !== "win32") {
    await fs.promises.chmod(filePath, 0o600);
  }
}

/**
 * Mirrors the warning in `src/server/auth/token-store.ts:writeTokenToFile`.
 * On Windows the access-control story is NTFS ACL inheritance from the
 * parent directory, not POSIX 0o600. If the data dir resolves outside
 * `%LOCALAPPDATA%` (e.g. the user has remapped Tandem's app data via
 * `TANDEM_APP_DATA_DIR`), ACL inheritance may not restrict access to the
 * current user. Defense-in-depth via cross-process file mode is not
 * available; the warning is the user-visible signal. Issue #643 tracks
 * a deeper ACL solution.
 */
function warnIfWindowsDataDirOutsideLocalAppData(dir: string): void {
  if (process.platform !== "win32") return;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return;
  const normalizedDir = path.resolve(dir).toLowerCase();
  const normalizedLocal = path.resolve(localAppData).toLowerCase();
  if (!normalizedDir.startsWith(normalizedLocal)) {
    console.warn(
      `[tandem] integrations.json dir is outside %LOCALAPPDATA% (${dir}); NTFS ACL inheritance may not restrict access to current user`,
    );
  }
}

/**
 * EXDEV fallback path. Open the destination directly with O_CREAT|O_EXCL via
 * the "wx" flag; if the file already exists, lstat-check it is not a symlink
 * before reopening in "w" mode.
 *
 * Known limitation: there is a TOCTOU window between the lstat and the "w"
 * open during which an attacker with write access to the directory could
 * substitute a symlink. Node does not expose O_NOFOLLOW or openat(2); closing
 * the window fully would require a native addon. In practice the data dir is
 * under `%LOCALAPPDATA%` / `~/.local/share/` and writable only by the current
 * user. The outer `chmod 0o600` at the end of `writeIntegrationsFile` is the
 * cross-process backstop; the in-function chmod here closes the transient
 * window between fh.close() and that outer chmod where an existing-file "w"
 * open would otherwise inherit the prior mode bits.
 */
async function writeViaOpen(filePath: string, content: string): Promise<void> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(filePath, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const stat = await fs.promises.lstat(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Refusing to write through symlink at ${filePath}. Remove the symlink and retry.`,
        );
      }
      fh = await fs.promises.open(filePath, "w", 0o600);
    } else {
      throw err;
    }
  }
  try {
    await fh.writeFile(content, "utf8");
    if (process.platform !== "win32") {
      await fh.chmod(0o600);
    }
  } finally {
    await fh.close();
  }
}

async function backupBrokenFile(filePath: string): Promise<void> {
  const backupPath = `${filePath}.broken-${Date.now()}`;
  try {
    await fs.promises.copyFile(filePath, backupPath);
    if (process.platform === "win32") {
      await setRestrictiveAcl(backupPath).catch(() => {
        /* best-effort ACL; backup is created, content is preserved */
      });
    } else {
      await fs.promises.chmod(backupPath, 0o600).catch(() => {
        /* best-effort chmod; backup is created, content is preserved */
      });
    }
    console.error(
      `[tandem] integrations.json was malformed; backed up to ${path.basename(backupPath)} and replaced with an empty config.`,
    );
  } catch (err) {
    console.error(
      `[tandem] integrations.json was malformed and the backup at ${backupPath} failed (${
        err instanceof Error ? err.message : String(err)
      }). The malformed file remains in place; an empty config is returned for this read.`,
    );
  }
}

function readSchemaVersion(parsed: unknown): number | null {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "schemaVersion" in parsed &&
    typeof (parsed as { schemaVersion: unknown }).schemaVersion === "number"
  ) {
    return (parsed as { schemaVersion: number }).schemaVersion;
  }
  return null;
}

/**
 * Replace `http://localhost` with `http://127.0.0.1` in any `url` field across
 * all integration records. Operates on the raw unknown post-migration shape so
 * it runs before Zod validation (which now rejects localhost). Safe to call on
 * any value — non-object / non-array inputs are returned unchanged.
 */
function normalizeLocalhostUrls(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(normalizeLocalhostUrls);
  if (data === null || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key === "url" && typeof obj[key] === "string") {
      result[key] = (obj[key] as string).replace(/^http:\/\/localhost([:\/]|$)/, (m) =>
        m.replace("localhost", "127.0.0.1"),
      );
    } else {
      result[key] = normalizeLocalhostUrls(obj[key]);
    }
  }
  return result;
}

function enforceReferentialIntegrity(file: IntegrationsFile): IntegrationsFile {
  if (file.defaultIntegrationId === undefined) return file;
  const exists = file.integrations.some((i) => i.id === file.defaultIntegrationId);
  if (exists) return file;
  console.error(
    `[tandem] integrations.json defaultIntegrationId "${file.defaultIntegrationId}" does not match any integration; clearing.`,
  );
  return { ...file, defaultIntegrationId: undefined };
}
