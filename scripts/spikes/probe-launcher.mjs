#!/usr/bin/env node
// Spike probe for #477 PR 4: sidecar launcher validation.
//
// Simulates what a stand-alone `tandem-launcher` binary (spawned by Claude
// Code via the MCP `command`/`args` shape) would do:
//   1. Resolve sidecar path from a pointer file (or env override).
//   2. Spawn the sidecar with TANDEM_AUTH_TOKEN + TANDEM_OPEN_BROWSER=0.
//      NOTE: TANDEM_BIND_HOST is intentionally unset → server binds 127.0.0.1.
//   3. Poll http://127.0.0.1:3479/health until 200 OK (or 20s deadline).
//   4. Print PASS / FAIL and exit code accordingly.
//
// This does NOT rewrite any real MCP config. It validates the spawn +
// health-check protocol end-to-end. Run with:
//   node scripts/spikes/probe-launcher.mjs [--exe <path>] [--port 3479]
//
// Security:
//   - Never reads $HOME/.claude.json.
//   - Auth token is generated fresh per invocation (32 hex chars from
//     node:crypto.randomBytes).
//   - URL polled is hard-coded to 127.0.0.1.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT = 3479;
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_POLL_MS = 250;

function parseArgs(argv) {
  const out = { exe: null, port: DEFAULT_PORT, pointer: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--exe") out.exe = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--pointer") out.pointer = argv[++i];
  }
  return out;
}

function resolveSidecar({ exe, pointer }) {
  if (exe) return { exe: resolve(exe), args: [] };
  if (pointer) {
    const json = JSON.parse(readFileSync(pointer, "utf8"));
    if (typeof json.exe !== "string") {
      throw new Error("pointer file missing 'exe'");
    }
    return { exe: json.exe, args: Array.isArray(json.args) ? json.args : [] };
  }
  // Fallback: look in the standard Tauri bundle location.
  const triple = process.env.TANDEM_TARGET_TRIPLE ?? "x86_64-pc-windows-msvc";
  const suffix = process.platform === "win32" ? ".exe" : "";
  const guess = resolve(`src-tauri/binaries/node-sidecar-${triple}${suffix}`);
  if (existsSync(guess)) return { exe: guess, args: [] };
  throw new Error(`could not resolve sidecar exe (tried ${guess})`);
}

async function pollHealth(port) {
  const url = `http://${LOOPBACK}:${port}/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr = "none";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return { ok: true, url };
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = String(e?.message ?? e);
    }
    await delay(HEALTH_POLL_MS);
  }
  return { ok: false, url, lastErr };
}

async function main() {
  const args = parseArgs(process.argv);
  const { exe, args: extra } = resolveSidecar(args);
  const token = randomBytes(16).toString("hex");
  const env = {
    ...process.env,
    TANDEM_AUTH_TOKEN: token,
    TANDEM_OPEN_BROWSER: "0",
  };
  // Defense-in-depth: explicitly strip TANDEM_BIND_HOST if the user has it
  // set globally. Launcher must always bind 127.0.0.1.
  delete env.TANDEM_BIND_HOST;

  console.error(`[probe] sidecar exe: ${exe}`);
  console.error(`[probe] extra args:  ${JSON.stringify(extra)}`);
  console.error(`[probe] port:        ${args.port}`);
  console.error(`[probe] token:       <${token.length} hex chars, generated fresh>`);

  const child = spawn(exe, extra, {
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  let exitedEarly = false;
  child.on("exit", (code, sig) => {
    exitedEarly = true;
    console.error(`[probe] sidecar exited early: code=${code} sig=${sig}`);
  });

  try {
    const result = await pollHealth(args.port);
    if (!result.ok) {
      console.error(
        `[probe] FAIL: ${result.url} did not respond 200 within ${HEALTH_TIMEOUT_MS}ms (last: ${result.lastErr})`,
      );
      process.exitCode = 1;
    } else if (exitedEarly) {
      console.error("[probe] FAIL: sidecar exited before/during health poll");
      process.exitCode = 1;
    } else {
      console.error(`[probe] PASS: ${result.url} responded 200`);
      process.exitCode = 0;
    }
  } finally {
    if (!child.killed) child.kill();
  }
}

main().catch((err) => {
  console.error(`[probe] crashed: ${err?.stack ?? err}`);
  process.exit(2);
});
