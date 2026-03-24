import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import * as Y from 'yjs';
import { getOrCreateDocument } from '../yjs/provider.js';
import { mcpSuccess, mcpError, noDocumentError, getErrorMessage } from './response.js';
import {
  MAX_FILE_SIZE,
  CHARS_PER_PAGE,
  LARGE_FILE_PAGE_THRESHOLD,
  VERY_LARGE_FILE_PAGE_THRESHOLD,
} from '../../shared/constants.js';
import { headingPrefix } from '../../shared/offsets.js';
import { loadMarkdown, saveMarkdown } from '../file-io/markdown.js';
import { loadDocx, htmlToYDoc } from '../file-io/docx.js';
import {
  saveSession, loadSession, restoreYDoc, sourceFileChanged,
  startAutoSave, stopAutoSave, isAutoSaveRunning,
} from '../session/manager.js';

// Document model (pure logic)
import {
  extractText, extractMarkdown, populateYDoc, getElementText,
  resolveOffset, getOrCreateXmlText, verifyAndResolveRange,
  detectFormat, docIdFromPath,
} from './document-model.js';

// Document service (state management)
import {
  getOpenDocs, getActiveDocId, setActiveDocId,
  getCurrentDoc, requireDocument, broadcastOpenDocs, toDocListEntry,
  addDoc, removeDoc, hasDoc, docCount,
} from './document-service.js';

// Re-export for backward compatibility with existing consumers.
export {
  extractText, extractMarkdown, populateYDoc, getElementText,
  getOrCreateXmlText, resolveOffset, verifyAndResolveRange,
  detectFormat, docIdFromPath, getHeadingPrefixLength,
} from './document-model.js';
export type { ResolvedOffset, RangeVerifyResult } from './document-model.js';
export {
  getCurrentDoc, getOpenDocs, getActiveDocId, setActiveDocId,
  requireDocument, toDocListEntry, saveCurrentSession, restoreCtrlSession,
  addDoc, removeDoc, hasDoc, docCount,
} from './document-service.js';
export type { OpenDoc } from './document-service.js';

