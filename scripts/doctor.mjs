#!/usr/bin/env node

/**
 * Tandem Doctor — diagnose common setup issues.
 * Usage: npm run doctor
 *
 * Pure Node.js built-ins only (no external dependencies).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// Keep in sync with src/shared/constants.ts (can't import TS from standalone .mjs)
const WS_PORT = 3478;
const MCP_PORT = 3479;

// ── Formatting helpers ──────────────────────────────────────────────

let failures = 0;
let warnings = 0;

function pass(msg) {
  console.log(`  \x1b[32m[PASS]\x1b[0m ${msg}`);
}

function warn(msg, fix) {
  warnings++;
  console.log(`  \x1b[33m[WARN]\x1b[0m ${msg}`);
  if (fix) console.log(`         Fix: ${fix}`);
}

function fail(msg, fix) {
  failures++;
  console.log(`  \x1b[31m[FAIL]\x1b[0m ${msg}`);
  if (fix) console.log(`         Fix: ${fix}`);
}

// ── Check: Node.js version ──────────────────────────────────────────

function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1), 10);
  if (major >= 22) {
    pass(`Node.js ${version} (>= 22 required)`);
  } else {
    fail(
      `Node.js ${version} — version 22+ required`,
      "Install Node.js 22+ from https://nodejs.org",
    );
  }
}

// ── Check: node_modules exists ──────────────────────────────────────

function checkNodeModules() {
  if (existsSync(join(process.cwd(), "node_modules"))) {
    pass("node_modules/ exists");
  } else {
    fail("node_modules/ not found", "npm install");
  }
}

// ── Check: .mcp.json ────────────────────────────────────────────────

function checkMcpJson() {
  const mcpPath = join(process.cwd(), ".mcp.json");
  if (!existsSync(mcpPath)) {
    fail(".mcp.json not found", "Restore it from git: git checkout .mcp.json");
    return;
  }

  let raw;
  try {
    raw = readFileSync(mcpPath, "utf-8");
  } catch (err) {
    fail(`.mcp.json could not be read: ${err.message}`);
    return;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    fail(`.mcp.json is not valid JSON: ${err.message}`);
    return;
  }

  const servers = config.mcpServers;
  if (!servers) {
    fail('.mcp.json missing "mcpServers" key');
    return;
  }

  // Check tandem (HTTP MCP) entry
  const tandem = servers.tandem;
  if (!tandem) {
    fail('.mcp.json missing "tandem" server entry');
  } else if (tandem.type !== "http" || !tandem.url?.includes("/mcp")) {
    warn(`.mcp.json tandem: unexpected config — type=${tandem.type}, url=${tandem.url}`);
  } else {
    pass(`.mcp.json tandem \u2192 ${tandem.url}`);
  }

  // Check tandem-channel entry
  const channel = servers["tandem-channel"];
  if (!channel) {
    warn(
      ".mcp.json missing tandem-channel — Claude will use polling instead of push notifications",
    );
  } else {
    const cmd = channel.command;
    const args = (channel.args || []).join(" ");

    if (cmd === "cmd" && args.includes("/c")) {
      warn(
        `.mcp.json tandem-channel uses Windows-only "cmd /c" — won't work on macOS/Linux`,
        'Change to: "command": "npx", "args": ["tsx", "src/channel/index.ts"]',
      );
    } else {
      pass(`.mcp.json tandem-channel \u2192 ${cmd} ${args}`);
    }

    if (!channel.env?.TANDEM_URL) {
      warn(
        "tandem-channel missing TANDEM_URL env var",
        'Add "env": {"TANDEM_URL": "http://localhost:3479"}',
      );
    }
  }
}

// ── Check: user-level MCP config (global install path) ─────────────

function checkUserMcpConfig() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const claudeCodePath = join(home, ".claude", "mcp_settings.json");

  if (!existsSync(claudeCodePath)) {
    warn(
      "~/.claude/mcp_settings.json not found",
      "Run: tandem setup  (or ignore if using project-local .mcp.json)",
    );
    return;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(claudeCodePath, "utf-8"));
  } catch (err) {
    warn(
      `~/.claude/mcp_settings.json is malformed JSON: ${err.message}`,
      "Run: tandem setup to rewrite it",
    );
    return;
  }

  const servers = config?.mcpServers ?? {};
  if (!servers.tandem) {
    warn("tandem not registered in ~/.claude/mcp_settings.json", "Run: tandem setup");
  } else {
    pass("tandem registered in ~/.claude/mcp_settings.json");
  }
  if (!servers["tandem-channel"]) {
    warn("tandem-channel not registered in ~/.claude/mcp_settings.json", "Run: tandem setup");
  } else {
    pass("tandem-channel registered in ~/.claude/mcp_settings.json");
  }
}

// ── Check: port status ──────────────────────────────────────────────

function probePort(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function checkPorts() {
  const [ws, mcp] = await Promise.all([probePort(WS_PORT), probePort(MCP_PORT)]);

  if (ws && mcp) {
    pass(`Ports ${WS_PORT} (WebSocket) + ${MCP_PORT} (MCP HTTP) in use`);
  } else if (!ws && !mcp) {
    fail(
      `Ports ${WS_PORT} + ${MCP_PORT} not listening — server not running`,
      "npm run dev:standalone",
    );
  } else {
    warn(
      `Partial: port ${WS_PORT} ${ws ? "up" : "down"}, port ${MCP_PORT} ${mcp ? "up" : "down"}`,
      "Server may be starting up or partially crashed",
    );
  }

  return { ws, mcp };
}

// ── Check: /health endpoint ─────────────────────────────────────────

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = request(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on("error", (err) => resolve({ error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

async function checkHealth() {
  const result = await httpGet(`http://127.0.0.1:${MCP_PORT}/health`);

  if (!result) {
    fail(`Server not responding on localhost:${MCP_PORT}`, "npm run dev:standalone");
    return false;
  }

  if (result.error) {
    fail(
      `Server not responding on localhost:${MCP_PORT} (${result.error})`,
      "npm run dev:standalone",
    );
    return false;
  }

  if (result.status !== 200) {
    fail(`/health returned status ${result.status}`);
    return false;
  }

  const d = result.data;
  if (d) {
    const session = d.hasSession ? "session active" : "no MCP session";
    pass(`Server healthy (v${d.version}, ${d.transport}, ${session})`);
    if (!d.hasSession) {
      warn("No active MCP session — Claude Code hasn't connected yet");
    }
  } else {
    pass("Server responded on /health (could not parse body)");
  }
  return true;
}

// ── Check: SSE event stream ─────────────────────────────────────────

function checkSseEndpoint() {
  return new Promise((resolve) => {
    const req = request(`http://127.0.0.1:${MCP_PORT}/api/events`, { timeout: 2000 }, (res) => {
      // SSE endpoint responds with 200 and text/event-stream
      req.destroy(); // don't hold the connection open
      const ct = res.headers["content-type"] || "";
      if (res.statusCode === 200 && ct.includes("text/event-stream")) {
        pass("SSE event stream reachable (/api/events)");
      } else {
        warn(`/api/events responded with status ${res.statusCode}, content-type: ${ct}`);
      }
      resolve();
    });
    req.on("error", (err) => {
      warn(`/api/events not reachable: ${err.message}`);
      resolve();
    });
    req.on("timeout", () => {
      req.destroy();
      warn("/api/events timed out");
      resolve();
    });
    req.end();
  });
}

// ── Check: annotation store health ──────────────────────────────────

/** Mirror of `env-paths("tandem").data` for the current OS. */
function resolveAppDataDir() {
  const override = process.env.TANDEM_APP_DATA_DIR;
  if (override && override.length > 0) return override;

  const home = homedir();
  switch (platform()) {
    case "win32":
      return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "tandem", "Data");
    case "darwin":
      return join(home, "Library", "Application Support", "tandem");
    default:
      return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "tandem");
  }
}

