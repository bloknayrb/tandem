import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import type * as Y from "yjs";
import { randomUUID } from "node:crypto";
import {
  getOrCreateDocument,
  getDocument,
  removeDocument,
  getHocuspocus,
} from "../yjs/provider.js";
import {
  MAX_FILE_SIZE,
  CHARS_PER_PAGE,
  LARGE_FILE_PAGE_THRESHOLD,
  VERY_LARGE_FILE_PAGE_THRESHOLD,
  SUPPORTED_EXTENSIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_SAVED_AT_VERSION,
} from "../../shared/constants.js";
import { MCP_ORIGIN, detachObservers } from "../events/queue.js";
import { getAdapter } from "../file-io/index.js";
import {
  saveSession,
  loadSession,
  restoreYDoc,
  sourceFileChanged,
  deleteSession,
  startAutoSave,
  isAutoSaveRunning,
} from "../session/manager.js";
import { extractText, detectFormat, docIdFromPath } from "./document-model.js";
import {
  type OpenDoc,
  getOpenDocs,
  setActiveDocId,
  broadcastOpenDocs,
  addDoc,
  removeDoc,
} from "./document-service.js";

export { SUPPORTED_EXTENSIONS };

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

/**
 * Open a file by its absolute path on disk.
 * Throws on errors (ENOENT, EACCES, EBUSY, etc.) — caller maps to MCP or HTTP responses.
 * Pass `force: true` to reload from disk even if already open (clears all document state).
 */
export async function openFileByPath(
  filePath: string,
  options?: { force?: boolean },
): Promise<OpenFileResult> {
  let resolved = path.resolve(filePath);
  try {
    resolved = fsSync.realpathSync(resolved);
  } catch {
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
  const openDocs = getOpenDocs();

  // Already open — force-reload from disk or switch to it
  const existing = openDocs.get(id);
  const forceReload = existing && options?.force === true;
  if (existing && !forceReload) {
    setActiveDocId(id);
    broadcastOpenDocs();
    const doc = getOrCreateDocument(id);
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

  if (forceReload) {
    await forceCloseDocument(id, existing);
  }

  const doc = getOrCreateDocument(id);
  const fileName = path.basename(resolved);
  let restoredFromSession = false;

  const session = await loadSession(resolved);
  if (session) {
    const changed = await sourceFileChanged(session);
    if (!changed) {
      restoreYDoc(doc, session);
      const fragment = doc.getXmlFragment("default");
      if (fragment.length > 0) {
        restoredFromSession = true;
      } else {
        console.error(
          `[Tandem] Session restore yielded empty doc for ${fileName}, falling back to source file`,
        );
      }
    }
  }

  if (!restoredFromSession) {
    const adapter = getAdapter(format);
    const fileContent = isDocx ? await fs.readFile(resolved) : await fs.readFile(resolved, "utf-8");
    await adapter.load(doc, fileContent);
  }

  addDoc(id, { id, filePath: resolved, format, readOnly, source: "file" });
  setActiveDocId(id);
  writeDocMeta(doc, id, fileName, format, readOnly);
  initSavedBaseline(doc);
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
      restoredFromSession,
    }),
    forceReloaded: forceReload === true,
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
  const syntheticPath = `upload://${randomUUID()}/${fileName}`;
  const id = docIdFromPath(syntheticPath);

  const doc = getOrCreateDocument(id);
  const adapter = getAdapter(format);
  await adapter.load(doc, content);

  addDoc(id, { id, filePath: syntheticPath, format, readOnly, source: "upload" });
  setActiveDocId(id);
  writeDocMeta(doc, id, fileName, format, readOnly);
  initSavedBaseline(doc);
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

// --- Private helpers ---

/**
 * Tear down an open document so it can be re-opened fresh from disk.
 * Clears all document state (content, annotations, awareness, session).
 * Directly manipulates Hocuspocus internals to avoid the nondeterministic
 * async timing of `unloadDocument()` (which bails if connections > 0).
 * Best-effort: each step is wrapped in try-catch so a failure in one step
 * doesn't prevent subsequent cleanup.
 */
async function forceCloseDocument(id: string, existing: OpenDoc): Promise<void> {
  console.error(`[Tandem] forceCloseDocument: tearing down ${id}`);
  let errors = 0;

  // 1. Stop event queue observers for this document
  try {
    detachObservers(id);
  } catch (err) {
    errors++;
    console.error(`[Tandem] forceCloseDocument: detachObservers failed for ${id}:`, err);
  }

  // 2. Remove from open-docs tracking and broadcast removal to clients.
  //    Clients see the doc disappear from openDocuments and destroy their provider+ydoc.
  try {
    removeDoc(id);
    broadcastOpenDocs();
  } catch (err) {
    errors++;
    console.error(`[Tandem] forceCloseDocument: removeDoc/broadcast failed for ${id}:`, err);
  }

  // 3. Hocuspocus cleanup (may not be running in tests / MCP-only mode)
  try {
    const hp = getHocuspocus();
    if (hp) {
      // Force-close WebSocket connections so clients disconnect
      hp.closeConnections(id);

      // Delete from hp.documents so that any deferred unloadDocument calls
      // (triggered by closeConnections settling) become no-ops
      // (line 594 of src/Hocuspocus.ts: `if (!this.documents.has(documentName)) return`).
      const hpDoc = hp.documents.get(id);
      if (hpDoc) {
        hp.documents.delete(id);
        hpDoc.destroy();
      }

      // Clear any in-flight load promise to prevent stale state on reconnect
      hp.loadingDocuments.delete(id);
    }
  } catch (err) {
    errors++;
    console.error(`[Tandem] forceCloseDocument: Hocuspocus cleanup failed for ${id}:`, err);
  }

  // 4. Remove from Tandem's provider Y.Doc map (idempotent if afterUnloadDocument already ran)
  try {
    const oldDoc = getDocument(id);
    if (oldDoc) {
      oldDoc.destroy();
      removeDocument(id);
    }
  } catch (err) {
    errors++;
    console.error(`[Tandem] forceCloseDocument: Y.Doc removal failed for ${id}:`, err);
  }

  // 5. Delete session so it doesn't restore stale state
  try {
    await deleteSession(existing.filePath);
  } catch (err) {
    errors++;
    console.error(`[Tandem] forceCloseDocument: deleteSession failed for ${id}:`, err);
  }

  // 6. Best-effort delay so the removal broadcast propagates to clients before re-add.
  //    Without this, React's automatic batching could merge remove+add into one render,
  //    causing the stale provider to survive. 100ms is a heuristic, not a guarantee.
  await new Promise((resolve) => setTimeout(resolve, 100));

  console.error(
    `[Tandem] forceCloseDocument: teardown complete for ${id}${errors > 0 ? ` with ${errors} error(s)` : ""}`,
  );
}

/** Set the initial savedAtVersion baseline so the client knows the file is clean on open. */
function initSavedBaseline(doc: Y.Doc): void {
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  doc.transact(() => meta.set(Y_MAP_SAVED_AT_VERSION, Date.now()), MCP_ORIGIN);
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

function ensureAutoSave(): void {
  if (isAutoSaveRunning()) return;
  startAutoSave(async () => {
    for (const [docId, state] of getOpenDocs()) {
      const d = getOrCreateDocument(docId);
      await saveSession(state.filePath, state.format, d);
    }
  });
}
