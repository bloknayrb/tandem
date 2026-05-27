#!/usr/bin/env node
// Spike probe for #477 PR 4: sidecar launcher validation.
//
// Simulates what a stand-alone `tandem-launcher` binary (spawned by Claude
// Code via the MCP `command`/`args` shape) would do:
//   1. Resolve sidecar path from a pointer file (or --exe override).
//   2. Spawn the sidecar with TANDEM_AUTH_TOKEN + TANDEM_TAURI_SIDECAR=1
//      and a minimal allowlisted env (PATH, SystemRoot, HOME, etc.).
//      NOTE: TANDEM_BIND_HOST is intentionally never set → server binds 127.0.0.1.
//   3. Race a 20s health-poll of http://127.0.0.1:3479/health against the
//      sidecar exiting early. The poll uses an AbortController so it
//      cancels immediately on early child exit (no 250ms tick wait).
//   4. Print PASS / FAIL and exit code accordingly.
//
// Usage:
//   node scripts/spikes/probe-launcher.mjs [--exe <path>] [--port 3479] [--pointer <path>]
//
// Exit codes:
//   0 — PASS: sidecar served /health 200 and was still alive.
//   1 — FAIL: sidecar timed out or exited before/during health poll.
//   2 — Arg/spawn error: bad --port, missing exe, ENOENT, EACCES, etc.
//   3 — FAIL (foreign-200): got 200 from :<port> but our sidecar had
//       already exited — something else is listening (stale dev server).
//
// Fallback resolution: when neither --exe nor --pointer is given, falls
// back to the bundled Tauri sidecar `src-tauri/binaries/node-sidecar-<triple>{.exe}`
// invoked with `dist/server/index.js` as the script argument (matching
// `start_sidecar` in `src-tauri/src/lib.rs`). Requires `npm run build:server`
// to have been run.
//
// Security:
//   - Never reads $HOME/.claude.json.
//   - Auth token is generated fresh per invocation (32 hex chars from
//     node:crypto.randomBytes).
//   - URL polled is hard-coded to 127.0.0.1.
//   - Child env is allowlist-constructed, not spread from `process.env`,
//     so unrelated parent-process secrets do not transitively reach the
//     sidecar or its grandchildren.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT = 3479;
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_POLL_MS = 250;
const PER_REQUEST_TIMEOUT_MS = 2_000;
const KILL_GRACE_MS = 1_000;

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

function validateArgs(args) {
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    console.error("[probe] FAIL: --port must be an integer 1–65535");
    process.exit(2);
  }
}

function resolveSidecar({ exe, pointer }) {
  if (exe) return { exe: resolve(exe), args: [] };
  if (pointer) {
    const json = JSON.parse(readFileSync(pointer, "utf8"));
    if (typeof json.exe !== "string") {
      throw new Error("pointer file missing 'exe'");
    }
    if (json.args !== undefined && !Array.isArray(json.args)) {
      throw new Error("pointer 'args' must be an array");
    }
    const args = Array.isArray(json.args) ? json.args : [];
    for (const [i, v] of args.entries()) {
      if (typeof v !== "string") {
        throw new Error(`pointer 'args[${i}]' must be a string`);
      }
    }
    return { exe: json.exe, args };
  }
  // Fallback: bundled Tauri sidecar. The packaged Node runtime requires a
  // script argument — match `start_sidecar` in src-tauri/src/lib.rs by
  // passing `dist/server/index.js`.
  const triple = process.env.TANDEM_TARGET_TRIPLE ?? "x86_64-pc-windows-msvc";
  const suffix = process.platform === "win32" ? ".exe" : "";
  const guessExe = resolve(`src-tauri/binaries/node-sidecar-${triple}${suffix}`);
  const guessScript = resolve("dist/server/index.js");
  if (!existsSync(guessExe)) {
    throw new Error(`could not resolve sidecar exe (tried ${guessExe})`);
  }
  if (!existsSync(guessScript)) {
    throw new Error(
      `fallback requires ${guessScript} — run \`npm run build:server\` first, or pass --pointer / --exe`,
    );
  }
  return { exe: guessExe, args: [guessScript] };
}

