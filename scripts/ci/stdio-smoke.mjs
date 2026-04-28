#!/usr/bin/env node
/**
 * CI smoke test: validates the Cowork stdio bridge end-to-end.
 *
 * Starts the real Tandem HTTP server from dist/server/index.js, polls /health
 * until ready, then spawns the stdio proxy from dist/cli/index.js mcp-stdio.
 * Sends MCP initialize + notifications/initialized + tools/list over stdin and
 * asserts that tools/list returns a non-empty tool array.
 *
 * Exits 0 on pass, 1 on failure. All diagnostics go to stderr; only MCP wire
 * traffic (forwarded from the proxy) appears on stdout.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");
const serverEntry = join(repoRoot, "dist/server/index.js");
const cliEntry = join(repoRoot, "dist/cli/index.js");

// ---------------------------------------------------------------------------
// Logging helpers (all to stderr — stdout is reserved for MCP wire)
// ---------------------------------------------------------------------------
function log(msg) {
  process.stderr.write(`[smoke] ${msg}\n`);
}

/** Sentinel error — message already emitted; .catch() skips re-logging. */
class SmokeFailure extends Error {}

/**
 * Log a FAIL message and throw SmokeFailure so the .catch() handler runs
 * cleanup() before exiting. Never calls process.exit() directly so the
 * finally / catch cleanup path always runs.
 */
function fail(msg) {
  process.stderr.write(`[smoke] FAIL: ${msg}\n`);
  throw new SmokeFailure(msg);
}

