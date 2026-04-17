# Step 6: Auto-Update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Tauri's updater plugin so the desktop app checks for updates on launch + every 8 hours, prompts the user, and installs + restarts on confirmation. A tray menu item provides manual "Check for Updates."

**Architecture:** Register `tauri-plugin-updater` alongside existing desktop-only plugins. A single `check_for_update()` async function handles all three triggers (launch, periodic, manual). Update manifests served from GitHub Releases. Updates are Ed25519-signed; Tauri verifies before applying.

**Tech Stack:** Rust, tauri-plugin-updater v2, tauri-plugin-dialog (existing), tauri-plugin-process (existing), tokio (existing)

**Spec:** `docs/superpowers/specs/2026-04-12-tauri-step6-auto-update-design.md`

**Manual prerequisites (Bryan must do before first signed release):**
1. Generate signing keypair: `tauri signer generate -w ~/.tauri/tandem.key`
2. Copy public key into `tauri.conf.json` at `plugins.updater.pubkey`
3. Add GitHub repo secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

---

## Task 1: Add updater plugin dependency and capability

**Files:**
- Modify: `src-tauri/Cargo.toml:33-35` (desktop-only deps block)
- Modify: `src-tauri/capabilities/desktop.json` (permissions array)

- [ ] **Step 1: Add `tauri-plugin-updater` to desktop-only dependencies in `Cargo.toml`**

In `src-tauri/Cargo.toml`, add `tauri-plugin-updater` to the existing desktop-only block:

```toml
[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
tauri-plugin-single-instance = "2"
tauri-plugin-window-state = "2"
tauri-plugin-updater = "2"
```

- [ ] **Step 2: Add updater permission to `desktop.json`**

In `src-tauri/capabilities/desktop.json`, add `"updater:default"` to the permissions array:

```json
{
  "identifier": "desktop-capability",
  "platforms": [
    "macOS",
    "windows",
    "linux"
  ],
  "windows": [
    "main"
  ],
  "permissions": [
    "window-state:default",
    "updater:default"
  ]
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: compilation succeeds (warnings OK, no errors)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/capabilities/desktop.json
git commit -m "feat(tauri): add updater plugin dependency and capability"
```

---

## Task 2: Add updater config to `tauri.conf.json`

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add `plugins.updater` block and `bundle.createUpdaterArtifacts`**

In `src-tauri/tauri.conf.json`, add two things:

1. A `plugins` section with the updater config at the top level (after `bundle`):

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/bloknayrb/tandem/releases/latest/download/latest.json"
    ],
    "pubkey": ""
  }
}
```

2. Add `"createUpdaterArtifacts": true` inside the existing `bundle` section:

The full `tauri.conf.json` should look like:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Tandem",
  "version": "0.3.2",
  "identifier": "com.tandem.editor",
  "build": {
    "frontendDist": "../dist/client",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Tandem",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:3478 http://localhost:3479 ws://localhost:3478; img-src 'self' data: blob:; font-src 'self' data:"
    }
  },
  "bundle": {
    "active": true,
    "createUpdaterArtifacts": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "externalBin": [
      "binaries/node-sidecar"
    ],
    "resources": {
      "../dist/server/": "dist/server/",
      "../dist/channel/": "dist/channel/",
      "../dist/client/": "dist/client/",
      "../sample/": "sample/"
    }
  },
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/bloknayrb/tandem/releases/latest/download/latest.json"
      ],
      "pubkey": ""
    }
  }
}
```