async function pollHealth(port, abortSignal) {
  const url = `http://${LOOPBACK}:${port}/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr = "none";
  while (Date.now() < deadline) {
    if (abortSignal.aborted) {
      return { ok: false, url, lastErr: "aborted (child exited)" };
    }
    try {
      const signal = AbortSignal.any([abortSignal, AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS)]);
      const res = await fetch(url, { signal });
      if (res.ok) return { ok: true, url };
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = String(e?.message ?? e);
      if (abortSignal.aborted) {
        return { ok: false, url, lastErr: "aborted (child exited)" };
      }
    }
    await delay(HEALTH_POLL_MS);
  }
  return { ok: false, url, lastErr };
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // taskkill /F /T descends the process tree. child.kill() on Windows
    // maps to TerminateProcess on the immediate child only.
    spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
    });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

async function awaitExit(child, exitPromise) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const timeout = delay(KILL_GRACE_MS).then(() => "timeout");
  const winner = await Promise.race([exitPromise, timeout]);
  if (winner === "timeout" && process.platform !== "win32") {
    try {
      child.kill("SIGKILL");
    } catch {}
    await Promise.race([exitPromise, delay(KILL_GRACE_MS)]);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  validateArgs(args);
  const { exe, args: extra } = resolveSidecar(args);
  const token = randomBytes(16).toString("hex");

  // Allowlist child env explicitly. Spreading process.env transitively
  // exposes parent-process secrets to the sidecar and any grandchildren.
  const env = {
    TANDEM_AUTH_TOKEN: token,
    TANDEM_TAURI_SIDECAR: "1",
  };
  for (const key of [
    "PATH",
    "SystemRoot",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "TANDEM_TARGET_TRIPLE",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Defense-in-depth: TANDEM_BIND_HOST is intentionally absent from the
  // allowlist. The launcher must always bind 127.0.0.1.

  console.error(`[probe] sidecar exe: ${exe}`);
  console.error(`[probe] extra args:  ${JSON.stringify(extra)}`);
  console.error(`[probe] port:        ${args.port}`);
  console.error(`[probe] token:       <${token.length} hex chars, generated fresh>`);

  const child = spawn(exe, extra, {
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // Cancel in-flight fetches immediately on early child exit.
  const exitController = new AbortController();
  let exited = null; // { code, sig } once the child exits

  const exitPromise = new Promise((resolveExit) => {
    child.on("exit", (code, sig) => {
      exited = { code, sig };
      console.error(`[probe] sidecar exited: code=${code} sig=${sig}`);
      exitController.abort();
      resolveExit(exited);
    });
  });

  // Async spawn errors (ENOENT, EACCES) — surface clearly, don't swallow.
  let spawnError = null;
  child.on("error", (err) => {
    spawnError = err;
    console.error(`[probe] FAIL: spawn error: ${err.code ?? ""} ${err.message}`);
    exitController.abort();
  });

  try {
    const result = await pollHealth(args.port, exitController.signal);

    if (spawnError) {
      process.exitCode = 2;
    } else if (result.ok && exited) {
      console.error(
        `[probe] FAIL: got 200 from :${args.port} but our sidecar already exited (code=${exited.code}). Check for a stale dev server or leftover process on the port.`,
      );
      process.exitCode = 3;
    } else if (result.ok) {
      console.error(`[probe] PASS: ${result.url} responded 200`);
      process.exitCode = 0;
    } else if (exited) {
      console.error(
        `[probe] FAIL: sidecar exited (code=${exited.code} sig=${exited.sig}) before serving /health`,
      );
      process.exitCode = 1;
    } else {
      console.error(
        `[probe] FAIL: ${result.url} did not respond 200 within ${HEALTH_TIMEOUT_MS}ms (last: ${result.lastErr})`,
      );
      process.exitCode = 1;
    }
  } finally {
    killChild(child);
    await awaitExit(child, exitPromise);
  }
}

main().catch((err) => {
  console.error(`[probe] crashed: ${err?.stack ?? err}`);
  process.exit(2);
});
