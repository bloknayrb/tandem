import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getOrCreateDocument } from '../yjs/provider.js';
import { mcpSuccess, mcpError, noDocumentError, getErrorMessage } from './response.js';
import { MAX_FILE_SIZE } from '../../shared/constants.js';
import { loadMarkdown, saveMarkdown } from '../file-io/markdown.js';
import {
  saveSession, loadSession, restoreYDoc, sourceFileChanged,
  startAutoSave, stopAutoSave,
} from '../session/manager.js';
import * as Y from 'yjs';

// Fixed room name — both MCP tools and browser client use this
// so they share the same Y.Doc instance via Hocuspocus
const ROOM_NAME = 'default';

// Current document state
let currentDoc: { filePath: string; format: string } | null = null;


export function getCurrentDoc() {
  return currentDoc ? { ...currentDoc, docName: ROOM_NAME } : null;
}

/** Save current session (for shutdown handler). No-op if no doc is open. */
export async function saveCurrentSession(): Promise<void> {
  if (!currentDoc) return;
  const doc = getOrCreateDocument(ROOM_NAME);
  await saveSession(currentDoc.filePath, currentDoc.format, doc);
}

/** Returns the shared Y.Doc or a noDocumentError if no doc is open */
function requireDocument(): { doc: Y.Doc; filePath: string } | null {
  if (!currentDoc) return null;
  return { doc: getOrCreateDocument(ROOM_NAME), filePath: currentDoc.filePath };
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
    'Open a file in the Tandem editor. Auto-opens browser.',
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
        if (format === 'docx') {
          return mcpError('FORMAT_ERROR', 'DOCX support not yet implemented. Use .md or .txt files for now.');
        }

        const doc = getOrCreateDocument(ROOM_NAME);
        const fileName = path.basename(resolved);
        const fileContent = await fs.readFile(resolved, 'utf-8');
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
          if (format === 'md') {
            loadMarkdown(doc, fileContent);
          } else {
            populateYDoc(doc, fileContent);
          }
        }

        currentDoc = { filePath: resolved, format };

        // Start auto-save timer
        startAutoSave(async () => {
          if (currentDoc) {
            await saveSession(currentDoc.filePath, currentDoc.format, doc);
          }
        });

        return mcpSuccess({
          filePath: resolved,
          fileName,
          format,
          tokenEstimate: Math.ceil(fileContent.length / 4),
          pageEstimate: Math.ceil(fileContent.length / 3000),
          restoredFromSession,
          message: restoredFromSession
            ? `Session restored: ${fileName} (annotations preserved)`
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
    {},
    async () => {
      const r = requireDocument();
      if (!r) return noDocumentError();
      const fragment = r.doc.getXmlFragment('default');
      return mcpSuccess({ content: fragment.toJSON(), filePath: r.filePath });
    }
  );

  server.tool(
    'tandem_getTextContent',
    'Read document as plain text. ~60% fewer tokens than getContent().',
    { section: z.string().optional().describe('Optional heading text to read only that section') },
    async ({ section }) => {
      const r = requireDocument();
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

      const format = currentDoc?.format;
      const text = format === 'md' ? extractMarkdown(r.doc) : extractText(r.doc);
      return mcpSuccess({ text, filePath: r.filePath });
    }
  );

  server.tool(
    'tandem_getOutline',
    'Get document structure (headings, sections) without full content. Low token cost.',
    {},
    async () => {
      const r = requireDocument();
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
    },
    async ({ from, to, newText }) => {
      const r = requireDocument();
      if (!r) return noDocumentError();

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
    {},
    async () => {
      const r = requireDocument();
      if (!r) return noDocumentError();
      try {
        const format = currentDoc?.format;
        const output = format === 'md' ? saveMarkdown(r.doc) : extractText(r.doc);
        // Atomic save: write to temp, then rename
        const tempPath = path.join(path.dirname(r.filePath), `.tandem-tmp-${Date.now()}`);
        await fs.writeFile(tempPath, output, 'utf-8');
        await fs.rename(tempPath, r.filePath);
        // Save session alongside file save (captures annotations + doc state)
        await saveSession(r.filePath, format ?? 'txt', r.doc);
        return mcpSuccess({ saved: true, filePath: r.filePath });
      } catch (err: unknown) {
        return mcpError('FILE_LOCKED', getErrorMessage(err));
      }
    }
  );

  server.tool(
    'tandem_status',
    'Check editor status: running, open file, user activity',
    {},
    async () => {
      return mcpSuccess({
        running: true,
        currentDocument: currentDoc?.filePath ?? null,
        format: currentDoc?.format ?? null,
      });
    }
  );

  server.tool(
    'tandem_close',
    'Close the current document',
    {},
    async () => {
      stopAutoSave(); // Prevent auto-save firing during close
      await saveCurrentSession(); // Save session before clearing state
      const was = currentDoc?.filePath ?? null;
      currentDoc = null;
      return mcpSuccess({ closed: true, was });
    }
  );
}
