// WebdriverIO configuration for the tauri-driver E2E harness.
//
// Purpose (issue #560): the Rust regression test in
// `src-tauri/tests/prevent_default.rs` asserts the *flag bag* returned by
// `prevent_default_flags()` but cannot prove the plugin actually intercepts
// keystrokes inside the live Tauri WebView. This harness drives the real
// built desktop binary through `tauri-driver` so reload-shortcut interception
// is covered end-to-end, and so a regression that removes `with_flags(...)`
// from the builder (which the Rust test cannot catch) is caught here.
//
// Platform support: `tauri-driver` works on Linux (webkit2gtk-driver) and
// Windows (Edge WebDriver). macOS has no WKWebView WebDriver and is
// unsupported — the harness is skipped there. CI runs it on Linux under xvfb
// (see `.github/workflows/tauri-webdriver.yml`).
//
// This file is intentionally NOT wired into `npm run typecheck` (the project
// tsconfigs scope to `src/`) because the WebdriverIO type packages are only
// installed in the dedicated CI job, not in the default dev install.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root is two levels up from tests/tauri-driver/. `__dirname` does not
// exist in ESM (package.json sets "type": "module"); derive it from import.meta.
const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..", "..");

// The built debug binary. The Cargo package is `tandem-desktop`
// (src-tauri/Cargo.toml) and `cargo tauri build -- --no-bundle` skips the
// bundler's rename step, so the artifact is the raw cargo binary
// `tandem-desktop` (`tandem-desktop.exe` on Windows) — NOT the `productName`
// "Tandem", which only names the bundled installer. (The release workflow
// references `target/release/tandem-desktop.exe` for the same reason.) We test
// the --debug build because it is faster to produce in CI than a full --release
// bundle and the prevent-default plugin behaves identically.
const binaryName = process.platform === "win32" ? "tandem-desktop.exe" : "tandem-desktop";
const application = path.resolve(repoRoot, "src-tauri", "target", "debug", binaryName);

// `tauri-driver` is installed via `cargo install tauri-driver --locked` and
// lands in the Cargo bin directory. Allow an override for non-standard setups.
const tauriDriverPath =
  process.env.TAURI_DRIVER_PATH ??
  path.resolve(
    os.homedir(),
    ".cargo",
    "bin",
    `tauri-driver${process.platform === "win32" ? ".exe" : ""}`,
  );

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  host: "127.0.0.1",
  port: 4444,

  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1, // the Tandem server accepts one MCP session at a time

  capabilities: [
    {
      // `tauri:options` is consumed by tauri-driver, which forwards the rest of
      // the session to the platform's native WebView driver (WebKitWebDriver on
      // Linux). Per the official Tauri v2 WebdriverIO example, the client sets NO
      // `browserName`: WebKitWebDriver offers no browser named "wry", so supplying
      // it fails W3C capability matching ("Failed to match capabilities"). tauri-
      // driver reports the browser as "wry" itself once the session is created.
      "tauri:options": {
        application,
      },
    } as WebdriverIO.Capabilities,
  ],

  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },

  // Build the desktop app once before the suite. `--no-bundle` skips installer
  // packaging (we only need the runnable binary). The sidecar binary must
  // already be present under src-tauri/binaries/ (the CI job downloads it via
  // scripts/download-node-sidecar.mjs before this runs).
  onPrepare: () => {
    if (process.env.TAURI_SKIP_BUILD === "1") {
      if (!existsSync(application)) {
        throw new Error(
          `TAURI_SKIP_BUILD=1 but the debug binary is missing at ${application}. ` +
            `Build it first with: cargo tauri build -- --debug --no-bundle`,
        );
      }
      return;
    }
    const result = spawnSync("cargo", ["tauri", "build", "--", "--debug", "--no-bundle"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`cargo tauri build (debug) failed with status ${result.status}`);
    }
  },

  // Start tauri-driver before each session and proxy WebDriver traffic to it.
  beforeSession: () =>
    new Promise<void>((resolve, reject) => {
      if (!existsSync(tauriDriverPath)) {
        reject(
          new Error(
            `tauri-driver not found at ${tauriDriverPath}. ` +
              `Install it with: cargo install tauri-driver --locked ` +
              `(or set TAURI_DRIVER_PATH).`,
          ),
        );
        return;
      }
      tauriDriver = spawn(tauriDriverPath, [], {
        stdio: [null, process.stdout, process.stderr],
      });
      tauriDriver.on("error", (error) =>
        reject(new Error(`tauri-driver failed: ${error.message}`)),
      );
      tauriDriver.on("exit", (code) => {
        if (code !== null && code !== 0) {
          reject(new Error(`tauri-driver exited unexpectedly with code ${code}`));
        }
      });
      // tauri-driver binds its proxy port near-instantly; a short settle window
      // is enough and avoids a flaky race on slow CI runners.
      setTimeout(resolve, 2_000);
    }),

  // Always tear the driver down so its proxy port is released for the next run.
  // NOTE: this reaps `tauri-driver` only — not the Tandem Node sidecar the
  // launched desktop binary spawns on :3478/:3479. The app kills its own sidecar
  // on a clean `RunEvent::Exit` (src-tauri/src/lib.rs); a SIGKILLed teardown or
  // app crash can orphan it. This harness deliberately runs OUTSIDE Playwright's
  // `freePort()`, so the CI job is assumed one-shot (fresh runner) — for repeated
  // LOCAL runs, free :3478/:3479 between runs if a launch collides with a stale
  // sidecar.
  afterSession: () => {
    tauriDriver?.kill();
    tauriDriver = undefined;
  },
};
