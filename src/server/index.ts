import type { Server } from "http";
import { isIP } from "net";
import path from "path";
import { fileURLToPath } from "url";
import {
  BYO_MODELS_ENABLED,
  CTRL_ROOM,
  DEFAULT_BIND_HOST,
  DEFAULT_MCP_PORT,
  DEFAULT_WS_PORT,
  TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV,
} from "../shared/constants.js";
import { isUploadPath } from "../shared/paths.js";
import { docHash } from "./annotations/doc-hash.js";
import {
  acquireStoreLock,
  getAnnotationsDir,
  isStoreReadOnly,
  releaseStoreLock,
} from "./annotations/store.js";
import { loadOrCreateToken, readTokenFromFile } from "./auth/token-store.js";
import { checkBindConfig, isNonLoopback } from "./bind-check.js";
import { isKnownHocuspocusError } from "./error-filter.js";
import {
  attachCtrlObservers,
  detachObservers,
  reattachCtrlObservers,
  reattachObservers,
} from "./events/queue.js";
import { sweepDocBackups } from "./file-io/doc-backup.js";
import { reapOrphanedTemps } from "./file-io/reaper.js";
import { unwatchAll } from "./file-watcher.js";
import {
  startLocalModelCollaborator,
  stopLocalModelCollaborator,
} from "./local-model/collaborator.js";
import {
  restoreCtrlSession,
  restoreOpenDocuments,
  saveCurrentSession,
  writeGenerationId,
} from "./mcp/document.js";
import {
  autoSaveAllToDisk,
  broadcastStoreReadOnly,
  docCount,
  getOpenDocs,
} from "./mcp/document-service.js";
import { openFileByPath } from "./mcp/file-opener.js";
import {
  APP_VERSION,
  closeMcpSession,
  startMcpServerHttp,
  startMcpServerStdio,
} from "./mcp/server.js";
import { pushNotification } from "./notifications.js";
import {
  freePort,
  LAST_SEEN_VERSION_FILE,
  resolveAppDataDir,
  SESSION_DIR,
  waitForPort,
} from "./platform.js";
import { captureFatal, initSidecarCrashReporting } from "./sentry.js";
import {
  cleanupOrphanedAnnotationFiles,
  cleanupSessions,
  cleanupStaleTombstones,
  stopAutoSave,
} from "./session/manager.js";
import { maybeOpenStartupFile } from "./startup-file.js";
import { checkVersionChange } from "./version-check.js";
import { setDocLifecycleCallbacks, startHocuspocus } from "./yjs/provider.js";

// stdout is exclusively reserved for the MCP JSON-RPC wire protocol (stdio mode).
// Redirect any console.log calls (from Hocuspocus or other libs) to stderr.
// In HTTP mode this is defense-in-depth; in stdio mode it's critical.

// In production (Tauri sidecar, TANDEM_TAURI_SIDECAR=1), suppress known noisy
// warnings from dependencies (mammoth, Y.js). In dev mode, show everything.
const isProduction = process.env.TANDEM_TAURI_SIDECAR === "1";
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
let launcherSupervisor: import("./launcher/supervisor.js").Supervisor | null = null;
let launcherUnavailableReason: import("../shared/launcher/contract.js").LauncherUnavailableReason =
  process.env.TANDEM_DISABLE_LAUNCHER === "1" ? "disabled-by-env" : "stdio-mode";

