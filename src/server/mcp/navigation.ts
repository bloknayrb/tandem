import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getOrCreateDocument } from '../yjs/provider.js';
import { getCurrentDoc, extractText } from './document.js';

/** Get full text from the current document's Y.Doc */
function getFullText(docName: string): string {
  const doc = getOrCreateDocument(docName);
  return extractText(doc);
}

export function registerNavigationTools(server: McpServer): void {
  server.tool(
    'tandem_search',
    'Search for text in the document. Returns matching positions.',
    {
      query: z.string().describe('Search query (supports regex)'),
      regex: z.boolean().optional().describe('Treat query as regex'),
    },
    async ({ query, regex }) => {
      const current = getCurrentDoc();
      if (!current) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }

      const fullText = getFullText(current.docName);
      const matches: Array<{ from: number; to: number; text: string }> = [];

      try {
        const pattern = regex ? new RegExp(query, 'gi') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        let match;
        while ((match = pattern.exec(fullText)) !== null) {
          matches.push({
            from: match.index,
            to: match.index + match[0].length,
            text: match[0],
          });
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'FORMAT_ERROR',
            message: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`
          }) }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false, data: { matches, count: matches.length }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_resolveRange',
    'Find text and return a valid range. Safer than raw character offsets under concurrent editing.',
    {
      pattern: z.string().describe('Text to find'),
      occurrence: z.number().optional().describe('Which occurrence (1-based, default 1)'),
    },
    async ({ pattern, occurrence = 1 }) => {
      const current = getCurrentDoc();
      if (!current) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }

      const fullText = getFullText(current.docName);
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'g');

      let match;
      let count = 0;
      while ((match = regex.exec(fullText)) !== null) {
        count++;
        if (count === occurrence) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: false,
              data: { from: match.index, to: match.index + match[0].length, text: match[0] }
            }) }],
          };
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: true, code: 'INVALID_RANGE',
          message: `Text "${pattern}" not found (occurrence ${occurrence}, found ${count} total)`
        }) }],
      };
    }
  );

  server.tool(
    'tandem_setStatus',
    'Update Claude status text shown to user (e.g., "Reviewing cost figures...")',
    {
      text: z.string().describe('Status text'),
    },
    async ({ text }) => {
      // TODO: Update Yjs awareness state so browser sees the status change
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false, data: { status: text }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_getContext',
    'Read content around a range without pulling the full document. Reduces token usage.',
    {
      from: z.number().describe('Start position'),
      to: z.number().describe('End position'),
      windowSize: z.number().optional().describe('Characters of context before/after (default 500)'),
    },
    async ({ from, to, windowSize = 500 }) => {
      const current = getCurrentDoc();
      if (!current) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: true, code: 'NO_DOCUMENT', message: 'No document is open.'
          }) }],
        };
      }

      const fullText = getFullText(current.docName);
      const contextStart = Math.max(0, from - windowSize);
      const contextEnd = Math.min(fullText.length, to + windowSize);
      const context = fullText.slice(contextStart, contextEnd);
      const selection = fullText.slice(from, to);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false,
          data: {
            context,
            selection,
            contextRange: { from: contextStart, to: contextEnd },
            selectionRange: { from, to },
          }
        }) }],
      };
    }
  );
}
