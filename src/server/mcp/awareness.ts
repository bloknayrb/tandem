import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getOrCreateDocument } from '../yjs/provider.js';
import { getCurrentDoc } from './document.js';
import { mcpSuccess, noDocumentError } from './response.js';

export function registerAwarenessTools(server: McpServer): void {
  server.tool(
    'tandem_getSelections',
    'Get text currently selected by the user in the editor',
    {},
    async () => {
      const current = getCurrentDoc();
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
    {},
    async () => {
      const current = getCurrentDoc();
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
}