// ---------------------------------------------------------------------------
// Line-buffer helper — ported from tests/cli/mcp-stdio.test.ts:46-75
// Resolves with up to n lines within timeoutMs; fewer lines = timeout.
// Removes the data listener on resolution to prevent listener accumulation
// across successive calls (stale listeners steal data from later calls).
// ---------------------------------------------------------------------------
function readLines(child, n, timeoutMs) {
  const stdoutChunks = [];
  const handler = (c) => stdoutChunks.push(c.toString("utf8"));
  child.stdout.on("data", handler);

  return new Promise((resolve) => {
    const lines = [];
    let remainder = "";

    const checker = setInterval(() => {
      const joined = remainder + stdoutChunks.join("");
      stdoutChunks.length = 0;
      const parts = joined.split("\n");
      remainder = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) lines.push(part);
      }
      if (lines.length >= n) {
        clearTimeout(timer);
        clearInterval(checker);
        child.stdout.off("data", handler);
        resolve(lines);
      }
    }, 50);

    const timer = setTimeout(() => {
      clearInterval(checker);
      child.stdout.off("data", handler);
      resolve(lines);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Health poll — 30 retries × 500ms = 15s max
// isCrashed() callback allows fail-fast if the server exits unexpectedly.
// ---------------------------------------------------------------------------
async function pollHealth(baseUrl, retries = 30, intervalMs = 500, isCrashed = () => false) {
  for (let i = 0; i < retries; i++) {
    if (isCrashed()) return false;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (res.ok) return true;
    } catch {
      // connection refused or timeout — keep retrying
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let server;
let proxy;
let tmpDir;

async function main() {
  // Pre-flight: fail fast if dist artifacts are missing rather than wasting 15s
  if (!existsSync(serverEntry) || !existsSync(cliEntry)) {
    fail(
      `Built artifacts missing — run \`npm run build\` first.\nExpected: ${serverEntry} and ${cliEntry}`,
    );
  }

  // Create isolated temp dir for TANDEM_APP_DATA_DIR
  tmpDir = await mkdtemp(join(tmpdir(), "tandem-smoke-"));
  log(`App data dir: ${tmpDir}`);

  const serverEnv = {
    ...process.env,
    TANDEM_APP_DATA_DIR: tmpDir,
    TANDEM_NO_SAMPLE: "1",
    TANDEM_OPEN_BROWSER: "0",
    TANDEM_MCP_PORT: "3479",
    TANDEM_PORT: "3478",
  };

  log("Spawning HTTP server...");
  server = spawn(process.execPath, [serverEntry], {
    env: serverEnv,
    // inherit stderr/stdout so CI logs see server output; no pipe deadlock risk
    stdio: ["ignore", "inherit", "inherit"],
  });

  server.on("error", (err) => {
    log(`Server spawn error: ${err.message}`);
  });

  // Detect early server crashes so health poll can fail fast
  let serverCrashed = false;
  server.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      serverCrashed = true;
      log(`Server exited unexpectedly with code ${code} (signal: ${signal ?? "none"})`);
    }
  });

  // Poll health before spawning proxy
  log("Polling /health (30 × 500ms)...");
  const healthy = await pollHealth("http://127.0.0.1:3479", 30, 500, () => serverCrashed);
  if (!healthy) {
    if (serverCrashed) {
      fail("Server crashed during startup — see server output above");
    }
    fail(
      "Server did not become healthy within 15s — check dist/server/index.js exists and ports 3478/3479 are free",
    );
  }
  log("Server is healthy.");

  // Spawn stdio proxy
  log("Spawning stdio proxy...");
  proxy = spawn(process.execPath, [cliEntry, "mcp-stdio"], {
    env: {
      ...process.env,
      TANDEM_URL: "http://127.0.0.1:3479",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  proxy.on("error", (err) => {
    log(`Proxy spawn error: ${err.message}`);
  });

  // Suppress unhandled write errors if proxy dies before stdin.write() — without
  // this, Node emits an uncaught error that bypasses .catch() and skips cleanup.
  proxy.stdin.on("error", (err) => {
    log(`Proxy stdin error: ${err.message}`);
  });

  // Prefix-log proxy stderr to CI output
  proxy.stderr.on("data", (chunk) => {
    const lines = chunk.toString("utf8").split("\n");
    for (const line of lines) {
      if (line.trim()) process.stderr.write(`[proxy] ${line}\n`);
    }
  });

  // ---------------------------------------------------------------------------
  // MCP wire exchange
  // ---------------------------------------------------------------------------

  // 1. Send initialize request
  const initializeRequest = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "ci-smoke", version: "0" },
      capabilities: {},
    },
  });
  log("Sending initialize...");
  proxy.stdin.write(`${initializeRequest}\n`);

  // 2. Read initialize response (15s timeout)
  log("Waiting for initialize response...");
  const initLines = await readLines(proxy, 1, 15_000);
  if (initLines.length === 0) {
    fail("Stage: initialize response — no response received within 15s");
  }

  let initResponse;
  try {
    initResponse = JSON.parse(initLines[0]);
  } catch {
    fail(`Stage: initialize response — could not parse JSON: ${initLines[0]}`);
  }

  if (initResponse.error) {
    fail(
      `Stage: initialize response — got error: ${JSON.stringify(initResponse.error)} (raw: ${initLines[0]})`,
    );
  }
  if (!initResponse.result) {
    fail(`Stage: initialize response — no result field (raw: ${initLines[0]})`);
  }
  log(`Initialize OK (serverInfo: ${JSON.stringify(initResponse.result?.serverInfo ?? {})})`);

  // 3. Send notifications/initialized (MCP lifecycle — no response expected)
  const initializedNotification = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  log("Sending notifications/initialized...");
  proxy.stdin.write(`${initializedNotification}\n`);

  // 4. Send tools/list request
  const toolsListRequest = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  log("Sending tools/list...");
  proxy.stdin.write(`${toolsListRequest}\n`);

  // 5. Read tools/list response (15s timeout)
  log("Waiting for tools/list response...");
  const toolsLines = await readLines(proxy, 1, 15_000);
  if (toolsLines.length === 0) {
    fail("Stage: tools/list response — no response received within 15s");
  }

  let toolsResponse;
  try {
    toolsResponse = JSON.parse(toolsLines[0]);
  } catch {
    fail(`Stage: tools/list response — could not parse JSON: ${toolsLines[0]}`);
  }

  if (toolsResponse.id !== 2) {
    fail(
      `Stage: tools/list response — unexpected response id ${JSON.stringify(toolsResponse.id)}, expected 2 (got: ${toolsLines[0]})`,
    );
  }
  if (toolsResponse.error) {
    fail(
      `Stage: tools/list response — got error: ${JSON.stringify(toolsResponse.error)} (raw: ${toolsLines[0]})`,
    );
  }
  if (!toolsResponse.result) {
    fail(`Stage: tools/list response — no result field (raw: ${toolsLines[0]})`);
  }
  if (!Array.isArray(toolsResponse.result.tools)) {
    fail(
      `Stage: tools/list response — result.tools is not an array (got: ${JSON.stringify(toolsResponse.result)})`,
    );
  }
  if (toolsResponse.result.tools.length < 20) {
    fail(
      `Stage: tools/list response — only ${toolsResponse.result.tools.length} tools registered, expected ≥20 (tool registrations stripped by build?)`,
    );
  }

  log(`tools/list OK — ${toolsResponse.result.tools.length} tools registered.`);
  log("PASS");
}

// ---------------------------------------------------------------------------
// Cleanup — always runs (success or failure)
// ---------------------------------------------------------------------------
async function cleanup() {
  log("Cleaning up...");

  if (proxy) {
    // Close stdin — routes through stdio.onclose → shutdown(0), the natural exit
    try {
      proxy.stdin.end();
    } catch {
      // already closed
    }
    // SIGKILL watchdog after 3s in case graceful shutdown hangs
    const proxyKillTimer = setTimeout(() => {
      log("Proxy did not exit in 3s — sending SIGKILL");
      try {
        proxy.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 3000);
    proxyKillTimer.unref();
    if (proxy.exitCode === null && proxy.signalCode === null) {
      await new Promise((r) => proxy.once("exit", r));
    }
    clearTimeout(proxyKillTimer);
    log("Proxy exited.");
  }

  if (server) {
    server.kill("SIGTERM");
    // SIGKILL watchdog after 3s if graceful shutdown hangs on httpServer.close()
    const serverKillTimer = setTimeout(() => {
      log("Server did not exit in 3s — sending SIGKILL");
      try {
        server.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 3000);
    serverKillTimer.unref();
    if (server.exitCode === null && server.signalCode === null) {
      await new Promise((r) => server.once("exit", r));
    }
    clearTimeout(serverKillTimer);
    log("Server exited.");
  }

  if (tmpDir) {
    try {
      await rm(tmpDir, { recursive: true, force: true });
      log(`Removed temp dir: ${tmpDir}`);
    } catch (err) {
      log(`Failed to remove temp dir ${tmpDir}: ${err.message}`);
    }
  }
}

// Run main, always clean up.
// fail() throws SmokeFailure so cleanup() always runs before exit.
main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (err) => {
    // SmokeFailure messages are already emitted by fail(); don't double-print.
    if (!(err instanceof SmokeFailure)) {
      log(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await cleanup();
    process.exit(1);
  });
