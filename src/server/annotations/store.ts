/**
 * Durable per-document annotation store.
 *
 * One JSON file per document at `<annotationsDir>/<docHash>.json`. The Y.Map
 * (`Y_MAP_ANNOTATIONS`) remains the live collab state; this module is the
 * crash-safe source of record behind it.
 *
 * Behaviour summary (see the Phase 1 durable-annotations plan for rationale):
 *   - Location: `env-paths("tandem").data/annotations/` by default, override
 *     via `TANDEM_APP_DATA_DIR`.
 *   - Writes are atomic (reuses `file-io/atomicWrite` with Windows retries).
 *   - Writes are debounced per docHash (100ms) — bursty rapid writes for the
 *     same doc coalesce, but parallel writes to different docs do NOT share a
 *     debounce timer.
 *   - Corrupt files are quarantined to `<hash>.json.corrupt.<epoch-ms>`.
 *   - Files from a newer schema are parked at `<hash>.json.future` (no ts so
 *     future migration tooling has a predictable name).
 *   - Cross-process concurrent-writer guard via a `store.lock` PID lockfile
 *     (belt-and-braces on top of the port 3479 bind, which is the primary
 *     lock).
 *   - Disk-full / permission-denied errors: 60s throttled toast per doc,
 *     disable writes for that doc after 3 consecutive failures (in-memory —
 *     restart clears the flag, matching the "restart to retry" UX).
 *   - `TANDEM_ANNOTATION_STORE=off` short-circuits the entire module.
 */

import * as crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import envPaths from "env-paths";
import { atomicWrite } from "../file-io/index.js";
import { pushNotification } from "../notifications.js";
import { type AnnotationDocV1, migrateToV1, parseAnnotationDoc } from "./schema.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DocStore {
  load(): Promise<AnnotationDocV1>;
  queueWrite(doc: AnnotationDocV1): void;
  flush(): Promise<void>;
  clear(): Promise<void>;
  isReadOnly(): boolean;
  isDisabled(docHash: string): boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 100;
const NOTIFY_THROTTLE_MS = 60_000;
const DISABLE_AFTER_FAILURES = 3;
const LOCK_FILE = "store.lock";

/**
 * Resolve the annotations directory. Honors `TANDEM_APP_DATA_DIR` for test
 * isolation (mirrors `SESSION_DIR` but decouples from it so each module gets a
 * fresh tempdir per test run). Not memoised — cheap and callers may reset the
 * env var between tests.
 */
export function getAnnotationsDir(): string {
  const override = process.env.TANDEM_APP_DATA_DIR;
  if (override && override.length > 0) {
    return path.join(override, "annotations");
  }
  const paths = envPaths("tandem", { suffix: "" });
  return path.join(paths.data, "annotations");
}

function isFeatureDisabled(): boolean {
  return process.env.TANDEM_ANNOTATION_STORE === "off";
}

// ---------------------------------------------------------------------------
// Shared module state
// ---------------------------------------------------------------------------

/** Lazy mkdir marker — mirrors `sessionDirReady` in session/manager.ts. */
let annotationsDirReady = false;

/** Read-only mode engaged when another live PID owns the lockfile. */
let readOnly = false;

/** Per-doc debounce queue. Guarded from concurrency by Node's single thread. */
const pending = new Map<string, { timer: NodeJS.Timeout; doc: AnnotationDocV1 }>();

/** Per-doc consecutive-failure counter. Cleared on a successful write. */
const failureCounts = new Map<string, number>();

/** Per-doc epoch-ms of the last notification (for the 60s throttle). */
const lastNotifiedAt = new Map<string, number>();

/** Set of docHashes whose writes are disabled for the life of the process. */
const disabledDocs = new Set<string>();

/** Track which docs have already emitted the persistent "disabled" toast. */
const persistentNotified = new Set<string>();

async function ensureDirReady(): Promise<void> {
  if (annotationsDirReady) return;
  await fs.mkdir(getAnnotationsDir(), { recursive: true });
  annotationsDirReady = true;
}

