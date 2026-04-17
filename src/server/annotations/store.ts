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
 *   - `queueWrite` takes a THUNK, not a pre-computed doc. The snapshot runs at
 *     debounce-fire time, not at mutation time, so a 50-mutation burst only
 *     pays for one serialization.
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
import { type AnnotationDocV1, parseAnnotationDoc, SCHEMA_VERSION } from "./schema.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DocStore {
  load(): Promise<AnnotationDocV1>;
  /**
   * Enqueue a debounced write. The `snapshot` thunk is invoked at
   * debounce-fire time, NOT at call time, so callers can pass the freshest
   * possible state without paying for N serializations in a burst.
   */
  queueWrite(snapshot: () => AnnotationDocV1): void;
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

/**
 * Per-doc debounce queue. Guarded from concurrency by Node's single thread.
 * The stored `snapshotFn` is invoked when the timer fires (or `flush` runs).
 */
const pending = new Map<string, { timer: NodeJS.Timeout; snapshotFn: () => AnnotationDocV1 }>();

/**
 * Per-doc failure bookkeeping. Consolidated into a single map so the
 * "transient toast / throttle / disable after N failures / persistent
 * one-shot notice" state machine is legible in one place.
 *
 * Lifecycle asymmetry (see `closeStore`): `count` and `lastNotifiedAt` are
 * transient — safe to clear on doc close so reopening gets a clean slate.
 * `disabled` and `persistentNotified` MUST survive doc close: they encode
 * "writes are off for this install until restart" UX, and clearing them on
 * close would let a disabled doc re-arm its first-failure toast on every
 * reopen.
 */
interface DocFailureState {
  count: number;
  lastNotifiedAt: number;
  disabled: boolean;
  persistentNotified: boolean;
}
const failureState = new Map<string, DocFailureState>();

function getOrInitFailureState(docHash: string): DocFailureState {
  let state = failureState.get(docHash);
  if (!state) {
    state = { count: 0, lastNotifiedAt: 0, disabled: false, persistentNotified: false };
    failureState.set(docHash, state);
  }
  return state;
}

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
  const state = getOrInitFailureState(docHash);
  if (kind === "transient" && now - state.lastNotifiedAt < NOTIFY_THROTTLE_MS) {
    return; // Throttled
  }
  state.lastNotifiedAt = now;

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

/**
 * Bump the per-doc failure counter and emit the appropriate notification.
 * After `DISABLE_AFTER_FAILURES` consecutive failures, the doc is flagged
 * `disabled` and a one-shot persistent notice fires (throttle bypassed);
 * otherwise a throttled transient notice fires. Called from both the debounce
 * timer in `scheduleWrite` and the synchronous flush path in `flushOne`.
 */
function recordFailure(docHash: string, filePath: string, err: unknown): void {
  const state = getOrInitFailureState(docHash);
  state.count += 1;
  if (state.count >= DISABLE_AFTER_FAILURES) {
    state.disabled = true;
    if (!state.persistentNotified) {
      state.persistentNotified = true;
      // Bypass throttle — persistent notice is a one-shot.
      state.lastNotifiedAt = 0;
      notifyFailure(docHash, filePath, err, "persistent");
    }
  } else {
    notifyFailure(docHash, filePath, err, "transient");
  }
}

// ---------------------------------------------------------------------------
// Core per-doc store implementation
// ---------------------------------------------------------------------------

/**
 * Zero-alloc empty-doc factory. Avoids routing through `migrateToV1({})`
 * (which runs Zod validation over two empty arrays for no benefit).
 */
function emptyDoc(docHash: string, filePath: string): AnnotationDocV1 {
  return {
    schemaVersion: SCHEMA_VERSION,
    docHash,
    meta: { filePath, lastUpdated: 0 },
    annotations: [],
    tombstones: [],
    replies: [],
  };
}

function filePathFor(docHash: string): string {
  return path.join(getAnnotationsDir(), `${docHash}.json`);
}

async function performWrite(docHash: string, doc: AnnotationDocV1): Promise<void> {
  await ensureDirReady();
  const target = filePathFor(docHash);
  await atomicWrite(target, JSON.stringify(doc));
  // Success — clear transient failure state but LEAVE `lastNotifiedAt` in
  // place so a brief recovery + re-failure within 60s doesn't re-spam the
  // user. Also leave `disabled`/`persistentNotified` alone: those only clear
  // on process restart (matching the "restart Tandem to retry" UX).
  const state = failureState.get(docHash);
  if (state) state.count = 0;
}

