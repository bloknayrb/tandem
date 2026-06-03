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
  Y_MAP_READ_ONLY,
  Y_MAP_SAVED_AT_VERSION,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import { withFileSync, withInternal, withReload } from "../../shared/origins.js";
import { SCRATCHPAD_PREFIX, UPLOAD_PREFIX } from "../../shared/paths.js";
import type { Annotation } from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { docHash } from "../annotations/doc-hash.js";
import { relaySanitizationEvent } from "../annotations/migration-log.js";
import { recoverRenamedEnvelope } from "../annotations/rename-recovery.js";
import { annotationFileExists, createStore } from "../annotations/store.js";
import { loadAndMerge } from "../annotations/sync.js";
import { markClean, registerDirtyObserver } from "../documents/dirty.js";
import { attachObservers, clearFileSyncContext, setFileSyncContext } from "../events/queue.js";
import { getAdapter, type LoadIssue, type Prepared } from "../file-io/index.js";
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
import { detectFormat, docIdFromPath, extractText } from "./document-model.js";
import {
  addDoc,
  autoSaveAllToDisk,
  broadcastOpenDocs,
  getOpenDocs,
  type OpenDoc,
  setActiveDocId,
} from "./document-service.js";
import { injectTutorialAnnotations } from "./tutorial-annotations.js";

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
  readOnly: boolean;
  id: string;
}

/**
 * Open a file by its absolute path on disk.
 * Throws on errors (ENOENT, EACCES, EBUSY, etc.) — caller maps to MCP or HTTP responses.
 * Pass `force: true` to reload from disk even if already open (clears all document state).
 * Pass `readOnly: true` to force the document open in read-only mode (e.g. CHANGELOG.md).
 */