// Swallow known Hocuspocus/ws protocol errors but crash on genuine bugs.
// Async so we can ship the unknown error to Sentry (when crash reporting is
// opt-in-enabled via TANDEM_SENTRY_DSN) and flush BEFORE exiting. captureFatal
// is a bounded no-op when reporting is disabled, so the default-launch exit
// path is unchanged (synchronous-equivalent: it awaits an immediately-resolved
// promise). Reporting can never block exit beyond captureFatal's flush bound.
async function handleFatalError(label: string, value: unknown): Promise<void> {
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
  // Best-effort, bounded ship+flush. Never throws (captureFatal swallows).
  await captureFatal(value);
  process.exit(1);
}
process.on("uncaughtException", (err) => {
  void handleFatalError("uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  void handleFatalError("unhandledRejection", reason);
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
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`[Tandem] ${signal} received, saving session...`);
  try {
    unwatchAll();
    // Abort any in-flight local-model run before tearing down (no-op while dark)
    // so its loop stops issuing writes during shutdown. The run's AbortController
    // cancels the in-flight model fetch, so this unwinds promptly.
    await stopLocalModelCollaborator();
    // Stop the timer BEFORE the flush so it can't fire concurrently with it
    // (the savingDocs lock would make that safe per-doc, but redundant saves
    // during teardown are pure noise).
    stopAutoSave();
    // Flush dirty docs to disk before the session snapshot, so (a) the disk
    // converges with the session instead of lagging up to 60s of edits a user
    // would see opening the file elsewhere, and (b) the session captures the
    // post-save Y_MAP_SAVED_AT_VERSION. Bounded: a hung disk write must not
    // stall SIGTERM past the Tauri shell's 5s health-poll patience. Saves are
    // sequential, so many large dirty docs may not all flush in time — the
    // session save below remains the recovery path, same as before.
    const flushed = await Promise.race([
      autoSaveAllToDisk().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!flushed) {
      console.error(
        "[Tandem] Shutdown disk flush timed out after 5s — session saved with a stale saved-at version; unflushed edits recover from the session on next launch",
      );
    }
    await saveCurrentSession();
  } catch (err) {
    console.error("[Tandem] Session save on shutdown failed:", err);
  }
  try {
    await closeMcpSession();
  } catch (err) {
    console.error("[Tandem] MCP session close on shutdown failed:", err);
  }
  // Stop the launcher BEFORE we tear down everything else — supervisor.stop()
  // sends SIGTERM to the reaper which gracefully reaps Claude. If we skip this
  // and just process.exit(0), the OS-level Job Object (Windows) / PDEATHSIG
  // (Linux) / kqueue (macOS) still kills Claude — but cleanly going through
  // SIGTERM gives Claude a chance to flush.
  if (launcherSupervisor) {
    try {
      await launcherSupervisor.stop();
    } catch (err) {
      console.error("[Tandem] Launcher stop on shutdown failed:", err);
    }
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

  // Crash reporting (#921) — opt-in, off by default. Enabled only when the
  // Tauri shell forwarded TANDEM_SENTRY_DSN to the sidecar. Awaited so a fatal
  // error early in startup can still be shipped by handleFatalError. No-op
  // (and no @sentry/node load) when the DSN is unset.
  await initSidecarCrashReporting();

  // Prune stale `.claude.json` backups left over from a previous run.
  // Idempotent and bounded — only touches Tandem's own `.backups/` dir.
  // Failures are non-fatal (a backup dir we can't sweep is operationally
  // annoying, not a security regression).
  try {
    const { sweepBackupsOnStartup } = await import("./integrations/backup.js");
    const { sweepBrokenIntegrationsBackupsOnStartup } = await import("./integrations/storage.js");
    const { sweepBrokenModelsBackupsOnStartup } = await import("./models/store.js");
    const { resolveAppDataDir } = await import("./platform.js");
    const appDataDir = resolveAppDataDir();
    await sweepBackupsOnStartup(appDataDir);
    await sweepBrokenIntegrationsBackupsOnStartup(appDataDir);
    await sweepBrokenModelsBackupsOnStartup(appDataDir);
  } catch (err) {
    console.error(
      `[Tandem] Warning: backup sweep failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Start the trial clock on first boot of a gate-active build (ADR-040 #1116).
  // No-op when the gate is dark. Runs in BOTH http and stdio mode, before any
  // transport bind, so the first /api/license/status read sees a started trial.
  try {
    const { ensureTrialStarted } = await import("./license/license-state.js");
    const { GATE_ENABLED } = await import("./license/gate-flag.js");
    const { resolveAppDataDir } = await import("./platform.js");
    await ensureTrialStarted(resolveAppDataDir(), () => Date.now(), GATE_ENABLED);
  } catch (err) {
    console.error(
      `[Tandem] Warning: trial-clock init failed: ${err instanceof Error ? err.message : err}`,
    );
  }

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

  // Sweep orphaned atomic-write temp files (`.tandem-tmp-*`) left behind when
  // the process was SIGKILLed between writeFile and rename. Only the app-data
  // dirs we own — never user document dirs. Skipped in read-only mode (another
  // instance holds the store lock). Fire-and-forget with a belt-and-braces
  // .catch(): an escaping rejection would hit the unhandledRejection handler.
  if (!isStoreReadOnly()) {
    reapOrphanedTemps([getAnnotationsDir(), SESSION_DIR])
      .then(({ cleaned, failed }) => {
        if (cleaned > 0)
          console.error(`[Tandem] Reaped ${cleaned} orphaned temp file(s) from app-data dirs`);
        if (failed > 0) console.error(`[Tandem] Failed to reap ${failed} orphaned temp file(s)`);
      })
      .catch((err) =>
        console.error(
          `[Tandem] Orphaned-temp reaper failed: ${err instanceof Error ? err.message : err}`,
        ),
      );

    // Age-sweep pre-overwrite document snapshots (30 days), same fire-and-
    // forget + read-only-gate discipline as the reaper above.
    sweepDocBackups(resolveAppDataDir())
      .then(({ cleaned, failed }) => {
        if (cleaned > 0) console.error(`[Tandem] Swept ${cleaned} expired document backup(s)`);
        if (failed > 0) console.error(`[Tandem] Failed to sweep ${failed} document backup(s)`);
      })
      .catch((err) =>
        console.error(
          `[Tandem] Document-backup sweep failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
  }

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

  // Compact stale tombstones (#318). Runs alongside the orphan-file sweep,
  // before restoreOpenDocuments (so no docs are open and the open-doc guard's
  // set is empty — but we pass the live set defensively in case this moves).
  try {
    const openDocHashes = new Set<string>();
    for (const open of getOpenDocs().values()) openDocHashes.add(docHash(open.filePath));
    const compacted = await cleanupStaleTombstones(openDocHashes);
    if (compacted > 0)
      console.error(`[Tandem] Compacted stale tombstones in ${compacted} annotation file(s)`);
  } catch (err) {
    console.error("[Tandem] Failed to compact stale tombstones:", err);
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

  // Warm the model-registry cache from disk BEFORE the collaborator resolves
  // its config (#1123 M1a). The collaborator resolves once, synchronously, at
  // start; without this a fresh boot with a valid models.json would read a cold
  // cache and resolve null. Gated on the SAME flag as the collaborator: while
  // dark, `start()` early-returns before `wire()` (collaborator.ts) so nothing
  // reads the cache — priming would be wasted boot-time disk I/O and would break
  // byte-identical-when-dark. At M4 both light up together, preserving the
  // "prime before wire" ordering. Awaited (like the session/doc restores above).
  if (BYO_MODELS_ENABLED) {
    try {
      const { primeModelStoreCache } = await import("./models/registry.js");
      await primeModelStoreCache();
    } catch (err) {
      console.error(
        `[Tandem] Failed to prime model-registry cache: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Wire the local-model collaborator (#1123 M1.2). DARK: this is a no-op while
  // BYO_MODELS_ENABLED is false (it never subscribes) — the gate lives inside.
  startLocalModelCollaborator();

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
    // Opened read-only as defense-in-depth — the underlying remark-stringify
    // over-escape was fixed in #605, but CHANGELOG is editorially a release
    // artifact (users shouldn't accidentally edit it) and read-only also
    // guards against any future regression in the serializer.
    try {
      const versionStatus = await checkVersionChange(APP_VERSION, LAST_SEEN_VERSION_FILE);
      if (versionStatus === "upgraded") {
        await openFileByPath(path.join(projectRoot, "CHANGELOG.md"), { readOnly: true });
        console.error(`[Tandem] Opened CHANGELOG.md (upgraded to v${APP_VERSION})`);
      }
    } catch (err) {
      console.error("[Tandem] Version check / changelog open failed (non-fatal):", err);
    }

    // OS file-association cold start: Tauri's argv parser (lib.rs) exports
    // TANDEM_OPEN_FILE before spawning the sidecar when the user double-clicks
    // a .md/.txt/etc. file. Open it BEFORE bind so stale tabs don't CRDT-merge
    // a doc list missing the requested doc. Skipping welcome.md happens
    // naturally below via docCount() === 0.
    const startupFileRequested = !!process.env.TANDEM_OPEN_FILE?.trim();
    const startupFileOpened = await maybeOpenStartupFile(process.env.TANDEM_OPEN_FILE);

    // Auto-open sample/welcome.md when no documents are open (fresh install or empty restored session).
    if (docCount() === 0 && !process.env.TANDEM_NO_SAMPLE) {
      if (startupFileRequested && !startupFileOpened) {
        // Correlate this fallback with the per-failure log line inside
        // maybeOpenStartupFile so support investigations don't have to
        // infer the link from two unrelated-looking error messages.
        console.error("[Tandem] Falling back to welcome.md after TANDEM_OPEN_FILE failure");
      }
      const sampleBase = process.env.TANDEM_DATA_DIR || projectRoot;
      const samplePath = path.join(sampleBase, "sample/welcome.md");
      try {
        await openFileByPath(samplePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          console.error("[Tandem] Sample file not found (skipping):", samplePath);
        } else {
          console.error("[Tandem] Failed to auto-open sample document:", err);
        }
      }
    }

    const [srv] = await Promise.all([
      startMcpServerHttp(
        mcpPort,
        bindHost,
        authToken,
        resolvedLanIP,
        {
          getSupervisor: () => launcherSupervisor,
          unavailableReason: () => launcherUnavailableReason,
        },
        wsPort,
        {
          // POST /api/shutdown (#1088): runs the exact same sequence as
          // SIGTERM/SIGINT — the Tauri shell calls this before restart/update
          // so dirty docs flush and the session snapshot stays in sync.
          requestShutdown: (reason) => void shutdown(reason),
        },
      ),
      startHocuspocus(wsPort).then(() => {
        console.error(`[Tandem] Hocuspocus WebSocket server running on ws://127.0.0.1:${wsPort}`);
      }),
    ]);
    httpServer = srv;

    console.error("");
    console.error(`  Tandem v${APP_VERSION}`);
    console.error("");
    console.error(`  MCP HTTP:    http://127.0.0.1:${mcpPort}/mcp`);
    console.error(`  WebSocket:   ws://127.0.0.1:${wsPort}`);
    console.error(`  Health:      http://127.0.0.1:${mcpPort}/health`);
    console.error("");
    console.error("  Open your AI client (Claude by default) and ask it to review a document.");
    console.error("");

    // Auto-launcher: spawn Claude Code as a managed child via tandem-reaper.
    // HTTP mode only. Gated by integrations.json having a claude-code entry
    // with apply !== "skip". Kill switch: TANDEM_DISABLE_LAUNCHER=1 for
    // debugging the server in isolation. PR #477 PR-4.
    if (process.env.TANDEM_DISABLE_LAUNCHER !== "1") {
      try {
        const { createSupervisor } = await import("./launcher/supervisor.js");
        const { resolveAppDataDir } = await import("./platform.js");
        launcherSupervisor = createSupervisor({
          integrationsBase: resolveAppDataDir(),
        });
        // Refresh the bundled skill on-disk if the version stamp moved
        // forward — existing users pick up skill updates without re-running
        // `tandem setup`. Best-effort, non-blocking.
        const { refreshSkillIfStale } = await import("./integrations/apply.js");
        void refreshSkillIfStale();
        await launcherSupervisor.start();
      } catch (err) {
        launcherUnavailableReason = "spawn-failed";
        console.error(
          `[Tandem] Launcher supervisor failed to start (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
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
      console.error(`[Tandem] Hocuspocus WebSocket server running on ws://127.0.0.1:${wsPort}`);
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
