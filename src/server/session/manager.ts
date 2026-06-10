import fs from "fs/promises";
import path from "path";
import * as Y from "yjs";
import { CTRL_ROOM, SESSION_MAX_AGE, Y_MAP_CHAT } from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import { isUploadPath } from "../../shared/paths.js";
import type { SessionData } from "../../shared/types.js";
import { docHash, ENVELOPE_FILENAME_RE } from "../annotations/doc-hash.js";
import { parseAnnotationDoc } from "../annotations/schema.js";
import { createStore, getAnnotationsDir, isStoreReadOnly } from "../annotations/store.js";
import { atomicWrite } from "../file-io/index.js";
import { SESSION_DIR } from "../platform.js";

const AUTO_SAVE_INTERVAL = 60 * 1000; // 60 seconds
let sessionDirReady = false;

/** Generate a session key from a file path */
export function sessionKey(filePath: string): string {
  return encodeURIComponent(filePath.replace(/\\/g, "/"));
}

/**
 * Save Y.Doc state + metadata as a session file.
 *
 * `opts.dirty` (#1069): pass true when the doc holds body edits not yet written
 * to disk (callers that know the docId pass `isDirty(docId)`). Consumed on
 * reopen by the `.docx` restore-vs-reload prompt — a dirty `.docx` session is
 * the only copy of those edits, so it restores even over a changed source file.
 * Omitted (falsy) → field absent, matching pre-#1069 sessions.
 */
export async function saveSession(
  filePath: string,
  format: string,
  doc: Y.Doc,
  opts?: { dirty?: boolean },
): Promise<void> {
  const key = sessionKey(filePath);
  let sourceFileMtime = 0;
  // Upload paths have no disk file — skip stat
  if (!isUploadPath(filePath)) {
    try {
      const stat = await fs.stat(filePath);
      sourceFileMtime = stat.mtimeMs;
    } catch {
      // File may not exist yet (new doc)
    }
  }

  const state = Y.encodeStateAsUpdate(doc);
  const ydocState = Buffer.from(state).toString("base64");

  const data: SessionData = {
    filePath,
    format,
    ydocState,
    sourceFileMtime,
    lastAccessed: Date.now(),
    ...(opts?.dirty ? { dirty: true } : {}),
  };

  if (!sessionDirReady) {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    sessionDirReady = true;
  }
  const sessionPath = path.join(SESSION_DIR, `${key}.json`);
  await atomicWrite(sessionPath, JSON.stringify(data));
}

/** Load a session file if it exists */
export async function loadSession(filePath: string): Promise<SessionData | null> {
  const key = sessionKey(filePath);
  const sessionPath = path.join(SESSION_DIR, `${key}.json`);
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    return JSON.parse(content) as SessionData;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      console.error(`[Tandem] Corrupted session file ${sessionPath}, removing:`, err.message);
      await fs.unlink(sessionPath).catch((unlinkErr) => {
        console.error(`[Tandem] Failed to remove corrupted session ${sessionPath}:`, unlinkErr);
      });
      return null;
    }
    console.error(`[Tandem] Failed to read session ${sessionPath}:`, err);
    return null;
  }
}

/** Restore a Y.Doc from a session's base64-encoded state */
export function restoreYDoc(doc: Y.Doc, session: SessionData): void {
  const state = Buffer.from(session.ydocState, "base64");
  Y.applyUpdate(doc, new Uint8Array(state));
}

/** Check if the source file has changed since the session was saved */
export async function sourceFileChanged(session: SessionData): Promise<boolean> {
  // Uploaded files have no disk path — session is the only truth
  if (isUploadPath(session.filePath)) return false;
  try {
    const stat = await fs.stat(session.filePath);
    return stat.mtimeMs !== session.sourceFileMtime;
  } catch {
    return true; // File doesn't exist — treat as changed
  }
}

/** Delete a session file */
export async function deleteSession(filePath: string): Promise<void> {
  const key = sessionKey(filePath);
  const sessionPath = path.join(SESSION_DIR, `${key}.json`);
  try {
    await fs.unlink(sessionPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error("[Tandem] deleteSession: failed to delete", sessionPath, err);
    }
  }
}

// --- CTRL_ROOM persistence (chat history) ---

