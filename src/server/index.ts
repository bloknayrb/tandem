import type { Server } from "http";
import { execSync } from "child_process";
import { startMcpServerStdio, startMcpServerHttp, closeMcpSession } from "./mcp/server.js";
import { startHocuspocus } from "./yjs/provider.js";
import { DEFAULT_WS_PORT, DEFAULT_MCP_PORT } from "../shared/constants.js";
import { cleanupSessions, stopAutoSave } from "./session/manager.js";
import { saveCurrentSession, restoreCtrlSession } from "./mcp/document.js";

// stdout is exclusively reserved for the MCP JSON-RPC wire protocol (stdio mode).
// Redirect any console.log calls (from Hocuspocus or other libs) to stderr.
// In HTTP mode this is defense-in-depth; in stdio mode it's critical.

console.log = console.error;
console.warn = console.error;
console.info = console.error;

const transportMode = (process.env.TANDEM_TRANSPORT || "http").toLowerCase();
const wsPort = parseInt(process.env.TANDEM_PORT || String(DEFAULT_WS_PORT), 10);
const mcpPort = parseInt(process.env.TANDEM_MCP_PORT || String(DEFAULT_MCP_PORT), 10);

let httpServer: Server | null = null;

/** Kill any process currently listening on the given TCP port (Windows). */
function freePort(p: number): void {
  try {
    const out = execSync(`netstat -ano | findstr ":${p}.*LISTENING"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pid = out.trim().split(/\s+/).at(-1);
    if (pid && /^\d+$/.test(pid)) {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      console.error(`[Tandem] Killed stale PID ${pid} holding port ${p}`);
    }
  } catch {
    // Nothing listening or kill failed — proceed anyway
  }
}

// Swallow all uncaught exceptions to keep the server alive during stale browser reconnects.
// Hocuspocus throws on malformed WebSocket frames; we log but never exit.
process.on("uncaughtException", (err: Error) => {
  console.error("[Tandem] uncaughtException (swallowed):", err.name, err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Tandem] unhandledRejection (swallowed):", reason);
});
process.on("exit", (code) => {
  console.error(`[Tandem] Process exiting with code ${code}`);
});

if (transportMode === "stdio") {
  process.stdin.on("end", () => {
    console.error("[Tandem] stdin ended (MCP transport closed)");
  });
}

// Graceful shutdown: save session + stop auto-save before exit
async function shutdown(signal: string) {
  console.error(`[Tandem] ${signal} received, saving session...`);
  try {
    await saveCurrentSession();
    stopAutoSave();
  } catch (err) {
    console.error("[Tandem] Session save on shutdown failed:", err);
  }
  await closeMcpSession();
  if (httpServer) {
    httpServer.close();
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  console.error(`[Tandem] Starting server (transport: ${transportMode})...`);

  // Clean up sessions older than 30 days
  cleanupSessions()
    .then((n) => {
      if (n > 0) console.error(`[Tandem] Cleaned up ${n} stale session(s)`);
    })
    .catch(() => {});

  // Restore chat history from previous session (must complete before Hocuspocus
  // starts so browsers never see stale openDocuments from the previous session)
  await restoreCtrlSession().catch((err) => {
    console.error("[Tandem] Failed to restore chat history:", err);
  });

  if (transportMode === "http") {
    // HTTP mode: no startup-order constraint — start both concurrently
    freePort(wsPort);
    freePort(mcpPort);
    // Give the OS a moment to release the ports after killing stale processes
    await new Promise((r) => setTimeout(r, 300));

    const [srv] = await Promise.all([
      startMcpServerHttp(mcpPort),
      startHocuspocus(wsPort).then(() => {
        console.error(`[Tandem] Hocuspocus WebSocket server running on ws://localhost:${wsPort}`);
      }),
    ]);
    httpServer = srv;
  } else {
    // Stdio mode: MCP must start before Hocuspocus to beat Claude Code's init timeout
    (async () => {
      freePort(wsPort);
      await new Promise((r) => setTimeout(r, 300));
      await startHocuspocus(wsPort);
      console.error(`[Tandem] Hocuspocus WebSocket server running on ws://localhost:${wsPort}`);
    })().catch((err) => {
      console.error("[Tandem] Hocuspocus startup error:", err);
    });

    await startMcpServerStdio();
    console.error("[Tandem] MCP server running on stdio");
  }
}

main().catch((err) => {
  console.error("[Tandem] Fatal error:", err);
  process.exit(1);
});
