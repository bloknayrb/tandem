#!/usr/bin/env node

/**
 * Tandem Doctor — diagnose common setup issues.
 * Usage: npm run doctor
 *
 * Pure Node.js built-ins only (no external dependencies).
 */

import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { request } from "node:http";

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

  let config;
  try {
    config = JSON.parse(readFileSync(mcpPath, "utf-8"));
  } catch {
    fail(".mcp.json is not valid JSON", "Check for syntax errors");
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
    warn(".mcp.json missing tandem-channel — Claude will use polling instead of push notifications");
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
      warn("tandem-channel missing TANDEM_URL env var", 'Add "env": {"TANDEM_URL": "http://localhost:3479"}');
    }
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
    req.on("error", () => resolve(null));
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
    const req = request(
      `http://127.0.0.1:${MCP_PORT}/api/events`,
      { timeout: 2000 },
      (res) => {
        // SSE endpoint responds with 200 and text/event-stream
        req.destroy(); // don't hold the connection open
        const ct = res.headers["content-type"] || "";
        if (res.statusCode === 200 && ct.includes("text/event-stream")) {
          pass("SSE event stream reachable (/api/events)");
        } else {
          warn(`/api/events responded with status ${res.statusCode}, content-type: ${ct}`);
        }
        resolve();
      },
    );
    req.on("error", () => {
      // Server not running — already caught by health check
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

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log();
  console.log("  Tandem Doctor");
  console.log("  =============");
  console.log();

  checkNodeVersion();
  checkNodeModules();
  checkMcpJson();

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

main();