// ---------------------------------------------------------------------------
// Lockfile (concurrent-writer guard)
// ---------------------------------------------------------------------------

/**
 * Take the per-install store lock. The port 3479 bind is the primary lock;
 * this is the belt-and-braces fallback for ports-bind races and edge cases.
 *
 * Returns:
 *   - `"locked"` when we now own the lock (either created fresh or reclaimed
 *     a stale one from a dead PID).
 *   - `"readonly"` when a live PID holds the lock. In this mode `queueWrite`
 *     is a no-op; `load` still works so the UI can render existing state.
 */
export async function acquireStoreLock(): Promise<"locked" | "readonly"> {
  if (isFeatureDisabled()) {
    // Feature off — no lock, not readonly (store is entirely inert).
    readOnly = false;
    return "locked";
  }

  await ensureDirReady();
  const lockPath = path.join(getAnnotationsDir(), LOCK_FILE);
  readOnly = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Exclusive create — fails with EEXIST if the file already exists.
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid), "utf-8");
      } finally {
        await handle.close();
      }
      return "locked";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // Permissions / disk full / something we can't recover from — degrade
        // to read-only so the app still runs.
        console.error(
          `[ANNOTATION-STORE] Failed to take lock at ${lockPath}: ${(err as Error).message}. Running read-only.`,
        );
        readOnly = true;
        return "readonly";
      }

      // Lock exists — check liveness of the PID inside it.
      const staleReclaimed = await tryReclaimStaleLock(lockPath);
      if (!staleReclaimed) {
        readOnly = true;
        return "readonly";
      }
      // Loop once more to try the exclusive create after unlinking.
    }
  }

  // Two attempts failed — couldn't reclaim cleanly.
  readOnly = true;
  return "readonly";
}

/**
 * Examine an existing lockfile. If its PID is dead, unlink it and return
 * `true` so the caller can retry acquiring. If the PID is alive, return
 * `false`. Any other error is logged and treated as "live" (safer default —
 * fail closed into read-only mode).
 */
async function tryReclaimStaleLock(lockPath: string): Promise<boolean> {
  let rawPid: string;
  try {
    rawPid = (await fs.readFile(lockPath, "utf-8")).trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true; // Lock vanished between stat and read.
    console.error(
      `[ANNOTATION-STORE] Failed to read lockfile at ${lockPath}: ${(err as Error).message}. Assuming live holder.`,
    );
    return false;
  }

  const pid = Number.parseInt(rawPid, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    // Garbage content — treat as stale and clear it.
    await fs.unlink(lockPath).catch(() => {});
    return true;
  }

  // Intentionally no `pid === process.pid` shortcut: acquireStoreLock is
  // expected to run exactly once at process startup, so an existing lock with
  // our own PID inside it only happens in tests that are explicitly
  // simulating "another live process already owns the lock" (since there's
  // only one PID that's guaranteed live in the current OS — ours). Falling
  // through to the liveness check gives that test the `readonly` outcome it
  // expects.
  let alive: boolean;
  try {
    // Signal 0 = existence check without sending a signal.
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = no such process. EPERM = process exists but we can't signal it.
    alive = code === "EPERM";
  }

  if (alive) return false;

  await fs.unlink(lockPath).catch(() => {});
  return true;
}

