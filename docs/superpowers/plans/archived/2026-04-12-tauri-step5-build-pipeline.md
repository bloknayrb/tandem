# Tauri Step 5: Build Pipeline + CI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cargo tauri build` produce working installers (.dmg/.msi/.AppImage) with bundled Node.js sidecar, and automate cross-platform releases via GitHub Actions.

**Architecture:** Three pieces: (1) populate `bundle.resources` in `tauri.conf.json` so the JS bundles + sample files ship inside the app, (2) a download script that fetches the platform-appropriate Node.js binary and renames it to the target-triple sidecar name, (3) a GitHub Actions matrix workflow that runs the download script + `tauri-action` for each platform. The server's `sample/welcome.md` auto-open also needs a Tauri-aware path so it reads from the app data dir (writable) rather than the read-only bundle.

**Tech Stack:** Tauri v2, GitHub Actions (`tauri-apps/tauri-action@v0`), Node.js 22.x binaries from nodejs.org

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/tauri.conf.json` | Modify | Add `bundle.resources` entries for dist + sample |
| `scripts/download-node-sidecar.mjs` | Create | Download, verify, and rename Node.js binary for current platform |
| `.github/workflows/tauri-release.yml` | Create | Matrix CI: build + release for macOS/Windows/Linux |
| `package.json` | Modify | Add `build:tauri` and `dev:tauri` scripts |
| `src/server/index.ts` | Modify | Tauri-aware sample/welcome.md path (use `TANDEM_DATA_DIR`) |
| `src-tauri/src/lib.rs` | Modify | Copy sample/ files from resources to data dir on first run |

---

### Task 1: Configure `bundle.resources` in `tauri.conf.json`

**Files:**
- Modify: `src-tauri/tauri.conf.json:28-42`

The `resources` array is currently empty. Populate it so the JS server bundle, channel bundle, client assets, and sample files get included in the production app.

- [ ] **Step 1: Edit `tauri.conf.json` to add resource entries**

```json
"resources": [
  "../dist/server/**",
  "../dist/channel/**",
  "../dist/client/**",
  "../sample/**"
]
```

Resource paths are relative to `src-tauri/`. The `../dist/` prefix reaches the project root's build output. The `../sample/` prefix includes the welcome tutorial and demo script.

- [ ] **Step 2: Verify the build command is correct**

`tauri.conf.json` already has `"beforeBuildCommand": "npm run build"` which runs `typecheck + vite build + tsup`. This produces `dist/server/`, `dist/channel/`, `dist/client/` — exactly what resources reference. No change needed.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(tauri): populate bundle.resources with JS bundles and sample files

beforeBuildCommand already produces dist/server, dist/channel, dist/client.
Resources reference these plus sample/ for the welcome tutorial."
```

---

### Task 2: Add `build:tauri` and `dev:tauri` npm scripts

**Files:**
- Modify: `package.json:35-56` (scripts section)

- [ ] **Step 1: Add the scripts**

Add two entries to `package.json` scripts:

```json
"dev:tauri": "cargo tauri dev",
"build:tauri": "cargo tauri build"
```

`cargo tauri dev` runs `beforeDevCommand` (`npm run dev` = Vite) + compiles Rust + opens the dev window. `cargo tauri build` runs `beforeBuildCommand` (`npm run build`) + compiles Rust release + bundles installer.

No wrapper needed — `cargo tauri build` already invokes `npm run build` via `beforeBuildCommand`.

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "feat(tauri): add dev:tauri and build:tauri npm scripts"
```

---

### Task 3: Create Node.js sidecar download script

**Files:**
- Create: `scripts/download-node-sidecar.mjs`

This script downloads the Node.js binary for the current platform, verifies its SHA256 checksum, extracts it, and renames it to the target-triple naming convention Tauri requires (`node-sidecar-{target-triple}[.exe]` in `src-tauri/binaries/`).

- [ ] **Step 1: Create `scripts/download-node-sidecar.mjs`**

```js
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

import { createHash } from "crypto";
import { execSync } from "child_process";
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
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  if (!resp.body) throw new Error(`No response body from ${url}`);
  await pipeline(Readable.fromWeb(resp.body), createWriteStream(tmpPath));
  renameSync(tmpPath, destPath);
}

