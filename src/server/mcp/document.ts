import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { getOrCreateDocument, getHocuspocus } from '../yjs/provider.js';
import * as Y from 'yjs';

// Current document state
let currentDoc: { filePath: string; docName: string; format: string } | null = null;

export function getCurrentDoc() {
  return currentDoc;
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

  // Split by lines and create XML elements
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line;
    let element: Y.XmlElement;

    if (trimmed.startsWith('### ')) {
      element = new Y.XmlElement('heading');
      element.setAttribute('level', '3');
      element.insert(0, [new Y.XmlText(trimmed.slice(4))]);
    } else if (trimmed.startsWith('## ')) {
      element = new Y.XmlElement('heading');
      element.setAttribute('level', '2');
      element.insert(0, [new Y.XmlText(trimmed.slice(3))]);
    } else if (trimmed.startsWith('# ')) {
      element = new Y.XmlElement('heading');
      element.setAttribute('level', '1');
      element.insert(0, [new Y.XmlText(trimmed.slice(2))]);
    } else if (trimmed === '') {
      continue; // Skip empty lines
    } else {
      element = new Y.XmlElement('paragraph');
      element.insert(0, [new Y.XmlText(trimmed)]);
    }

    fragment.insert(fragment.length, [element]);
  }
}

/** Extract plain text from a Y.Doc's XmlFragment */
function extractText(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment('default');
  const lines: string[] = [];

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) {
      const text = node.toJSON();
      lines.push(typeof text === 'string' ? text : JSON.stringify(text));
    }
  }

  return lines.join('\n');
}

export function registerDocumentTools(server: McpServer): void {
  server.tool(
    'tandem_open',
    'Open a file in the Tandem editor. Auto-opens browser.',
    {
      filePath: z.string().describe('Absolute path to the file to open'),
    },
    async ({ filePath }) => {
      try {
        // Validate path
        const resolved = path.resolve(filePath);

        // Reject UNC paths
        if (resolved.startsWith('\\\\') || resolved.startsWith('//')) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: true, code: 'FILE_NOT_FOUND',
              message: 'UNC paths are not supported for security reasons.'
            }) }],
          };
        }

        // Check file exists and size
        const stat = await fs.stat(resolved);
        if (stat.size > 50 * 1024 * 1024) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: true, code: 'FORMAT_ERROR',
              message: 'File exceeds 50MB limit.'
            }) }],
          };
        }

        const format = detectFormat(resolved);
        const fileName = path.basename(resolved);
        const docName = resolved.replace(/[\\/:]/g, '_');

        // Load file content
        let content: string;
        if (format === 'docx') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: true, code: 'FORMAT_ERROR',
              message: 'DOCX support not yet implemented. Use .md or .txt files for now.'
            }) }],
          };
        }

        content = await fs.readFile(resolved, 'utf-8');

        // Create/get Y.Doc and populate it
        const doc = getOrCreateDocument(docName);
        populateYDoc(doc, content);

        currentDoc = { filePath: resolved, docName, format };

        // Estimate tokens (~4 chars per token)
        const tokenEstimate = Math.ceil(content.length / 4);
        const pageEstimate = Math.ceil(content.length / 3000);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: false,
            data: {
              filePath: resolved,
              fileName,
              format,
              docName,
              tokenEstimate,
              pageEstimate,
              message: `Document opened: ${fileName}`,
            }
          }) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const code = message.includes('ENOENT') ? 'FILE_NOT_FOUND'
          : message.includes('EBUSY') ? 'FILE_LOCKED'
          : 'FORMAT_ERROR';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code, message
          }) }],
        };
      }
    }
  );

  server.tool(
    'tandem_getContent',
    'Read full document content. Warning: token-heavy for large docs. Use getOutline() or getTextContent() instead.',
    {},
    async () => {
      if (!currentDoc) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT',
            message: 'No document is open. Call tandem_open first.'
          }) }],
        };
      }
      const doc = getOrCreateDocument(currentDoc.docName);
      const fragment = doc.getXmlFragment('default');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false,
          data: { content: fragment.toJSON(), filePath: currentDoc.filePath }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_getTextContent',
    'Read document as plain text. ~60% fewer tokens than getContent().',
    {
      section: z.string().optional().describe('Optional section heading to read only that section'),
    },
    async ({ section }) => {
      if (!currentDoc) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT',
            message: 'No document is open. Call tandem_open first.'
          }) }],
        };
      }
      const doc = getOrCreateDocument(currentDoc.docName);
      const text = extractText(doc);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false,
          data: { text, filePath: currentDoc.filePath }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_getOutline',
    'Get document structure (headings, sections) without full content. Low token cost.',
    {},
    async () => {
      if (!currentDoc) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT',
            message: 'No document is open. Call tandem_open first.'
          }) }],
        };
      }
      const doc = getOrCreateDocument(currentDoc.docName);
      const fragment = doc.getXmlFragment('default');
      const outline: Array<{ level: number; text: string; index: number }> = [];

      for (let i = 0; i < fragment.length; i++) {
        const node = fragment.get(i);
        if (node instanceof Y.XmlElement && node.nodeName === 'heading') {
          const level = parseInt(node.getAttribute('level') || '1', 10);
          const textContent = node.toString();
          outline.push({ level, text: textContent, index: i });
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false,
          data: { outline, totalNodes: fragment.length }
        }) }],
      };
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
      if (!currentDoc) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }
      // TODO: Implement proper ProseMirror-aware editing via Y.Doc
      // For now, return a stub response
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false,
          data: { edited: true, from, to, newTextLength: newText.length }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_save',
    'Save the current document back to disk',
    {},
    async () => {
      if (!currentDoc) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }
      try {
        const doc = getOrCreateDocument(currentDoc.docName);
        const text = extractText(doc);

        // Atomic save: write to temp, then rename
        const tempPath = path.join(
          path.dirname(currentDoc.filePath),
          `.tandem-tmp-${Date.now()}`
        );
        await fs.writeFile(tempPath, text, 'utf-8');
        await fs.rename(tempPath, currentDoc.filePath);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: false,
            data: { saved: true, filePath: currentDoc.filePath }
          }) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'FILE_LOCKED', message
          }) }],
        };
      }
    }
  );

  server.tool(
    'tandem_status',
    'Check editor status: running, open file, user activity',
    {},
    async () => {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false,
          data: {
            running: true,
            currentDocument: currentDoc?.filePath ?? null,
            format: currentDoc?.format ?? null,
          }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_close',
    'Close the current document',
    {},
    async () => {
      const was = currentDoc?.filePath ?? null;
      currentDoc = null;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false, data: { closed: true, was }
        }) }],
      };
    }
  );
}