export function registerDocumentTools(server: McpServer): void {
  const openDocs = getOpenDocs();

  server.tool(
    'tandem_open',
    'Open a file in the Tandem editor. Returns a documentId for multi-document workflows. Auto-opens browser.',
    { filePath: z.string().describe('Absolute path to the file to open') },
    async ({ filePath }) => {
      let resolved = path.resolve(filePath);
      try {
        try {
          resolved = fsSync.realpathSync(path.resolve(filePath));
        } catch {
          resolved = path.resolve(filePath);
        }

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

        const id = docIdFromPath(resolved);
        const existing = openDocs.get(id);
        if (existing) {
          setActiveDocId(id);
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

        const session = await loadSession(resolved);
        if (session) {
          const changed = await sourceFileChanged(session);
          if (!changed) {
            restoreYDoc(doc, session);
            restoredFromSession = true;
          }
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

        addDoc(id, { id, filePath: resolved, format, readOnly });
        setActiveDocId(id);

        const meta = doc.getMap('documentMeta');
        meta.set('readOnly', readOnly);
        meta.set('format', format);
        meta.set('documentId', id);
        meta.set('fileName', fileName);

        broadcastOpenDocs();

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
        const pageEstimate = Math.ceil(textLen / CHARS_PER_PAGE);

        const warnings: string[] = [];
        if (pageEstimate >= VERY_LARGE_FILE_PAGE_THRESHOLD) {
          warnings.push(`Very large document (~${pageEstimate} pages). Consider splitting into smaller files.`);
        } else if (pageEstimate >= LARGE_FILE_PAGE_THRESHOLD) {
          warnings.push(`Large document (~${pageEstimate} pages). Operations may be slower than usual.`);
        }

        return mcpSuccess({
          documentId: id,
          filePath: resolved,
          fileName,
          format,
          readOnly,
          tokenEstimate: Math.ceil(textLen / 4),
          pageEstimate,
          restoredFromSession,
          ...(warnings.length > 0 ? { warnings } : {}),
          message: restoredFromSession
            ? `Session restored: ${fileName} (annotations preserved)`
            : readOnly
              ? `Document opened (review only): ${fileName}`
              : `Document opened: ${fileName}`,
        });
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          return mcpError('FILE_NOT_FOUND', `File not found: ${resolved}`);
        }
        if (e.code === 'EBUSY' || e.code === 'EPERM') {
          return mcpError('FILE_LOCKED', `File is locked — another program (likely Microsoft Word) has it open. Close it and try again.`);
        }
        if (e.code === 'EACCES') {
          return mcpError('PERMISSION_DENIED', `Permission denied — check file permissions for: ${resolved}`);
        }
        return mcpError('FORMAT_ERROR', getErrorMessage(err));
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
            if (inSection && level <= sectionLevel) break;
            if (text.trim().toLowerCase() === section.trim().toLowerCase()) {
              inSection = true;
              sectionLevel = level;
              lines.push(headingPrefix(level) + text);
              continue;
            }
          }

          if (inSection) {
            if (node.nodeName === 'heading') {
              const level = Number(node.getAttribute('level') ?? 1);
              lines.push(headingPrefix(level) + text);
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
      textSnapshot: z.string().optional().describe('Expected text at [from, to] — returns RANGE_STALE with relocated range on mismatch'),
    },
    async ({ from, to, newText, documentId, textSnapshot }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();

      if (textSnapshot) {
        const result = verifyAndResolveRange(r.doc, from, to, textSnapshot);
        if (!result.valid) {
          if (result.gone) {
            return mcpError('RANGE_STALE', 'Target text no longer exists in the document.');
          }
          return mcpError('RANGE_STALE', 'Target text has moved. Use resolvedFrom/resolvedTo to retry.', {
            resolvedFrom: result.resolvedFrom,
            resolvedTo: result.resolvedTo,
          });
        }
      }

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

      if (startPos.clampedFromPrefix || endPos.clampedFromPrefix) {
        return mcpError('INVALID_RANGE',
          'Edit range overlaps with heading markup (e.g., "## "). Target the text content only. ' +
          'Use tandem_resolveRange to find the text position.');
      }

      if (startPos.elementIndex !== endPos.elementIndex) {
        r.doc.transact(() => {
          const startNode = fragment.get(startPos.elementIndex) as Y.XmlElement;
          const startText = getOrCreateXmlText(startNode);
          const startLen = startText.toString().length;
          if (startPos.textOffset < startLen) {
            startText.delete(startPos.textOffset, startLen - startPos.textOffset);
          }

          const deleteCount = endPos.elementIndex - startPos.elementIndex - 1;
          for (let i = 0; i < deleteCount; i++) {
            fragment.delete(startPos.elementIndex + 1, 1);
          }

          const endNode = fragment.get(startPos.elementIndex + 1) as Y.XmlElement;
          const endText = getOrCreateXmlText(endNode);
          if (endPos.textOffset > 0) {
            endText.delete(0, endPos.textOffset);
          }
          const remainingText = endText.toString();
          if (remainingText.length > 0) {
            startText.insert(startPos.textOffset, remainingText);
          }
          fragment.delete(startPos.elementIndex + 1, 1);

          startText.insert(startPos.textOffset, newText);
        });
      } else {
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
          await saveSession(r.filePath, format, r.doc);
          return mcpSuccess({
            saved: true,
            sessionOnly: true,
            filePath: r.filePath,
            message: 'Session saved (annotations preserved). Source file unchanged — document is read-only.',
          });
        }

        const output = format === 'md' ? saveMarkdown(r.doc) : extractText(r.doc);
        const tempPath = path.join(path.dirname(r.filePath), `.tandem-tmp-${Date.now()}`);
        await fs.writeFile(tempPath, output, 'utf-8');
        await fs.rename(tempPath, r.filePath);
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
      const activeId = getActiveDocId();
      const active = activeId ? openDocs.get(activeId) : null;
      return mcpSuccess({
        running: true,
        activeDocument: active ? { documentId: active.id, filePath: active.filePath, format: active.format } : null,
        openDocuments: Array.from(openDocs.values()).map(d => ({
          documentId: d.id,
          filePath: d.filePath,
          format: d.format,
          readOnly: d.readOnly,
        })),
        documentCount: docCount(),
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
      const id = documentId ?? getActiveDocId();
      if (!id) return mcpError('NO_DOCUMENT', 'No document to close.');

      const docState = openDocs.get(id);
      if (!docState) return mcpError('NO_DOCUMENT', `Document ${id} not found.`);

      const doc = getOrCreateDocument(id);
      await saveSession(docState.filePath, docState.format, doc);

      removeDoc(id);

      if (getActiveDocId() === id) {
        const remaining = Array.from(openDocs.keys());
        setActiveDocId(remaining.length > 0 ? remaining[0] : null);
      }

      if (docCount() === 0) {
        stopAutoSave();
      }

      broadcastOpenDocs();

      return mcpSuccess({
        closed: true,
        was: docState.filePath,
        activeDocumentId: getActiveDocId(),
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
          isActive: d.id === getActiveDocId(),
        })),
        activeDocumentId: getActiveDocId(),
        count: docCount(),
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
      if (!hasDoc(documentId)) {
        return mcpError('NO_DOCUMENT', `Document ${documentId} is not open.`);
      }
      setActiveDocId(documentId);
      broadcastOpenDocs();
      return mcpSuccess({
        activeDocumentId: documentId,
        ...toDocListEntry(openDocs.get(documentId)!),
      });
    }
  );
}