const CTRL_SESSION_KEY = CTRL_ROOM;

/** Save the CTRL_ROOM Y.Doc (chat history) */
export async function saveCtrlSession(doc: Y.Doc): Promise<void> {
  if (!sessionDirReady) {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    sessionDirReady = true;
  }

  // Prune chat to newest 200 messages before saving
  const chatMap = doc.getMap(Y_MAP_CHAT);
  const entries: Array<{ id: string; timestamp: number }> = [];
  chatMap.forEach((value, key) => {
    const msg = value as { timestamp: number };
    entries.push({ id: key, timestamp: msg.timestamp });
  });
  if (entries.length > 200) {
    entries.sort((a, b) => a.timestamp - b.timestamp);
    const toDelete = entries.slice(0, entries.length - 200);
    withInternal(doc, () => {
      for (const entry of toDelete) {
        chatMap.delete(entry.id);
      }
    });
  }

  const state = Y.encodeStateAsUpdate(doc);
  const ydocState = Buffer.from(state).toString("base64");

  const data = { ydocState, lastAccessed: Date.now() };
  const sessionPath = path.join(SESSION_DIR, `${CTRL_SESSION_KEY}.json`);
  await atomicWrite(sessionPath, JSON.stringify(data));
}

/** Load the CTRL_ROOM session if it exists */
export async function loadCtrlSession(): Promise<string | null> {
  const sessionPath = path.join(SESSION_DIR, `${CTRL_SESSION_KEY}.json`);
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    const data = JSON.parse(content);
    return data.ydocState ?? null;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      console.error(`[Tandem] Corrupted ctrl session ${sessionPath}, removing:`, err.message);
      await fs.unlink(sessionPath).catch((unlinkErr) => {
        console.error(
          `[Tandem] Failed to remove corrupted ctrl session ${sessionPath}:`,
          unlinkErr,
        );
      });
      return null;
    }
    console.error(`[Tandem] Failed to read ctrl session:`, err);
    return null;
  }
}

/** Restore a CTRL_ROOM Y.Doc from base64 state */
export function restoreCtrlDoc(doc: Y.Doc, base64State: string): void {
  const state = Buffer.from(base64State, "base64");
  Y.applyUpdate(doc, new Uint8Array(state));
}

/**
 * Scan the session directory for document sessions that can be restored.
 * Skips the ctrl session, upload:// paths, and corrupt files.
 * Returns file paths sorted by most recently accessed first.
 */
export async function listSessionFilePaths(): Promise<
  Array<{ filePath: string; lastAccessed: number }>
> {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const files = await fs.readdir(SESSION_DIR);
    const results: Array<{ filePath: string; lastAccessed: number }> = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      // Skip ctrl session (key is the CTRL_ROOM name)
      if (file === `${encodeURIComponent(CTRL_ROOM)}.json`) continue;

      try {
        const raw = await fs.readFile(path.join(SESSION_DIR, file), "utf-8");
        const data = JSON.parse(raw) as SessionData;
        if (!data.filePath || isUploadPath(data.filePath)) continue;
        results.push({ filePath: data.filePath, lastAccessed: data.lastAccessed ?? 0 });
      } catch (err) {
        console.error(`[Tandem] Skipping unreadable session file ${file}:`, err);
      }
    }

    results.sort((a, b) => b.lastAccessed - a.lastAccessed);
    return results;
  } catch (err) {
    console.error("[Tandem] Failed to read session directory:", err);
    return [];
  }
}

/** Metadata for a single persisted document session, surfaced in the Sessions UI. */
export interface SessionMetadata {
  filePath: string;
  /** Last-accessed timestamp (ms since epoch) from the session record. */
  lastAccessed: number;
  /** Count of live (non-tombstoned) annotations in the durable envelope, 0 if none. */
  annotationCount: number;
}

/**
 * Count live annotations for a document path by reading its durable annotation
 * envelope (`<docHash>.json`). Tombstones and replies don't count. Returns 0 if
 * the envelope is missing, corrupt, or a future schema version — the count is a
 * best-effort UI hint, never load-bearing.
 */
