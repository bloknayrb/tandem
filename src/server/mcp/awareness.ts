import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getOrCreateDocument } from '../yjs/provider.js';
import { getCurrentDoc, extractText } from './document.js';
import { collectAnnotations } from './annotations.js';
import { mcpSuccess, noDocumentError } from './response.js';
import type { Annotation } from '../../shared/types.js';

// Track which annotation IDs have been surfaced to Claude via checkInbox
const surfacedIds = new Set<string>();

/** Reset surfaced IDs (exported for testing) */
export function resetInbox(): void {
  surfacedIds.clear();
}

export function registerAwarenessTools(server: McpServer): void {
  server.tool(
    'tandem_getSelections',
    'Get text currently selected by the user in the editor',
    {
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ documentId }) => {
      const current = getCurrentDoc(documentId);
      if (!current) return noDocumentError();

      const doc = getOrCreateDocument(current.docName);
      const userAwareness = doc.getMap('userAwareness');
      const selection = userAwareness.get('selection') as { from: number; to: number; timestamp: number } | undefined;

      if (!selection || selection.from === selection.to) {
        return mcpSuccess({ selections: [], message: 'No text selected' });
      }

      return mcpSuccess({
        selections: [{ from: selection.from, to: selection.to }],
        timestamp: selection.timestamp,
      });
    }
  );

  server.tool(
    'tandem_getActivity',
    'Check if the user is actively editing and where their cursor is',
    {
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ documentId }) => {
      const current = getCurrentDoc(documentId);
      if (!current) return noDocumentError();

      const doc = getOrCreateDocument(current.docName);
      const userAwareness = doc.getMap('userAwareness');
      const activity = userAwareness.get('activity') as {
        isTyping: boolean;
        cursor: number;
        lastEdit: number;
      } | undefined;

      if (!activity) {
        return mcpSuccess({ active: false, cursor: null, lastEdit: null, message: 'No activity detected' });
      }

      // Consider user active if last edit was within 10 seconds
      const isActive = activity.isTyping || (Date.now() - activity.lastEdit < 10000);

      return mcpSuccess({
        active: isActive,
        isTyping: activity.isTyping,
        cursor: activity.cursor,
        lastEdit: activity.lastEdit,
      });
    }
  );

  server.tool(
    'tandem_checkInbox',
    'Check for user actions you haven\'t seen yet — new highlights, comments, questions, and responses to your annotations. Call this after completing any task, between steps, and whenever you pause. Low token cost.',
    {
      documentId: z.string().optional().describe('Target document ID (defaults to active document)'),
    },
    async ({ documentId }) => {
      const current = getCurrentDoc(documentId);
      if (!current) return noDocumentError();

      const doc = getOrCreateDocument(current.docName);
      const annotationsMap = doc.getMap('annotations');
      const allAnnotations = collectAnnotations(annotationsMap);
      const fullText = extractText(doc);

      // Bucket 1: new user-created annotations (highlights, comments, questions)
      const userActions: Array<Annotation & { textSnippet: string }> = [];
      // Bucket 2: user responses to Claude's annotations (accepted/dismissed)
      const userResponses: Array<Annotation & { textSnippet: string }> = [];

      for (const ann of allAnnotations) {
        if (surfacedIds.has(ann.id)) continue;

        const snippet = safeSlice(fullText, ann.range.from, ann.range.to);

        if (ann.author === 'user') {
          userActions.push({ ...ann, textSnippet: snippet });
          surfacedIds.add(ann.id);
        } else if (ann.author === 'claude' && ann.status !== 'pending') {
          userResponses.push({ ...ann, textSnippet: snippet });
          surfacedIds.add(ann.id);
        }
      }

      // Current user activity
      const userAwareness = doc.getMap('userAwareness');
      const selection = userAwareness.get('selection') as { from: number; to: number; timestamp: number } | undefined;
      const activity = userAwareness.get('activity') as {
        isTyping: boolean;
        cursor: number;
        lastEdit: number;
      } | undefined;

      const hasSelection = selection && selection.from !== selection.to;
      const selectedText = hasSelection
        ? safeSlice(fullText, selection!.from, selection!.to)
        : null;

      // Build summary
      const parts: string[] = [];
      if (userActions.length > 0) {
        const typeCounts: Record<string, number> = {};
        for (const a of userActions) {
          typeCounts[a.type] = (typeCounts[a.type] || 0) + 1;
        }
        const typeList = Object.entries(typeCounts)
          .map(([t, n]) => `${n} ${t}${n > 1 ? 's' : ''}`)
          .join(', ');
        parts.push(`${userActions.length} new: ${typeList}`);
      }
      if (userResponses.length > 0) {
        const statusCounts: Record<string, number> = {};
        for (const r of userResponses) {
          statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
        }
        const statusList = Object.entries(statusCounts)
          .map(([s, n]) => `${n} ${s}`)
          .join(', ');
        parts.push(statusList);
      }
      const summary = parts.length > 0 ? parts.join('. ') + '.' : 'No new actions.';

      const hasNew = userActions.length > 0 || userResponses.length > 0;

      return mcpSuccess({
        summary,
        hasNew,
        userActions,
        userResponses,
        activity: {
          isTyping: activity?.isTyping ?? false,
          cursor: activity?.cursor ?? null,
          lastEdit: activity?.lastEdit ?? null,
          selectedText,
        },
      });
    }
  );
}

function safeSlice(text: string, from: number, to: number): string {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  const snippet = text.slice(start, end);
  return snippet.length > 100 ? snippet.slice(0, 97) + '...' : snippet;
}
