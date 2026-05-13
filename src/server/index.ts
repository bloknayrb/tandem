import type { Server } from "http";
import { isIP } from "net";
import path from "path";
import { fileURLToPath } from "url";
import {
  CTRL_ROOM,
  DEFAULT_BIND_HOST,
  DEFAULT_MCP_PORT,
  DEFAULT_WS_PORT,
  TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV,
} from "../shared/constants.js";
import { isUploadPath } from "../shared/paths.js";
import { acquireStoreLock, isStoreReadOnly, releaseStoreLock } from "./annotations/store.js";
import { loadOrCreateToken, readTokenFromFile } from "./auth/token-store.js";
import { checkBindConfig, isNonLoopback } from "./bind-check.js";
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
import { broadcastStoreReadOnly, docCount, getOpenDocs } from "./mcp/document-service.js";
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
  console.error(`[Tandem] Fatal context: openDocuments=${docCount()}`);
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

  // Take the durable-annotation store lock before accepting connections.
  // HTTP mode: retry up to 30s when a live PID holds the lock, logging every 5s.
  // Stdio mode: single attempt only — the MCP init timeout cannot survive a retry loop.
  {
    let lock: "locked" | "readonly" = "readonly";
    let lockErr: unknown;

    if (transportMode === "http") {
      // HTTP mode: retry up to 30s — browser has no init deadline
      const RETRY_INTERVAL_MS = 5_000;
      const RETRY_DEADLINE_MS = 30_000;
      const retryStart = Date.now();
      try {
        lock = await acquireStoreLock();
      } catch (err) {
        lockErr = err;
      }
      while (
        lock === "readonly" &&
        lockErr === undefined &&
        Date.now() - retryStart < RETRY_DEADLINE_MS
      ) {
        const remaining = Math.ceil((RETRY_DEADLINE_MS - (Date.now() - retryStart)) / 1000);
        process.stderr.write(
          `[Tandem] store lock held by another process, retrying in 5s... (${remaining}s remaining)\n`,
        );
        await new Promise<void>((r) => setTimeout(r, RETRY_INTERVAL_MS));
        try {
          lock = await acquireStoreLock();
        } catch (err) {
          lockErr = err;
        }
      }
    } else {
      // Stdio mode: single attempt only — MCP init timeout cannot tolerate a retry loop
      try {
        lock = await acquireStoreLock();
      } catch (err) {
        lockErr = err;
      }
    }

    if (lockErr !== undefined) {
      // acquireStoreLock is designed to degrade internally, but defend against
      // future refactors. A hard throw here would lose the same "nothing is
      // saving" signal, so we still notify.
      console.error("[Tandem] acquireStoreLock threw:", lockErr);
      pushNotification({
        id: `store-lock-error-${Date.now()}`,
        type: "save-error",
        severity: "error",
        message: `Annotation store failed to initialize: ${(lockErr as Error)?.message ?? "unknown error"}. Annotations won't be saved this session.`,
        dedupKey: "annotation-store:lock-error",
        timestamp: Date.now(),
      });
    } else if (lock === "readonly") {
      console.error(
        "[Tandem] Annotation store is read-only (another process holds the lock); writes disabled for this session.",
      );
      pushNotification({
        id: `store-readonly-${Date.now()}`,
        type: "save-error",
        severity: "warning",
        message:
          "Annotation store is read-only (another process holds the lock); annotation writes are disabled for this session. Close the other Tandem instance and restart.",
        dedupKey: "annotation-store:readonly",
        timestamp: Date.now(),
      });
    }
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

  // Broadcast store read-only state so browser clients can show a warning banner
  // when the annotation store is locked by another process.
  broadcastStoreReadOnly(isStoreReadOnly());

  // Attach event queue observers to CTRL_ROOM for channel push notifications
  attachCtrlObservers();

  // Register doc lifecycle callbacks so the event queue reattaches observers
  // when Hocuspocus swaps Y.Doc instances (avoids circular import).
  setDocLifecycleCallbacks(
    (docName, newDoc) => {
      if (docName === CTRL_ROOM) {
        reattachCtrlObservers();
      } else {
        const openDoc = getOpenDocs().get(docName);
        const uploadDoc = openDoc ? isUploadPath(openDoc.filePath) : false;
        reattachObservers(docName, newDoc, { uploadDoc });
      }
    },
    (docName) => {
      detachObservers(docName);
    },
  );

  // ── Bind-host selection (MCP only — Hocuspocus always stays loopback) ────────
  const bindHost = process.env.TANDEM_BIND_HOST ?? DEFAULT_BIND_HOST;

  // Fix 4: Validate TANDEM_BIND_HOST as an IP when it is non-loopback and non-wildcard.
  // Loopback and wildcard values are reserved words handled by checkBindConfig;
  // only concrete IPs need net.isIP validation here.
  const LOOPBACK_AND_WILDCARD = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]);
  if (!LOOPBACK_AND_WILDCARD.has(bindHost) && isIP(bindHost) === 0) {
    process.stderr.write(
      `[tandem] TANDEM_BIND_HOST="${bindHost}" is not a valid IP address. Exiting.\n`,
    );
    process.exit(1);
  }

  // Fix 2: Coerce empty-string TANDEM_LAN_IP to undefined so nullish coalescing
  // in bind-check.ts does not treat "" as a valid IP and add it to the Host allowlist.
  // (An empty Host header would otherwise match "" via includes("") === true.)
  const lanIP = process.env.TANDEM_LAN_IP || undefined;

  // Fix 4: Validate TANDEM_LAN_IP when set.
  if (lanIP && isIP(lanIP) === 0) {
    process.stderr.write(`[tandem] TANDEM_LAN_IP="${lanIP}" is not a valid IP address. Exiting.\n`);
    process.exit(1);
  }

  // Read the existing token (without generating) so the fail-closed check fires
  // when there is no pre-provisioned token. loadOrCreateToken() runs AFTER this
  // check passes — so a first-time LAN bind correctly refuses to auto-generate.
  const existingToken = process.env.TANDEM_AUTH_TOKEN || (await readTokenFromFile());

  const bindCheck = checkBindConfig({
    bindHost,
    port: mcpPort,
    authToken: existingToken,
    // Fix 3: Only treat the env var as truthy when it equals exactly "1".
    allowUnauthLAN: process.env[TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV] === "1",
    lanIP,
  });

  if (!bindCheck.ok) {
    process.stderr.write(bindCheck.stderrMessage ?? "");
    process.exit(bindCheck.exitCode ?? 1);
  }

  // Load (or create) the auth token after the bind check passes.
  // TANDEM_AUTH_TOKEN env (set by Tauri before sidecar spawn) takes priority.
  const authToken = await loadOrCreateToken();

  if (bindCheck.lanWarning) {
    process.stderr.write(bindCheck.lanWarning);
  }

  if (isNonLoopback(bindHost) && bindCheck.detectedIPs && bindCheck.detectedIPs.length === 1) {
    process.stderr.write(`[tandem] Detected LAN interface: ${bindCheck.detectedIPs[0]}\n`);
  }

  // The resolved LAN IP is used in the Host-header allowlist so browsers on
  // the LAN can connect. undefined for loopback binds.
  const resolvedLanIP = bindCheck.resolvedLanIP;

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
    // Opened read-only so the 60s autosave timer does not round-trip the file
    // through the markdown serializer and rewrite it with escape noise.
    try {
      const versionStatus = await checkVersionChange(APP_VERSION, LAST_SEEN_VERSION_FILE);
      if (versionStatus === "upgraded") {
        await openFileByPath(path.join(projectRoot, "CHANGELOG.md"), { readOnly: true });
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
      startMcpServerHttp(mcpPort, bindHost, authToken, resolvedLanIP),
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
