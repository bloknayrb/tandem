/**
 * Process-singleton wrapper over the Models store (#1123 M1a).
 *
 * Owns (a) the single `ModelStore` instance, (b) an in-memory cache of the
 * parsed `models.json`, and (c) the read/prime/persist surface the rest of the
 * server uses. The local-model resolver (`config-source.ts`) reads the cache
 * SYNCHRONOUSLY — the collaborator's `resolveConfig` seam is `() => … | null`,
 * so the cache must already be warm.
 *
 * **Boot cache-warm is mandatory (architecture review Finding 1).** The
 * collaborator resolves config exactly once at boot; with a write-only-primed
 * cache, a fresh run with a valid `models.json` on disk would read a cold empty
 * cache and resolve null — defeating the whole "resolve without a browser
 * session" premise. `primeModelStoreCache()` MUST be awaited before
 * `startLocalModelCollaborator()` in `src/server/index.ts`. `read()` never
 * throws (see store.ts), and priming swallows anything else → empty cache.
 */

import type { ModelsFile } from "../../shared/models/contract.js";
import { resolveAppDataDir } from "../platform.js";
import { emptyModelsFile } from "./schema.js";
import { createModelStore, type ModelStore } from "./store.js";

let store: ModelStore | null = null;
let cache: ModelsFile = emptyModelsFile();

function getStore(): ModelStore {
  if (!store) store = createModelStore(resolveAppDataDir());
  return store;
}

/**
 * Warm the cache from disk. Awaited at boot before the collaborator starts.
 * Never throws — any failure leaves the cache empty (loop inert).
 */
export async function primeModelStoreCache(): Promise<void> {
  try {
    cache = await getStore().read();
  } catch {
    cache = emptyModelsFile();
  }
}

/** Synchronous read of the last-primed registry. Used by the resolver. */
export function getCachedModelsFile(): ModelsFile {
  return cache;
}

/**
 * Persist a whole registry file (validated by the store's Zod parse) and keep
 * the cache coherent. The `POST /api/models` handler calls this.
 */
export async function persistModelsFile(file: ModelsFile): Promise<void> {
  await getStore().write(file);
  cache = file;
}

/**
 * Test seam. Point the singleton at a temp dir (or reset it) and clear the
 * cache so each test starts clean. `basePath` omitted → next access re-derives
 * from `resolveAppDataDir()`.
 */
export function __resetModelRegistryForTests(basePath?: string): void {
  store = basePath ? createModelStore(basePath) : null;
  cache = emptyModelsFile();
}