export async function openFileByPath(
  filePath: string,
  options?: { force?: boolean; readOnly?: boolean },
): Promise<OpenFileResult> {
  const {
    resolved,
    format,
    readOnly: derivedReadOnly,
    id,
  } = await resolveAndValidatePath(filePath);
  // Caller may override the derived readOnly (e.g. force changelog read-only).
  const readOnly = options?.readOnly === true ? true : derivedReadOnly;
  const fileName = path.basename(resolved);
  const openDocs = getOpenDocs();
  const existing = openDocs.get(id);

  // Already open — force-reload or switch to existing
  if (existing) {
    const forceReload = options?.force === true;
    if (forceReload) {
      // Force-reload stays inline — distinct lifecycle from normal open.
      // Read the buffer here so the fs.readFile sink sits at the call site
      // where `resolved` was just produced by resolveAndValidatePath —
      // CodeQL traces the sanitizer cross-line within a function but not
      // across function boundaries.
      const doc = getDocument(id) ?? getOrCreateDocument(id);
      const reloadBuffer =
        format === "docx" ? await fs.readFile(resolved) : await fs.readFile(resolved, "utf-8");
      await clearAndReload(id, doc, resolved, format, existing, reloadBuffer);
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
    return handleAlreadyOpen(
      id,
      getOrCreateDocument(id),
      format,
      resolved,
      readOnly,
      existing,
      options?.readOnly === true,
    );
  }

  // Normal open
  const doc = getOrCreateDocument(id);
  const restoredFromSession = await maybeRestoreSession(resolved, doc, fileName);
  if (!restoredFromSession) {
    await loadContentIntoDoc(doc, format, resolved, id);
  }
  await finalizeDocOpen(id, doc, resolved, fileName, format, readOnly);

  // Inject tutorial annotations whenever the sample welcome document is opened,
  // regardless of whether TANDEM_NO_SAMPLE skipped the server startup auto-open.
  // injectTutorialAnnotations is idempotent — safe to call on session-restored docs.
  if (resolved.endsWith(path.join("sample", "welcome.md"))) {
    injectTutorialAnnotations(doc);
  }

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
  // Display name is the uploaded filename, not the synthetic upload path, so
  // notifications don't leak the internal path shape to the user.
  await populateDocFromContent(doc, format, content, id, {
    displayName: fileName,
    dedupSource: syntheticPath,
  });

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

/**
 * Open a new ephemeral scratchpad document.
 *
 * A scratchpad has no file on disk. It uses a synthetic `upload://scratchpad/<uuid>/Scratchpad.md`
 * path, which ensures:
 * - Session manager skips it (isUploadPath filter in listSessionFilePaths)
 * - Auto-save skips it (source === "upload" guard in saveDocumentToDisk / autoSaveAllToDisk)
 * - Recent-files list excludes it (isUploadPath guard in App.svelte)
 *
 * Each call mints a new UUID so closing a scratchpad tab and opening another
 * always yields a fresh empty document. Content is gone when the tab is closed.
 */
export async function openScratchpad(content?: string): Promise<OpenFileResult> {
  const uuid = randomUUID();
  const syntheticPath = `${SCRATCHPAD_PREFIX}${uuid}/Scratchpad.md`;
  const fileName = "Scratchpad.md";
  const format = "md";
  const readOnly = false;
  const id = docIdFromPath(syntheticPath);

  const doc = getOrCreateDocument(id);
  // Optional initial markdown content (#979). Empty (the default) clears the
  // fragment; Tiptap creates a default paragraph on first mount. Structured
  // content is parsed into real blocks via the same markdown adapter. Sync
  // apply inside a single transact preserves the populate path's atomicity
  // invariant (#609). Seeded content is not authorship-stamped — scratchpads are
  // ephemeral (no durable store), so the decorative overlay carries no value.
  const adapter = getAdapter(format);
  const prepared = await adapter.parse(content ?? "");
  withInternal(doc, () => adapter.apply(doc, prepared));

  addDoc(id, { id, filePath: syntheticPath, format, readOnly, source: "upload" });
  setActiveDocId(id);
  writeDocMeta(doc, id, fileName, format, readOnly);
  await initSavedBaseline(doc);
  // Skip wireAnnotationStore — scratchpads are ephemeral; durable store
  // would leave orphaned JSON files in the annotations directory on close.
  broadcastOpenDocs();
  ensureAutoSave();

  return {
    ...buildResult(doc, {
      documentId: id,
      filePath: syntheticPath,
      fileName,
      format,
      readOnly,
      source: "upload",
      restoredFromSession: false,
    }),
    forceReloaded: false,
  };
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

  return { resolved, format, readOnly, id };
}

/**
 * Handle the non-force already-open branch: activate the doc and broadcast.
 * This is the only place that sets alreadyOpen: true in the return value.
 *
 * If the caller explicitly requests readOnly: true and the existing record
 * is not already read-only, we upgrade the document to read-only in both the
 * open-docs registry and the Y.Doc metadata so clients see the correct flag.
 * We never downgrade an existing readOnly:true document — the explicit signal
 * only upgrades.
 */
function handleAlreadyOpen(
  id: string,
  doc: Y.Doc,
  format: string,
  resolved: string,
  readOnly: boolean,
  existing: OpenDoc,
  explicitReadOnly: boolean,
): OpenFileResult {
  // Upgrade to read-only when explicitly requested and not already read-only.
  if (explicitReadOnly && !existing.readOnly) {
    addDoc(id, { ...existing, readOnly: true });
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    withInternal(doc, () => meta.set(Y_MAP_READ_ONLY, true));
  }

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
 * Context passed to populateDocFromContent for user-facing diagnostics —
 * either a file path (displayName=basename, dedupSource=absolute path) or
 * an upload (displayName=uploaded filename, dedupSource=synthetic upload path).
 */
interface PopulateContext {
  displayName: string;
  dedupSource: string;
}

/**
 * Async pre-parse step — runs OUTSIDE any Y.Doc transact. Delegates all
 * format-specific work to the adapter's `parse`; parse-time failures land
 * as `LoadIssue` entries on the returned `Prepared` rather than throwing.
 * Notifications fire later at `applyPreparedContent` time so parse + apply
 * issues are surfaced together.
 */
async function prepareContent(format: string, source: string | Buffer): Promise<Prepared> {
  if (format === "docx" && !Buffer.isBuffer(source)) {
    throw Object.assign(new Error("prepareContent: docx requires Buffer source"), {
      code: "INVALID_SOURCE",
    });
  }
  return getAdapter(format).parse(source);
}

/**
 * Sync apply step — must run INSIDE the caller's origin-tagged transact.
 *
 * Delegates doc mutation to `adapter.apply`. The docx adapter owns the
 * snapshot/undo dance around `injectCommentsAsAnnotations` (Yjs does NOT roll
 * back inner-transact writes when a callback throws). Parse-time and apply-
 * time `LoadIssue`s surface as deduped user-facing notifications; distinct
 * dedupKey namespaces per failure kind so a docx hitting both comments-failed
 * AND inject-failed shows two toasts, not one collapsed.
 */
function applyPreparedContent(doc: Y.Doc, prepared: Prepared, ctx: PopulateContext): void {
  const adapter = getAdapter(prepared.format);
  const applyIssues = adapter.apply(doc, prepared, { fileName: ctx.displayName });
  for (const issue of prepared.issues) notifyIssue(issue, ctx);
  for (const issue of applyIssues) notifyIssue(issue, ctx);
}

/** Translate a single LoadIssue to a user-facing notification. */
function notifyIssue(issue: LoadIssue, ctx: PopulateContext): void {
  switch (issue.kind) {
    case "comments-failed":
      pushNotification({
        id: generateNotificationId(),
        type: "annotation-error",
        severity: "warning",
        message: `Failed to import Word comments from ${ctx.displayName}. Document opened without comments.`,
        dedupKey: `docx-comments:${ctx.dedupSource}`,
        timestamp: Date.now(),
      });
      return;
    case "inject-failed":
      pushNotification({
        id: generateNotificationId(),
        type: "annotation-error",
        severity: "warning",
        message: `Failed to import some Word comments from ${ctx.displayName}. Document opened, but comments may be missing.`,
        dedupKey: `docx-comments-inject:${ctx.dedupSource}`,
        timestamp: Date.now(),
      });
      return;
    case "other":
      pushNotification({
        id: generateNotificationId(),
        type: "annotation-error",
        severity: "warning",
        message: issue.message ?? `Loading ${ctx.displayName} produced a warning.`,
        dedupKey: `load-other:${ctx.dedupSource}`,
        timestamp: Date.now(),
      });
      return;
  }
}

/**
 * Load file content from disk into the Y.Doc. Thin wrapper around
 * populateDocFromContent — reads the buffer once (the caller has already
 * validated `resolved` via resolveAndValidatePath: size limit, extension
 * allowlist, UNC rejection) and delegates the parse + transact + cleanup logic
 * to the shared helper used by openFileFromContent.
 */
async function loadContentIntoDoc(
  doc: Y.Doc,
  format: string,
  resolved: string,
  docId: string,
): Promise<void> {
  const buffer = await fs.readFile(resolved);
  await populateDocFromContent(doc, format, buffer, docId, {
    displayName: path.basename(resolved),
    dedupSource: resolved,
  });
}

/**
 * Shared populate path for openFileByPath (disk) and openFileFromContent
 * (upload). Async I/O and parsing happen OUTSIDE the transaction; the Y.Doc
 * mutation runs INSIDE one `withInternal` transact so mdastToYDoc's many tiny
 * inserts arrive as one update. The durable-annotation sync observer and the
 * channel event queue both attach later via `wireAnnotationStore`, so no
 * echo can occur during populate.
 */
async function populateDocFromContent(
  doc: Y.Doc,
  format: string,
  source: string | Buffer,
  docId: string | undefined,
  ctx: PopulateContext,
): Promise<void> {
  const prepared = await prepareContent(format, source);

  try {
    withInternal(doc, () => applyPreparedContent(doc, prepared, ctx));
  } catch (err) {
    // Clear partial state in a fresh top-level transact so a retry sees a clean
    // Y.Doc instead of a poisoned cached one. Yjs has unwound the failed
    // transact by the time the catch fires, so this is not nested. Same
    // origin as the populate above — observers don't attach until
    // wireAnnotationStore, so there's nothing to echo to.
    let cleanupOk = true;
    try {
      withInternal(doc, () => {
        const fragment = doc.getXmlFragment("default");
        fragment.delete(0, fragment.length);
        // injectCommentsAsAnnotations can leave partial entries even when its
        // own catch fires (Yjs does not roll back inner-transact writes).
        const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
        annotations.forEach((_, k) => annotations.delete(k));
      });
    } catch (cleanupErr) {
      cleanupOk = false;
      console.error(
        "[Tandem] populateDocFromContent: cleanup after populate failure also failed:",
        cleanupErr,
      );
      // Evict in-place (#616) — see evictPartialDocState. Failures are logged
      // and swallowed so the original populate error is what bubbles up.
      try {
        evictPartialDocState(doc, docId);
      } catch (evictErr) {
        console.error(
          "[Tandem] populateDocFromContent: eviction after cleanup failure also failed:",
          evictErr,
        );
      }
    }
    // Static-literal first arg; user-controlled values arrive as trailing args
    // so util.format doesn't treat them as a format string.
    console.error(
      "[Tandem] populateDocFromContent: populate failed; partial state cleared before rethrow.",
      { format, displayName: ctx.displayName, cleanupOk },
      err,
    );
    throw err;
  }
}

/**
 * Evict a cached Y.Doc's content + annotation state in-place (#616).
 *
 * Called from the cleanup-after-populate-failure path when targeted cleanup
 * itself threw — the Y.Doc is then in an indeterminate partial state and a
 * subsequent open of the same `documentId` would merge fresh content on top
 * of poisoned CRDT state. Eviction restores the doc to the same fresh-
 * instance shape `getOrCreateDocument(id)` would have produced.
 *
 * `withFileSync` tag: both durable-sync and channel-event observers skip
 * file-sync, so the half-cleared snapshot is neither persisted nor broadcast.
 * The per-doc file-sync context drops with phase `"close"` (not `"swap"`) —
 * eviction is fresh-start semantics, so the prior tombstone ledger is
 * released, not retained.
 */
function evictPartialDocState(doc: Y.Doc, docId: string | undefined): void {
  if (docId) {
    // Drop the per-doc file-sync context with phase "close" (the registry's
    // clearFileSyncContext path). A no-op if no context was ever registered
    // for this docId — common during open, since wireAnnotationStore runs
    // AFTER populate.
    clearFileSyncContext(docId);
  }

  // `clearFileSyncContext` MUST run before the clear. It detaches the
  // durable-sync observer first; otherwise clearing the maps would fire the
  // observer with empty-map delete events and persist an empty snapshot to the
  // on-disk annotation file — destroying durable annotations for the docId we
  // intended to evict-and-reopen.
  withFileSync(doc, () => {
    clearDocMaps(doc);
    const fragment = doc.getXmlFragment("default");
    fragment.delete(0, fragment.length);
  });
}

/**
 * Clear the four document-state Y.Maps (annotations, replies, awareness,
 * user-awareness) in place. Caller wraps with the appropriate origin helper
 * and is responsible for the XmlFragment if it also needs clearing.
 */
function clearDocMaps(doc: Y.Doc): void {
  const maps = [
    doc.getMap(Y_MAP_ANNOTATIONS),
    doc.getMap(Y_MAP_ANNOTATION_REPLIES),
    doc.getMap(Y_MAP_AWARENESS),
    doc.getMap(Y_MAP_USER_AWARENESS),
  ];
  for (const m of maps) m.forEach((_, k) => m.delete(k));
}

export { evictPartialDocState as __testEvictPartialDocState };

/**
 * Finalize a normal (non-force) document open: register in open-docs map,
 * set active, write metadata, init saved baseline, wire annotation store,
 * broadcast, start auto-save, and (for non-docx) set up the file watcher.
 *
 * NOTE: openFileFromContent follows a similar sequence but intentionally omits
 * wireFileWatcher and calls initSavedBaseline without a path argument (upload
 * path — no mtime tracking). These divergences are intentional, not drift.
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
  // Normal first open of a real file — enable rename recovery (#313).
  await wireAnnotationStore(id, doc, resolved, { allowRecovery: true });

  // Register the autosave dirty-tracking observer NOW (#851), after content has
  // been loaded into the body — so the open-time baseline is "clean" and a doc
  // opened to view but never edited never autosaves. Registering here (not only
  // in the Hocuspocus swap path) ensures MCP-only edits (tandem_edit) are
  // tracked even when no browser has connected yet. The observer is keyed by
  // docId in module state and re-registered on swap, so it survives the Y.Doc
  // replacement in onLoadDocument.
  registerDirtyObserver(id, doc);

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
export async function wireAnnotationStore(
  id: string,
  doc: Y.Doc,
  filePath: string,
  opts?: { allowRecovery?: boolean },
): Promise<void> {
  try {
    const hash = docHash(filePath);

    // Rename recovery (#313): on a genuine first open, if NO envelope exists at
    // this document's path-hash, the file may have been renamed (new path -> new
    // hash), orphaning its annotations. Try to re-associate an orphaned envelope
    // by exact content match. Runs BEFORE loadAndMerge so the re-keyed envelope
    // is the one loadAndMerge picks up. Gating on "no existing envelope"
    // guarantees recovery never steals from a live envelope.
    //
    // Only enabled for the normal-open path. Force-reload (clearAndReload)
    // deliberately clears the envelope and must NOT resurrect a stale orphan;
    // upload:// recovery is deferred (see rename-recovery.ts header).
    if (opts?.allowRecovery && !(await annotationFileExists(hash))) {
      await recoverRenamedEnvelope(doc, hash, filePath);
    }

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
 * Clear all document state in-place and repopulate from a pre-read buffer.
 * Unlike the old forceCloseDocument, this preserves the Y.Doc instance, Hocuspocus
 * room, and client WebSocket connections. All state (content, annotations, awareness)
 * is cleared and repopulated in a single Y.js transaction so clients see one atomic update.
 *
 * The caller owns the disk read (passes `source`) so the `fs.readFile` sink
 * sits at the call site where the path has already flowed through
 * resolveAndValidatePath — keeps CodeQL path-injection tracking local.
 *
 * Shares parse + apply helpers with `populateDocFromContent` (closes #611).
 * That means force-reload now inherits the rollback containment + docx
 * comment-extract/inject notification UX that #612 added to the normal-open
 * path: a malformed Word comment no longer silently drops on reload, and an
 * inject mid-transact failure rolls back partial annotation writes.
 */
async function clearAndReload(
  id: string,
  doc: Y.Doc,
  resolved: string,
  format: string,
  existing: OpenDoc,
  source: string | Buffer,
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

  // 1. Pre-parse OUTSIDE the transaction (async I/O / docx parsing). Reuses
  //    prepareContent so the docx pre-parse and comment-extract notification
  //    UX match populateDocFromContent exactly.
  const ctx: PopulateContext = {
    displayName: path.basename(resolved),
    dedupSource: resolved,
  };
  const prepared = await prepareContent(format, source);
  const isDocx = format === "docx";

  // 2. Single transaction: clear all state + repopulate + rewrite metadata.
  //    Clients see one atomic Y.js update — no intermediate states. The
  //    try-catch is a diagnostic safety net for Y.js internal corruption; on
  //    throw we re-raise so the caller's force-reload reports the failure.
  try {
    withInternal(doc, () => {
      clearDocMaps(doc);
      // Repopulate content via shared helper (idem with populateDocFromContent).
      applyPreparedContent(doc, prepared, ctx);
      // Rewrite metadata + dirty-tracking baseline
      const meta = doc.getMap(Y_MAP_DOCUMENT_META);
      meta.set(Y_MAP_READ_ONLY, isDocx);
      meta.set("format", format);
      meta.set("documentId", id);
      meta.set("fileName", path.basename(resolved));
      meta.set(Y_MAP_SAVED_AT_VERSION, Date.now());
    });

    // 3. Reattach event queue observers (idempotent — detaches existing first)
    attachObservers(id, doc);

    // The body now mirrors disk content — clear the autosave dirty flag so the
    // reload itself doesn't trigger a redundant write-back (#851). Done after
    // attachObservers re-registers the body observer (which preserves the
    // counter the in-transaction repopulation above may have bumped).
    markClean(id);
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
  withInternal(doc, () => meta.set(Y_MAP_SAVED_AT_VERSION, baseline));
}

function writeDocMeta(
  doc: Y.Doc,
  id: string,
  fileName: string,
  format: string,
  readOnly: boolean,
): void {
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  withInternal(doc, () => {
    meta.set(Y_MAP_READ_ONLY, readOnly);
    meta.set("format", format);
    meta.set("documentId", id);
    meta.set("fileName", fileName);
  });
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

    // 1. Read new content outside the transaction (async I/O). Pre-parse
    //    through the adapter so we use the same code path as opens
    //    (ADR-036 + PR #707 review — single source of truth). For md/txt
    //    `parse` is essentially a no-op wrap.
    const fileContent = await fs.readFile(filePath, "utf-8");
    const reloadAdapter = getAdapter(format);
    const reloadPrepared = await reloadAdapter.parse(fileContent);

    // 2. Single transaction: clear awareness + repopulate content, preserve
    //    annotations. `withReload`: channel skips, durable-sync persists, the
    //    tombstone observer records — file-watcher reload semantics.
    withReload(doc, () => {
      const awareness = doc.getMap(Y_MAP_AWARENESS);
      awareness.forEach((_, k) => awareness.delete(k));

      const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
      userAwareness.forEach((_, k) => userAwareness.delete(k));

      // Repopulate content via adapter.apply (clears XmlFragment internally).
      // Any apply-time issues are dropped here — reload is a recovery path,
      // not a user-initiated open; surfacing inject failures via toast on
      // every file-watcher reload would be noisy. The original surface in
      // openFileByPath catches inject failures during the initial open.
      reloadAdapter.apply(doc, reloadPrepared, { fileName: path.basename(filePath) });
    });

    // 3. Refresh all annotation ranges in a batch transaction (sanitize legacy shapes)
    const annotationMap = doc.getMap(Y_MAP_ANNOTATIONS);
    const annotations: Annotation[] = [];
    const reloadDocHash = docHash(filePath);
    annotationMap.forEach((val) =>
      annotations.push(
        sanitizeAnnotation(val as Annotation, (event) =>
          relaySanitizationEvent(reloadDocHash, event),
        ),
      ),
    );

    if (annotations.length > 0) {
      // Merge refresh + textSnapshot relocation into a single `withReload`
      // transact so durable-sync persists the re-anchored ranges in one step.
      // Closes the two-write crash window (GH #622): a process kill between
      // the refresh and relocation passes previously left annotations stored
      // at partially refreshed ranges.
      withReload(doc, () => {
        const refreshed = refreshAllRanges(annotations, doc, annotationMap, {
          skipTransact: true,
        }).map((r) => r.annotation);

        // 4. Second pass: textSnapshot-based relocation for annotations with stale relRanges.
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
      });
    }

    // 5. Reattach event queue observers (idempotent)
    attachObservers(id, doc);

    // The body now mirrors the on-disk content we just read — clear the
    // autosave dirty flag so a file-watcher reload doesn't trigger a redundant
    // write-back (#851).
    markClean(id);

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
