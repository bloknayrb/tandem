import { startMcpServer } from './mcp/server.js';
import { startHocuspocus } from './yjs/provider.js';
import { DEFAULT_WS_PORT } from '../shared/constants.js';

const port = parseInt(process.env.TANDEM_PORT || String(DEFAULT_WS_PORT), 10);

async function main() {
  console.error('[Tandem] Starting server...');

  // Start Hocuspocus WebSocket server
  await startHocuspocus(port);
  console.error(`[Tandem] Hocuspocus WebSocket server running on ws://localhost:${port}`);

  // Start MCP server on stdio (blocks — stdin/stdout used for MCP protocol)
  await startMcpServer();
  console.error('[Tandem] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[Tandem] Fatal error:', err);
  process.exit(1);
});
