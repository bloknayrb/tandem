# Plan: Tauri Desktop App for Tandem

## Context

Tandem is a collaborative AI-human document editor targeting writers, editors, and content creators. The current installation requires Node.js 22+, npm, and terminal commands — unacceptable for the target audience. The browser UI is excellent once running; the problem is getting there.

**Decision:** Skip incremental CLI improvements. Build a Tauri desktop app that eliminates ALL CLI friction: double-click install, no Node.js, no terminal.

**Why Tauri:**
- ADR-015 explicitly chose tsup bundling to prepare for Tauri sidecar packaging
- System webview = ~40-60MB installer (vs. Electron's ~150-200MB)
- First-class sidecar support for bundling Node.js + server
- Built-in auto-updater via GitHub Releases
- Zero native modules in Tandem = clean bundling

---

## Architecture

```
Tandem.app / Tandem.exe / Tandem.AppImage
  ├── tandem-app (Rust/Tauri shell, ~3MB)
  ├── binaries/
  │   └── node-sidecar-{target-triple}[.exe]   (platform Node.js 22, ~30MB, Tauri sidecar)
  ├── resources/
  │   ├── dist/server/index.js    (88KB bundled server, from existing tsup build)
  │   ├── dist/channel/index.js   (bundled channel shim)
  │   ├── dist/client/            (static HTML/CSS/JS from existing Vite build)
  │   └── sample/welcome.md
  └── (system webview, not bundled)
```

**Key distinction:** The Node.js binary is a **sidecar** (`bundle.externalBin`) — an executable Tauri manages the lifecycle of. Everything else is a **resource** (`bundle.resources`) — data files resolved at runtime via `app.path().resource_dir()`. Tauri requires these to be separate; JS files cannot go in the sidecar manifest.

**Flow:**
1. User double-clicks Tandem icon
2. `tauri-plugin-single-instance` checks for existing instance — if found, focuses that window and exits
3. Tauri Rust shell spawns `node-sidecar` with resolved resource path: `node-sidecar <resource_dir>/dist/server/index.js`
4. Rust polls `GET http://localhost:3479/health` until ready, then loads webview
5. On every launch: validate MCP config paths, re-write if stale (reuses `detectTargets()` + `applyConfig()` logic from `src/cli/setup.ts`, with absolute path to bundled Node binary)
6. System tray icon persists with menu: "Open Editor", "Setup Claude", "Quit"

---

## Implementation Plan

### Step 1: Tauri Project Scaffolding ✅
- Initialize `src-tauri/` with `cargo create-tauri-app` or manual setup
- Create `tauri.conf.json` with:
  - `bundle.identifier`: `com.tandem.editor`
  - `bundle.externalBin`: `["binaries/node-sidecar"]` (Node.js binary only — JS files are resources)
  - `bundle.resources`: `["dist/server/**", "dist/channel/**", "dist/client/**", "sample/**"]`
  - `windows`: single window (URL set dynamically from Rust after sidecar health check)
  - `build.beforeBuildCommand`: `npm run build` (existing build pipeline)
  - `build.frontendDist`: `../dist/client` (existing Vite output)
- Configure `src-tauri/capabilities/default.json` to allow sidecar execution with JS path argument
- Minimal `src-tauri/src/main.rs`: window creation, sidecar lifecycle, system tray
- **Files:** New `src-tauri/` directory, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`

### Step 2: Node.js Sidecar Integration ✅
- Node.js binary declared as sidecar in `bundle.externalBin`; JS bundles declared as resources in `bundle.resources`
- At runtime, Rust resolves the resource dir path and spawns: `node-sidecar <resource_dir>/dist/server/index.js`
- Rust code manages sidecar lifecycle:
  - Spawn on app start with env: `TANDEM_OPEN_BROWSER=0`, `TANDEM_DATA_DIR=<app_data_dir>` (align session storage with Tauri's app data, not env-paths default)
  - Wait for server health (`GET http://localhost:3479/health` polling, replicating the pattern from `src/server/platform.ts:waitForPort()`)
  - Load webview URL only after health check passes
  - Forward SIGTERM/SIGINT on app quit (matches pattern in `src/cli/start.ts:36-38`)
  - **Crash recovery:** detect sidecar exit, auto-restart up to 3 times with backoff, show user-visible error after exhausting retries ("Server stopped unexpectedly. Restart?"). Non-technical users cannot recover from a terminal.
  - Route sidecar stdout to Rust's log (not Tauri's IPC) — stdout is reserved for MCP wire protocol in stdio mode; avoid capture conflicts with the channel shim
