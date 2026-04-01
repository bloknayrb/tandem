---
name: dev-server
description: Start Tandem dev environment (server + client) and verify MCP connection
disable-model-invocation: true
---

# Start Tandem Dev Environment

Start the Tandem development servers and verify everything is connected.

## Important Gotchas
- The server MUST be running before Claude Code connects via MCP
- `freePort()` kills any existing process on :3478/:3479 at startup — you cannot run two instances
- E2E tests (`npm run test:e2e`) will also kill dev servers on those ports

## Steps

1. Check if servers are already running:
   ```bash
   curl -s http://127.0.0.1:3479/health 2>/dev/null && echo "Server already running" || echo "Server not running"
   ```

2. If not running, start the standalone dev environment (server + client):
   ```bash
   npm run dev:standalone
   ```
   This starts:
   - Hocuspocus WebSocket server on `:3478`
   - MCP HTTP server on `:3479`
   - Vite dev server on `:5173`

3. Wait for both servers to be ready:
   ```bash
   # Wait for MCP health endpoint
   for i in {1..15}; do curl -sf http://127.0.0.1:3479/health && break || sleep 1; done
   ```

4. Verify MCP connection works by running `/mcp` in Claude Code if needed.

5. Open the editor at `http://localhost:5173` in the browser.

## Restarting After Server Code Changes
If you changed server code, restart just the server:
1. Stop the running `dev:standalone` process
2. Run `npm run dev:standalone` again
3. Run `/mcp` in Claude Code to reconnect
