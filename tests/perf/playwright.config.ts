import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { PERF_MCP_PORT, PERF_WS_PORT } from "../../scripts/test-ports";
import { TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV } from "../../src/shared/constants";

/**
 * Isolated Playwright config for the v1.0 performance gate.
 *
 * ## Why a separate config rather than a tag
 *
 * The root config sets `testDir: "tests/e2e"` with no grep/testIgnore, and
 * `npm run test:e2e` passes no filter — collection is directory-based, so a
 * `@perf`-tagged spec under `tests/e2e/` would still run in the default suite
 * and in CI. `scripts/screenshots/` and `scripts/design-baselines/` already
 * solved this the right way: a separate config with its own `testDir`, which
 * the standard runner cannot discover even if a future CI glob widens.
 *
 * That matters more here than for a screenshot capture. Timings from a shared
 * CI runner are noise, and the gate's pass conditions are explicitly scoped to
 * "the smoke-checklist machines" — running this in CI would manufacture
 * numbers nobody should trust.
 *
 * ## Why it serves a production build
 *
 * The root config's webServer runs `npm run dev` — unbundled ESM, no
 * minification. Open-to-interactive measured there is dominated by the module
 * waterfall, not by the editor, and would be wrong in the pessimistic
 * direction: we would go fix a problem that does not exist in shipped builds.
 * So this config serves the perf client build via `vite preview` and runs the
 * built server, and `npm run perf:gate` (scripts/perf-build.ts) builds both
 * first.
 *
 * `--host 127.0.0.1` is NOT cosmetic: `vite preview` defaults to `localhost`,
 * and bare `localhost` was deliberately narrowed out of the server's CORS
 * allowlist in PR #637 (DNS-rebinding hardening). On the default host every
 * API call would be rejected.
 *
 * Run with: `npm run perf:gate`
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Isolated app-data dir, wiped by `perf-server.mjs` at every server START.
 *
 * Lives in the OS temp dir, NOT under the repo. Inside the working tree on
 * Windows, the server's own doc-backup writes and the wipe both hit EPERM —
 * the same reason the E2E harness keeps its app-data outside the repo.
 *
 * The wipe is a correctness requirement, not hygiene, and its timing is the
 * whole point. `src/server/index.ts` restores the previous session during
 * startup (`restoreCtrlSession()` / `restoreOpenDocuments()`), so anything on
 * disk at boot is rehydrated into the run: the prior run's open tabs and its
 * durable annotation envelopes. Server start is the only moment that precedes
 * that, which is why the wipe lives in the launcher and NOT in globalSetup —
 * Playwright starts every webServer before it runs globalSetup (see
 * global-setup.ts for the receipt).
 *
 * A stable, inspectable path is deliberate over an `mkdtemp` per run: the
 * gate's output is a recorded measurement, and being able to look at the
 * app-data a recorded run actually used is worth more than never issuing a
 * delete. The launcher's hard-coded basename guard is the safety boundary.
 */
const PERF_APP_DATA_DIR = path.join(os.tmpdir(), "tandem-perf-data");
const PERF_SERVER_LAUNCHER = path.join(__dirname, "perf-server.mjs");

/** Deliberately not 5173 — a running `npm run dev` must not be silently reused. */
const PREVIEW_PORT = 4318;

/**
 * The perf client is a SEPARATE build in a separate outDir (#1492).
 * `scripts/perf-build.ts` bakes VITE_TANDEM_* into it so it targets the perf
 * backend pair — writing that build into `dist/client` would leave a developer
 * who runs `npm run perf:gate` and then `node dist/server/index.js` with a
 * shipped-looking client permanently "Disconnected" on the product ports, with
 * zero diagnosis.
 *
 * Nothing consumes this outDir but the perf harness, and three separate
 * mechanisms keep it out of shipped artifacts: `src/server/mcp/server.ts`
 * serves `join(__dirname, "../client")`, Tauri's `bundle.resources` names
 * `../dist/client/` explicitly, and package.json's `files` carries an explicit
 * `"!dist/perf-client"` negation. That negation is load-bearing, not
 * belt-and-braces: `files: ["dist/"]` publishes the whole directory and
 * `prepublishOnly`'s `npm run build` does not clean it, so without the
 * negation a `perf:gate` run followed by a publish would put a full
 * perf-baked client in the tarball. `tests/scripts/e2e-guard-wiring.test.ts`
 * pins it.
 */
const CLIENT_DIST = path.join(REPO_ROOT, "dist", "perf-client", "index.html");
const SERVER_DIST = path.join(REPO_ROOT, "dist", "server", "index.js");

// A MISSING build is fatal: there is nothing to measure. A perf gate that
// silently measured the wrong artifact is worse than one that refuses to run.
for (const [label, p] of [
  ["client", CLIENT_DIST],
  ["server", SERVER_DIST],
] as const) {
  if (!existsSync(p)) {
    throw new Error(
      `Performance gate: no production ${label} build at ${p}.\n` +
        `Run \`npm run perf:gate\`, which builds before measuring.`,
    );
  }
}

