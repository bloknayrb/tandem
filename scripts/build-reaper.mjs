#!/usr/bin/env node

/**
 * Compile the `tandem-reaper` crate and place the binary in
 * src-tauri/binaries/ with the target-triple name Tauri expects, mirroring
 * scripts/download-node-sidecar.mjs.
 *
 * The reaper is the auto-launcher's process-tree babysitter: the desktop app
 * spawns Claude Code *through* it so Claude dies when Tandem dies. It is an
 * `externalBin` in tauri.conf.json, so it MUST exist at
 * src-tauri/binaries/tandem-reaper-<triple>[.exe] before any `cargo tauri
 * build`/`dev` — `tauri_build::build()` validates every declared externalBin.
 *
 * Usage:
 *   node scripts/build-reaper.mjs [--target <triple>]
 *
 * If --target is omitted, the host triple (via `rustc -vV`) is used and the
 * crate is built NATIVELY (no `--target` flag → output under
 * reaper/target/release/). When --target IS given (the CI matrix passes it,
 * including the macOS cross-builds), it is forwarded to cargo and the output
 * lands under reaper/target/<triple>/release/. The output filename always
 * carries the resolved triple regardless.
 */

import { execFileSync } from "child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const REAPER_DIR = join(PROJECT_ROOT, "reaper");
const BINARIES_DIR = join(PROJECT_ROOT, "src-tauri", "binaries");

// The only triples Tandem ships a desktop build for — same allowlist as the
// node-sidecar downloader. An unknown triple is rejected rather than passed to
// cargo, so a stray `--target` value can never reach the build invocation.
const SUPPORTED_TRIPLES = new Set([
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
]);

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function detectHostTriple() {
  // execFileSync with an arg array (shell:false by default) — no shell parsing.
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf-8" });
  const match = output.match(/^host:\s*(.+)$/m);
  if (!match) throw new Error("Could not detect host triple from `rustc -vV`");
  return match[1].trim();
}

// --- Main ---

const explicitTarget = getArg("--target");
const targetTriple = explicitTarget || detectHostTriple();

if (!SUPPORTED_TRIPLES.has(targetTriple)) {
  console.error(`Unsupported target triple: ${targetTriple}`);
  console.error(`Supported: ${[...SUPPORTED_TRIPLES].join(", ")}`);
  process.exit(1);
}

const isWindows = targetTriple.includes("windows");
const exeSuffix = isWindows ? ".exe" : "";

// Forward --target to cargo ONLY when it was explicitly requested. A bare
// invocation builds natively (host triple) so the output stays under
// reaper/target/release/ — the path the webdriver workflow and local dev rely on.
const cargoArgs = ["build", "--release"];
if (explicitTarget) cargoArgs.push("--target", explicitTarget);

console.log(`Building tandem-reaper (${targetTriple})...`);
execFileSync("cargo", cargoArgs, { cwd: REAPER_DIR, stdio: "inherit" });

const sourcePath = join(
  REAPER_DIR,
  "target",
  ...(explicitTarget ? [explicitTarget, "release"] : ["release"]),
  `tandem-reaper${exeSuffix}`,
);
if (!existsSync(sourcePath)) {
  console.error(`cargo build succeeded but the binary is missing at ${sourcePath}`);
  process.exit(1);
}

const outputPath = join(BINARIES_DIR, `tandem-reaper-${targetTriple}${exeSuffix}`);
// Wrap the filesystem ops so a failure prints a friendly message + exits 1,
// matching the explicit treatment of the other failure modes above (raw
// throws would non-zero-exit too, but with an unhelpful stack).
try {
  mkdirSync(BINARIES_DIR, { recursive: true });
  copyFileSync(sourcePath, outputPath);
  if (!isWindows) chmodSync(outputPath, 0o755);
} catch (err) {
  console.error(`Failed to place reaper binary at ${outputPath}: ${err.message}`);
  process.exit(1);
}

const size = statSync(outputPath).size;
if (size === 0) {
  console.error(`Copied reaper is empty: ${outputPath}`);
  process.exit(1);
}
console.log(`Reaper ready (${(size / 1024).toFixed(0)}KB): ${outputPath}`);
