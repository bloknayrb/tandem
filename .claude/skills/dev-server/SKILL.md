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
- `freePort()` does NOT cover :5173 — an orphaned Vite from a killed `dev:standalone` survives, and because `vite.config.ts` sets `strictPort: true` the new Vite **exits with an error** rather than falling back to another port. The symptom is a dev server that won't start, not a silently-wrong URL (see step 2)
- E2E tests (`npm run test:e2e`) will also kill dev servers on those ports

## Steps

0. Run the doctor first — it diagnoses Node version, .mcp.json, server health, and ports before anything else:
   ```bash
   npm run doctor
   ```
   If you pulled since the last dev-server run, also refresh dependencies (they drift):
   ```bash
   npm install
   ```

1. Check if servers are already running:
   ```bash
   curl -s http://127.0.0.1:3479/health 2>/dev/null && echo "Server already running" || echo "Server not running"
   ```

2. If the server is NOT running but something still holds :5173, it's an orphaned Vite from a previous `dev:standalone`. Kill it first — `strictPort: true` means the new Vite will otherwise fail to start with `Port 5173 is already in use` instead of picking another port.

   Windows (git-bash) — note the PID in the last column:
   ```bash
   netstat -ano | grep ":5173" | grep LISTENING
   taskkill //PID <pid> //F
   ```

   macOS/Linux:
   ```bash
   lsof -ti tcp:5173 | xargs -r kill
   ```

3. If not running, start the standalone dev environment (server + client):
   ```bash
   npm run dev:standalone
   ```
   This starts:
   - Hocuspocus WebSocket server on `:3478`
   - MCP HTTP server on `:3479`
   - Vite dev server on `:5173`

4. Wait for both servers to be ready:
   ```bash
   # Wait for MCP health endpoint
   for i in {1..15}; do curl -sf http://127.0.0.1:3479/health && break || sleep 1; done
   ```

5. Verify MCP connection works by running `/mcp` in Claude Code if needed.

6. Open the editor at `http://127.0.0.1:5173` in the browser.

## Restarting After Server Code Changes
If you changed server code, restart just the server:
1. Stop the running `dev:standalone` process
2. Run `npm run dev:standalone` again
3. Run `/mcp` in Claude Code to reconnect