/** Release the store lock. Safe to call repeatedly; no-op if we don't own it. */
export async function releaseStoreLock(): Promise<void> {
  if (isFeatureDisabled()) return;
  const lockPath = path.join(getAnnotationsDir(), LOCK_FILE);
  try {
    const raw = (await fs.readFile(lockPath, "utf-8")).trim();
    if (Number.parseInt(raw, 10) === process.pid) {
      await fs.unlink(lockPath);
    }
  } catch {
    // ENOENT or parse error — nothing to release.
  }
  readOnly = false;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function notifyFailure(
  docHash: string,
  filePath: string,
  err: unknown,
  kind: "transient" | "persistent",
): void {
  const now = Date.now();
  const prev = lastNotifiedAt.get(docHash) ?? 0;
  if (kind === "transient" && now - prev < NOTIFY_THROTTLE_MS) {
    return; // Throttled
  }
  lastNotifiedAt.set(docHash, now);

  const fileName = path.basename(filePath) || docHash;
  const message =
    kind === "persistent"
      ? `Annotation saving disabled for ${fileName}; restart Tandem to retry.`
      : `Failed to save annotations for ${fileName}: ${(err as Error)?.message ?? "unknown error"}`;

  try {
    pushNotification({
      id: crypto.randomUUID(),
      type: "save-error",
      severity: "error",
      message,
      dedupKey: `annotation-store:${docHash}:${kind}`,
      timestamp: now,
      errorCode: (err as NodeJS.ErrnoException)?.code,
    });
  } catch (notifyErr) {
    console.error("[ANNOTATION-STORE] pushNotification threw:", notifyErr);
  }

  // Always mirror to stderr for power users debugging without the UI.
  console.error(`[ANNOTATION-STORE] ${message}`);
}

// ---------------------------------------------------------------------------
// Core per-doc store implementation
// ---------------------------------------------------------------------------

function emptyDoc(docHash: string, filePath: string): AnnotationDocV1 {
  const base = migrateToV1({});
  base.docHash = docHash;
  base.meta = { filePath, lastUpdated: 0 };
  return base;
}

function filePathFor(docHash: string): string {
  return path.join(getAnnotationsDir(), `${docHash}.json`);
}

async function performWrite(
  docHash: string,
  metaPath: string,
  doc: AnnotationDocV1,
): Promise<void> {
  await ensureDirReady();
  const target = filePathFor(docHash);
  await atomicWrite(target, JSON.stringify(doc));
  // Success — clear transient failure state.
  failureCounts.delete(docHash);
  // Leave `lastNotifiedAt` in place so a brief recovery + re-failure within
  // 60s doesn't re-spam the user.
}

function scheduleWrite(docHash: string, filePath: string, doc: AnnotationDocV1): void {
  if (isFeatureDisabled()) return;
  if (readOnly) {
    console.warn(`[ANNOTATION-STORE] Read-only mode; dropping write for ${docHash}`);
    return;
  }
  if (disabledDocs.has(docHash)) return;

  const existing = pending.get(docHash);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    const entry = pending.get(docHash);
    pending.delete(docHash);
    if (!entry) return;
    performWrite(docHash, filePath, entry.doc).catch((err) => {
      const count = (failureCounts.get(docHash) ?? 0) + 1;
      failureCounts.set(docHash, count);
      if (count >= DISABLE_AFTER_FAILURES) {
        disabledDocs.add(docHash);
        if (!persistentNotified.has(docHash)) {
          persistentNotified.add(docHash);
          // Bypass throttle — persistent notice is a one-shot.
          lastNotifiedAt.delete(docHash);
          notifyFailure(docHash, filePath, err, "persistent");
        }
      } else {
        notifyFailure(docHash, filePath, err, "transient");
      }
    });
  }, DEBOUNCE_MS);

  // Don't block process exit on a debounce timer — callers who care about
  // flushing should call `flush()` explicitly.
  if (typeof timer.unref === "function") timer.unref();

  pending.set(docHash, { timer, doc });
}

async function flushOne(docHash: string): Promise<void> {
  const entry = pending.get(docHash);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(docHash);
  // `performWrite` re-throws so `flush()` surfaces failures to tests/shutdown.
  // It still trips the failure counter inside performWrite? Actually no —
  // performWrite clears-on-success but doesn't bump on failure (scheduleWrite
  // does that). Mirror the same bookkeeping here.
  try {
    await performWrite(docHash, entry.doc.meta.filePath, entry.doc);
  } catch (err) {
    const count = (failureCounts.get(docHash) ?? 0) + 1;
    failureCounts.set(docHash, count);
    if (count >= DISABLE_AFTER_FAILURES) {
      disabledDocs.add(docHash);
      if (!persistentNotified.has(docHash)) {
        persistentNotified.add(docHash);
        lastNotifiedAt.delete(docHash);
        notifyFailure(docHash, entry.doc.meta.filePath, err, "persistent");
      }
    } else {
      notifyFailure(docHash, entry.doc.meta.filePath, err, "transient");
    }
    throw err;
  }
}

