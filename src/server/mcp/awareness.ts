import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerAwarenessTools(server: McpServer): void {
  server.tool(
    'tandem_getSelections',
    'Get text currently selected by the user in the editor',
    {},
    async () => {
      // TODO: Read from Yjs awareness protocol
      // The browser client updates awareness with selection state
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false,
          data: { selections: [], message: 'Awareness integration pending' }
        }) }],
      };
    }
  );

  server.tool(
    'tandem_getActivity',
    'Check if the user is actively editing and where their cursor is',
    {},
    async () => {
      // TODO: Read from Yjs awareness protocol
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: false,
          data: {
            active: false,
            cursor: null,
            lastEdit: null,
            message: 'Awareness integration pending',
          }
        }) }],
      };
    }
  );
}