Note: `pubkey` is intentionally empty — Bryan will fill it after generating the signing keypair. The updater plugin tolerates an empty pubkey at compile time but will fail at runtime if it hasn't been set before a release build. **WARNING:** `cargo tauri build` will succeed silently with an empty pubkey, producing an app that can never update. Bryan must set the pubkey before cutting any release.

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(tauri): add updater config and createUpdaterArtifacts"
```

---

## Task 3: Register updater plugin and add trait imports

**Files:**
- Modify: `src-tauri/src/lib.rs:1-8` (imports) and `lib.rs:56` (plugin chain)

- [ ] **Step 1: Add trait imports at the top of `lib.rs`**

Add these two lines after the existing `use tauri_plugin_shell::ShellExt;` import (line 8):

```rust
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_process::ProcessExt;
```

- [ ] **Step 2: Register the updater plugin in the builder chain**

In the `tauri::Builder::default()` chain in `run()`, add the updater plugin after `.plugin(tauri_plugin_process::init())` (line 56):

```rust
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: compilation succeeds. There may be "unused import" warnings for `UpdaterExt` and `ProcessExt` — that's expected, they'll be used in the next task.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tauri): register updater plugin with trait imports"
```

---

## Task 4: Implement update check logic and dialog helpers

**Files:**
- Modify: `src-tauri/src/lib.rs` (add functions before `run()`)

- [ ] **Step 1: Add the dialog helper functions**

Add these three functions after the existing `show_no_claude_dialog` function (after line 554) and before the closing of the file:

```rust
/// Prompt the user to install an available update. Returns true if they accept.
/// This is intentionally a sync `fn`, NOT `async fn` — `blocking_show()` blocks
/// the calling thread waiting for the OS dialog. This is safe because:
/// 1. Tauri uses a multi-threaded Tokio runtime (default)
/// 2. This is only called from spawned async tasks, never the main thread
/// Do NOT make this async — `blocking_show()` on an async runtime thread will deadlock.
fn show_update_available_dialog(app: &tauri::AppHandle, version: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    app.dialog()
        .message(format!(
            "Tandem v{version} is available.\n\n\
             Would you like to update now? The application will restart after installing."
        ))
        .title("Update Available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
}

/// Inform the user they're on the latest version (manual check feedback).
fn show_up_to_date_dialog(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    app.dialog()
        .message(format!(
            "You're running the latest version of Tandem (v{}).",
            env!("CARGO_PKG_VERSION")
        ))
        .title("No Updates Available")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

/// Show an error dialog for failed update checks (manual check feedback only).
fn show_update_error_dialog(app: &tauri::AppHandle, error: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    app.dialog()
        .message(format!(
            "Could not check for updates.\n\n\
             Error: {error}\n\n\
             Please try again later or check your internet connection."
        ))
        .title("Update Error")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}
```

- [ ] **Step 2: Add the `check_for_update` function**

Add this function after the dialog helpers:

```rust
/// Check for updates and optionally prompt the user.
/// `manual` controls whether the user gets feedback on "no update" / error.
async fn check_for_update(app: &tauri::AppHandle, manual: bool) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::error!("Failed to create updater: {e}");
            if manual {
                show_update_error_dialog(app, &e.to_string());
            }
            return;
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            log::info!("No update available");
            if manual {
                show_up_to_date_dialog(app);
            }
            return;
        }
        Err(e) => {
            log::warn!("Update check failed: {e}");
            if manual {
                show_update_error_dialog(app, &e.to_string());
            }
            return;
        }
    };

    let version = update.version.clone();
    log::info!("Update available: v{version}");

    if !show_update_available_dialog(app, &version) {
        log::info!("User declined update to v{version}");
        return;
    }

    // Download and install — closures receive progress but we don't use them yet
    match update.download_and_install(|_chunk_len, _total| {}, || {}).await {
        Ok(()) => {
            log::info!("Update to v{version} installed — killing sidecar and restarting");
            // Kill sidecar BEFORE restart. CommandChild::kill() sends the signal
            // but doesn't wait for exit — add a brief delay so the OS releases
            // ports 3478/3479 before the new instance tries to bind them.
            // The RunEvent::Exit handler will also call kill_sidecar (harmless
            // no-op since guard.take() already returned None).
            kill_sidecar(app);
            tokio::time::sleep(Duration::from_millis(500)).await;
            app.restart();
        }
        Err(e) => {
            log::error!("Update install failed: {e}");
            show_update_error_dialog(app, &e.to_string());
        }
    }
}
```

Key points:
- `app.updater()` returns `Result<Updater>` (via `UpdaterExt` trait) — handle the error
- `updater.check()` returns `Result<Option<Update>>` — `None` means up-to-date
- `show_update_available_dialog` is a sync `fn` (NOT async) using `blocking_show()` which returns `bool` — safe on Tauri's multi-threaded Tokio runtime when called from a spawned task
- `kill_sidecar(app)` is called **before** `app.restart()` with a 500ms delay to let the OS release ports. The `RunEvent::Exit` handler also calls `kill_sidecar` — this is harmless (double-call is a no-op via `guard.take()`)
- `app.restart()` comes from the `ProcessExt` trait (already imported in Task 3)

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: compilation succeeds. The new functions may show "unused function" warnings since they're not called yet — that's fine.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tauri): add update check logic and dialog helpers"
```

