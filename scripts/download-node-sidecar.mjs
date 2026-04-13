#!/usr/bin/env node

/**
 * Download a platform-appropriate Node.js binary and place it in
 * src-tauri/binaries/ with the target-triple name Tauri expects.
 *
 * Usage:
 *   node scripts/download-node-sidecar.mjs [--target <triple>] [--node-version <version>]
 *
 * If --target is omitted, detects the host triple via `rustc -vV`.
 * Defaults to Node.js 22 (LTS).
 */

import { execSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "fs";
import { dirname, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const BINARIES_DIR = join(PROJECT_ROOT, "src-tauri", "binaries");

// Node.js binary is at least 20MB on all platforms
const MIN_SIDECAR_SIZE = 20 * 1024 * 1024;

// Map Rust target triples to Node.js download platform/arch
const TRIPLE_MAP = {
  "x86_64-pc-windows-msvc": { platform: "win", arch: "x64", binary: "node.exe" },
  "aarch64-pc-windows-msvc": { platform: "win", arch: "arm64", binary: "node.exe" },
  "x86_64-apple-darwin": { platform: "darwin", arch: "x64", binary: "bin/node" },
  "aarch64-apple-darwin": { platform: "darwin", arch: "arm64", binary: "bin/node" },
  "x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64", binary: "bin/node" },
  "aarch64-unknown-linux-gnu": { platform: "linux", arch: "arm64", binary: "bin/node" },
};

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function detectHostTriple() {
  const output = execSync("rustc -vV", { encoding: "utf-8" });
  const match = output.match(/^host:\s*(.+)$/m);
  if (!match) throw new Error("Could not detect host triple from `rustc -vV`");
  return match[1].trim();
}

async function download(url, destPath) {
  console.log(`Downloading ${url}`);
  const tmpPath = destPath + ".tmp";
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    if (!resp.body) throw new Error(`No response body from ${url}`);
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(tmpPath));
    renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

const isCI = process.env.CI === "true";

async function verifyChecksum(archivePath, archiveName, nodeVersion) {
  const shaUrl = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;
  let resp;
  try {
    resp = await fetch(shaUrl);
  } catch (err) {
    if (isCI) throw new Error(`Checksum fetch failed in CI: ${err.message}`);
    console.warn("WARNING: Could not fetch checksums — skipping verification");
    return;
  }
  if (!resp.ok) {
    if (isCI) throw new Error(`Checksum fetch returned HTTP ${resp.status} in CI`);
    console.warn(`WARNING: Checksum fetch returned HTTP ${resp.status} — skipping verification`);
    return;
  }
  const shasums = await resp.text();
  const line = shasums.split("\n").find((l) => l.includes(archiveName));
  if (!line) {
    if (isCI) throw new Error(`No checksum found for ${archiveName} in CI`);
    console.warn(`WARNING: No checksum found for ${archiveName} — skipping verification`);
    return;
  }
  const expectedHash = line.split(/\s+/)[0];
  const fileBuffer = readFileSync(archivePath);
  const actualHash = createHash("sha256").update(fileBuffer).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${archiveName}!\n` +
        `Expected: ${expectedHash}\n` +
        `Got:      ${actualHash}\n` +
        `Delete ${archivePath} and re-run, or check your network connection.`,
    );
  }
  console.log(`Checksum verified: ${archiveName}`);
}

function extractTarGz(archivePath, nodeVersion, info, outputPath) {
  const prefix = `node-v${nodeVersion}-${info.platform}-${info.arch}`;
  const entryPath = `${prefix}/${info.binary}`;

  try {
    execSync(
      `tar -xzf "${archivePath}" -C "${dirname(outputPath)}" --strip-components=2 "${entryPath}"`,
      { stdio: "inherit" },
    );
  } catch (err) {
    throw new Error(
      `Failed to extract Node.js binary from archive. ` +
        `Expected entry: ${entryPath}. ` +
        `This may indicate download corruption — delete ${archivePath} and re-run.\n` +
        `Original error: ${err.message} (exit code ${err.status})`,
    );
  }

  // tar extracts to dirname(outputPath)/node — rename to final sidecar name
  const extractedName = join(dirname(outputPath), "node");
  if (extractedName !== outputPath) {
    renameSync(extractedName, outputPath);
  }
  chmodSync(outputPath, 0o755);
}

function extractZip(archivePath, nodeVersion, info, outputPath) {
  const prefix = `node-v${nodeVersion}-win-${info.arch}`;
  const tempDir = join(dirname(archivePath), "_node_extract");

  try {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" },
    );
  } catch (err) {
    throw new Error(
      `Failed to extract Node.js zip archive. ` +
        `This may indicate download corruption — delete ${archivePath} and re-run.\n` +
        `Original error: ${err.message} (exit code ${err.status})`,
    );
  }

  try {
    const extracted = join(tempDir, prefix, info.binary);
    renameSync(extracted, outputPath);
  } finally {
    // Clean up temp dir using Node.js API (cross-platform, no shell quoting issues)
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// --- Main ---

const nodeVersion = getArg("--node-version") || "22.17.0";
const targetTriple = getArg("--target") || detectHostTriple();

const info = TRIPLE_MAP[targetTriple];
if (!info) {
  console.error(`Unsupported target triple: ${targetTriple}`);
  console.error(`Supported: ${Object.keys(TRIPLE_MAP).join(", ")}`);
  process.exit(1);
}

const isWindows = info.platform === "win";
const sidecarName = `node-sidecar-${targetTriple}${isWindows ? ".exe" : ""}`;
const outputPath = join(BINARIES_DIR, sidecarName);

// Validate existing binary — a truncated file from an interrupted build must be re-downloaded
if (existsSync(outputPath)) {
  const size = statSync(outputPath).size;
  if (size >= MIN_SIDECAR_SIZE) {
    console.log(`Sidecar already exists (${(size / 1e6).toFixed(1)}MB): ${outputPath}`);
    process.exit(0);
  }
  console.warn(`Existing sidecar is suspiciously small (${size} bytes) — re-downloading`);
  unlinkSync(outputPath);
}

mkdirSync(BINARIES_DIR, { recursive: true });

const archiveName = isWindows
  ? `node-v${nodeVersion}-win-${info.arch}.zip`
  : `node-v${nodeVersion}-${info.platform}-${info.arch}.tar.gz`;
const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
const archivePath = join(BINARIES_DIR, archiveName);

try {
  await download(url, archivePath);
  await verifyChecksum(archivePath, archiveName, nodeVersion);

  if (isWindows) {
    extractZip(archivePath, nodeVersion, info, outputPath);
  } else {
    extractTarGz(archivePath, nodeVersion, info, outputPath);
  }

  console.log(`Sidecar ready: ${outputPath}`);
} finally {
  try {
    unlinkSync(archivePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`Could not clean up archive ${archivePath}: ${err.message}`);
    }
  }
}