- Port strategy: keep fixed ports 3478/3479 (current behavior). `freePort()` kills stale processes on startup. Single-instance protection (Step 4) prevents the "second instance kills first" scenario, making dynamic port discovery unnecessary.
- **Files:** `src-tauri/tauri.conf.json` (sidecar + resource config), `src-tauri/src/main.rs` (sidecar management)
- **Key reference:** `src/server/platform.ts` — `waitForPort()` pattern for health checking

### Step 3: MCP Setup (Every Launch) ✅
- **On every launch** (not just first run): validate and update MCP config paths. App updates, relocations (macOS drag to /Applications), and OS updates can invalidate absolute paths. Cost is a single JSON file write.
- Detect if Claude Code or Claude Desktop is installed (reuse logic from `src/cli/setup.ts:detectTargets()`)
- **Critical:** MCP config for `tandem-channel` must write the **absolute path to the bundled Node binary** as `command`, not `"node"`. Resolve via Tauri's `app.path().resource_dir()` at runtime. Example output:
  ```json
  "tandem-channel": {
    "command": "/Applications/Tandem.app/Contents/MacOS/node-sidecar",
    "args": ["/Applications/Tandem.app/Contents/Resources/dist/channel/index.js"],
    "env": { "TANDEM_URL": "http://localhost:3479" }
  }
  ```
- If Claude not found: show a setup dialog explaining Claude Desktop is required, with download link and explicit status: "Claude integration: configured / not found / error"
- Install the Claude Code skill to `~/.claude/skills/tandem/SKILL.md` (reuse `installSkill()` from `src/cli/setup.ts:156`)
- **Product decision:** Primary target is Claude Desktop (non-technical users). Claude Code support is secondary. `detectTargets()` handles both — write config for whichever is found.
- **"Launch Claude" button:** Detect if Claude Desktop is installed; if so, launch via OS app launcher (`open` on macOS, `start` on Windows). If Claude Code CLI is available, use current `spawn("claude")` behavior. If neither found, show download instructions. Hide the button entirely if no Claude integration is detected.
- **Files:** `src-tauri/src/main.rs` (launch-time validation), new `src/setup-bridge.ts` or invoke existing `setup.ts` functions via sidecar
- **Key reference:** `src/cli/setup.ts` — `detectTargets()`, `applyConfig()`, `installSkill()`, `buildMcpEntries()`

### Step 4: Single Instance + System Tray
- **Single-instance protection (required):** Add `tauri-plugin-single-instance` — must be the **first plugin registered**. On second launch, focus the existing window and exit. Without this, a second instance's `freePort()` kills the running server.
- Add system tray icon with menu:
  - "Open Editor" — bring window to front / reopen if closed
  - "Setup Claude" — re-run MCP config detection and registration
  - "About Tandem" — version info
  - "Quit" — graceful shutdown (stop sidecar, close window)
- Closing the window hides to tray (server keeps running); "Quit" from tray actually exits
- **Files:** `src-tauri/Cargo.toml` (single-instance dep), `src-tauri/src/main.rs` (tray + instance guard), tray icon assets in `src-tauri/icons/`

### Step 5: Build Pipeline + CI
- Add build scripts to `package.json`:
  - `build:tauri` — runs `npm run build` then `cargo tauri build`
  - `dev:tauri` — runs `npm run dev` then `cargo tauri dev`
- GitHub Actions workflow (`.github/workflows/tauri-release.yml`):
  - Triggered on version tag push (e.g., `v0.4.0`)
  - Matrix build: macOS (x64 + arm64), Windows (x64), Linux (x64)
  - Uses `tauri-apps/tauri-action` for builds
  - Uploads `.dmg`, `.msi`, `.AppImage` to GitHub Releases
  - Generates Tauri updater JSON manifest for auto-updates