/** Newest mtime under a directory tree, skipping node_modules and dot-dirs. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(full));
    else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

// Provenance, printed unconditionally: a recorded run should carry the
// timestamp of the artifact it measured, so the table in
// docs/perf-gate-results.md can be audited after the fact. `console.error`
// keeps it off stdout, where the Playwright reporter lives.
const clientBuiltAt = statSync(CLIENT_DIST).mtimeMs;
const serverBuiltAt = statSync(SERVER_DIST).mtimeMs;
console.error(
  `[perf-gate] dist/perf-client built ${new Date(clientBuiltAt).toISOString()}, ` +
    `dist/server built ${new Date(serverBuiltAt).toISOString()}`,
);

// STALENESS is a warning, not a throw. It is a real hazard — `npm run perf:gate`
// builds first, but the config is also directly runnable with
// `playwright test --config=…`, which is exactly how someone iterating skips a
// two-minute rebuild. It is NOT reliable enough to block on: a formatter hook,
// or a fresh `git worktree`/checkout, restamps every file under `src/` without
// changing a byte of what would be built. So: say it loudly, measure anyway,
// and let the operator decide.
const srcNewest = newestMtimeMs(path.join(REPO_ROOT, "src"));
if (srcNewest > Math.min(clientBuiltAt, serverBuiltAt)) {
  console.error(
    `[perf-gate] WARNING: a file under src/ (mtime ${new Date(srcNewest).toISOString()}) is ` +
      `newer than the dist artifacts above — this run may measure a stale build. ` +
      `Run \`npm run perf:gate\` to rebuild first.`,
  );
}

export default defineConfig({
  testDir: "./",
  // `testDir: "./"` makes Playwright walk this directory recursively looking
  // for specs, and it walks straight into the generated fixture output —
  // where, on Windows, a doc-backup subdirectory can be permission-denied and
  // abort the whole run before a single test starts. Nothing under
  // `.generated/` is ever a spec.
  testIgnore: "**/.generated/**",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  // Generous relative to the 3s/500ms/100ms THRESHOLDS: those bound the
  // measured operation, this bounds the whole spec, which also opens a
  // 22,500-word document, seeds 50 annotations and scrolls the full length.
  // Headroom over the 240s this started at, because the spec now mounts the
  // margin pipeline: run 1 already spent ~8.2s inside the accept step with the
  // margin OFF, and a spec-level timeout prints NOTHING (every number is
  // reported at the end), so an under-sized budget turns a slow result into no
  // result at all.
  timeout: 420_000,
  // No retries. A retry would silently report a second, warmer run's numbers.
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${PREVIEW_PORT}`,
    headless: true,
    // Pinned, because margin mode is WIDTH-derived and the spec now depends on
    // landing in `full`. `marginModeThresholds` (editor-stage.svelte.ts) gives
    // `t1 = narrowThresholdPx(rails) = 2*272 + rails + 480`; with the right
    // rail at its default 300px (PANEL_DEFAULT_WIDTH, src/client/panel-layout.ts:5)
    // that is 1324. Playwright's unpinned 1280 default would land in `narrow`,
    // which renders `clamped` cards with NO action row — the accept button
    // would be display:none and the measured click would hang rather than
    // report. 1600 clears t1 with far more headroom than the 32px hysteresis
    // band.
    viewport: { width: 1600, height: 900 },
  },
  webServer: [
    {
      command: `npx vite preview --outDir dist/perf-client --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      // Playwright defaults webServer.cwd to the CONFIG file's directory, not
      // the repo root. Without this, vite resolves `dist` against tests/perf/,
      // fails to find it, and never reads vite.config.ts at all. The --outDir
      // flag points preview at the perf-baked client (see CLIENT_DIST above).
      cwd: REPO_ROOT,
    },
    {
      // Through the launcher, which wipes PERF_APP_DATA_DIR immediately before
      // spawning the server — the only moment that precedes session restore.
      // See PERF_APP_DATA_DIR above and tests/perf/perf-server.mjs.
      command: `node ${JSON.stringify(PERF_SERVER_LAUNCHER)} ${JSON.stringify(SERVER_DIST)}`,
      url: `http://127.0.0.1:${PERF_MCP_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: REPO_ROOT,
      env: {
        ...(process.env as Record<string, string>),
        [TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV]: "1",
        TANDEM_APP_DATA_DIR: PERF_APP_DATA_DIR,
        TANDEM_NO_SAMPLE: "1",
        // Own pair (#1492): the built server no longer boots onto the product
        // ports, where its freePort() SIGKILLed a running desktop Tandem.
        TANDEM_PORT: String(PERF_WS_PORT),
        TANDEM_MCP_PORT: String(PERF_MCP_PORT),
      },
    },
  ],
});

// NOTE: this env block intentionally mirrors the root playwright.config.ts
// server webServer entry. If that one gains a variable the server needs to
// boot correctly, this one needs it too — there is no shared surface by
// design (see "Why a separate config" above), so the coupling is manual.

export { PREVIEW_PORT };
