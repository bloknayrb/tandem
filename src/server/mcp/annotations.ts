import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getOrCreateDocument } from '../yjs/provider.js';
import { getCurrentDoc, extractText } from './document.js';
import { mcpSuccess, mcpError, noDocumentError } from './response.js';
import { exportAnnotations } from '../file-io/docx.js';
import * as Y from 'yjs';
import type { Annotation, AnnotationType, HighlightColor } from '../../shared/types.js';

/** Get the annotations Y.Map on the target document, or null if no doc is open */
function getAnnotationsMap(documentId?: string): Y.Map<unknown> | null {
  const doc = getCurrentDoc(documentId);
  if (!doc) return null;
  const ydoc = getOrCreateDocument(doc.docName);
  return ydoc.getMap('annotations');
}

import { generateAnnotationId as generateId } from '../../shared/utils.js';
export { generateId };

/** Create an annotation and store it in the Y.Map. Returns the annotation ID. */
export function createAnnotation(
  map: Y.Map<unknown>,
  type: AnnotationType,
  from: number,
  to: number,
  content: string,
  extras?: Partial<Annotation>,
): string {
  const id = generateId();
  const annotation: Annotation = {
    id,
    author: 'claude',
    type,
    range: { from, to },
    content,
    status: 'pending',
    timestamp: Date.now(),
    ...extras,
  };
  map.set(id, annotation);
  return id;
}

/** Collect all annotations from the Y.Map as an array */
export function collectAnnotations(map: Y.Map<unknown>): Annotation[] {
  const result: Annotation[] = [];
  map.forEach((value) => result.push(value as Annotation));
  return result;
}

export function registerAnnotationTools(server: McpServer): void {
  server.tool(
    'tandem_highlight',
    'Highlight text with a color and optional note',
    {
      from: z.number().describe('Start position'),
      to: z.number().describe('End position'),
      color: z.enum(['yellow', 'red', 'green', 'blue', 'purple']).describe('Highlight color'),
      note: z.string().optional().describe('Optional note for the highlight'),
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ from, to, color, note, documentId }) => {
      const map = getAnnotationsMap(documentId);
      if (!map) return noDocumentError();
      const id = createAnnotation(map, 'highlight', from, to, note || '', { color: color as HighlightColor });
      return mcpSuccess({ annotationId: id });
    }
  );

  server.tool(
    'tandem_comment',
    'Add a comment to a text range',
    {
      from: z.number().describe('Start position'),
      to: z.number().describe('End position'),
      text: z.string().describe('Comment text'),
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ from, to, text, documentId }) => {
      const map = getAnnotationsMap(documentId);
      if (!map) return noDocumentError();
      const id = createAnnotation(map, 'comment', from, to, text);
      return mcpSuccess({ annotationId: id });
    }
  );

  server.tool(
    'tandem_suggest',
    'Propose a text replacement (tracked change style)',
    {
      from: z.number().describe('Start position'),
      to: z.number().describe('End position'),
      newText: z.string().describe('Suggested replacement text'),
      reason: z.string().optional().describe('Reason for the suggestion'),
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ from, to, newText, reason, documentId }) => {
      const map = getAnnotationsMap(documentId);
      if (!map) return noDocumentError();
      const id = createAnnotation(map, 'suggestion', from, to, JSON.stringify({ newText, reason: reason || '' }));
      return mcpSuccess({ annotationId: id });
    }
  );

  server.tool(
    'tandem_flag',
    'Flag a text range for attention (e.g., issues, concerns, or items needing review)',
    {
      from: z.number().describe('Start position'),
      to: z.number().describe('End position'),
      note: z.string().optional().describe('Reason for flagging'),
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ from, to, note, documentId }) => {
      const map = getAnnotationsMap(documentId);
      if (!map) return noDocumentError();
      const id = createAnnotation(map, 'flag', from, to, note || '');
      return mcpSuccess({ annotationId: id });
    }
  );

  server.tool(
    'tandem_getAnnotations',
    'Read all annotations, optionally filtered by author/type/status. For checking new user actions, prefer tandem_checkInbox.',
    {
      author: z.enum(['user', 'claude']).optional().describe('Filter by author'),
      type: z.enum(['highlight', 'comment', 'suggestion', 'overlay', 'question', 'flag']).optional().describe('Filter by type'),
      status: z.enum(['pending', 'accepted', 'dismissed']).optional().describe('Filter by status'),
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ author, type, status, documentId }) => {
      const map = getAnnotationsMap(documentId);
      if (!map) return noDocumentError();

      let results = collectAnnotations(map);
      if (author) results = results.filter(a => a.author === author);
      if (type) results = results.filter(a => a.type === type);
      if (status) results = results.filter(a => a.status === status);

      return mcpSuccess({ annotations: results, count: results.length });
    }
  );

  server.tool(
    'tandem_resolveAnnotation',
    'Accept or dismiss an annotation',
    {
      id: z.string().describe('Annotation ID'),
      action: z.enum(['accept', 'dismiss']).describe('Action to take'),
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ id, action, documentId }) => {
      const map = getAnnotationsMap(documentId);
      if (!map) return noDocumentError();

      const ann = map.get(id) as Annotation | undefined;
      if (!ann) return mcpError('INVALID_RANGE', `Annotation ${id} not found`);

      const updated = { ...ann, status: action === 'accept' ? 'accepted' as const : 'dismissed' as const };
      map.set(id, updated);
      return mcpSuccess({ id, status: updated.status });
    }
  );

  server.tool(
    'tandem_removeAnnotation',
    'Remove an annotation entirely',
    {
      id: z.string().describe('Annotation ID'),
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ id, documentId }) => {
      const map = getAnnotationsMap(documentId);
      if (!map) return noDocumentError();
      if (!map.has(id)) return mcpError('INVALID_RANGE', `Annotation ${id} not found`);
      map.delete(id);
      return mcpSuccess({ removed: true, id });
    }
  );

  server.tool(
    'tandem_exportAnnotations',
    'Export all annotations as a formatted summary. Useful for review reports, especially on read-only .docx files.',
    {
      format: z.enum(['markdown', 'json']).optional().describe('Output format (default: markdown)'),
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ format, documentId }) => {
      const docInfo = getCurrentDoc(documentId);
      if (!docInfo) return noDocumentError();

      const map = getAnnotationsMap(documentId);
      if (!map) return noDocumentError();

      const annotations = collectAnnotations(map);
      const ydoc = getOrCreateDocument(docInfo.docName);

      if (format === 'json') {
        const fullText = extractText(ydoc);
        const enriched = annotations.map((ann) => ({
          ...ann,
          textSnippet: fullText.slice(
            Math.max(0, ann.range.from),
            Math.min(fullText.length, ann.range.to),
          ),
        }));
        return mcpSuccess({ annotations: enriched, count: enriched.length });
      }

      const markdown = exportAnnotations(ydoc, annotations);
      return mcpSuccess({ markdown, count: annotations.length });
    }
  );
}
