#!/usr/bin/env node
/**
 * CI smoke test: guards against the `tandem monitor` double-main() bug in the
 * REAL tsup/esbuild-built bundle.
 *
 * src/cli/index.ts's `monitor` subcommand dynamically imports
 * src/monitor/run.ts (never src/monitor/index.ts, which carries an
 * `isDirectRun` auto-run guard that resolves TRUE inside the bundled CLI and
 * would fire main() a second time — doubling every SSE-driven notification).
 * tests/monitor/entry-runtime-split.test.ts and tests/cli/monitor.test.ts
 * cover this structurally and via `tsx`-run source respectively, but neither
 * exercises dist/cli/index.js — the actual artifact `npx tandem-editor@version
 * monitor` runs in production. A future change to how tsup/esbuild bundles
 * the dynamic import (splitting, noExternal, import hoisting) could silently
 * reintroduce the double-run without either existing test catching it.
 *
 * Spawns dist/cli/index.js monitor against a dead port (loopback, no
 * listener — refusal is near-instant) and asserts exactly one "Tandem
 * monitor starting" line appears on stderr, and none on stdout (STDOUT IS
 * RESERVED, CLAUDE.md rule #3). The startup line logs once, synchronously,
 * before the connect/retry loop begins, so a double-fire would appear
 * immediately — the wait window below is generous margin, not a tight race.
 *
 * Exits 0 on pass, 1 on failure. All diagnostics go to stderr.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");
const cliEntry = join(repoRoot, "dist/cli/index.js");

const STARTING_RE = /Tandem monitor starting/g;
const WAIT_MS = 4_000;

function log(msg) {
  process.stderr.write(`[monitor-smoke] ${msg}\n`);
}

class SmokeFailure extends Error {}

function fail(msg) {
  process.stderr.write(`[monitor-smoke] FAIL: ${msg}\n`);
  throw new SmokeFailure(msg);
}

let child;

async function main() {
  if (!existsSync(cliEntry)) {
    fail(`Built artifact missing — run \`npm run build\` first.\nExpected: ${cliEntry}`);
  }

  log("Spawning `dist/cli/index.js monitor` against a dead port...");
  child = spawn(process.execPath, [cliEntry, "monitor"], {
    env: {
      ...process.env,
      // Dead port: the monitor logs "starting" once, then loops in backoff.
      TANDEM_URL: "http://127.0.0.1:1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.on("error", (err) => {
    log(`Spawn error: ${err.message}`);
  });

  const stderrChunks = [];
  const stdoutChunks = [];
  child.stdout.on("data", (c) => stdoutChunks.push(c.toString("utf8")));
  child.stderr.on("data", (c) => {
    const text = c.toString("utf8");
    stderrChunks.push(text);
    for (const line of text.split("\n")) {
      if (line.trim()) process.stderr.write(`[monitor] ${line}\n`);
    }
  });

  let exitedEarly = false;
  let exitInfo = "";
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      exitedEarly = true;
      exitInfo = `code ${code}${signal ? ` (signal: ${signal})` : ""}`;
    }
  });

  log(`Waiting ${WAIT_MS}ms for startup + reconnect cycles...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  if (exitedEarly) {
    fail(`Process exited unexpectedly before assertions: ${exitInfo}`);
  }

  const stderr = stderrChunks.join("");
  const matches = stderr.match(STARTING_RE) ?? [];
  if (matches.length !== 1) {
    fail(
      `Expected exactly 1 "Tandem monitor starting" line on stderr, got ${matches.length} — ` +
        `a count > 1 means main() ran more than once (double SSE subscription).\nstderr:\n${stderr}`,
    );
  }

  const stdout = stdoutChunks.join("");
  if (/Tandem monitor starting/.test(stdout)) {
    fail(
      `"Tandem monitor starting" leaked onto stdout (reserved for plugin-host line protocol):\n${stdout}`,
    );
  }

  log("PASS — exactly one startup line, stderr-only.");
}

async function cleanup() {
  if (!child) return;
  log("Cleaning up...");
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  log("Process exited.");
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (err) => {
    if (!(err instanceof SmokeFailure)) {
      log(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await cleanup();
    process.exit(1);
  });
