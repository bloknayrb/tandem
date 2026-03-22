import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getOrCreateDocument } from '../yjs/provider.js';
import { mcpSuccess, mcpError, noDocumentError, getErrorMessage } from './response.js';
import { MAX_FILE_SIZE } from '../../shared/constants.js';
import { loadMarkdown, saveMarkdown } from '../file-io/markdown.js';
import { loadDocx, htmlToYDoc } from '../file-io/docx.js';
import {
  saveSession, loadSession, restoreYDoc, sourceFileChanged,
  startAutoSave, stopAutoSave, isAutoSaveRunning,
} from '../session/manager.js';
import * as Y from 'yjs';

// --- Multi-document state ---

export interface OpenDoc {
  id: string;
  filePath: string;
  format: string;
  readOnly: boolean;
}

/** All open documents, keyed by document ID (which is also the Hocuspocus room name) */
const openDocs = new Map<string, OpenDoc>();

/** The active document ID — tools default to this when no documentId is specified */
let activeDocId: string | null = null;

/**
 * Generate a stable, readable document ID from a file path.
 * Used as both the map key and the Hocuspocus room name.
 */
export function docIdFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  const name = path.basename(filePath, path.extname(filePath))
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 16);
  return `${name}-${Math.abs(hash).toString(36).slice(0, 6)}`;
}

export function getOpenDocs(): Map<string, OpenDoc> {
  return openDocs;
}

export function getActiveDocId(): string | null {
  return activeDocId;
}

/**
 * Resolve which document to operate on.
 * If documentId is provided, use that. Otherwise use the active doc.
 */
export function getCurrentDoc(documentId?: string) {
  const id = documentId ?? activeDocId;
  if (!id) return null;
  const doc = openDocs.get(id);
  if (!doc) return null;
  return { ...doc, docName: id };
}

/** Save all open sessions (for shutdown handler). */
export async function saveCurrentSession(): Promise<void> {
  for (const [id, state] of openDocs) {
    const doc = getOrCreateDocument(id);
    await saveSession(state.filePath, state.format, doc);
  }
}

/** Returns the shared Y.Doc or null if the target doc isn't open */
function requireDocument(documentId?: string): { doc: Y.Doc; filePath: string; docId: string } | null {
  const current = getCurrentDoc(documentId);
  if (!current) return null;
  return { doc: getOrCreateDocument(current.docName), filePath: current.filePath, docId: current.id };
}

/** Build the document list entry for a single OpenDoc */
function toDocListEntry(d: OpenDoc) {
  return {
    id: d.id,
    filePath: d.filePath,
    fileName: path.basename(d.filePath),
    format: d.format,
    readOnly: d.readOnly,
  };
}

/** Broadcast the open documents list to the active document's connected clients */
function broadcastOpenDocs(): void {
  if (!activeDocId) return;
  const docList = Array.from(openDocs.values()).map(toDocListEntry);
  const ydoc = getOrCreateDocument(activeDocId);
  const meta = ydoc.getMap('documentMeta');
  meta.set('openDocuments', docList);
  meta.set('activeDocumentId', activeDocId);
}

function detectFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.md': return 'md';
    case '.txt': return 'txt';
    case '.html': case '.htm': return 'html';
    case '.docx': return 'docx';
    default: return 'txt';
  }
}

/** Insert text content into a Y.Doc's XmlFragment as paragraphs */
export function populateYDoc(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment('default');

  // Clear existing content in a single operation
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }

  // Truly empty input produces empty fragment
  if (text === '') return;

  const lines = text.split('\n');
  for (const line of lines) {
    if (line === '') {
      const empty = new Y.XmlElement('paragraph');
      empty.insert(0, [new Y.XmlText('')]);
      fragment.insert(fragment.length, [empty]);
      continue;
    }

    let element: Y.XmlElement;

    if (line.startsWith('### ')) {
      element = new Y.XmlElement('heading');
      element.setAttribute('level', 3 as any);
      element.insert(0, [new Y.XmlText(line.slice(4))]);
    } else if (line.startsWith('## ')) {
      element = new Y.XmlElement('heading');
      element.setAttribute('level', 2 as any);
      element.insert(0, [new Y.XmlText(line.slice(3))]);
    } else if (line.startsWith('# ')) {
      element = new Y.XmlElement('heading');
      element.setAttribute('level', 1 as any);
      element.insert(0, [new Y.XmlText(line.slice(2))]);
    } else {
      element = new Y.XmlElement('paragraph');
      element.insert(0, [new Y.XmlText(line)]);
    }

    fragment.insert(fragment.length, [element]);
  }
}

