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

import { createHash } from "node:crypto";

import type { ModelsFile } from "../../shared/models/contract.js";
import { resolveAppDataDir } from "../platform.js";
import { emptyModelsFile } from "./schema.js";
import { createModelStore, type ModelStore, serializeModelsFile } from "./store.js";

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
  } catch (err) {
    // read() is contractually non-throwing, so reaching here means a genuine
    // failure (e.g. createModelStore rejecting a bad appData path). Log it —
    // the boot-site catch in index.ts only sees dynamic-import failures, so
    // swallowing silently here would leave the empty cache unexplained.
    console.error(
      `[tandem] Failed to prime model-registry cache (${
        err instanceof Error ? err.message : String(err)
      }); using an empty registry.`,
    );
    cache = emptyModelsFile();
  }
}

/** Synchronous read of the last-primed registry. Used by the resolver. */
export function getCachedModelsFile(): ModelsFile {
  return cache;
}

/**
 * Content-hash of an arbitrary registry file — SHA-256 over its canonical
 * serialized bytes. The shared ETag primitive: `getModelsEtag()` hashes the full
 * cache (the POST If-Match precondition + the loopback GET), while the LAN GET
 * hashes the *scrubbed* file it actually returns (so the etag can't leak that a
 * hidden field — `endpoint`/`apiKeyRef` — changed; #1123 M2 security review Q5).
 */
export function hashModelsFile(file: ModelsFile): string {
  return createHash("sha256").update(serializeModelsFile(file)).digest("hex");
}

/**
 * Content-hash ETag of the cached registry (#1123 M2) — SHA-256 over the exact
 * canonical bytes the store writes to disk. Serves `GET /api/models` (loopback)
 * and the `POST /api/models` optimistic-concurrency precondition (If-Match), so a
 * stale writer is rejected with 409 instead of clobbering. Deliberately NOT a
 * persisted `revision` field: a schema bump would make an older binary
 * back-up-and-empty a newer file (a one-way downgrade cliff); a hash needs no
 * schema change. Derived from the cache, which equals the last-written bytes.
 */
export function getModelsEtag(): string {
  return hashModelsFile(cache);
}

/**
 * Persist a whole registry file and keep the cache coherent. Caches the
 * Zod-CANONICAL form the store returns (not the caller's object) so the ETag is
 * stable across a write→read cycle (see `store.serializeModelsFile`).
 */
export async function persistModelsFile(file: ModelsFile): Promise<void> {
  cache = await getStore().write(file);
}

/** Result of an optimistic-concurrency write. */
export type IfMatchWriteResult =
  | { ok: true; etag: string }
  | { ok: false; reason: "stale"; currentEtag: string }
  | { ok: false; reason: "busy" };

// Single-flight guard. Node is single-threaded, but `persistModelsFile` awaits,
// so two POSTs could both pass the synchronous etag compare before either write
// resolves and the second clobbers the first (the TOCTOU the concurrency guard
// exists to prevent). This boolean serializes compare+write; a concurrent
// second writer is told "busy" (→ 429, retry) rather than racing.
let writeInFlight = false;

/**
 * Optimistic-concurrency write (#1123 M2). Rejects a stale writer (`ifMatch`
 * ≠ current ETag) with `{stale}` so the client re-GETs and reconciles instead
 * of clobbering. The client always GETs first, so it always holds an ETag (even
 * of the empty baseline) — there is no null/force path. The server owns the
 * token: it derives the new ETag from the freshly written bytes; the client
 * never supplies a value to persist.
 */
export async function persistModelsFileIfMatch(
  file: ModelsFile,
  ifMatch: string,
): Promise<IfMatchWriteResult> {
  if (writeInFlight) return { ok: false, reason: "busy" };
  writeInFlight = true;
  try {
    const current = getModelsEtag();
    if (ifMatch !== current) return { ok: false, reason: "stale", currentEtag: current };
    await persistModelsFile(file);
    return { ok: true, etag: getModelsEtag() };
  } finally {
    writeInFlight = false;
  }
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
