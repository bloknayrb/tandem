/**
 * Storage layer for the server-relocated Models registry (`models.json`, #1123 M1a).
 *
 * Mirrors `src/server/integrations/storage.ts` (atomic write, broken-file
 * backup, referential integrity) but with ONE deliberate divergence
 * (security review Finding 2): **the read path never throws.** The resolver
 * (`src/server/local-model/config-source.ts`) and the boot cache-warm read
 * this store on a synchronous / boot path with no error channel, so a
 * version-too-new or post-migration-invalid file must degrade to an empty
 * config (loop goes inert), never crash startup. Integrations can throw there
 * because its reads are always inside an HTTP try/catch; this store is not.
 *
 * Read recovery (all lossy-to-stderr, never throwing):
 *   ENOENT (no file)            → empty config (no backup — nothing to preserve)
 *   malformed / empty JSON      → backup + empty  (a 0-byte file fails JSON.parse)
 *   missing/newer schemaVersion → backup + empty  (NOT a throw)
 *   Zod validation failure      → backup + empty  (no migrateUp step exists yet)
 *   dangling defaultModelId     → cleared with stderr warning
 */

import fs from "node:fs";
import path from "node:path";

import { MODELS_SCHEMA_VERSION, type ModelsFile } from "../../shared/models/contract.js";
import {
  atomicWriteConfigFile,
  backupBrokenJsonFile,
  readSchemaVersion,
  sweepBrokenBackupsOnStartup,
} from "../integrations/storage.js";
import { emptyModelsFile, ModelsFileSchema } from "./schema.js";

export const MODELS_FILE_NAME = "models.json";

/** Filename prefix for broken-models backups (shares `.broken-backups/`). */
export const MODELS_BROKEN_BACKUP_PREFIX = "models-";

export interface ModelStore {
  read(): Promise<ModelsFile>;
  /** Writes `file` and returns the Zod-canonical form actually persisted. */
  write(file: ModelsFile): Promise<ModelsFile>;
  readonly filePath: string;
}

export function createModelStore(basePath: string): ModelStore {
  if (!basePath || basePath.length === 0) {
    throw new Error("createModelStore: basePath is required");
  }
  if (!path.isAbsolute(basePath)) {
    throw new Error(`createModelStore: basePath must be absolute (got "${basePath}")`);
  }
  const filePath = path.join(basePath, MODELS_FILE_NAME);
  return {
    filePath,
    read: () => readModelsFile(filePath),
    write: (file) => writeModelsFile(filePath, file),
  };
}

async function readModelsFile(filePath: string): Promise<ModelsFile> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyModelsFile();
    // Any other read error (permissions, IO) degrades to empty — never crash
    // the boot/resolver path. The file is left in place for a human to inspect.
    console.error(
      `[tandem] ${MODELS_FILE_NAME} could not be read (${
        err instanceof Error ? err.message : String(err)
      }); using an empty registry for this read.`,
    );
    return emptyModelsFile();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await backupBrokenJsonFile(filePath, MODELS_BROKEN_BACKUP_PREFIX);
    return emptyModelsFile();
  }

  // Missing/non-number version OR a version newer than we support → the file is
  // unusable to this build. Back it up and start empty. Unlike integrations we
  // do NOT throw on the newer-version case: the resolver has no error channel.
  const version = readSchemaVersion(parsed);
  if (version === null || version > MODELS_SCHEMA_VERSION) {
    await backupBrokenJsonFile(filePath, MODELS_BROKEN_BACKUP_PREFIX);
    return emptyModelsFile();
  }
  // v1 is the only version today, so there is no migrateUp step yet. When a v2
  // lands, migrate here (mirroring integrations) BEFORE the safeParse.

  const result = ModelsFileSchema.safeParse(parsed);
  if (!result.success) {
    await backupBrokenJsonFile(filePath, MODELS_BROKEN_BACKUP_PREFIX);
    return emptyModelsFile();
  }

  return enforceReferentialIntegrity(result.data);
}

/**
 * Canonical on-disk serialization for a `ModelsFile`. The ONE source of the
 * exact bytes written to disk, so the content-hash ETag (`getModelsEtag`, #1123
 * M2) hashes precisely what a client would read back. Deterministic key order:
 * callers pass a Zod-parsed file, whose keys follow schema definition order
 * regardless of input order, so two logically-equal files serialize identically.
 */
export function serializeModelsFile(file: ModelsFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

async function writeModelsFile(filePath: string, file: ModelsFile): Promise<ModelsFile> {
  // Parse to the Zod-CANONICAL form (schema key order, independent of the
  // caller's input order), then run the SAME referential-integrity pass `read()`
  // applies — so a dangling `defaultModelId` is cleared identically on write and
  // read, and the cached bytes hash identically to a fresh read cycle
  // (JSON.parse→safeParse→schema order→integrity). Without either, the ETag would
  // differ between GET-after-POST and GET-after-restart, 409-ing every first write.
  const canonical = enforceReferentialIntegrity(ModelsFileSchema.parse(file));
  await atomicWriteConfigFile(filePath, serializeModelsFile(canonical));
  return canonical;
}

/** Server-startup hook — prune models broken-backups to the shared cap. */
export async function sweepBrokenModelsBackupsOnStartup(appDataDir: string): Promise<void> {
  await sweepBrokenBackupsOnStartup(appDataDir, MODELS_BROKEN_BACKUP_PREFIX);
}

function enforceReferentialIntegrity(file: ModelsFile): ModelsFile {
  if (file.defaultModelId === null) return file;
  const exists = file.models.some((m) => m.id === file.defaultModelId);
  if (exists) return file;
  console.error(
    `[tandem] ${MODELS_FILE_NAME} defaultModelId "${file.defaultModelId}" does not match any entry; clearing.`,
  );
  return { ...file, defaultModelId: null };
}
