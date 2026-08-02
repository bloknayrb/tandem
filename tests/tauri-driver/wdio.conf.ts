// WebdriverIO configuration for the tauri-driver E2E harness.
//
// Purpose (issue #560): the Rust regression test in
// `src-tauri/tests/prevent_default.rs` asserts the *flag bag* returned by
// `prevent_default_flags()` but cannot prove the plugin actually intercepts
// keystrokes inside the live Tauri WebView. This harness drives the real
// built desktop binary through `tauri-driver` and verifies the plugin's keydown
// listener fires `preventDefault()` on a reload shortcut — so a regression that
// disables reload interception (e.g. `prevent_default_flags()` losing `RELOAD`,
// or the plugin being dropped) is caught here. See specs/prevent-default.e2e.ts
// for why it observes `defaultPrevented` rather than an actual page reload.
//
// Platform support: `tauri-driver` works on Linux (webkit2gtk-driver) and
// Windows (Edge WebDriver). macOS has no WKWebView WebDriver and is
// unsupported — the harness is skipped there. CI runs it on Windows/WebView2
// (see `.github/workflows/tauri-webdriver.yml`): WebKitGTK's WebDriver wedges
// on native element/key commands under headless xvfb, whereas Chromium-backed
// WebView2 drives them reliably.
//
// This file is intentionally NOT wired into `npm run typecheck` (the project
// tsconfigs scope to `src/`) because the WebdriverIO type packages are only
// installed in the dedicated CI job, not in the default dev install.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root is two levels up from tests/tauri-driver/. `__dirname` does not
// exist in ESM (package.json sets "type": "module"); derive it from import.meta.
const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..", "..");

// The built debug binary. The Cargo package is `tandem-desktop`
// (src-tauri/Cargo.toml) and `cargo tauri build --no-bundle` skips the
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

// Optional msedgedriver diagnostics (issue #1197).
//
// HYPOTHESIS, NOT A PROVEN FIX — unverifiable outside Windows/WebView2, so it
// stands until a tag build (or `workflow_dispatch`) says otherwise. Since
// WebView2 Runtime 150 the Windows job dies at session creation with
// `session not created: DevToolsActivePort file doesn't exist`, ~63s after
// msedgedriver launched the app — i.e. the driver matched capabilities and
// started the binary, but no CDP endpoint ever appeared. The primary hypothesis
// is a driver/runtime version pairing (addressed in the workflow's driver-setup
// step, which now prefers the exact runtime version); this shim addresses the
// *other* half of the problem, which is that we have never seen msedgedriver's
// own account of what it did. tauri-driver proxies to whatever `msedgedriver.exe`
// is on PATH and `--native-driver` takes a *path*, not arguments — so wrap the
// real driver in a one-line .cmd that adds `--verbose --log-path=...` and
// forwards tauri-driver's own args (`%*`). A failed round then carries evidence
// instead of costing another blind ~15-minute CI cycle.
//
// Opt-in via TAURI_DRIVER_VERBOSE_LOG=1 (only the CI job sets it) and fails soft
// to the plain PATH lookup if anything doesn't resolve — a diagnostic must never
// be the reason the suite can't start. Reverting is deleting this function and
// the `--native-driver` args below. Note tauri-driver kills the shim's cmd.exe
// on teardown, which can briefly orphan the wrapped msedgedriver; acceptable on
// the one-shot CI runner this is enabled for, which is why it is not on locally.
//
// "Fails soft" has to cover EXECUTION, not just creation: writing a .cmd proves
// nothing about whether anything can run it, and once `--native-driver <shim>`
// is on the tauri-driver command line there is no fallback left. Two concrete
// ways an unverified shim would kill the very run it exists to diagnose:
//   (a) tauri-driver spawns the native driver through Rust's `std::process::
//       Command`, and Windows `CreateProcessW` cannot execute a .bat/.cmd
//       directly. std's implicit cmd.exe wrapping has shifted across Rust
//       versions and, since the CVE-2024-24576 fix, can return `InvalidInput`
//       instead of spawning.
//   (b) an older `tauri-driver` (whatever `cargo install --locked` resolves in
//       the workflow) may not have `--native-driver` at all, in which case clap
//       exits non-zero before anything starts.
// So the shim is adopted only after it is smoke-tested here — the flag is probed
// against the real `tauri-driver --help`, and the .cmd is actually executed and
// required to answer `--version`. That closes (b) outright and makes (a) far
// less likely, but it does NOT prove it: a Node spawn of a .cmd is not a Rust
// spawn of a .cmd. Nothing local can prove that, so the residual risk is made
// observable instead — the chosen path (or the fallback) is logged to stderr, so
// the CI log always says which branch the run took.
const driverLogDir = process.env.RUNNER_TEMP ?? os.tmpdir();

