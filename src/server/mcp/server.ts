import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { registerDocumentTools } from './document.js';
import { registerAnnotationTools } from './annotations.js';
import { registerNavigationTools } from './navigation.js';
import { registerAwarenessTools } from './awareness.js';

/** Create an McpServer with all tool groups registered (no transport). */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'tandem',
    version: '0.1.0',
  });

  registerDocumentTools(server);
  registerAnnotationTools(server);
  registerNavigationTools(server);
  registerAwarenessTools(server);

  return server;
}

/** Start the MCP server on stdio (legacy, used as fallback via TANDEM_TRANSPORT=stdio). */
export async function startMcpServerStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Start the MCP server on HTTP using Streamable HTTP transport. Returns the http.Server for lifecycle management. */
export async function startMcpServerHttp(port: number, host = '127.0.0.1'): Promise<Server> {
  const server = createMcpServer();
  const app = createMcpExpressApp({ host });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const mcpHandler = async (req: any, res: any) => {
    await transport.handleRequest(req, res, req.body);
  };
  app.post('/mcp', mcpHandler);
  app.get('/mcp', mcpHandler);
  app.delete('/mcp', mcpHandler);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', transport: 'http' });
  });

  await server.connect(transport);

  return new Promise<Server>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      httpServer.on('error', (err) => console.error('[Tandem] HTTP server error:', err));
      console.error(`[Tandem] MCP HTTP server on http://${host}:${port}/mcp`);
      resolve(httpServer);
    });
    httpServer.on('error', reject);
  });
}
