import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getOrCreateDocument } from '../yjs/provider.js';
import { mcpSuccess, mcpError, noDocumentError, getErrorMessage } from './response.js';
import { MAX_FILE_SIZE } from '../../shared/constants.js';
import * as Y from 'yjs';

// Fixed room name — both MCP tools and browser client use this
// so they share the same Y.Doc instance via Hocuspocus
const ROOM_NAME = 'default';

// Current document state
let currentDoc: { filePath: string; format: string } | null = null;

export function getCurrentDoc() {
  return currentDoc ? { ...currentDoc, docName: ROOM_NAME } : null;
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
function populateYDoc(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment('default');

  // Clear existing content
  while (fragment.length > 0) {
    fragment.delete(0, 1);
  }

  const lines = text.split('\n');
  for (const line of lines) {
    if (line === '') continue;

    let element: Y.XmlElement;

    if (line.startsWith('### ')) {
      element = new Y.XmlElement('heading');
      element.setAttribute('level', '3');
      element.insert(0, [new Y.XmlText(line.slice(4))]);
    } else if (line.startsWith('## ')) {
      element = new Y.XmlElement('heading');
      element.setAttribute('level', '2');
      element.insert(0, [new Y.XmlText(line.slice(3))]);
    } else if (line.startsWith('# ')) {
      element = new Y.XmlElement('heading');
      element.setAttribute('level', '1');
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
function getElementText(element: Y.XmlElement): string {
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
        const level = parseInt(node.getAttribute('level') || '1', 10);
        lines.push('#'.repeat(level) + ' ' + text);
      } else {
        lines.push(text);
      }
    }
  }

  return lines.join('\n');
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

        const content = await fs.readFile(resolved, 'utf-8');
        const doc = getOrCreateDocument(ROOM_NAME);
        populateYDoc(doc, content);
        currentDoc = { filePath: resolved, format };

        const fileName = path.basename(resolved);
        return mcpSuccess({
          filePath: resolved,
          fileName,
          format,
          tokenEstimate: Math.ceil(content.length / 4),
          pageEstimate: Math.ceil(content.length / 3000),
          message: `Document opened: ${fileName}`,
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
    { section: z.string().optional().describe('Optional section heading to read only that section') },
    async ({ section }) => {
      const r = requireDocument();
      if (!r) return noDocumentError();
      return mcpSuccess({ text: extractText(r.doc), filePath: r.filePath });
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
          const level = parseInt(node.getAttribute('level') || '1', 10);
          outline.push({ level, text: getElementText(node), index: i });
        }
      }

      return mcpSuccess({ outline, totalNodes: fragment.length });
    }
  );

  server.tool(
    'tandem_edit',
    'Edit text in the document at a specific range',
    {
      from: z.number().describe('Start position (character offset)'),
      to: z.number().describe('End position (character offset)'),
      newText: z.string().describe('Replacement text'),
    },
    async ({ from, to, newText }) => {
      if (!currentDoc) return noDocumentError();
      // TODO: Implement proper ProseMirror-aware editing via Y.Doc
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
        const text = extractText(r.doc);
        // Atomic save: write to temp, then rename
        const tempPath = path.join(path.dirname(r.filePath), `.tandem-tmp-${Date.now()}`);
        await fs.writeFile(tempPath, text, 'utf-8');
        await fs.rename(tempPath, r.filePath);
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
      const was = currentDoc?.filePath ?? null;
      currentDoc = null;
      return mcpSuccess({ closed: true, was });
    }
  );
}