---

## Task 5: Wire up launch and periodic update checks

**Files:**
- Modify: `src-tauri/src/lib.rs` (the `setup()` async block, around lines 75-103)

- [ ] **Step 1: Add update check after MCP setup in the existing async block**

In the `setup()` closure, there's an existing `tauri::async_runtime::spawn` block (starting around line 75) that runs `copy_sample_files`, `start_sidecar`, and `run_setup`. Add the launch update check at the end of this block, and spawn the periodic timer.

Replace the tail of the async block. The current code ends with:

```rust
                // Setup fires after health check passes — in BOTH paths
                // (freshly spawned sidecar OR already-running dev server)
                if let Err(e) = run_setup(&handle, &client).await {
                    log::warn!("MCP setup failed (non-fatal): {e}");
                }
            });
```

Replace with:

```rust
                // Setup fires after health check passes — in BOTH paths
                // (freshly spawned sidecar OR already-running dev server)
                if let Err(e) = run_setup(&handle, &client).await {
                    log::warn!("MCP setup failed (non-fatal): {e}");
                }

                // Check for updates on launch (non-blocking, after sidecar is healthy)
                check_for_update(&handle, false).await;
            });

            // Periodic update check every 8 hours (for long-running sessions)
            // Note: `handle` was moved into the first spawn block above, so we
            // clone from `app.handle()` here (still in the setup() closure scope)
            let periodic_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(8 * 60 * 60));
                interval.tick().await; // Discard the first immediate tick — launch check covers it
                loop {
                    interval.tick().await;
                    check_for_update(&periodic_handle, false).await;
                }
            });
```

Note: The periodic timer is a separate `spawn` — it runs independently of the setup block and ticks every 8 hours after the first (immediate) tick is discarded. The `Duration::from_secs(8 * 60 * 60)` = 28800 seconds = 8 hours.

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: compilation succeeds. The "unused function" warnings for the dialog helpers should be gone now.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tauri): wire up launch and periodic update checks"
```

---

## Task 6: Add "Check for Updates" tray menu item

**Files:**
- Modify: `src-tauri/src/lib.rs` (constants, menu construction, menu event handler)

- [ ] **Step 1: Add the `MENU_UPDATE` constant**

Add this line after the existing tray menu constants (after line 23, `const MENU_QUIT: &str = "quit";`):

```rust
const MENU_UPDATE: &str = "update";
```

- [ ] **Step 2: Add the menu item to the tray menu**

In the `setup()` closure, the tray menu is constructed around lines 105-111. Add a "Check for Updates" item between `setup_i` and `sep`:

Replace:

```rust
            let open_i = MenuItem::with_id(app, MENU_OPEN, "Open Editor", true, None::<&str>)?;
            let setup_i = MenuItem::with_id(app, MENU_SETUP, "Setup Claude", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let about_i = MenuItem::with_id(app, MENU_ABOUT, "About Tandem", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&open_i, &setup_i, &sep, &about_i, &quit_i])?;
