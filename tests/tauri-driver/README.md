# tauri-driver E2E harness

End-to-end coverage for **webview-level keyboard interception** in the Tandem
desktop app, driven through [`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/)
and [WebdriverIO](https://webdriver.io/).

## Why this exists (issue #560)

`prevent_default_flags()` in `src-tauri/src/lib.rs` returns `Flags::RELOAD`,
configuring the [`tauri-plugin-prevent-default`](https://crates.io/crates/tauri-plugin-prevent-default)
plugin to swallow browser reload shortcuts (F5, Ctrl+F5, Shift+F5, Ctrl+R,
Ctrl+Shift+R) inside the WebView while leaving DevTools, Find, Print, and the
context menu accessible.

The Rust regression test `src-tauri/tests/prevent_default.rs` asserts the
**flag value** but cannot prove the plugin actually intercepts keystrokes in a
live WebView — its own comment documents the limitation. In particular, dropping
`.with_flags(prevent_default_flags())` from the builder in `lib.rs` would still
pass the Rust test. This harness closes that gap: it drives the real built
binary and asserts that a reload shortcut does **not** reload the WebView.

## Platform support

| OS      | Status                | WebView driver                          |
| ------- | --------------------- | --------------------------------------- |
| Windows | ✅ supported (CI)     | Microsoft Edge WebDriver (WebView2)     |
| Linux   | ⚠️ local-only         | `webkit2gtk-driver` (under `xvfb`)      |
| macOS   | ❌ unsupported        | no WKWebView WebDriver exists           |

CI runs this on **Windows/WebView2** (`.github/workflows/tauri-webdriver.yml`).
We moved off Linux/WebKitGTK because its WebDriver wedges on native element/key
commands (`findElement`, Actions) under headless `xvfb` for a non-trivial app —
`execute` works but `findElement` hangs to the Mocha timeout and the session
dies (`hyper::Error(IncompleteMessage)`). Chromium-backed WebView2 drives those
commands reliably. The plugin under test enforces RELOAD via a platform-agnostic
injected JS script, so Windows coverage is equally valid. The Linux config still
works locally under `xvfb` for quick checks; it is no longer the CI target.

CI pre-starts the Node server (`node dist/server/index.js`) and the `--no-bundle`
debug binary reuses it via the app's debug health-gate, so the harness does not
exercise the app's own sidecar-spawn path — an acceptable trade for #560's
webview-key-interception purpose. It is intentionally **not** part of the default
`npm run test:e2e` Playwright run, which exercises the browser frontend.

## Prerequisites

1. **Rust toolchain + Tauri system deps.**
   - **Windows (the CI target):** the WebView2 Runtime ships with Windows. You
     need a `msedgedriver.exe` whose version matches the **WebView2 Runtime**
     (not necessarily the Edge browser) on `PATH` — the CI workflow reads the
     runtime version from the registry and downloads the matching driver; locally,
     install a matching Edge WebDriver and put it on `PATH` (tauri-driver
     auto-finds it; or pass `--native-driver`).
   - **Linux (local only):**
     ```sh
     sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
       librsvg2-dev patchelf libxdo-dev webkit2gtk-driver xvfb
     ```
2. **`tauri-driver`:**
   ```sh
   cargo install tauri-driver --locked
   ```
   (Override the lookup path with `TAURI_DRIVER_PATH` if it is not on `~/.cargo/bin`.)
3. **The Node sidecar + reaper binaries** under `src-tauri/binaries/` — both are
   `externalBin`s, so `cargo tauri build` fails without them:
   ```sh
   node scripts/download-node-sidecar.mjs
   node scripts/build-reaper.mjs
   ```
4. **Harness dependencies:**
   ```sh
   cd tests/tauri-driver && npm install
   ```

## Running

From `tests/tauri-driver/`:

```sh
npm test
```

This builds the debug desktop binary (`cargo tauri build --debug --no-bundle`),
starts `tauri-driver`, launches the app, and runs the specs. To skip the build
and reuse an existing `src-tauri/target/debug/tandem-desktop[.exe]`, set
`TAURI_SKIP_BUILD=1`.

On Linux (local only), wrap with a virtual display:

```sh
xvfb-run npm test
```

## Layout

- `wdio.conf.ts` — WebdriverIO config; builds the app, spawns/stops `tauri-driver`.
- `specs/prevent-default.e2e.ts` — the reload-interception assertions.
- `package.json` / `tsconfig.json` — standalone toolchain (kept out of the root
  install so the WebdriverIO dependency tree is opt-in).