/**
 * Extract plain text from a Y.XmlElement by recursively collecting Y.XmlText content.
 */
export function getElementText(element: Y.XmlElement): string {
  const parts: string[] = [];
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      parts.push(child.toString());
    } else if (child instanceof Y.XmlElement) {
      parts.push(getElementText(child));
    }
  }
  return parts.join('');
}

/** Extract plain text from a Y.Doc's XmlFragment */
export function extractText(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment('default');
  const lines: string[] = [];

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) {
      const text = getElementText(node);
      if (node.nodeName === 'heading') {
        const level = Number(node.getAttribute('level') ?? 1);
        lines.push('#'.repeat(level) + ' ' + text);
      } else {
        lines.push(text);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Extract readable markdown from a Y.Doc via remark serialization.
 * Used for tandem_getTextContent on .md files so Claude can read document structure.
 * NOT used by resolveOffset or tandem_edit (those use extractText).
 */
export function extractMarkdown(doc: Y.Doc): string {
  return saveMarkdown(doc).trimEnd();
}

/**
 * Get the heading prefix length for a node ("## " = 3, "# " = 2, paragraph = 0).
 */
export function getHeadingPrefixLength(node: Y.XmlElement): number {
  if (node.nodeName === 'heading') {
    const level = Number(node.getAttribute('level') ?? 1);
    return level + 1; // "# " = 2, "## " = 3, "### " = 4
  }
  return 0;
}

export interface ResolvedOffset {
  elementIndex: number;
  textOffset: number;
  /** True if the original offset fell inside a heading prefix (e.g., "## ") and was clamped to 0 */
  clampedFromPrefix: boolean;
}

/**
 * Resolve a flat character offset (from extractText) to a Y.Doc element position.
 * Returns { elementIndex, textOffset, clampedFromPrefix } where textOffset is within
 * the element's Y.XmlText (NOT including heading prefix).
 */
export function resolveOffset(
  fragment: Y.XmlFragment,
  charOffset: number
): ResolvedOffset | null {
  let accumulated = 0;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    const prefixLen = getHeadingPrefixLength(node);
    const text = getElementText(node);
    const fullLen = prefixLen + text.length;

    // Is the target offset within this element?
    if (accumulated + fullLen > charOffset) {
      const offsetInFull = charOffset - accumulated;
      const clampedFromPrefix = offsetInFull < prefixLen && prefixLen > 0;
      const textOffset = Math.max(0, offsetInFull - prefixLen);
      return { elementIndex: i, textOffset, clampedFromPrefix };
    }

    accumulated += fullLen;

    // Account for the \n separator between elements
    if (i < fragment.length - 1) {
      accumulated += 1;
      if (accumulated > charOffset) {
        return { elementIndex: i, textOffset: text.length, clampedFromPrefix: false };
      }
    }
  }

  // Offset at or past end of document — return end of last element
  if (fragment.length > 0) {
    const lastNode = fragment.get(fragment.length - 1);
    if (lastNode instanceof Y.XmlElement) {
      return { elementIndex: fragment.length - 1, textOffset: getElementText(lastNode).length, clampedFromPrefix: false };
    }
  }

  return null;
}

/**
 * Find the first Y.XmlText child of a Y.XmlElement.
 * Creates one if the element is empty.
 */
export function getOrCreateXmlText(element: Y.XmlElement): Y.XmlText {
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      return child;
    }
  }
  // No text child — create one
  const textNode = new Y.XmlText('');
  element.insert(0, [textNode]);
  return textNode;
}

