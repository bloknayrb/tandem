import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerDocumentTools } from './document.js';
import { registerAnnotationTools } from './annotations.js';
import { registerNavigationTools } from './navigation.js';
import { registerAwarenessTools } from './awareness.js';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'tandem',
    version: '0.1.0',
  });

  // Register all tool groups
  registerDocumentTools(server);
  registerAnnotationTools(server);
  registerNavigationTools(server);
  registerAwarenessTools(server);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
