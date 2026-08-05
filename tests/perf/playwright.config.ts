import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { DEFAULT_MCP_PORT, TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV } from "../../src/shared/constants";

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
 * So this config serves `dist/client` via `vite preview` and runs the built
 * server, and `npm run perf:gate` builds both first.
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
 * Isolated app-data dir, wiped in globalSetup.
 *
 * Lives in the OS temp dir, NOT under the repo. Inside the working tree on
 * Windows, the server's own doc-backup writes and the setup wipe both hit
 * EPERM — the same reason the E2E harness keeps its app-data outside the repo.
 *
 * The wipe is a correctness requirement, not hygiene. The fixture is
 * byte-identical across runs (seeded) while its path changes per run — exactly
 * the two preconditions for content-hash rename-recovery (#313/#318) to
 * resurrect the previous run's orphaned annotation envelopes into this one.
 * `scripts/e2e-server.mjs` avoids this by wiping at every server start; this
 * harness runs its own server and so does not inherit that.
 */
const PERF_APP_DATA_DIR = path.join(os.tmpdir(), "tandem-perf-data");

/** Deliberately not 5173 — a running `npm run dev` must not be silently reused. */
const PREVIEW_PORT = 4318;

const CLIENT_DIST = path.join(REPO_ROOT, "dist", "client", "index.html");
const SERVER_DIST = path.join(REPO_ROOT, "dist", "server", "index.js");

// Fail loudly and early rather than measuring a stale or missing build. A perf
// gate that silently measured the wrong artifact is worse than one that refuses
// to run.
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
  timeout: 240_000,
  // No retries. A retry would silently report a second, warmer run's numbers.
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${PREVIEW_PORT}`,
    headless: true,
  },
  webServer: [
    {
      command: `npx vite preview --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      // Playwright defaults webServer.cwd to the CONFIG file's directory, not
      // the repo root. Without this, vite resolves `dist` against tests/perf/,
      // fails to find it, and never reads vite.config.ts at all (so it would
      // also miss `build.outDir: dist/client`).
      cwd: REPO_ROOT,
    },
    {
      command: `node ${JSON.stringify(SERVER_DIST)}`,
      url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: REPO_ROOT,
      env: {
        ...(process.env as Record<string, string>),
        [TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV]: "1",
        TANDEM_APP_DATA_DIR: PERF_APP_DATA_DIR,
        TANDEM_NO_SAMPLE: "1",
      },
    },
  ],
});

export { PERF_APP_DATA_DIR, PREVIEW_PORT };