- Download Node.js binaries for each platform at build time (pre-build script)
- **Target-triple naming (required):** Tauri sidecar binaries must be named `node-sidecar-{target-triple}[.exe]` exactly matching the Rust compilation target (e.g., `node-sidecar-x86_64-apple-darwin`, `node-sidecar-aarch64-apple-darwin`, `node-sidecar-x86_64-pc-windows-msvc.exe`). The pre-build script must detect the active target via `rustc -vV | grep host` and rename the downloaded Node binary accordingly. Build will fail without this.
- **`sample/welcome.md` copy (from Step 3 deferral):** The app bundle is read-only in production. The server's welcome.md auto-open writes to the file's original path, which fails in a read-only bundle. Step 5 must copy `sample/welcome.md` from `bundle.resources` to the user data dir at first-run (or on version upgrade), and configure the server to open the copy. The existing `TANDEM_DATA_DIR` env var gives the sidecar the right location.
- **Files:** `.github/workflows/tauri-release.yml`, `scripts/download-node-sidecar.sh`, `package.json` (new scripts)

### Step 6: Auto-Update
- Configure Tauri's built-in updater in `tauri.conf.json`:
  - `updater.endpoints`: point to GitHub Releases JSON manifest
  - `updater.dialog`: true (show update prompt to user)
- On update: download new bundle, replace sidecar + client assets, restart
- **Files:** `src-tauri/tauri.conf.json` (updater config)

### Step 7: Code Signing
- **macOS:** Apple Developer account ($99/yr), notarize with `xcrun notarytool`
  - On Apple Silicon, **all native code must be at least ad-hoc signed** (`codesign -s -`). Completely unsigned ARM64 binaries are blocked from executing — this is hardware-enforced, not bypassable by users. Ad-hoc sign during development; get a real cert before distribution.
  - Notarization must cover the sidecar binary individually, not just the outer `.app` bundle.
- **Windows:** Code signing certificate (~$200-400/yr), sign with `signtool`
  - **Windows SmartScreen** shows a blocking "Windows protected your PC" dialog for unsigned `.msi` installers. For non-technical users, this is a conversion killer — they won't know to click "More info" → "Run anyway". Prioritize Windows signing for public distribution.
- **Recommendation:** Use ad-hoc signing from day one (macOS). Get real certificates before any distribution outside the dev team. The review was right that "ship unsigned" is riskier than it sounds — both platforms actively discourage running unsigned apps.

---

## Key Existing Code to Reuse

| Existing Code | Location | Reuse In |
|---|---|---|
| MCP config detection + writing | `src/cli/setup.ts` — `detectTargets()`, `applyConfig()`, `buildMcpEntries()` | Step 3: First-run setup |
| Skill installation | `src/cli/setup.ts` — `installSkill()` | Step 3: First-run setup |
| Port health checking | `src/server/platform.ts` — `waitForPort()` | Step 2: Sidecar health check |
| Signal forwarding pattern | `src/cli/start.ts:36-38` | Step 2: Sidecar lifecycle |
| Server entry point | `dist/server/index.js` | Step 2: Sidecar target |
| Channel shim | `dist/channel/index.js` | Step 3: MCP config channel entry |
| Static client assets | `dist/client/` | Step 1: Webview content |
| Session storage paths | `src/server/session/manager.ts` (via `env-paths`) | Step 2: `TANDEM_DATA_DIR` alignment |
| tsup single-file bundling | `tsup.config.ts` | Step 1: Existing build produces sidecar-ready bundles |

---

## New Files to Create

```
src-tauri/
  ├── Cargo.toml              (Rust dependencies: tauri, serde, reqwest)
  ├── tauri.conf.json          (App config: window, sidecar, updater, bundle)
  ├── build.rs                 (Tauri build script)
  ├── icons/                   (App icons for all platforms)
  │   ├── icon.ico
  │   ├── icon.icns
  │   ├── icon.png
  │   └── ...
  ├── capabilities/
  │   └── default.json         (Permissions: sidecar execution with JS arg allowlist)
  └── src/
      └── main.rs              (Sidecar management, system tray, single-instance, MCP config)

scripts/
  └── download-node-sidecar.sh (Download platform Node.js binary for bundling)

.github/workflows/
  └── tauri-release.yml        (CI: build + sign + release for 3 platforms)
```