async function annotationCountForPath(filePath: string): Promise<number> {
  const hash = docHash(filePath);
  const envelopePath = path.join(getAnnotationsDir(), `${hash}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(envelopePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[Tandem] annotationCountForPath: failed to read", envelopePath, err);
    }
    return 0;
  }
  const parsed = parseAnnotationDoc(raw);
  if (!parsed.ok) return 0;
  return parsed.doc.annotations.length;
}

/**
 * List persisted document sessions with display metadata for the Sessions UI:
 * file path, last-accessed time, and live annotation count. Sorted most
 * recently accessed first (inherits ordering from `listSessionFilePaths`).
 */
export async function listSessionsMetadata(): Promise<SessionMetadata[]> {
  const sessions = await listSessionFilePaths();
  return Promise.all(
    sessions.map(async ({ filePath, lastAccessed }) => ({
      filePath,
      lastAccessed,
      annotationCount: await annotationCountForPath(filePath),
    })),
  );
}

/**
 * Delete every persisted document session (the "Clear all" action). The
 * CTRL_ROOM chat session and upload:// sessions are preserved — only the
 * document sessions surfaced in the UI are removed. Returns the count deleted.
 * No-op in read-only mode.
 */
export async function clearAllSessions(): Promise<number> {
  if (isStoreReadOnly()) return 0;
  const sessions = await listSessionFilePaths();
  let deleted = 0;
  for (const { filePath } of sessions) {
    await deleteSession(filePath);
    deleted++;
  }
  return deleted;
}

/**
 * Delete orphaned per-document annotation files older than `SESSION_MAX_AGE`.
 *
 * Phase 1 of the durable-annotations plan ships this as a best-effort startup
 * hint — issue #318 tracks the full policy (e.g., cross-referencing against
 * active session files, retention tiers). For now we only GC files whose
 * names match `<64-hex>.json` or `upload_<id>.json`, leaving `.corrupt.*`,
 * `.future`, and the `store.lock` file alone.
 *
 * Matches the 30-day cutoff used by `cleanupSessions` (same constant).
 */
export async function cleanupOrphanedAnnotationFiles(): Promise<{
  cleaned: number;
  raced: number;
  failed: number;
}> {
  const dir = getAnnotationsDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { cleaned: 0, raced: 0, failed: 0 };
    console.error("[Tandem] Failed to read annotations directory:", err);
    return { cleaned: 0, raced: 0, failed: 0 };
  }

  // Only consider files that match the known per-doc envelope filename shape.
  // Quarantined (`.corrupt.<ts>`), parked (`.future`), and the lockfile are
  // skipped — they carry their own lifecycles.

  // Fan out stat + unlink so this isn't O(N) serial syscalls on startup.
  const now = Date.now();
  type Result = "cleaned" | "raced" | "skipped" | "failed";
  const results = await Promise.all(
    files
      .filter((file) => ENVELOPE_FILENAME_RE.test(file))
      .map(async (file): Promise<Result> => {
        const filePath = path.join(dir, file);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs <= SESSION_MAX_AGE) return "skipped";
          await fs.unlink(filePath);
          return "cleaned";
        } catch (err) {
          // ENOENT is benign — another tandem instance racing the same GC got
          // there first. Anything else (permissions, locks, I/O) points at a
          // real problem the operator needs to see with a code to triage on.
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") return "raced"; // peer cleaned it first
          console.error(
            `[Tandem] cleanupOrphanedAnnotationFiles: failed to process ${file} (${code ?? "unknown"}):`,
            err,
          );
          return "failed";
        }
      }),
  );
  return {
    cleaned: results.filter((r) => r === "cleaned").length,
    raced: results.filter((r) => r === "raced").length,
    failed: results.filter((r) => r === "failed").length,
  };
}

/**
 * Compact stale tombstones from CLOSED documents' annotation envelopes (#318).
 *
 * Tombstones prevent a stale reconnecting browser tab from resurrecting a
 * deleted annotation (the anti-resurrection merge in `sync.ts`). They are only
 * needed while such a stale peer might reconnect, which is bounded by SESSION
 * GC: a session older than `SESSION_MAX_AGE` (30d) is itself reaped, so a
 * tombstone older than that horizon can no longer be contradicted by a
 * reconnecting peer carrying the pre-deletion copy.
 *
 * Safety contract:
 *   - Only CLOSED docs are swept. `openDocHashes` (the docHashes of currently
 *     open documents) is the guard: an open doc's in-memory `tombstonesByDoc`
 *     ledger is authoritative and MUST NOT be contradicted by a disk rewrite.
 *     (At the current pre-`restoreOpenDocuments` call site this set is empty,
 *     but the guard is load-bearing if the call site ever moves.)
 *   - Only tombstones with `deletedAt` older than `SESSION_MAX_AGE` are
 *     dropped. Annotations, replies, and fresh tombstones are preserved.
 *   - The rewrite is routed through the store's `queueWrite`/`flush` (atomic
 *     write + debounce coalescing), never a raw `fs.writeFile`.
 *   - No-op in read-only mode.
 *
 * @param openDocHashes docHashes of documents currently open (skip these).
 * @returns count of envelopes whose tombstone array was compacted.
 */
export async function cleanupStaleTombstones(
  openDocHashes: ReadonlySet<string> = new Set(),
): Promise<number> {
  if (isStoreReadOnly()) return 0;

  const dir = getAnnotationsDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    console.error("[Tandem] cleanupStaleTombstones: failed to read annotations dir:", err);
    return 0;
  }

  const now = Date.now();
  let compacted = 0;

  for (const file of files) {
    if (!ENVELOPE_FILENAME_RE.test(file)) continue;
    const fileHash = file.slice(0, -".json".length);
    // Open-doc guard: never mutate an open doc's envelope from disk — its
    // in-memory tombstone ledger is authoritative.
    if (openDocHashes.has(fileHash)) continue;

    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, file), "utf-8");
    } catch (err) {
      console.error(`[Tandem] cleanupStaleTombstones: failed to read ${file}:`, err);
      continue;
    }

    const parsed = parseAnnotationDoc(raw);
    if (!parsed.ok) continue; // corrupt/future files have their own lifecycle
    const doc = parsed.doc;
    if (doc.tombstones.length === 0) continue;

    const kept = doc.tombstones.filter((t) => now - t.deletedAt <= SESSION_MAX_AGE);
    if (kept.length === doc.tombstones.length) continue; // nothing stale

    // Re-key the rewrite to the FILENAME hash, not the envelope's internal
    // docHash — a hand-edited file whose internal docHash disagrees with its
    // filename must not write to a different path (which would orphan the
    // stale file and create a duplicate). The filename is the storage key.
    const rewritten = { ...doc, docHash: fileHash, tombstones: kept };
    const store = createStore(fileHash, { filePath: doc.meta.filePath });
    store.queueWrite(() => rewritten);
    try {
      await store.flush();
      compacted++;
    } catch (err) {
      console.error(`[Tandem] cleanupStaleTombstones: failed to rewrite ${file}:`, err);
    }
  }

  return compacted;
}

/** Delete sessions older than 30 days */
export async function cleanupSessions(): Promise<number> {
  let cleaned = 0;
  let files: string[];
  try {
    files = await fs.readdir(SESSION_DIR);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    console.error("[Tandem] Failed to read session directory:", err);
    return 0;
  }

  const now = Date.now();
  for (const file of files) {
    try {
      const filePath = path.join(SESSION_DIR, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > SESSION_MAX_AGE) {
        await fs.unlink(filePath);
        cleaned++;
      }
    } catch (err) {
      console.error(`[Tandem] cleanupSessions: failed to process ${file}:`, err);
    }
  }
  return cleaned;
}

// --- Auto-save ---

let autoSaveTimer: ReturnType<typeof setInterval> | null = null;
let autoSaveCallback: (() => Promise<void>) | null = null;

/** Check if auto-save is currently running */
export function isAutoSaveRunning(): boolean {
  return autoSaveTimer !== null;
}

/** Start auto-saving every 60 seconds. Pass a callback that saves the current session. */
export function startAutoSave(callback: () => Promise<void>): void {
  stopAutoSave();
  autoSaveCallback = callback;
  autoSaveTimer = setInterval(async () => {
    try {
      await autoSaveCallback?.();
    } catch (err) {
      console.error("[Tandem] Auto-save failed:", err);
    }
  }, AUTO_SAVE_INTERVAL);
}

/** Stop auto-save timer */
export function stopAutoSave(): void {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
  autoSaveCallback = null;
}
