import { randomUUID } from "node:crypto";
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import type * as Y from "yjs";
import {
  CHARS_PER_PAGE,
  LARGE_FILE_PAGE_THRESHOLD,
  MAX_FILE_SIZE,
  SUPPORTED_EXTENSIONS,
  VERY_LARGE_FILE_PAGE_THRESHOLD,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_SAVED_AT_VERSION,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import { UPLOAD_PREFIX } from "../../shared/paths.js";
import type { Annotation } from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { docHash } from "../annotations/doc-hash.js";
import { createStore } from "../annotations/store.js";
import { loadAndMerge } from "../annotations/sync.js";
import {
  attachObservers,
  clearFileSyncContext,
  MCP_ORIGIN,
  setFileSyncContext,
} from "../events/queue.js";
import { loadDocx } from "../file-io/docx.js";
import { extractDocxComments, injectCommentsAsAnnotations } from "../file-io/docx-comments.js";
import { htmlToYDoc } from "../file-io/docx-html.js";
import { getAdapter } from "../file-io/index.js";
import { loadMarkdown } from "../file-io/markdown.js";
import { watchFile } from "../file-watcher.js";
import { pushNotification } from "../notifications.js";
import { anchoredRange, refreshAllRanges, validateRange } from "../positions.js";
import {
  deleteSession,
  isAutoSaveRunning,
  loadSession,
  restoreYDoc,
  saveSession,
  sourceFileChanged,
  startAutoSave,
} from "../session/manager.js";
import { getDocument, getOrCreateDocument } from "../yjs/provider.js";
import { sanitizeAnnotation } from "./annotations.js";
import { detectFormat, docIdFromPath, extractText, populateYDoc } from "./document-model.js";
import {
  addDoc,
  autoSaveAllToDisk,
  broadcastOpenDocs,
  getOpenDocs,
  type OpenDoc,
  setActiveDocId,
} from "./document-service.js";

export { SUPPORTED_EXTENSIONS };

const reloadInProgress = new Set<string>();

export interface OpenFileResult {
  documentId: string;
  filePath: string;
  fileName: string;
  format: string;
  readOnly: boolean;
  source: "file" | "upload";
  tokenEstimate: number;
  pageEstimate: number;
  restoredFromSession: boolean;
  alreadyOpen: boolean;
  forceReloaded: boolean;
  warnings?: string[];
}

/** Resolved + validated path metadata for openFileByPath. stat is NOT included — only used for the size check. */
interface ResolvedPath {
  resolved: string;
  format: string;
  isDocx: boolean;
  readOnly: boolean;
  id: string;
}

/**
 * Open a file by its absolute path on disk.
 * Throws on errors (ENOENT, EACCES, EBUSY, etc.) — caller maps to MCP or HTTP responses.
 * Pass `force: true` to reload from disk even if already open (clears all document state).
 */
export async function openFileByPath(
  filePath: string,
  options?: { force?: boolean },
): Promise<OpenFileResult> {
  const { resolved, format, readOnly, id } = await resolveAndValidatePath(filePath);
  const fileName = path.basename(resolved);
  const openDocs = getOpenDocs();
  const existing = openDocs.get(id);

  // Already open — force-reload or switch to existing
  if (existing) {
    const forceReload = options?.force === true;
    if (forceReload) {
      // Force-reload stays inline — distinct lifecycle from normal open
      const doc = getDocument(id) ?? getOrCreateDocument(id);
      await clearAndReload(id, doc, resolved, format, existing);
      addDoc(id, { id, filePath: resolved, format, readOnly, source: "file" });
      setActiveDocId(id);
      await wireAnnotationStore(id, doc, resolved);
      broadcastOpenDocs();
      ensureAutoSave();
      return {
        ...buildResult(doc, {
          documentId: id,
          filePath: resolved,
          fileName,
          format,
          readOnly,
          source: "file",
          restoredFromSession: false,
        }),
        forceReloaded: true,
      };
    }
    return handleAlreadyOpen(id, getOrCreateDocument(id), format, resolved, readOnly);
  }

  // Normal open
  const doc = getOrCreateDocument(id);
  const restoredFromSession = await maybeRestoreSession(resolved, doc, fileName);
  if (!restoredFromSession) {
    await loadContentIntoDoc(doc, format, resolved);
  }
  await finalizeDocOpen(id, doc, resolved, fileName, format, readOnly);

  return {
    ...buildResult(doc, {
      documentId: id,
      filePath: resolved,
      fileName,
      format,
      readOnly,
      source: "file",
      restoredFromSession,
    }),
    forceReloaded: false,
  };
}

/**
 * Open a file from uploaded content (no disk path).
 * Used when the browser drag-and-drops or selects a file.
 */
export async function openFileFromContent(
  fileName: string,
  content: string | Buffer,
): Promise<OpenFileResult> {
  const ext = path.extname(fileName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw Object.assign(
      new Error(
        `Unsupported file format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
      ),
      { code: "UNSUPPORTED_FORMAT" },
    );
  }

  const contentSize =
    content instanceof Buffer ? content.length : Buffer.byteLength(content as string);
  if (contentSize > MAX_FILE_SIZE) {
    throw Object.assign(new Error("File exceeds 50MB limit."), { code: "FILE_TOO_LARGE" });
  }

  const format = detectFormat(fileName);
  const readOnly = true;
  const syntheticPath = `${UPLOAD_PREFIX}${randomUUID()}/${fileName}`;
  const id = docIdFromPath(syntheticPath);

  const doc = getOrCreateDocument(id);
  const adapter = getAdapter(format);
  await adapter.load(doc, content);

  addDoc(id, { id, filePath: syntheticPath, format, readOnly, source: "upload" });
  setActiveDocId(id);
  writeDocMeta(doc, id, fileName, format, readOnly);
  await initSavedBaseline(doc);
  await wireAnnotationStore(id, doc, syntheticPath);
  broadcastOpenDocs();
  ensureAutoSave();

  return buildResult(doc, {
    documentId: id,
    filePath: syntheticPath,
    fileName,
    format,
    readOnly,
    source: "upload",
    restoredFromSession: false,
  });
}

// --- Extracted helpers for openFileByPath ---

/**
 * Resolve a raw file path to its canonical form, validate it (UNC check,
 * extension check, size limit), derive format / readOnly / doc ID.
 * stat is used only for the size check and is not returned.
 */
async function resolveAndValidatePath(filePath: string): Promise<ResolvedPath> {
  let resolved = path.resolve(filePath);
  try {
    resolved = fsSync.realpathSync(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(
        `[Tandem] realpathSync failed for ${filePath} (${code}), using path.resolve fallback`,
      );
    }
    resolved = path.resolve(filePath);
  }

  if (process.platform === "win32" && (resolved.startsWith("\\\\") || resolved.startsWith("//"))) {
    throw Object.assign(new Error("UNC paths are not supported for security reasons."), {
      code: "INVALID_PATH",
    });
  }

  const ext = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw Object.assign(
      new Error(
        `Unsupported file format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
      ),
      { code: "UNSUPPORTED_FORMAT" },
    );
  }

  const stat = await fs.stat(resolved);
  if (stat.size > MAX_FILE_SIZE) {
    throw Object.assign(new Error("File exceeds 50MB limit."), { code: "FILE_TOO_LARGE" });
  }

  const format = detectFormat(resolved);
  const isDocx = format === "docx";
  const readOnly = isDocx;
  const id = docIdFromPath(resolved);

  return { resolved, format, isDocx, readOnly, id };
}

/**
 * Handle the non-force already-open branch: activate the doc and broadcast.
 * This is the only place that sets alreadyOpen: true in the return value.
 */
function handleAlreadyOpen(
  id: string,
  doc: Y.Doc,
  format: string,
  resolved: string,
  readOnly: boolean,
): OpenFileResult {
  setActiveDocId(id);
  broadcastOpenDocs();
  return {
    ...buildResult(doc, {
      documentId: id,
      filePath: resolved,
      fileName: path.basename(resolved),
      format,
      readOnly,
      source: "file",
      restoredFromSession: false,
    }),
    alreadyOpen: true,
  };
}

/**
 * Attempt to restore a Y.Doc from a saved session.
 * Returns true ONLY if the session was restored AND the fragment is non-empty.
 * Returns false if no session exists, the source file has changed, or the
 * restored fragment is empty (falls back to loading from source file).
 */
async function maybeRestoreSession(
  resolved: string,
  doc: Y.Doc,
  fileName: string,
): Promise<boolean> {
  const session = await loadSession(resolved);
  if (session) {
    const changed = await sourceFileChanged(session);
    if (!changed) {
      restoreYDoc(doc, session);
      const fragment = doc.getXmlFragment("default");
      if (fragment.length > 0) {
        return true;
      }
      console.error(
        `[Tandem] Session restore yielded empty doc for ${fileName}, falling back to source file`,
      );
    }
  }
  return false;
}

/**
 * Load file content from disk into the Y.Doc using the appropriate adapter.
 * Reads as Buffer for docx, utf-8 string for all other formats.
 */
async function loadContentIntoDoc(doc: Y.Doc, format: string, resolved: string): Promise<void> {
  const adapter = getAdapter(format);
  const isDocx = format === "docx";
  const fileContent = isDocx ? await fs.readFile(resolved) : await fs.readFile(resolved, "utf-8");
  await adapter.load(doc, fileContent);
}

/**
 * Finalize a normal (non-force) document open: register in open-docs map,
 * set active, write metadata, init saved baseline, wire annotation store,
 * broadcast, start auto-save, and (for non-docx) set up the file watcher.
 *
 * NOTE: openFileFromContent has a similar finalization sequence — keep them in sync.
 */
async function finalizeDocOpen(
  id: string,
  doc: Y.Doc,
  resolved: string,
  fileName: string,
  format: string,
  readOnly: boolean,
): Promise<void> {
  addDoc(id, { id, filePath: resolved, format, readOnly, source: "file" });
  setActiveDocId(id);
  writeDocMeta(doc, id, fileName, format, readOnly);
  await initSavedBaseline(doc, resolved);
  await wireAnnotationStore(id, doc, resolved);
  broadcastOpenDocs();
  ensureAutoSave();

  // Watch for external file changes (skip .docx — binary format, no live reload)
  if (format !== "docx") {
    wireFileWatcher(id, resolved, format);
  }
}

// --- Private helpers ---

/**
 * Wire a document's annotations to the durable per-doc store.
 *
 * Runs `loadAndMerge` so on-disk state merges with whatever the Y.Doc already
 * holds (session restore, force-reload content, or a freshly-loaded file),
 * then registers the resulting observer cleanup against the event queue's
 * per-doc registry so reattach-on-doc-swap keeps persistence alive.
 *
 * Errors here MUST NOT fail the open — annotations are additive durability,
 * not required for rendering. We log and continue.
 */
async function wireAnnotationStore(id: string, doc: Y.Doc, filePath: string): Promise<void> {
  try {
    const hash = docHash(filePath);
    const store = createStore(hash, { filePath });
    const cleanup = await loadAndMerge({
      ydoc: doc,
      store,
      docHash: hash,
      meta: { filePath },
    });
    setFileSyncContext(id, { ydoc: doc, store, docHash: hash, meta: { filePath } }, cleanup);
  } catch (err) {
    // Annotations are additive durability — never block a doc open. But a
    // silent console.error means the user never knows their pre-existing
    // annotations aren't loading and new ones won't persist. Surface via
    // the notification bus (deduped per-file so a per-route retry storm
    // doesn't flood the UI).
    console.error("[Tandem] wireAnnotationStore failed for %s (%s):", id, filePath, err);
    pushNotification({
      id: generateNotificationId(),
      type: "save-error",
      severity: "warning",
      message: `Annotations for ${path.basename(filePath) || id} are not being saved this session. See server log.`,
      dedupKey: `annotation-wire:${id}`,
      timestamp: Date.now(),
    });
  }
}

/**
 * Clear all document state in-place and repopulate from disk.
 * Unlike the old forceCloseDocument, this preserves the Y.Doc instance, Hocuspocus
 * room, and client WebSocket connections. All state (content, annotations, awareness)
 * is cleared and repopulated in a single Y.js transaction so clients see one atomic update.
 */
async function clearAndReload(
  id: string,
  doc: Y.Doc,
  filePath: string,
  format: string,
  existing: OpenDoc,
): Promise<void> {
  console.error(`[Tandem] clearAndReload: reloading ${id} from disk`);

  // 0. Detach durable-annotation sync for this doc before clearing Y.Maps so
  //    the observer doesn't queue a write snapshotting the mid-clear state,
  //    and wipe the on-disk annotation file so loadAndMerge (run by the
  //    caller after repopulation) doesn't resurrect the pre-reload set.
  //    Failures here must not abort the reload — annotations are additive
  //    durability and we still want the content reload to land.
  const dropped = clearFileSyncContext(id);
  if (dropped) {
    try {
      await dropped.store.clear();
    } catch (err) {
      console.error("[Tandem] clearAndReload: store.clear failed for %s:", id, err);
    }
  }

  // 1. Prepare content outside the transaction (async I/O must happen before transact)
  const isDocx = format === "docx";
  let preparedHtml: string | undefined;
  let preparedComments: Awaited<ReturnType<typeof extractDocxComments>> | undefined;
  let preparedContent: string | undefined;

  if (isDocx) {
    const buffer = await fs.readFile(filePath);
    [preparedHtml, preparedComments] = await Promise.all([
      loadDocx(buffer),
      extractDocxComments(buffer).catch((err) => {
        console.error(
          "[docx-comments] Comment extraction failed; document will reload without imported comments:",
          err,
        );
        return [] as Awaited<ReturnType<typeof extractDocxComments>>;
      }),
    ]);
  } else {
    preparedContent = await fs.readFile(filePath, "utf-8");
  }

  // 2. Single transaction: clear all state + repopulate from pre-parsed content.
  //    Clients see one atomic Y.js update — no intermediate states.
  //    Content loaders are verified robust (remark-parse, htmlparser2 don't throw on
  //    malformed input; populateYDoc is safe). The try-catch is a diagnostic safety net
  //    for Y.js internal corruption — it logs context before re-throwing.
  try {
    doc.transact(() => {
      // Clear Y.Maps
      const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
      annotations.forEach((_, k) => annotations.delete(k));

      const annotationReplies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
      annotationReplies.forEach((_, k) => annotationReplies.delete(k));

      const awareness = doc.getMap(Y_MAP_AWARENESS);
      awareness.forEach((_, k) => awareness.delete(k));

      const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
      userAwareness.forEach((_, k) => userAwareness.delete(k));

      // Repopulate content (load functions clear the XmlFragment internally)
      if (isDocx && preparedHtml !== undefined) {
        htmlToYDoc(doc, preparedHtml);
        if (preparedComments && preparedComments.length > 0) {
          injectCommentsAsAnnotations(doc, preparedComments);
        }
      } else if (format === "md" && preparedContent !== undefined) {
        loadMarkdown(doc, preparedContent);
      } else if (preparedContent !== undefined) {
        populateYDoc(doc, preparedContent);
      }

      // Rewrite metadata + dirty-tracking baseline
      const meta = doc.getMap(Y_MAP_DOCUMENT_META);
      meta.set("readOnly", isDocx);
      meta.set("format", format);
      meta.set("documentId", id);
      meta.set("fileName", path.basename(filePath));
      meta.set(Y_MAP_SAVED_AT_VERSION, Date.now());
    }, MCP_ORIGIN);

    // 3. Reattach event queue observers (idempotent — detaches existing first)
    attachObservers(id, doc);
  } catch (err) {
    console.error(
      `[Tandem] clearAndReload: failed for ${id} (format=${format}). Y.Doc may be in a partially cleared state:`,
      err,
    );
    throw err;
  }

  // 4. Delete session after successful reload so stale state doesn't restore on next startup.
  //    Runs last: if readFile or transact fails above, the session survives as a recovery path.
  await deleteSession(existing.filePath).catch((err) => {
    console.error(`[Tandem] clearAndReload: deleteSession failed for ${id}:`, err);
  });

  console.error(`[Tandem] clearAndReload: complete for ${id}`);
}

/**
 * Set the initial savedAtVersion baseline so the client knows the file is clean on open.
 * Uses the file's mtime when available so the first auto-save can detect external modifications.
 */
async function initSavedBaseline(doc: Y.Doc, filePath?: string): Promise<void> {
  let baseline = Date.now();
  if (filePath) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) baseline = stat.mtimeMs;
  }
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  doc.transact(() => meta.set(Y_MAP_SAVED_AT_VERSION, baseline), MCP_ORIGIN);
}