---

## Target User Experience

**Install:**
1. Go to GitHub Releases (or future website)
2. Download `.dmg` (Mac) / `.msi` (Windows) / `.AppImage` (Linux)
3. Install (drag to Applications / run installer / chmod +x)

**First Run:**
1. Double-click Tandem icon
2. "Setting up..." — auto-detects Claude, writes MCP config with bundled Node path
3. Copies `sample/welcome.md` from app bundle to user data dir (app bundle is read-only); editor opens the copy with tutorial annotations
4. System tray icon appears

**Daily Use:**
1. Click Tandem in dock/taskbar (or system tray > "Open Editor")
2. Editor opens, server starts automatically
3. Claude connects via MCP (auto-configured from first run)

**Update:**
1. Dialog appears: "Tandem v0.5.0 is available. Update now?"
2. Click "Update" — app restarts with new version

**No terminal. No Node.js. No npm. No port management.**

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Tauri requires Rust toolchain for development | Only needed for building, not for users. CI handles release builds. |
| macOS WebKit webview differs from Chrome | Tandem uses standard React/Tiptap — test early, fix CSS differences |
| Windows WebView2 availability | Ships with Windows 10 21H2+ and Windows 11. Tauri auto-installs it if missing. |
| Linux webkitgtk dependency | AppImage bundles it. Document system package requirement for .deb. |
| Node.js binary size (~30MB) | Acceptable for a desktop app. Total installer ~40-60MB. |
| Sidecar port conflicts | Fixed ports + single-instance plugin. `freePort()` kills stale processes; no second instance to compete. |
| Sidecar crash | Auto-restart up to 3x with backoff. User-visible error after exhaustion. |
| MCP config path staleness | Re-validate and rewrite on every launch, not just first run. |
| Session dir divergence | Pass `TANDEM_DATA_DIR` to sidecar, aligning with Tauri's app data dir. |
| Code signing costs | Ad-hoc sign from day one (macOS ARM64 requires it). Real certs before public distribution. |
| Windows SmartScreen | Unsigned MSI shows blocking dialog. Prioritize Windows cert for public launch. |
| Claude Desktop vs. Code targeting | Detect both, write config for whichever is found. Claude Desktop is primary for non-technical users. |

---

## Verification

- [ ] `cargo tauri dev` starts sidecar + opens webview with working editor
- [ ] MCP config written with absolute bundled Node path (not `"node"`)
- [ ] MCP config re-validated on subsequent launches (paths updated if app relocated)
- [ ] Second app launch focuses existing window (single-instance works)
- [ ] Sidecar crash triggers auto-restart; user sees error after 3 failures
- [ ] Closing window hides to tray; "Quit" from tray kills sidecar
- [ ] `cargo tauri build` produces working `.dmg` / `.msi` / `.AppImage`
- [ ] Node sidecar binary correctly named with target triple in each platform build
- [ ] Auto-updater detects new GitHub Release and updates successfully
- [ ] Existing E2E tests pass against the Tauri-hosted server (same ports, same API)
- [ ] Tutorial annotations appear on first launch with `sample/welcome.md` (copied to user data dir)
- [ ] "Launch Claude" button opens Claude Desktop (or shows instructions if not installed)

---

## Progress

| Step | Description | Status |
|------|-------------|--------|
| 1 | Tauri Project Scaffolding | Done |
| 2 | Node.js Sidecar Integration | Done |
| 3 | MCP Setup (Every Launch) | Done |
| 4 | Single Instance + System Tray | Not started |
| 5 | Build Pipeline + CI | Not started |
| 6 | Auto-Update | Not started |
| 7 | Code Signing | Not started |

### Dev Notes

- `bundle.resources` is currently empty — `dist/server/**`, `dist/channel/**`, `dist/client/**`, `sample/**` will be added in Step 5 (build pipeline) when production builds are configured.
- Sidecar binary for dev: `node.exe` copied to `src-tauri/binaries/node-sidecar-{target-triple}.exe` (gitignored). Production builds will use a download script.
- `start_sidecar()` checks health first and skips spawn if server is already running — allows `cargo tauri dev` alongside manual `npm run dev:standalone`.
- Window close hides to tray (server keeps running); app exit kills sidecar.
