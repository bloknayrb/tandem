import { execSync } from 'child_process';
import { startMcpServer } from './mcp/server.js';
import { startHocuspocus } from './yjs/provider.js';
import { DEFAULT_WS_PORT } from '../shared/constants.js';

// stdout is exclusively reserved for the MCP JSON-RPC wire protocol.
// Redirect any console.log calls (from Hocuspocus or other libs) to stderr.
// eslint-disable-next-line no-console
console.log = console.error;

const port = parseInt(process.env.TANDEM_PORT || String(DEFAULT_WS_PORT), 10);

/** Kill any process currently listening on the given TCP port (Windows). */
function freePort(p: number): void {
  try {
    const out = execSync(
      `netstat -ano | findstr ":${p}.*LISTENING"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const pid = out.trim().split(/\s+/).at(-1);
    if (pid && /^\d+$/.test(pid)) {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      console.error(`[Tandem] Killed stale PID ${pid} holding port ${p}`);
    }
  } catch {
    // Nothing listening or kill failed — proceed anyway
  }
}

// Swallow all uncaught exceptions to keep the server alive during stale browser reconnects.
// Hocuspocus throws on malformed WebSocket frames; we log but never exit.
process.on('uncaughtException', (err: Error) => {
  console.error('[Tandem] uncaughtException (swallowed):', err.name, err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Tandem] unhandledRejection (swallowed):', reason);
});

async function main() {
  console.error('[Tandem] Starting server...');

  // Start Hocuspocus in the background so MCP can respond to initialize immediately.
  // Claude Code sends MCP initialize right after spawn — if we delay, the client times out.
  (async () => {
    freePort(port);
    // Give the OS a moment to release the port after killing a stale process
    await new Promise(r => setTimeout(r, 300));
    await startHocuspocus(port);
    console.error(`[Tandem] Hocuspocus WebSocket server running on ws://localhost:${port}`);
  })().catch((err) => {
    console.error('[Tandem] Hocuspocus startup error:', err);
  });

  // Start MCP server on stdio immediately (blocks — stdin/stdout used for MCP protocol)
  await startMcpServer();
  console.error('[Tandem] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[Tandem] Fatal error:', err);
  process.exit(1);
});
