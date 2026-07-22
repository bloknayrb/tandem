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
 *   ENOENT / empty              → empty config
 *   malformed JSON              → backup + empty
 *   missing/newer schemaVersion → backup + empty  (NOT a throw)
 *   migration or Zod failure    → backup + empty
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
  write(file: ModelsFile): Promise<void>;
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

async function writeModelsFile(filePath: string, file: ModelsFile): Promise<void> {
  ModelsFileSchema.parse(file);
  await atomicWriteConfigFile(filePath, JSON.stringify(file, null, 2) + "\n");
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
