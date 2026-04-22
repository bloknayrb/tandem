# Tauri Architecture Review for Tandem

This document is a companion to the [Tauri Desktop App Plan](./tauri-plan.md), providing a critical review of the proposed architecture, identifying potential flaws, and suggesting necessary mitigations before implementation begins.

## Plain-Language Summary

The plan is headed in the right direction, but it has a "catch-22" regarding Node.js. The goal is to avoid making the user install Node.js, but the current MCP configuration relies on it. To fix this, the app needs to tell Claude to use the "secret" Node.js binary hidden inside the app bundle. 

In this deeper dive, I've discovered several other critical flaws regarding how the app bundles its files, how it communicates with Claude, and how the "Launch Claude" button works. For example, if a user clicks "Launch Claude" in the app, it will try to run a developer tool (`claude` CLI) that your target audience won't have installed! I've detailed these issues and their solutions below.

---

## Detailed Findings Report

### 1. Critical Architecture Flaws (Needs immediate revision)

*   **The "No Node.js" Contradiction in MCP Config:**
    *   **The Flaw:** The plan states that the app will require "no Node.js". However, `src/cli/setup.ts` configures Claude's MCP to use `command: "node"`, `args: ["channel/index.js"]`. If the user doesn't have Node installed globally, Claude will silently fail to connect.
    *   **The Solution:** The Tauri Rust shell (or the setup script) must dynamically resolve the *absolute path* to the bundled Node.js sidecar binary (e.g., `C:\Program Files\Tandem\node.exe` or `/Applications/Tandem.app/Contents/MacOS/node`) and write *that* as the `command` in the `claude_desktop_config.json`.

*   **Sidecar vs. Resource Bundling Confusion:**
    *   **The Flaw:** The plan states `tauri.conf.json` declares the "Node binary + dist/server/index.js as args" in the sidecar manifest. Tauri sidecars are explicitly standalone binaries; they do not take dynamic JavaScript files as arguments in the `tauri.conf.json` definition.
    *   **The Solution:** You must declare *only* the Node.js binary as the sidecar (`bundle.externalBin: ["node-sidecar"]`). The compiled Javascript (`dist/server/index.js` and `dist/client/*`) must be declared as application resources (`bundle.resources: [...]`). The Rust initialization code must then dynamically resolve the path to the `dist/server/index.js` resource and pass it as an argument when spawning the `node-sidecar` command.

*   **Dynamic Port Discovery Handshake vs. MCP Config:**
    *   **The Flaw:** The plan mentions using `freePort()` to prevent port conflicts, but also states the webview will load `http://localhost:3479`. Furthermore, `claude_desktop_config.json` hardcodes `TANDEM_URL` via the setup script. If the sidecar discovers port 3479 is in use and falls back to 3480, Claude will connect to the wrong port, and the webview will load a dead page.
    *   **The Solution:** The Node sidecar needs to output its selected port to `stdout` (e.g., `SERVER_READY_PORT=3480`). The Rust shell must read the sidecar's `stdout`, parse the port, and *then* initialize the webview pointing to the correct dynamic URL. It must also rewrite the MCP config with the new port *every time* it changes.

*   **The Single-Instance Problem:**
    *   **The Flaw:** The plan says closing the window hides it to the tray, and the server keeps running. If the user forgets it's in the tray and double-clicks the Tandem app icon again, the OS will spawn a *second* Rust shell. This second shell will spawn a second sidecar, which will likely crash due to database locks or port contention.
    *   **The Solution:** You must implement the `tauri-plugin-single-instance` plugin. If a second instance is launched, it should send a signal to the primary instance to unhide/focus its window, and then the second instance should immediately exit.

### 2. UX & State Management Omissions

*   **The "Launch Claude" Button Failure for Non-Developers:**
    *   **The Flaw:** The current `src/server/mcp/launcher.ts` logic (`POST /api/launch-claude`) uses `child_process.spawn("claude")`. If the target audience doesn't have Node.js and the `@anthropic-ai/claude-code` npm package installed, clicking this button in the app will silently fail or throw an error.
    *   **The Solution:** The backend should detect if it's running in Tauri mode or detect if the `claude` CLI is available. If it's not available, the UI should either attempt to launch Claude Desktop (e.g. via deep link if Anthropic supports it), show a helpful dialog instructing the user to open Claude Desktop manually, or hide the button entirely.

*   **The App Update / Relocation Breakage:**
    *   **The Flaw:** The plan states MCP config is written "On first run". If the app updates, or if a macOS user moves `Tandem.app` from their Downloads folder to their Applications folder, the absolute paths inside the Claude config will instantly break.
    *   **The Solution:** Do not limit the MCP config check to the "first run". The app should validate and update the MCP config paths *on every single launch* to ensure Claude always knows exactly where the app is currently located.

*   **Read-Only App Bundle Constraints:**
    *   **The Flaw:** "Editor opens with `sample/welcome.md`". Application directories (`Program Files` on Windows, inside `.app` on Mac) are read-only to prevent tampering. If you open a file located inside the app bundle, the user will get permission errors when they try to save their edits.
    *   **The Solution:** On first launch, the app should *copy* `welcome.md` from the bundle into a user-writable directory (like `~/Documents/Tandem/` or their AppData folder) and open that copied version instead.

### 3. Build, Security & Distribution Risks

*   **Cross-Compilation Target Triples for Node binaries:**
    *   **The Flaw:** Step 5 says "Download Node.js binaries... (pre-build script)". Tauri's sidecar feature requires the binary filename to *exactly* match the target Rust compilation triple (e.g., `node-sidecar-x86_64-apple-darwin`, `node-sidecar-aarch64-apple-darwin`). If the pre-build script just downloads "node-mac.tar.gz" without renaming the inner executable to match the active Rust triple, the Tauri build will fail to package it.
    *   **The Solution:** The pre-build script must detect the active Rust target triple and ensure the downloaded Node binary is renamed to `node-sidecar-{target_triple}` in the `src-tauri` directory before `cargo tauri build` runs.

*   **macOS Gatekeeper Child Process Kills:**
    *   **The Flaw:** The plan suggests shipping "unsigned v1 to unblock testing". While you can right-click -> Open an unsigned app on macOS, modern macOS (Gatekeeper) is extremely aggressive against unsigned apps that spawn *other* unsigned binaries (like your Node sidecar). It may silently kill the sidecar in the background.
    *   **The Solution:** Even for local or alpha testing, you should configure Tauri to use local ad-hoc signing (`codesign -s -`), and you should prioritize getting an Apple Developer certificate early to avoid debugging false-positive bugs caused by macOS security interventions.

### 4. General Considerations (For Beginners)

*   **Is it normal to bundle a 30MB Node.js runtime inside a desktop app?**
    *   *Answer:* Yes, it is very common and completely acceptable. This is called the "Sidecar" pattern. 30-40MB is a great tradeoff to guarantee the app works flawlessly on the user's machine without forcing them to use the terminal.
*   **How does Claude actually talk to my bundled app?**
    *   *Answer:* Claude's MCP protocol doesn't use the network directly to start; it uses standard input/output (`stdio`). Claude will execute your bundled Node binary, passing your bundled `channel/index.js` as an argument. That script then acts as a bridge, talking to Claude via `stdio` and talking to your running Tandem server via HTTP/WebSockets.
