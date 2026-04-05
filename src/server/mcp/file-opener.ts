import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import type * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { getOrCreateDocument, getDocument } from "../yjs/provider.js";
import {
  MAX_FILE_SIZE,
  CHARS_PER_PAGE,
  LARGE_FILE_PAGE_THRESHOLD,
  VERY_LARGE_FILE_PAGE_THRESHOLD,
  SUPPORTED_EXTENSIONS,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_USER_AWARENESS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_SAVED_AT_VERSION,
} from "../../shared/constants.js";
import { MCP_ORIGIN, attachObservers } from "../events/queue.js";
import { getAdapter } from "../file-io/index.js";
import { loadMarkdown } from "../file-io/markdown.js";
import { loadDocx } from "../file-io/docx.js";
import { htmlToYDoc } from "../file-io/docx-html.js";
import { extractDocxComments, injectCommentsAsAnnotations } from "../file-io/docx-comments.js";
import {
  saveSession,
  loadSession,
  restoreYDoc,
  sourceFileChanged,
  deleteSession,
  startAutoSave,
  isAutoSaveRunning,
} from "../session/manager.js";
import { extractText, detectFormat, docIdFromPath, populateYDoc } from "./document-model.js";
import {
  type OpenDoc,
  getOpenDocs,
  setActiveDocId,
  broadcastOpenDocs,
  addDoc,
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
    const doc = getDocument(id) ?? getOrCreateDocument(id);
    const fileName = path.basename(resolved);
    await clearAndReload(id, doc, resolved, format, existing);

    addDoc(id, { id, filePath: resolved, format, readOnly, source: "file" });
    setActiveDocId(id);
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

  // 1. Delete session so stale state doesn't restore on next startup
  await deleteSession(existing.filePath).catch((err) => {
    console.error(`[Tandem] clearAndReload: deleteSession failed for ${id}:`, err);
  });

  // 2. Prepare content outside the transaction (async I/O must happen before transact)
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

  // 3. Single transaction: clear all state + repopulate from pre-parsed content.
  //    Clients see one atomic Y.js update — no intermediate states.
  doc.transact(() => {
    // Clear Y.Maps
    const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
    annotations.forEach((_, k) => annotations.delete(k));

    const awareness = doc.getMap(Y_MAP_AWARENESS);
    awareness.forEach((_, k) => awareness.delete(k));

    const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
    userAwareness.forEach((_, k) => userAwareness.delete(k));

    // Repopulate content (adapters clear the XmlFragment internally)
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

  // 4. Reattach event queue observers (idempotent — detaches existing first)
  attachObservers(id, doc);

  console.error(`[Tandem] clearAndReload: complete for ${id}`);
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