function scheduleWrite(docHash: string, filePath: string, snapshotFn: () => AnnotationDocV1): void {
  if (isFeatureDisabled()) return;
  if (readOnly) {
    console.warn(`[ANNOTATION-STORE] Read-only mode; dropping write for ${docHash}`);
    return;
  }
  if (failureState.get(docHash)?.disabled) return;

  const existing = pending.get(docHash);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    const entry = pending.get(docHash);
    pending.delete(docHash);
    if (!entry) return;
    // Isolate thunk failures to the per-doc failure path. Without this, a
    // throw from `snapshot()` (e.g. a destroyed Y.Doc after a close race)
    // escapes the timer and hits `process.on("uncaughtException", ...)` in
    // index.ts, which exits the whole server — a per-doc save failure must
    // never take the process down.
    let doc: AnnotationDocV1;
    try {
      doc = entry.snapshotFn();
    } catch (err) {
      recordFailure(docHash, filePath, err);
      return;
    }
    performWrite(docHash, doc).catch((err) => {
      recordFailure(docHash, filePath, err);
    });
  }, DEBOUNCE_MS);

  // Don't block process exit on a debounce timer — callers who care about
  // flushing should call `flush()` explicitly.
  if (typeof timer.unref === "function") timer.unref();

  pending.set(docHash, { timer, snapshotFn });
}

async function flushOne(docHash: string): Promise<void> {
  const entry = pending.get(docHash);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(docHash);
  // Invoke the thunk at flush time (mirrors the debounce-fire path). Same
  // isolation rule: a throwing thunk must not crash the process. We report
  // the failure and re-throw so `flush()` callers (tests, shutdown) see it,
  // but the stack-trace origin is `recordFailure`, not `uncaughtException`.
  let doc: AnnotationDocV1;
  try {
    doc = entry.snapshotFn();
  } catch (err) {
    // Unknown filePath — the unmaterialized doc can't tell us. Use an empty
    // string; `notifyFailure` falls back to docHash for the UI label.
    recordFailure(docHash, "", err);
    throw err;
  }
  try {
    await performWrite(docHash, doc);
  } catch (err) {
    recordFailure(docHash, doc.meta.filePath, err);
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
  if (result.ok) return result.doc;

  if (result.error === "corrupt") {
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

  const schemaVersion = result.schemaVersion;
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
    queueWrite: (snapshotFn) => scheduleWrite(docHash, meta.filePath, snapshotFn),
    flush: () => flushOne(docHash),
    clear: () => clearOne(docHash),
    isReadOnly: () => readOnly,
    isDisabled: (h) => failureState.get(h)?.disabled === true,
  };
}

// ---------------------------------------------------------------------------
// Per-doc lifecycle
// ---------------------------------------------------------------------------

/**
 * Flush any pending write for this doc and clear its TRANSIENT bookkeeping.
 * Wired into the file-opener's close path so long-running servers opening
 * many docs don't accumulate stale entries in the module-level maps.
 *
 * Asymmetric cleanup (intentional):
 *   - Cleared: `pending` timer/thunk, `failureState.count`, `failureState.lastNotifiedAt`.
 *   - Preserved: `failureState.disabled`, `failureState.persistentNotified`.
 *
 * The preserved flags encode "writes disabled until process restart" UX. If
 * we cleared them on close, a user who hit 3 failures, closed the doc, then
 * reopened would get the "first failure" toast again instead of the terminal
 * "disabled; restart Tandem to retry" state they're already in.
 */
export async function closeStore(docHash: string): Promise<void> {
  if (isFeatureDisabled()) return;
  try {
    await flushOne(docHash);
  } catch {
    // Swallow — a failing flush already notified via recordFailure; we still
    // want to clean up transient state. Persistent failure flags are
    // preserved by the selective reset below.
  }

  const state = failureState.get(docHash);
  if (state) {
    if (state.disabled || state.persistentNotified) {
      // Preserve the terminal flags; zero out transient bookkeeping.
      state.count = 0;
      state.lastNotifiedAt = 0;
    } else {
      failureState.delete(docHash);
    }
  }
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------

/** Reset all module state. Tests only — never call in production. */
export function resetForTesting(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  failureState.clear();
  annotationsDirReady = false;
  readOnly = false;
}
