import type { Server } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { CTRL_ROOM, DEFAULT_MCP_PORT, DEFAULT_WS_PORT } from "../shared/constants.js";
import { acquireStoreLock, releaseStoreLock } from "./annotations/store.js";
import { isKnownHocuspocusError } from "./error-filter.js";
import {
  attachCtrlObservers,
  detachObservers,
  reattachCtrlObservers,
  reattachObservers,
} from "./events/queue.js";
import { unwatchAll } from "./file-watcher.js";
import {
  restoreCtrlSession,
  restoreOpenDocuments,
  saveCurrentSession,
  writeGenerationId,
} from "./mcp/document.js";
import { docIdFromPath } from "./mcp/document-model.js";
import { docCount } from "./mcp/document-service.js";
import { openFileByPath } from "./mcp/file-opener.js";
import {
  APP_VERSION,
  closeMcpSession,
  startMcpServerHttp,
  startMcpServerStdio,
} from "./mcp/server.js";
import { injectTutorialAnnotations } from "./mcp/tutorial-annotations.js";
import { pushNotification } from "./notifications.js";
import { freePort, LAST_SEEN_VERSION_FILE, waitForPort } from "./platform.js";
import {
  cleanupOrphanedAnnotationFiles,
  cleanupSessions,
  stopAutoSave,
} from "./session/manager.js";
import { checkVersionChange } from "./version-check.js";
import { getOrCreateDocument, setDocLifecycleCallbacks, startHocuspocus } from "./yjs/provider.js";

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
    unwatchAll();
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
  // Release the durable-annotation store lockfile last so a crash between
  // session save and lock release still leaves the lockfile reclaimable on
  // next boot (the reclaim path checks liveness via PID).
  try {
    await releaseStoreLock();
  } catch (err) {
    console.error("[Tandem] releaseStoreLock on shutdown failed:", err);
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

  // Take the durable-annotation store lock before anything else touches
  // app-data. The port 3479 bind is the primary concurrent-writer guard;
  // this is a belt-and-braces fallback for port-bind races and edge cases.
  // `readonly` is tolerable — load() still works; queueWrite becomes a no-op,
  // but without a user-visible warning a second instance silently drops every
  // annotation for a whole session. Push a toast so the user sees it.
  try {
    const lock = await acquireStoreLock();
    if (lock === "readonly") {
      console.error(
        "[Tandem] Annotation store is read-only (another process holds the lock); writes disabled for this session.",
      );
      pushNotification({
        id: `store-readonly-${Date.now()}`,
        type: "save-error",
        severity: "warning",
        message:
          "Another Tandem process is running — annotations won't be saved this session. Close the other instance and restart.",
        dedupKey: "annotation-store:readonly",
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    // acquireStoreLock is designed to degrade internally, but defend against
    // future refactors. A hard throw here would lose the same "nothing is
    // saving" signal, so we still notify.
    console.error("[Tandem] acquireStoreLock threw:", err);
    pushNotification({
      id: `store-lock-error-${Date.now()}`,
      type: "save-error",
      severity: "error",
      message: `Annotation store failed to initialize: ${(err as Error)?.message ?? "unknown error"}. Annotations won't be saved this session.`,
      dedupKey: "annotation-store:lock-error",
      timestamp: Date.now(),
    });
  }

  // Clean up sessions older than 30 days
  cleanupSessions()
    .then((n) => {
      if (n > 0) console.error(`[Tandem] Cleaned up ${n} stale session(s)`);
    })
    .catch((err) => {
      console.error("[Tandem] Failed to clean up stale sessions:", err);
    });

  // Must await before restoreOpenDocuments: the GC unlinks stale envelopes,
  // and wireAnnotationStore reads them. A fire-and-forget chain raced the
  // read and silently emptied annotations (#334). #318 tracks the full policy.
  try {
    const { cleaned, raced, failed } = await cleanupOrphanedAnnotationFiles();
    if (cleaned > 0) console.error(`[Tandem] Cleaned up ${cleaned} orphaned annotation file(s)`);
    if (raced > 0) console.error(`[Tandem] ${raced} orphaned annotation file(s) cleaned by peer`);
    if (failed > 0)
      console.error(
        `[Tandem] Failed to clean up ${failed} orphaned annotation file(s) — see above`,
      );
  } catch (err) {
    console.error("[Tandem] Failed to clean up orphaned annotation files:", err);
  }

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

    // Both blocks below must run BEFORE servers start — the browser auto-opens
    // when MCP binds, and a stale tab reconnecting can CRDT-merge an old
    // openDocuments list that lacks the new tab, closing it.
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

    // Open CHANGELOG.md as active tab on first startup after an update.
    try {
      const versionStatus = await checkVersionChange(APP_VERSION, LAST_SEEN_VERSION_FILE);
      if (versionStatus === "upgraded") {
        await openFileByPath(path.join(projectRoot, "CHANGELOG.md"));
        console.error(`[Tandem] Opened CHANGELOG.md (upgraded to v${APP_VERSION})`);
      }
    } catch (err) {
      console.error("[Tandem] Version check / changelog open failed (non-fatal):", err);
    }

    // Auto-open sample/welcome.md when no documents are open (fresh install or empty restored session).
    if (docCount() === 0 && !process.env.TANDEM_NO_SAMPLE) {
      const sampleBase = process.env.TANDEM_DATA_DIR || projectRoot;
      const samplePath = path.join(sampleBase, "sample/welcome.md");
      try {
        await openFileByPath(samplePath);
        try {
          const doc = getOrCreateDocument(docIdFromPath(samplePath));
          injectTutorialAnnotations(doc);
        } catch (err) {
          console.error("[Tandem] Failed to inject tutorial annotations:", err);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          console.error("[Tandem] Sample file not found (skipping):", samplePath);
        } else {
          console.error("[Tandem] Failed to auto-open sample document:", err);
        }
      }
    }

    const [srv] = await Promise.all([
      startMcpServerHttp(mcpPort),
      startHocuspocus(wsPort).then(() => {
        console.error(`[Tandem] Hocuspocus WebSocket server running on ws://localhost:${wsPort}`);
      }),
    ]);
    httpServer = srv;

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
