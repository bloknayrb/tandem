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
  ├── node-sidecar (platform-specific Node.js 22 binary, ~30MB)
  ├── dist/
  │   ├── server/index.js    (88KB bundled server, from existing tsup build)
  │   ├── channel/index.js   (bundled channel shim)
  │   └── client/            (static HTML/CSS/JS from existing Vite build)
  └── sample/welcome.md
```

**Flow:**
1. User double-clicks Tandem icon
2. Tauri Rust shell spawns `node-sidecar dist/server/index.js` as a managed sidecar process
3. Tauri webview loads `http://localhost:3479` (server serves static client assets)
4. On first run: auto-detect Claude Code/Desktop, write MCP config (reuses `detectTargets()` + `applyConfig()` from `src/cli/setup.ts`)
5. System tray icon persists with menu: "Open Editor", "Setup Claude", "Quit"

---

## Implementation Plan

### Step 1: Tauri Project Scaffolding
- Initialize `src-tauri/` with `cargo create-tauri-app` or manual setup
- Create `tauri.conf.json` with:
  - `bundle.identifier`: `com.tandem.editor`
  - `windows`: single window pointing to `http://localhost:3479`
  - `build.beforeBuildCommand`: `npm run build` (existing build pipeline)
  - `build.frontendDist`: `../dist/client` (existing Vite output)
- Minimal `src-tauri/src/main.rs`: window creation, sidecar lifecycle, system tray
- **Files:** New `src-tauri/` directory, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`

### Step 2: Node.js Sidecar Integration
- Configure Tauri sidecar to bundle platform-specific Node.js 22 binary
- Sidecar manifest in `tauri.conf.json` declares the Node binary + `dist/server/index.js` as args
- Rust code manages sidecar lifecycle:
  - Spawn on app start
  - Wait for server health (`GET http://localhost:3479/health` polling, replicating the pattern from `src/server/platform.ts:waitForPort()`)
  - Load webview URL only after health check passes
  - Forward SIGTERM/SIGINT on app quit (matches pattern in `src/cli/start.ts:36-38`)
  - Restart sidecar if it crashes
- Set `TANDEM_OPEN_BROWSER=0` (Tauri provides the webview; don't also open a system browser)
- **Files:** `src-tauri/tauri.conf.json` (sidecar config), `src-tauri/src/main.rs` (sidecar management)
- **Key reference:** `src/server/platform.ts` — `waitForPort()` pattern for health checking

### Step 3: First-Run Setup Flow
- On first launch, detect if Claude Code or Claude Desktop is installed (reuse logic from `src/cli/setup.ts:detectTargets()`)
- If found: auto-write MCP config via `applyConfig()` logic
- If not found: show a setup dialog in the webview explaining that Claude is required, with download links
- Store "setup complete" flag in platform-appropriate app data dir (already using `env-paths` in `src/server/session/manager.ts`)
- Install the Claude Code skill to `~/.claude/skills/tandem/SKILL.md` (reuse `installSkill()` from `src/cli/setup.ts:156`)
- **Files:** `src-tauri/src/main.rs` (first-run check), new `src/setup-bridge.ts` or invoke existing `setup.ts` functions via sidecar
- **Key reference:** `src/cli/setup.ts` — `detectTargets()`, `applyConfig()`, `installSkill()`, `buildMcpEntries()`

### Step 4: System Tray
- Add system tray icon with menu:
  - "Open Editor" — bring window to front / reopen if closed
  - "Setup Claude" — re-run MCP config detection and registration
  - "About Tandem" — version info
  - "Quit" — graceful shutdown (stop sidecar, close window)
- Closing the window hides to tray (server keeps running); "Quit" from tray actually exits
- **Files:** `src-tauri/src/main.rs` (tray setup), tray icon assets in `src-tauri/icons/`

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
- **Files:** `.github/workflows/tauri-release.yml`, `scripts/download-node-sidecar.sh`, `package.json` (new scripts)

### Step 6: Auto-Update
- Configure Tauri's built-in updater in `tauri.conf.json`:
  - `updater.endpoints`: point to GitHub Releases JSON manifest
  - `updater.dialog`: true (show update prompt to user)
- On update: download new bundle, replace sidecar + client assets, restart
- **Files:** `src-tauri/tauri.conf.json` (updater config)

### Step 7: Code Signing (Optional for v1)
- **macOS:** Apple Developer account ($99/yr), notarize with `xcrun notarytool`
- **Windows:** Code signing certificate (~$200-400/yr), sign with `signtool`
- Can ship unsigned for initial testing (macOS shows "unidentified developer" warning, user can right-click > Open to bypass; Windows shows SmartScreen warning)
- **Recommendation:** Ship unsigned v1 to unblock testing. Add signing before public distribution.

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
| Session storage paths | `src/server/session/manager.ts` (via `env-paths`) | Step 3: First-run flag storage |
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
  └── src/
      └── main.rs              (Sidecar management, system tray, first-run setup)

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
2. "Setting up..." — auto-detects Claude, writes MCP config
3. Editor opens with `sample/welcome.md` and tutorial annotations
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
| Sidecar port conflicts | Reuse existing `freePort()` logic from `src/server/platform.ts` |
| Code signing costs | Ship unsigned v1. Sign before public/marketing launch. |

---

## Verification

- [ ] `cargo tauri dev` starts sidecar + opens webview with working editor
- [ ] First-run detects Claude Desktop and writes MCP config
- [ ] Closing window hides to tray; "Quit" from tray kills sidecar
- [ ] `cargo tauri build` produces working `.dmg` / `.msi` / `.AppImage`
- [ ] Auto-updater detects new GitHub Release and updates successfully
- [ ] Existing E2E tests pass against the Tauri-hosted server (same ports, same API)
- [ ] Tutorial annotations appear on first launch with `sample/welcome.md`
