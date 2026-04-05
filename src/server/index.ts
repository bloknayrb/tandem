import type { Server } from "http";
import path from "path";
import { fileURLToPath } from "url";
import {
  startMcpServerStdio,
  startMcpServerHttp,
  closeMcpSession,
  APP_VERSION,
} from "./mcp/server.js";
import { startHocuspocus, setDocLifecycleCallbacks, getOrCreateDocument } from "./yjs/provider.js";
import { DEFAULT_WS_PORT, DEFAULT_MCP_PORT, CTRL_ROOM } from "../shared/constants.js";
import { cleanupSessions, stopAutoSave } from "./session/manager.js";
import {
  saveCurrentSession,
  restoreCtrlSession,
  restoreOpenDocuments,
  writeGenerationId,
} from "./mcp/document.js";
import { freePort, waitForPort, LAST_SEEN_VERSION_FILE } from "./platform.js";
import { checkVersionChange } from "./version-check.js";
import { isKnownHocuspocusError } from "./error-filter.js";
import {
  attachCtrlObservers,
  reattachObservers,
  reattachCtrlObservers,
  detachObservers,
} from "./events/queue.js";
import { getOpenDocs } from "./mcp/document-service.js";
import { openFileByPath } from "./mcp/file-opener.js";
import { docIdFromPath } from "./mcp/document-model.js";
import { injectTutorialAnnotations } from "./mcp/tutorial-annotations.js";

// stdout is exclusively reserved for the MCP JSON-RPC wire protocol (stdio mode).
// Redirect any console.log calls (from Hocuspocus or other libs) to stderr.
// In HTTP mode this is defense-in-depth; in stdio mode it's critical.

// In production (global install, TANDEM_OPEN_BROWSER=1), suppress known noisy
// warnings from dependencies (mammoth, Y.js). In dev mode, show everything.
const isProduction = process.env.TANDEM_OPEN_BROWSER === "1";
const SUPPRESSED_PATTERNS = [/^\[mammoth\]/, /Invalid access/i, /^\s*add yjs type/i];

const originalStderrWrite = process.stderr.write.bind(process.stderr);
if (isProduction) {
  const filteredError = (...args: Parameters<typeof console.error>) => {
    const msg = args.map(String).join(" ");
    if (SUPPRESSED_PATTERNS.some((p) => p.test(msg))) return;
    originalStderrWrite(msg + "\n");
  };
  console.log = filteredError;
  console.warn = filteredError;
  console.info = filteredError;
  console.error = filteredError;
} else {
  console.log = console.error;
  console.warn = console.error;
  console.info = console.error;
}

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
  const previousActiveDocId = await restoreCtrlSession().catch((err) => {
    console.error("[Tandem] Failed to restore chat history:", err);
    return null;
  });

  // Re-open documents from previous session before Hocuspocus starts
  await restoreOpenDocuments(previousActiveDocId).catch((err) => {
    console.error("[Tandem] Failed to restore open documents:", err);
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
    try {
      await Promise.all([waitForPort(wsPort), waitForPort(mcpPort)]);
    } catch (err) {
      console.error(`[Tandem] ${err instanceof Error ? err.message : err} — proceeding anyway`);
    }

    const [srv] = await Promise.all([
      startMcpServerHttp(mcpPort),
      startHocuspocus(wsPort).then(() => {
        console.error(`[Tandem] Hocuspocus WebSocket server running on ws://localhost:${wsPort}`);
      }),
    ]);
    httpServer = srv;

    // Open CHANGELOG.md as active tab on first startup after an update
    try {
      const versionStatus = await checkVersionChange(APP_VERSION, LAST_SEEN_VERSION_FILE);
      if (versionStatus === "upgraded") {
        const changelogPath = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../CHANGELOG.md",
        );
        await openFileByPath(changelogPath);
        console.error(`[Tandem] Opened CHANGELOG.md (upgraded to v${APP_VERSION})`);
      }
    } catch (err) {
      console.error("[Tandem] Version check / changelog open failed (non-fatal):", err);
    }

    // Auto-open sample/welcome.md when no documents are open (fresh install or empty restored session)
    if (getOpenDocs().size === 0 && !process.env.TANDEM_NO_SAMPLE) {
      const samplePath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../sample/welcome.md",
      );
      openFileByPath(samplePath)
        .then(() => {
          const doc = getOrCreateDocument(docIdFromPath(samplePath));
          injectTutorialAnnotations(doc);
        })
        .catch((err) => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            console.error("[Tandem] Sample file not found (skipping):", samplePath);
          } else {
            console.error("[Tandem] Failed to auto-open sample document:", err);
          }
        });
    }

    console.error("");
    console.error(`  Tandem v${APP_VERSION}`);
    console.error("");
    console.error(`  MCP HTTP:    http://localhost:${mcpPort}/mcp`);
    console.error(`  WebSocket:   ws://localhost:${wsPort}`);
    console.error(`  Health:      http://localhost:${mcpPort}/health`);
    console.error("");
    console.error("  Open Claude Code and ask Claude to review a document.");
    console.error("");
  } else {
    // Stdio mode: MCP must start before Hocuspocus to beat Claude Code's init timeout
    (async () => {
      freePort(wsPort);
      try {
        await waitForPort(wsPort);
      } catch (err) {
        console.error(`[Tandem] ${err instanceof Error ? err.message : err} — proceeding anyway`);
      }
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