async function loadOne(docHash: string, filePath: string): Promise<AnnotationDocV1> {
  if (isFeatureDisabled()) return emptyDoc(docHash, filePath);

  const target = filePathFor(docHash);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyDoc(docHash, filePath);
    // Hard read error — fall back to empty and log; don't crash the server.
    console.error(
      `[ANNOTATION-STORE] Failed to read ${target}: ${(err as Error).message}. Returning empty doc.`,
    );
    return emptyDoc(docHash, filePath);
  }

  const result = parseAnnotationDoc(raw);
  if (!("error" in result)) return result;

  // TS can't narrow Zod's `objectOutputType` out of the union via `"error" in`
  // alone (the passthrough index signature defeats the exclusion), so coerce
  // to the error union explicitly now that we've confirmed `error` exists.
  const errResult = result as { error: "corrupt" } | { error: "future"; schemaVersion: number };

  if (errResult.error === "corrupt") {
    const quarantinePath = `${target}.corrupt.${Date.now()}`;
    try {
      await fs.rename(target, quarantinePath);
    } catch (renameErr) {
      console.error(
        `[ANNOTATION-STORE] Failed to quarantine corrupt file ${target}: ${(renameErr as Error).message}`,
      );
    }
    // Throttled toast so a corrupt-on-boot doesn't silently swallow data.
    notifyFailure(docHash, filePath, new Error("Annotation file was corrupt"), "transient");
    return emptyDoc(docHash, filePath);
  }

  // errResult.error === "future"
  const schemaVersion = errResult.schemaVersion;
  const futurePath = `${target}.future`;
  try {
    // rename is not idempotent; unlink any existing `.future` from a prior
    // downgrade so we always keep the most recent copy.
    await fs.unlink(futurePath).catch(() => {});
    await fs.rename(target, futurePath);
  } catch (renameErr) {
    console.error(
      `[ANNOTATION-STORE] Failed to park future-schema file ${target}: ${(renameErr as Error).message}`,
    );
  }
  console.error(
    `[ANNOTATION-STORE] Annotation file ${target} has future schemaVersion=${schemaVersion}; moved to .future.`,
  );
  return emptyDoc(docHash, filePath);
}

async function clearOne(docHash: string): Promise<void> {
  if (isFeatureDisabled()) return;
  // Drop any pending write so we don't immediately re-create the file.
  const entry = pending.get(docHash);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(docHash);
  }
  const target = filePathFor(docHash);
  try {
    await fs.unlink(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`[ANNOTATION-STORE] Failed to delete ${target}: ${(err as Error).message}`);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a per-doc store handle. Cheap; safe to call as often as needed (state
 * is keyed off `docHash` at module scope).
 *
 * @param docHash  Output of `docHash(filePath)` from ./doc-hash.ts.
 * @param meta.filePath  Original filesystem path. Used for the `.meta`
 *   envelope field and for toast messages.
 */
export function createStore(docHash: string, meta: { filePath: string }): DocStore {
  if (isFeatureDisabled()) {
    return {
      async load() {
        return emptyDoc(docHash, meta.filePath);
      },
      queueWrite() {
        /* inert */
      },
      async flush() {
        /* inert */
      },
      async clear() {
        /* inert */
      },
      isReadOnly() {
        return false;
      },
      isDisabled() {
        return false;
      },
    };
  }

  return {
    load: () => loadOne(docHash, meta.filePath),
    queueWrite: (doc) => scheduleWrite(docHash, meta.filePath, doc),
    flush: () => flushOne(docHash),
    clear: () => clearOne(docHash),
    isReadOnly: () => readOnly,
    isDisabled: (h) => disabledDocs.has(h),
  };
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------

/** Reset all module state. Tests only — never call in production. */
export function resetForTesting(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  failureCounts.clear();
  lastNotifiedAt.clear();
  disabledDocs.clear();
  persistentNotified.clear();
  annotationsDirReady = false;
  readOnly = false;
}