function verboseNativeDriverShim(): string | undefined {
  if (process.env.TAURI_DRIVER_VERBOSE_LOG !== "1" || process.platform !== "win32") {
    return undefined;
  }
  const fallback = (why: string): undefined => {
    console.error(`[wdio] msedgedriver verbose shim not adopted (${why}); using PATH lookup`);
    return undefined;
  };
  try {
    // (b) Does this tauri-driver even take `--native-driver`? `--help` exits 0
    // and lists the flag; anything else means don't pass it.
    const help = spawnSync(tauriDriverPath, ["--help"], { encoding: "utf8" });
    const helpText = `${help.stdout ?? ""}${help.stderr ?? ""}`;
    if (help.status !== 0 || !helpText.includes("--native-driver")) {
      return fallback("tauri-driver does not advertise --native-driver");
    }

    const found = spawnSync("where.exe", ["msedgedriver.exe"], { encoding: "utf8" });
    const real = found.stdout?.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
    if (found.status !== 0 || !real || !existsSync(real)) {
      return fallback("msedgedriver.exe not found on PATH");
    }
    const shim = path.join(driverLogDir, "msedgedriver-verbose.cmd");
    const logPath = path.join(driverLogDir, "msedgedriver.log");
    writeFileSync(shim, `@echo off\r\n"${real}" --verbose "--log-path=${logPath}" %*\r\n`);

    // (a) Execute what we just wrote. `shell: true` is required — Node refuses
    // to spawn a .cmd without it (CVE-2024-27980) — and the path is quoted
    // because the shell concatenates the command line. A driver that answers
    // `--version` with a version string is one that at least runs.
    // (`--version` exits immediately; whatever it writes to the log file is
    // replaced when the real session starts the driver for real.)
    const smoke = spawnSync(`"${shim}"`, ["--version"], { encoding: "utf8", shell: true });
    const version = (smoke.stdout ?? "").trim();
    if (smoke.status !== 0 || !/\d+\.\d+\.\d+/.test(version)) {
      const detail = `${version} ${(smoke.stderr ?? "").trim()}`.trim().slice(0, 300);
      return fallback(`shim did not run (status ${smoke.status}, output ${JSON.stringify(detail)})`);
    }

    console.error(`[wdio] native-driver shim: ${shim} -> ${real} (${version})`);
    console.error(`[wdio] msedgedriver verbose log: ${logPath}`);
    return shim;
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}

export const config: WebdriverIO.Config = {
  host: "127.0.0.1",
  port: 4444,

  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1, // the Tandem server accepts one MCP session at a time

  capabilities: [
    {
      // `tauri:options` is consumed by tauri-driver, which forwards the rest of
      // the session to the platform's native WebView driver (Microsoft Edge
      // WebDriver / msedgedriver on Windows). Per the official Tauri v2
      // WebdriverIO example, the client sets NO `browserName`.
      //
      // On Windows it would make no difference if it did: tauri-driver's
      // `into_native_object()` injects `browserName: "webview2"`,
      // `ms:edgeChromium` and a full `ms:edgeOptions` map, and `map_capabilities`
      // extends those over `alwaysMatch` — overwriting any client value for
      // those keys. (Green runs report `[webview2 <version> windows]`, which is
      // that injection taking effect.) An earlier version of this comment said
      // the documented fix for a capability-match failure was
      // `browserName: "wry"`; that is inherited Linux/WebKit advice and is wrong
      // on the Windows path — noted here because it misdirected a #1197 triage.
      //
      // `webviewOptions: {}` is required by the working Windows WebView2 example
      // for capability matching. `application` is an absolute path (below) to
      // avoid the "no msedge binary at <path>" cwd-resolution bug on Windows.
      "tauri:options": {
        application,
        webviewOptions: {},
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
            `Build it first with: cargo tauri build --debug --no-bundle`,
        );
      }
      return;
    }
    // `--debug`/`--no-bundle` are `tauri build` flags — they must NOT go behind
    // `--` (which forwards to `cargo build`, where `--debug` is rejected). Matches
    // the CI workflow's invocation.
    const result = spawnSync("cargo", ["tauri", "build", "--debug", "--no-bundle"], {
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
      const shim = verboseNativeDriverShim();
      tauriDriver = spawn(tauriDriverPath, shim ? ["--native-driver", shim] : [], {
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