```

With:

```rust
            let open_i = MenuItem::with_id(app, MENU_OPEN, "Open Editor", true, None::<&str>)?;
            let setup_i = MenuItem::with_id(app, MENU_SETUP, "Setup Claude", true, None::<&str>)?;
            let update_i = MenuItem::with_id(app, MENU_UPDATE, "Check for Updates", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let about_i = MenuItem::with_id(app, MENU_ABOUT, "About Tandem", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&open_i, &setup_i, &update_i, &sep, &about_i, &quit_i])?;
```

- [ ] **Step 3: Add the menu event handler for the update item**

In the `.on_menu_event` closure (around line 123), add a handler for `MENU_UPDATE` between the `MENU_SETUP` and `MENU_ABOUT` arms:

Add this arm after the `MENU_SETUP` arm's closing brace:

```rust
                    MENU_UPDATE => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            check_for_update(&handle, true).await;
                        });
                    }
```

The `true` argument means this is a manual check — the user always gets feedback (either "no updates" or an error dialog).

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: compilation succeeds with no warnings

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tauri): add Check for Updates tray menu item"
```

---

## Task 7: Update CI workflow with signing secrets

**Files:**
- Modify: `.github/workflows/tauri-release.yml:62-72`

- [ ] **Step 1: Add signing env vars to the tauri-action step**

In `.github/workflows/tauri-release.yml`, the `tauri-apps/tauri-action@v0` step currently has:

```yaml
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

Replace the `env:` block to add the signing secrets:

```yaml
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: v__VERSION__
          releaseName: "Tandem v__VERSION__"
          releaseBody: "See the assets to download and install Tandem."
          releaseDraft: true
          prerelease: false
          updaterJsonPreferNsis: true
          args: ${{ matrix.args }}
```

When these env vars are present, `tauri-action` automatically:
1. Signs each installer artifact with the private key, producing `.sig` files
2. Includes the signatures in the generated `latest.json` manifest

When the secrets are not configured (i.e., before Bryan adds them), the action still succeeds but produces unsigned artifacts and no `latest.json` — the updater won't work until the secrets are in place.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/tauri-release.yml
git commit -m "ci(tauri): pass signing secrets to tauri-action for updater"
```

---

## Task 8: Update CLAUDE.md with updater documentation

**Files:**
- Modify: `CLAUDE.md` (Tauri Desktop section)

- [ ] **Step 1: Add updater notes to the Tauri Desktop section**

In `CLAUDE.md`, the `## Tauri Desktop` section currently documents the plugins and capabilities. Add updater information. After the line about `@tauri-apps/api`:

```markdown
- **Auto-updater** checks for updates on launch + every 8h, or manually via tray menu "Check for Updates"
- Updater config in `tauri.conf.json` `plugins.updater`: endpoint points to GitHub Releases `latest.json`
- `bundle.createUpdaterArtifacts: true` tells CI to generate `.sig` signature files alongside installers
- **Signing:** Ed25519 keypair. Public key in `tauri.conf.json`, private key in GitHub Actions secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
- `kill_sidecar()` is called **before** `app.restart()` after update install — prevents port conflict when new instance starts
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add auto-updater notes to CLAUDE.md Tauri section"
```

---

## Task 9: Final compilation and smoke test

- [ ] **Step 1: Full cargo check**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: compilation succeeds with no errors

- [ ] **Step 2: Verify existing tests still pass**

Run: `npm test 2>&1 | tail -10`
Expected: all tests pass (the updater is Rust-only, no JS tests affected)

- [ ] **Step 3: Verify `cargo tauri dev` launches**

Run: `cargo tauri dev` (requires the dev server to be running or `beforeDevCommand` to handle it)

Verify:
1. App window opens
2. Tray icon appears with "Check for Updates" in the menu
3. Clicking "Check for Updates" shows either "No Updates Available" or an error dialog (expected at this point since pubkey is empty — the error is fine, it confirms the code path runs)
4. App doesn't crash on startup

- [ ] **Step 4: Verify tray menu order**

The tray menu should show (top to bottom):
- Open Editor
- Setup Claude
- Check for Updates
- ─── (separator)
- About Tandem
- Quit