/** Cross-platform test that a PID currently points at a live process. */
function isPidLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function checkAnnotationStore() {
  const dir = join(resolveAppDataDir(), "annotations");
  if (!existsSync(dir)) {
    pass(`Annotation store dir not yet created (${dir}) — first open will create it`);
    return;
  }

  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    fail(`Annotation store dir unreadable: ${err.message}`, `Check permissions on ${dir}`);
    return;
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json") && !f.endsWith(".corrupt.json"));
  const corruptFiles = entries.filter((f) => f.includes(".corrupt."));

  let totalBytes = 0;
  let newest = { name: null, mtime: 0 };
  let sampleSchemaVersion = null;

  for (const f of jsonFiles) {
    try {
      const s = statSync(join(dir, f));
      totalBytes += s.size;
      if (s.mtimeMs > newest.mtime) {
        newest = { name: f, mtime: s.mtimeMs };
      }
      if (sampleSchemaVersion === null) {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, f), "utf-8"));
          if (typeof parsed?.schemaVersion === "number") {
            sampleSchemaVersion = parsed.schemaVersion;
          }
        } catch {
          // malformed individual file — counted under corruptFiles check below
        }
      }
    } catch {
      // file vanished between readdir and stat — ignore
    }
  }

  pass(`Annotation store: ${jsonFiles.length} doc(s), ${formatBytes(totalBytes)} total`);

  if (newest.name) {
    const ageMs = Date.now() - newest.mtime;
    const ageStr =
      ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`;
    pass(`Most recent annotation write: ${newest.name} (${ageStr} ago)`);
  }

  if (sampleSchemaVersion !== null) {
    pass(`Annotation schema version: ${sampleSchemaVersion}`);
  }

  if (corruptFiles.length > 0) {
    warn(
      `${corruptFiles.length} quarantined annotation file(s) in ${dir}`,
      "Safe to delete after inspection; kept 7d by design.",
    );
  }

  // Lock status
  const lockPath = join(dir, "store.lock");
  if (!existsSync(lockPath)) {
    pass("Annotation store lock: not held (no running writer)");
    return;
  }

  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid)) {
      warn(
        `Annotation store lock at ${lockPath} has unparseable content: "${raw}"`,
        "Restart Tandem or delete the lock file if no server is running.",
      );
      return;
    }
    if (isPidLive(pid)) {
      pass(`Annotation store lock held by live PID ${pid}`);
    } else {
      warn(
        `Annotation store lock at ${lockPath} points to dead PID ${pid}`,
        "The next server start will reclaim the stale lock automatically.",
      );
    }
  } catch (err) {
    warn(`Could not read annotation store lock: ${err.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log();
  console.log("  Tandem Doctor");
  console.log("  =============");
  console.log();

  checkNodeVersion();
  checkNodeModules();
  checkMcpJson();
  checkUserMcpConfig();

  console.log();
  checkAnnotationStore();

  console.log();
  const { mcp } = await checkPorts();

  if (mcp) {
    const healthy = await checkHealth();
    if (healthy) {
      await checkSseEndpoint();
    }
  }

  console.log();
  if (failures > 0) {
    console.log(`  ${failures} issue(s) found. Fix the items above and re-run: npm run doctor`);
    process.exit(1);
  } else if (warnings > 0) {
    console.log(`  ${warnings} warning(s) — Tandem should work, but check the items above.`);
  } else {
    console.log("  All checks passed. Tandem is ready.");
  }
  console.log();
}

main().catch((err) => {
  console.error(`\n  Tandem Doctor crashed unexpectedly: ${err.message}`);
  console.error("  Please report this at https://github.com/bloknayrb/tandem/issues\n");
  process.exit(2);
});