async function verifyChecksum(archivePath, archiveName, nodeVersion) {
  const shaUrl = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;
  let resp;
  try {
    resp = await fetch(shaUrl);
  } catch {
    console.warn("Could not fetch checksums — skipping verification");
    return;
  }
  if (!resp.ok) {
    console.warn(`Checksum fetch returned HTTP ${resp.status} — skipping verification`);
    return;
  }
  const shasums = await resp.text();
  const line = shasums.split("\n").find((l) => l.includes(archiveName));
  if (!line) {
    console.warn(`No checksum found for ${archiveName} — skipping verification`);
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
  } catch {
    throw new Error(
      `Failed to extract Node.js binary from archive. ` +
        `Expected entry: ${entryPath}. ` +
        `This may indicate download corruption — delete ${archivePath} and re-run.`,
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
  } catch {
    throw new Error(
      `Failed to extract Node.js zip archive. ` +
        `This may indicate download corruption — delete ${archivePath} and re-run.`,
    );
  }

  const extracted = join(tempDir, prefix, info.binary);
  renameSync(extracted, outputPath);

  // Clean up temp dir using Node.js API (cross-platform, no shell quoting issues)
  rmSync(tempDir, { recursive: true, force: true });
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
```

- [ ] **Step 2: Test the script locally**

Run:
```bash
node scripts/download-node-sidecar.mjs
```

Expected: Downloads Node.js, verifies SHA256 checksum, extracts just the `node.exe` binary, places it at `src-tauri/binaries/node-sidecar-x86_64-pc-windows-msvc.exe`. This file is already gitignored by `src-tauri/.gitignore` (`/binaries/`).

- [ ] **Step 3: Fix any issues found during testing, then commit**

```bash
git add scripts/download-node-sidecar.mjs
git commit -m "feat(tauri): add Node.js sidecar download script

Downloads platform-appropriate Node.js binary from nodejs.org,
verifies SHA256 checksum, extracts the node executable, renames
to target-triple convention Tauri requires.

Validates existing binaries by size to catch truncated files from
interrupted builds."
```

---

### Task 4: Make `sample/welcome.md` Tauri-aware in the server

**Files:**
- Modify: `src/server/index.ts:178-208`
- Modify: `src-tauri/src/lib.rs`

**Problem:** In production Tauri builds, the app bundle is read-only. The server currently resolves `sample/welcome.md` relative to `projectRoot` (the bundle). We need:
1. Rust: on first run, copy all `sample/` files from resources to the writable `TANDEM_DATA_DIR`
2. Server: when `TANDEM_DATA_DIR` is set, look for `sample/welcome.md` there instead of in `projectRoot`

**Note on `projectRoot`:** In bundled Tauri builds, `import.meta.url` points to `<resource_dir>/dist/server/index.js`, so `projectRoot` (`../..` from there) resolves to `<resource_dir>` — the read-only bundle root. The `TANDEM_DATA_DIR` override redirects sample lookups to the writable data dir, which is where Rust copies the files. This is correct because `TANDEM_DATA_DIR` is only set by the Tauri sidecar spawn in `lib.rs:199`. The npm-installed CLI never sets it, so `projectRoot` (the repo root) is still used for non-Tauri installs.

- [ ] **Step 1: Modify `src/server/index.ts` to use `TANDEM_DATA_DIR` for sample path**

Replace the sample path resolution (line 193) to check `TANDEM_DATA_DIR` first:

```typescript
// Current:
const samplePath = path.join(projectRoot, "sample/welcome.md");

// New:
const sampleBase = process.env.TANDEM_DATA_DIR || projectRoot;
const samplePath = path.join(sampleBase, "sample/welcome.md");
```

Leave `CHANGELOG.md` (line 184) using `projectRoot` — it only matters for the npm CLI path, and isn't bundled in resources anyway (it would harmlessly ENOENT in Tauri, caught by the existing try/catch).

- [ ] **Step 2: Add sample copy logic to `lib.rs`**

In `lib.rs`, after the `start_sidecar` call in the setup async block, copy all files from `sample/` in resources to the app data dir. Add this function:

```rust
/// Copy sample/ files from resources to the writable data dir.
/// Copies each file only if the destination doesn't already exist (first-run).
fn copy_sample_files(handle: &tauri::AppHandle) -> Result<(), String> {
    let resource_dir = handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;
    let data_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    let src_dir = resource_dir.join("sample");
    let dest_dir = data_dir.join("sample");

    // Skip if source doesn't exist (dev mode without build)
    if !src_dir.exists() {
        log::info!("No bundled sample/ directory — skipping copy");
        return Ok(());
    }

    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create sample dir: {e}"))?;

    let entries = std::fs::read_dir(&src_dir)
        .map_err(|e| format!("Failed to read sample dir: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {e}"))?;
        let dest = dest_dir.join(entry.file_name());
        if !dest.exists() {
            std::fs::copy(entry.path(), &dest)
                .map_err(|e| format!("Failed to copy {}: {e}", entry.file_name().to_string_lossy()))?;
            log::info!("Copied sample/{} to data dir", entry.file_name().to_string_lossy());
        }
    }

    Ok(())
}
```

Call it in the `setup` async block, after `start_sidecar` succeeds and before `run_setup`:

```rust
// Copy sample files to writable data dir (first-run only)
if let Err(e) = copy_sample_files(&handle) {
    log::warn!("Sample file copy failed (non-fatal): {e}");
}
```

Note: this is a synchronous function (not async) — file copies are fast and don't need tokio.

- [ ] **Step 3: Run the existing tests to verify no regressions**

Run:
```bash
npm test -- --run
```

Expected: All 921+ tests pass. The change is gated behind `TANDEM_DATA_DIR` being set, which only happens in Tauri mode.

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts src-tauri/src/lib.rs
git commit -m "feat(tauri): Tauri-aware sample path for read-only bundles

In Tauri production builds, the app bundle is read-only. Rust copies
all sample/ files from resources to TANDEM_DATA_DIR on first run.
Server uses TANDEM_DATA_DIR as base for sample path when set."
```

---

### Task 5: Create GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/tauri-release.yml`

Matrix build for macOS (arm64 + x64), Windows (x64), and Linux (x64). Triggered on version tag push. Uses `tauri-apps/tauri-action@v0`. Generates updater JSON manifest for auto-updates (Step 6 will configure the updater endpoint in `tauri.conf.json`).

- [ ] **Step 1: Create `.github/workflows/tauri-release.yml`**

```yaml
name: Tauri Release

on:
  push:
    tags:
      - "v*"

jobs:
  build-tauri:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: "--target aarch64-apple-darwin"
            node-target: aarch64-apple-darwin
          - platform: macos-latest
            args: "--target x86_64-apple-darwin"
            node-target: x86_64-apple-darwin
          - platform: ubuntu-22.04
            args: ""
            node-target: x86_64-unknown-linux-gnu
          - platform: windows-latest
            args: ""
            node-target: x86_64-pc-windows-msvc

    runs-on: ${{ matrix.platform }}

    steps:
      - uses: actions/checkout@v4

      - name: Install Linux dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: "./src-tauri -> target"

      - name: Install npm dependencies
        run: npm ci

      - name: Download Node.js sidecar
        run: node scripts/download-node-sidecar.mjs --target ${{ matrix.node-target }}

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: v__VERSION__
          releaseName: "Tandem v__VERSION__"
          releaseBody: "See the assets to download and install Tandem."
          releaseDraft: true
          prerelease: false
          updaterJsonPreferNsis: true
          args: ${{ matrix.args }}
```

The `updaterJsonPreferNsis: true` option generates the `latest.json` updater manifest that Step 6 will consume. The manifest is uploaded alongside the release assets.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/tauri-release.yml
git commit -m "ci(tauri): add cross-platform release workflow

Matrix build: macOS arm64+x64, Windows x64, Linux x64.
Triggered on version tag push. Downloads Node.js sidecar per
platform, builds via tauri-action, uploads to GitHub Releases.
Generates updater JSON manifest for auto-update (Step 6)."
```

---

### Task 6: Add sidecar download to `dev:tauri` workflow

**Files:**
- Modify: `package.json:35-56` (scripts section)

The `dev:tauri` script needs to ensure the sidecar binary exists before `cargo tauri dev` runs. Currently developers manually copy `node.exe` — the download script automates this.

- [ ] **Step 1: Update `dev:tauri` to run the download script first**

```json
"dev:tauri": "node scripts/download-node-sidecar.mjs && cargo tauri dev"
```

The script exits early (exit 0) if the binary already exists, so this adds no overhead after the first run.

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "feat(tauri): dev:tauri auto-downloads sidecar on first run

download-node-sidecar.mjs exits immediately if binary exists,
so no overhead after first invocation."
```

---

### Task 7: Smoke test the local build

**Files:** None (verification only)

- [ ] **Step 1: Run `npm run build` to produce the dist/ output**

```bash
npm run build
```

Expected: `dist/server/index.js`, `dist/channel/index.js`, `dist/client/` all exist.

- [ ] **Step 2: Run `cargo tauri build` (debug mode is fine for verification)**

```bash
cd src-tauri && cargo build
```

Expected: Compiles without errors. Full `cargo tauri build` can be attempted but may take longer — the key check is that resource paths resolve and sidecar config is valid.

- [ ] **Step 3: Verify `cargo tauri dev` still works**

```bash
npm run dev:tauri
```

Expected: Vite dev server starts, Rust compiles, window opens with the editor. If the dev server is already running from `dev:standalone`, the sidecar skips spawn and connects to the existing server.

---

## Summary

| Task | Description | Dependencies |
|------|-------------|--------------|
| 1 | `bundle.resources` in tauri.conf.json | None |
| 2 | `build:tauri` + `dev:tauri` npm scripts | None |
| 3 | Node.js sidecar download script | None |
| 4 | Tauri-aware sample/welcome.md | None |
| 5 | GitHub Actions release workflow | Task 3 |
| 6 | Auto-download sidecar in dev:tauri | Tasks 2, 3 |
| 7 | Smoke test | Tasks 1-6 |

Tasks 1-4 are independent and can be parallelized. Task 5 depends on Task 3 (references the download script). Task 6 depends on Tasks 2 and 3. Task 7 is final verification.
