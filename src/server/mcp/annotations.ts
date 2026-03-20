import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getOrCreateDocument } from '../yjs/provider.js';
import { getCurrentDoc } from './document.js';
import * as Y from 'yjs';
import type { Annotation, HighlightColor } from '../../shared/types.js';

/** Get or create the annotations Y.Map on the current document */
function getAnnotationsMap(): Y.Map<unknown> | null {
  const doc = getCurrentDoc();
  if (!doc) return null;
  const ydoc = getOrCreateDocument(doc.docName);
  return ydoc.getMap('annotations');
}

function generateId(): string {
  return `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    },
    async ({ from, to, color, note }) => {
      const map = getAnnotationsMap();
      if (!map) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }

      const id = generateId();
      const annotation: Annotation = {
        id,
        author: 'claude',
        type: 'highlight',
        range: { from, to },
        content: note || '',
        status: 'pending',
        timestamp: Date.now(),
        color: color as HighlightColor,
      };
      map.set(id, annotation);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false, data: { annotationId: id }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_comment',
    'Add a comment to a text range',
    {
      from: z.number().describe('Start position'),
      to: z.number().describe('End position'),
      text: z.string().describe('Comment text'),
    },
    async ({ from, to, text }) => {
      const map = getAnnotationsMap();
      if (!map) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }

      const id = generateId();
      const annotation: Annotation = {
        id,
        author: 'claude',
        type: 'comment',
        range: { from, to },
        content: text,
        status: 'pending',
        timestamp: Date.now(),
      };
      map.set(id, annotation);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false, data: { annotationId: id }
        }) }],
      };
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
    },
    async ({ from, to, newText, reason }) => {
      const map = getAnnotationsMap();
      if (!map) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }

      const id = generateId();
      const annotation: Annotation = {
        id,
        author: 'claude',
        type: 'suggestion',
        range: { from, to },
        content: JSON.stringify({ newText, reason: reason || '' }),
        status: 'pending',
        timestamp: Date.now(),
      };
      map.set(id, annotation);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false, data: { annotationId: id }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_getAnnotations',
    'Read all annotations, optionally filtered by author/type/status',
    {
      author: z.enum(['user', 'claude']).optional().describe('Filter by author'),
      type: z.enum(['highlight', 'comment', 'suggestion', 'overlay']).optional().describe('Filter by type'),
      status: z.enum(['pending', 'accepted', 'dismissed']).optional().describe('Filter by status'),
    },
    async ({ author, type, status }) => {
      const map = getAnnotationsMap();
      if (!map) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }

      let results: Annotation[] = [];
      map.forEach((value) => {
        const ann = value as Annotation;
        results.push(ann);
      });

      if (author) results = results.filter(a => a.author === author);
      if (type) results = results.filter(a => a.type === type);
      if (status) results = results.filter(a => a.status === status);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false, data: { annotations: results, count: results.length }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_resolveAnnotation',
    'Accept or dismiss an annotation',
    {
      id: z.string().describe('Annotation ID'),
      action: z.enum(['accept', 'dismiss']).describe('Action to take'),
    },
    async ({ id, action }) => {
      const map = getAnnotationsMap();
      if (!map) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }

      const ann = map.get(id) as Annotation | undefined;
      if (!ann) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'INVALID_RANGE', message: `Annotation ${id} not found`
          }) }],
        };
      }

      const updated = { ...ann, status: action === 'accept' ? 'accepted' : 'dismissed' };
      map.set(id, updated);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false, data: { id, status: updated.status }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_removeAnnotation',
    'Remove an annotation entirely',
    {
      id: z.string().describe('Annotation ID'),
    },
    async ({ id }) => {
      const map = getAnnotationsMap();
      if (!map) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }

      if (!map.has(id)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'INVALID_RANGE', message: `Annotation ${id} not found`
          }) }],
        };
      }

      map.delete(id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false, data: { removed: true, id }
        }) }],
      };
    }
  );
}