function writeDocMeta(
  doc: Y.Doc,
  id: string,
  fileName: string,
  format: string,
  readOnly: boolean,
): void {
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  doc.transact(() => {
    meta.set("readOnly", readOnly);
    meta.set("format", format);
    meta.set("documentId", id);
    meta.set("fileName", fileName);
  }, MCP_ORIGIN);
}

function buildResult(
  doc: Y.Doc,
  base: Omit<
    OpenFileResult,
    "tokenEstimate" | "pageEstimate" | "alreadyOpen" | "forceReloaded" | "warnings"
  >,
): OpenFileResult {
  const textContent = extractText(doc);
  const textLen = textContent.length;
  const pageEstimate = Math.ceil(textLen / CHARS_PER_PAGE);

  const warnings: string[] = [];
  if (pageEstimate >= VERY_LARGE_FILE_PAGE_THRESHOLD) {
    warnings.push(
      `Very large document (~${pageEstimate} pages). Consider splitting into smaller files.`,
    );
  } else if (pageEstimate >= LARGE_FILE_PAGE_THRESHOLD) {
    warnings.push(`Large document (~${pageEstimate} pages). Operations may be slower than usual.`);
  }

  return {
    ...base,
    tokenEstimate: Math.ceil(textLen / 4),
    pageEstimate,
    alreadyOpen: false,
    forceReloaded: false,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Reload document content from disk without clearing annotations.
 * Used by the file watcher when an external tool modifies the source file.
 *
 * Steps:
 * 1. Read new content from disk (async I/O outside transaction)
 * 2. Single transaction: clear awareness maps + repopulate content (NOT annotations)
 * 3. After transaction: refreshAllRanges to re-anchor annotation CRDT positions
 * 4. Second pass: textSnapshot-based relocation for still-stale annotations
 * 5. Reattach event queue observers
 */
async function reloadFromDisk(id: string, filePath: string, format: string): Promise<void> {
  if (reloadInProgress.has(id)) {
    console.error(`[FileWatcher] reload already in progress for ${id}, skipping`);
    return;
  }
  reloadInProgress.add(id);
  try {
    console.error(`[FileWatcher] reloadFromDisk: reloading ${id} from ${filePath}`);

    const doc = getOrCreateDocument(id);

    // 1. Read new content outside the transaction (async I/O)
    const fileContent = await fs.readFile(filePath, "utf-8");

    // 2. Single transaction: clear awareness + repopulate content, preserve annotations
    doc.transact(() => {
      const awareness = doc.getMap(Y_MAP_AWARENESS);
      awareness.forEach((_, k) => awareness.delete(k));

      const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
      userAwareness.forEach((_, k) => userAwareness.delete(k));

      // Repopulate content (load functions clear XmlFragment internally)
      if (format === "md") {
        loadMarkdown(doc, fileContent);
      } else {
        populateYDoc(doc, fileContent);
      }
    }, MCP_ORIGIN);

    // 3. Refresh all annotation ranges in a batch transaction (sanitize legacy shapes)
    const annotationMap = doc.getMap(Y_MAP_ANNOTATIONS);
    const annotations: Annotation[] = [];
    annotationMap.forEach((val) => annotations.push(sanitizeAnnotation(val as Annotation)));

    if (annotations.length > 0) {
      const refreshed = refreshAllRanges(annotations, doc, annotationMap);

      // 4. Second pass: textSnapshot-based relocation for annotations with stale relRanges
      doc.transact(() => {
        for (const ann of refreshed) {
          if (!ann.textSnapshot) continue;

          const vr = validateRange(doc, ann.range.from, ann.range.to, {
            textSnapshot: ann.textSnapshot,
          });

          if (vr.ok) continue; // Range is still valid

          if (vr.code === "RANGE_MOVED") {
            const relocated = anchoredRange(doc, vr.resolvedFrom, vr.resolvedTo, ann.textSnapshot);
            if (relocated.ok) {
              const updated: Annotation = {
                ...ann,
                range: relocated.range,
                relRange: relocated.fullyAnchored ? relocated.relRange : undefined,
              };
              annotationMap.set(ann.id, updated);
            }
          }
          // RANGE_GONE: annotation text was deleted entirely — leave as-is
        }
      }, MCP_ORIGIN);
    }

    // 5. Reattach event queue observers (idempotent)
    attachObservers(id, doc);

    console.error(`[FileWatcher] reloadFromDisk: complete for ${id}`);
  } finally {
    reloadInProgress.delete(id);
  }
}

/**
 * Wire up the file watcher for a document. Calls reloadFromDisk on
 * external changes and pushes a browser notification.
 */
function wireFileWatcher(id: string, filePath: string, format: string): void {
  try {
    watchFile(filePath, async () => {
      try {
        await reloadFromDisk(id, filePath, format);
        pushNotification({
          id: generateNotificationId(),
          type: "file-reloaded",
          severity: "info",
          message: `File changed on disk — reloaded: ${path.basename(filePath)}`,
          documentId: id,
          dedupKey: `reload:${id}`,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error(`[FileWatcher] reloadFromDisk failed for ${filePath}:`, err);
        pushNotification({
          id: generateNotificationId(),
          type: "general-error",
          severity: "warning",
          message: `Failed to reload ${path.basename(filePath)} from disk`,
          documentId: id,
          dedupKey: `reload-error:${id}`,
          timestamp: Date.now(),
        });
      }
    });
  } catch (err) {
    console.error(`[FileWatcher] wireFileWatcher failed for ${filePath}:`, err);
  }
}

function ensureAutoSave(): void {
  if (isAutoSaveRunning()) return;
  startAutoSave(async () => {
    // Session saves (all documents — preserves CRDT state for restart recovery)
    for (const [docId, state] of getOpenDocs()) {
      const d = getOrCreateDocument(docId);
      await saveSession(state.filePath, state.format, d);
    }
    // Disk saves (eligible .md/.txt documents only)
    await autoSaveAllToDisk();
  });
}
