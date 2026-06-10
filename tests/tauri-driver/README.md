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

| OS      | Status        | WebView driver                     |
| ------- | ------------- | ---------------------------------- |
| Linux   | ✅ supported  | `webkit2gtk-driver` (under `xvfb`) |
| Windows | ✅ supported  | Edge WebDriver (auto-managed)      |
| macOS   | ❌ unsupported | no WKWebView WebDriver exists      |

CI runs this on Linux under `xvfb` (`.github/workflows/tauri-webdriver.yml`).
It is intentionally **not** part of the default `npm run test:e2e` Playwright
run, which exercises the browser frontend, not the Tauri shell.

## Prerequisites

1. **Rust toolchain + Tauri system deps.** On Linux:
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

This builds the debug desktop binary (`cargo tauri build -- --debug --no-bundle`),
starts `tauri-driver`, launches the app, and runs the specs. To skip the build
and reuse an existing `src-tauri/target/debug/Tandem[.exe]`, set
`TAURI_SKIP_BUILD=1`.

On Linux, wrap with a virtual display:

```sh
xvfb-run npm test
```

## Layout

- `wdio.conf.ts` — WebdriverIO config; builds the app, spawns/stops `tauri-driver`.
- `specs/prevent-default.e2e.ts` — the reload-interception assertions.
- `package.json` / `tsconfig.json` — standalone toolchain (kept out of the root
  install so the WebdriverIO dependency tree is opt-in).