export function registerDocumentTools(server: McpServer): void {
  server.tool(
    'tandem_open',
    'Open a file in the Tandem editor. Returns a documentId for multi-document workflows. Auto-opens browser.',
    { filePath: z.string().describe('Absolute path to the file to open') },
    async ({ filePath }) => {
      try {
        // Resolve symlinks/junctions BEFORE path validation (prevents symlink-to-UNC bypass)
        let resolved: string;
        try {
          resolved = fsSync.realpathSync(path.resolve(filePath));
        } catch {
          resolved = path.resolve(filePath);
        }

        // Reject UNC paths (prevents NTLM credential hash leakage via SMB)
        if (resolved.startsWith('\\\\') || resolved.startsWith('//')) {
          return mcpError('FILE_NOT_FOUND', 'UNC paths are not supported for security reasons.');
        }

        const stat = await fs.stat(resolved);
        if (stat.size > MAX_FILE_SIZE) {
          return mcpError('FORMAT_ERROR', 'File exceeds 50MB limit.');
        }

        const format = detectFormat(resolved);
        const isDocx = format === 'docx';
        const readOnly = isDocx;

        // Check if this file is already open
        const id = docIdFromPath(resolved);
        const existing = openDocs.get(id);
        if (existing) {
          // Already open — just switch to it
          activeDocId = id;
          broadcastOpenDocs();
          const doc = getOrCreateDocument(id);
          const textContent = extractText(doc);
          return mcpSuccess({
            documentId: id,
            filePath: resolved,
            fileName: path.basename(resolved),
            format,
            readOnly,
            tokenEstimate: Math.ceil(textContent.length / 4),
            pageEstimate: Math.ceil(textContent.length / 3000),
            restoredFromSession: false,
            alreadyOpen: true,
            message: `Switched to already-open document: ${path.basename(resolved)}`,
          });
        }

        const doc = getOrCreateDocument(id);
        const fileName = path.basename(resolved);
        let restoredFromSession = false;

        // Check for existing session
        const session = await loadSession(resolved);
        if (session) {
          const changed = await sourceFileChanged(session);
          if (!changed) {
            // Source file unchanged — restore Y.Doc from session (preserves annotations)
            restoreYDoc(doc, session);
            restoredFromSession = true;
          }
          // If source changed, fall through to fresh load (annotations may be stale)
        }

        if (!restoredFromSession) {
          if (isDocx) {
            const html = await loadDocx(resolved);
            htmlToYDoc(doc, html);
          } else {
            const fileContent = await fs.readFile(resolved, 'utf-8');
            if (format === 'md') {
              loadMarkdown(doc, fileContent);
            } else {
              populateYDoc(doc, fileContent);
            }
          }
        }

        // Register in the open docs map
        openDocs.set(id, { id, filePath: resolved, format, readOnly });
        activeDocId = id;

        // Write document metadata for client consumption
        const meta = doc.getMap('documentMeta');
        meta.set('readOnly', readOnly);
        meta.set('format', format);
        meta.set('documentId', id);
        meta.set('fileName', fileName);

        broadcastOpenDocs();

        // Start auto-save timer if not already running (saves all open docs)
        if (!isAutoSaveRunning()) {
          startAutoSave(async () => {
            for (const [docId, state] of openDocs) {
              const d = getOrCreateDocument(docId);
              await saveSession(state.filePath, state.format, d);
            }
          });
        }

        const textContent = extractText(doc);
        const textLen = textContent.length;
        return mcpSuccess({
          documentId: id,
          filePath: resolved,
          fileName,
          format,
          readOnly,
          tokenEstimate: Math.ceil(textLen / 4),
          pageEstimate: Math.ceil(textLen / 3000),
          restoredFromSession,
          message: restoredFromSession
            ? `Session restored: ${fileName} (annotations preserved)`
            : readOnly
              ? `Document opened (review only): ${fileName}`
              : `Document opened: ${fileName}`,
        });
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        const code = message.includes('ENOENT') ? 'FILE_NOT_FOUND'
          : message.includes('EBUSY') ? 'FILE_LOCKED'
          : 'FORMAT_ERROR';
        return mcpError(code, message);
      }
    }
  );

  server.tool(
    'tandem_getContent',
    'Read full document content. Warning: token-heavy for large docs. Use getOutline() or getTextContent() instead.',
    {
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ documentId }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();
      const fragment = r.doc.getXmlFragment('default');
      return mcpSuccess({ content: fragment.toJSON(), filePath: r.filePath, documentId: r.docId });
    }
  );

  server.tool(
    'tandem_getTextContent',
    'Read document as plain text. ~60% fewer tokens than getContent().',
    {
      section: z.string().optional().describe('Optional heading text to read only that section'),
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ section, documentId }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();

      if (section) {
        // Extract only the section matching the heading
        const fragment = r.doc.getXmlFragment('default');
        const lines: string[] = [];
        let inSection = false;
        let sectionLevel = 0;

        for (let i = 0; i < fragment.length; i++) {
          const node = fragment.get(i);
          if (!(node instanceof Y.XmlElement)) continue;

          const text = getElementText(node);

          if (node.nodeName === 'heading') {
            const level = Number(node.getAttribute('level') ?? 1);
            if (inSection && level <= sectionLevel) break; // Hit next section at same/higher level
            if (text.trim().toLowerCase() === section.trim().toLowerCase()) {
              inSection = true;
              sectionLevel = level;
              lines.push('#'.repeat(level) + ' ' + text);
              continue;
            }
          }

          if (inSection) {
            if (node.nodeName === 'heading') {
              const level = Number(node.getAttribute('level') ?? 1);
              lines.push('#'.repeat(level) + ' ' + text);
            } else {
              lines.push(text);
            }
          }
        }

        if (!inSection) {
          return mcpError('INVALID_RANGE', `Section "${section}" not found in document.`);
        }
        return mcpSuccess({ text: lines.join('\n'), filePath: r.filePath, section });
      }

      const docState = getCurrentDoc(documentId);
      const format = docState?.format;
      const text = format === 'md' ? extractMarkdown(r.doc) : extractText(r.doc);
      return mcpSuccess({ text, filePath: r.filePath, documentId: r.docId });
    }
  );

  server.tool(
    'tandem_getOutline',
    'Get document structure (headings, sections) without full content. Low token cost.',
    {
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ documentId }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();
      const fragment = r.doc.getXmlFragment('default');
      const outline: Array<{ level: number; text: string; index: number }> = [];

      for (let i = 0; i < fragment.length; i++) {
        const node = fragment.get(i);
        if (node instanceof Y.XmlElement && node.nodeName === 'heading') {
          const level = Number(node.getAttribute('level') ?? 1);
          outline.push({ level, text: getElementText(node), index: i });
        }
      }

      return mcpSuccess({ outline, totalNodes: fragment.length });
    }
  );

  server.tool(
    'tandem_edit',
    'Edit text in the document at a specific range. For single-paragraph replacements only — newlines in newText are inserted as literal text.',
    {
      from: z.number().describe('Start position (character offset)'),
      to: z.number().describe('End position (character offset)'),
      newText: z.string().describe('Replacement text (single paragraph — no newlines)'),
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ from, to, newText, documentId }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();

      const docState = getCurrentDoc(documentId);
      if (docState?.readOnly) {
        return mcpError('FORMAT_ERROR', 'Document is read-only (.docx). Use annotations instead.');
      }

      if (from > to) {
        return mcpError('INVALID_RANGE', `Invalid range: from (${from}) must be <= to (${to}).`);
      }

      const fragment = r.doc.getXmlFragment('default');
      const startPos = resolveOffset(fragment, from);
      const endPos = resolveOffset(fragment, to);

      if (!startPos || !endPos) {
        return mcpError('INVALID_RANGE', `Cannot resolve offset range [${from}, ${to}] in document.`);
      }

      // Validate that offsets don't land inside heading prefixes (e.g., "## ").
      // If they do, the clamped textOffset=0 would target the wrong content.
      if (startPos.clampedFromPrefix || endPos.clampedFromPrefix) {
        return mcpError('INVALID_RANGE',
          'Edit range overlaps with heading markup (e.g., "## "). Target the text content only. ' +
          'Use tandem_resolveRange to find the text position.');
      }

      // For v1: handle same-element edits. Cross-element edits are more complex.
      if (startPos.elementIndex !== endPos.elementIndex) {
        // Cross-element edit: delete from start to end across elements, insert new text in start element
        r.doc.transact(() => {
          // Delete everything from startPos to end of start element
          const startNode = fragment.get(startPos.elementIndex) as Y.XmlElement;
          const startText = getOrCreateXmlText(startNode);
          const startLen = startText.toString().length;
          if (startPos.textOffset < startLen) {
            startText.delete(startPos.textOffset, startLen - startPos.textOffset);
          }

          // Delete all elements between start and end (exclusive)
          const deleteCount = endPos.elementIndex - startPos.elementIndex - 1;
          for (let i = 0; i < deleteCount; i++) {
            fragment.delete(startPos.elementIndex + 1, 1);
          }

          // Now endPos.elementIndex shifted — the end element is at startPos.elementIndex + 1
          const endNode = fragment.get(startPos.elementIndex + 1) as Y.XmlElement;
          const endText = getOrCreateXmlText(endNode);
          // Delete from start of end element up to endPos.textOffset
          if (endPos.textOffset > 0) {
            endText.delete(0, endPos.textOffset);
          }
          // Append remaining end text to start element, then delete end element
          const remainingText = endText.toString();
          if (remainingText.length > 0) {
            startText.insert(startPos.textOffset, remainingText);
          }
          fragment.delete(startPos.elementIndex + 1, 1);

          // Insert new text at the start position
          startText.insert(startPos.textOffset, newText);
        });
      } else {
        // Same-element edit
        r.doc.transact(() => {
          const node = fragment.get(startPos.elementIndex) as Y.XmlElement;
          const textNode = getOrCreateXmlText(node);
          const deleteLen = endPos.textOffset - startPos.textOffset;
          if (deleteLen > 0) {
            textNode.delete(startPos.textOffset, deleteLen);
          }
          if (newText.length > 0) {
            textNode.insert(startPos.textOffset, newText);
          }
        });
      }

      return mcpSuccess({ edited: true, from, to, newTextLength: newText.length });
    }
  );

  server.tool(
    'tandem_save',
    'Save the current document back to disk',
    {
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ documentId }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();
      try {
        const docState = getCurrentDoc(documentId);
        const format = docState?.format ?? 'txt';
        const readOnly = docState?.readOnly ?? false;

        if (readOnly) {
          // Read-only docs: save session only (annotations persist), don't touch the source file
          await saveSession(r.filePath, format, r.doc);
          return mcpSuccess({
            saved: true,
            sessionOnly: true,
            filePath: r.filePath,
            message: 'Session saved (annotations preserved). Source file unchanged — document is read-only.',
          });
        }

        const output = format === 'md' ? saveMarkdown(r.doc) : extractText(r.doc);
        // Atomic save: write to temp, then rename
        const tempPath = path.join(path.dirname(r.filePath), `.tandem-tmp-${Date.now()}`);
        await fs.writeFile(tempPath, output, 'utf-8');
        await fs.rename(tempPath, r.filePath);
        // Save session alongside file save (captures annotations + doc state)
        await saveSession(r.filePath, format, r.doc);
        return mcpSuccess({ saved: true, filePath: r.filePath });
      } catch (err: unknown) {
        return mcpError('FILE_LOCKED', getErrorMessage(err));
      }
    }
  );

  server.tool(
    'tandem_status',
    'Check editor status: running, open documents, active document',
    {},
    async () => {
      const active = activeDocId ? openDocs.get(activeDocId) : null;
      return mcpSuccess({
        running: true,
        activeDocument: active ? { documentId: active.id, filePath: active.filePath, format: active.format } : null,
        openDocuments: Array.from(openDocs.values()).map(d => ({
          documentId: d.id,
          filePath: d.filePath,
          format: d.format,
          readOnly: d.readOnly,
        })),
        documentCount: openDocs.size,
      });
    }
  );

  server.tool(
    'tandem_close',
    'Close a document. Closes the active document if no documentId specified.',
    {
      documentId: z.string().optional().describe('Document ID to close (defaults to active document)'),
    },
    async ({ documentId }) => {
      const id = documentId ?? activeDocId;
      if (!id) return mcpError('NO_DOCUMENT', 'No document to close.');

      const docState = openDocs.get(id);
      if (!docState) return mcpError('NO_DOCUMENT', `Document ${id} not found.`);

      // Save session before closing
      const doc = getOrCreateDocument(id);
      await saveSession(docState.filePath, docState.format, doc);

      openDocs.delete(id);

      // If we closed the active doc, switch to another or null
      if (activeDocId === id) {
        const remaining = Array.from(openDocs.keys());
        activeDocId = remaining.length > 0 ? remaining[0] : null;
      }

      // Stop auto-save if no docs remain
      if (openDocs.size === 0) {
        stopAutoSave();
      }

      broadcastOpenDocs();

      return mcpSuccess({
        closed: true,
        was: docState.filePath,
        activeDocumentId: activeDocId,
      });
    }
  );

  server.tool(
    'tandem_listDocuments',
    'List all open documents with their IDs, file paths, and formats.',
    {},
    async () => {
      return mcpSuccess({
        documents: Array.from(openDocs.values()).map(d => ({
          ...toDocListEntry(d),
          isActive: d.id === activeDocId,
        })),
        activeDocumentId: activeDocId,
        count: openDocs.size,
      });
    }
  );

  server.tool(
    'tandem_switchDocument',
    'Switch the active document. Tools will operate on this document by default.',
    {
      documentId: z.string().describe('Document ID to switch to'),
    },
    async ({ documentId }) => {
      if (!openDocs.has(documentId)) {
        return mcpError('NO_DOCUMENT', `Document ${documentId} is not open.`);
      }
      activeDocId = documentId;
      broadcastOpenDocs();
      return mcpSuccess({
        activeDocumentId: documentId,
        ...toDocListEntry(openDocs.get(documentId)!),
      });
    }
  );
}
