import type { Server } from "http";
import { startMcpServerStdio, startMcpServerHttp, closeMcpSession } from "./mcp/server.js";
import { startHocuspocus } from "./yjs/provider.js";
import { DEFAULT_WS_PORT, DEFAULT_MCP_PORT } from "../shared/constants.js";
import { cleanupSessions, stopAutoSave } from "./session/manager.js";
import { saveCurrentSession, restoreCtrlSession, writeGenerationId } from "./mcp/document.js";
import { freePort } from "./platform.js";
import { isKnownHocuspocusError } from "./error-filter.js";
import {
  attachCtrlObservers,
  reattachObservers,
  reattachCtrlObservers,
  detachObservers,
} from "./events/queue.js";
import { setDocLifecycleCallbacks } from "./yjs/provider.js";
import { CTRL_ROOM } from "../shared/constants.js";

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
let isShuttingDown = false;

// Swallow known Hocuspocus/ws protocol errors but crash on genuine bugs.
function handleFatalError(label: string, value: unknown): void {
  if (value instanceof Error && isKnownHocuspocusError(value)) {
    console.error("[Tandem] Known WS error (swallowed):", value.message, value.stack);
    return;
  }
  if (isShuttingDown) {
    console.error(`[Tandem] ${label} during shutdown (ignored):`, value);
    return;
  }
  if (value instanceof Error) {
    console.error(`[Tandem] ${label} (FATAL):`, value.name, value.message, value.stack);
  } else {
    console.error(`[Tandem] ${label} (FATAL):`, value);
  }
  process.exit(1);
}
process.on("uncaughtException", (err) => handleFatalError("uncaughtException", err));
process.on("unhandledRejection", (reason) => handleFatalError("unhandledRejection", reason));
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
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`[Tandem] ${signal} received, saving session...`);
  try {
    await saveCurrentSession();
    stopAutoSave();
  } catch (err) {
    console.error("[Tandem] Session save on shutdown failed:", err);
  }
  try {
    await closeMcpSession();
  } catch (err) {
    console.error("[Tandem] MCP session close on shutdown failed:", err);
  }
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
    .catch((err) => {
      console.error("[Tandem] Failed to clean up stale sessions:", err);
    });

  // Must complete before Hocuspocus starts to prevent browsers seeing stale openDocuments
  await restoreCtrlSession().catch((err) => {
    console.error("[Tandem] Failed to restore chat history:", err);
  });

  // Write a unique ID so clients can detect when the server process has restarted
  writeGenerationId();

  // Attach event queue observers to CTRL_ROOM for channel push notifications
  attachCtrlObservers();

  // Register doc lifecycle callbacks so the event queue reattaches observers
  // when Hocuspocus swaps Y.Doc instances (avoids circular import).
  setDocLifecycleCallbacks(
    (docName, newDoc) => {
      if (docName === CTRL_ROOM) {
        reattachCtrlObservers();
      } else {
        reattachObservers(docName, newDoc);
      }
    },
    (docName) => {
      detachObservers(docName);
    },
  );

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
