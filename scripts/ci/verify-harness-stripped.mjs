#!/usr/bin/env node
/**
 * CI smoke test: assert dev-only harness components do NOT leak into the
 * production client bundle.
 *
 * The svelte-harness directory exists so unit and E2E tests can mount the
 * updater dot, updater banner, error boundary, etc. without standing up
 * the full App.svelte. Those harnesses are intentionally permissive about
 * exposing internal state (e.g. `harness-acknowledge` button, version
 * accessor) — fine for tests, embarrassing in production.
 *
 * Vite includes only the HTML entries explicitly listed in
 * `rollupOptions.input`. The harness lives at the repo root in its own
 * `svelte-harness.html` and is NOT listed there, so it's never bundled —
 * but a future change could accidentally import a harness component from
 * a production-shipping module and pull it into the main chunk graph.
 * This script catches that regression at CI time.
 *
 * The same script also catches a second, unrelated leak with the same shape
 * (#1492): `src/client/utils/backend-ports.ts` reads `VITE_TANDEM_*` from
 * `import.meta.env`, which Vite substitutes from the ambient environment at
 * build time, so a stale harness port exported in the building shell would be
 * baked into the shipped client — which would then be permanently
 * "Disconnected" with no diagnosis. `scripts/build-client.mjs` deletes those
 * vars, and the harness port literals below are the check that it worked.
 *
 * Strategy: post-build, grep the emitted JS/CSS/HTML for harness-specific
 * symbols. A hit fails the build with a pointer at which file leaked.
 *
 * Exits 0 on pass (no hits), 1 on any hit. Diagnostics to stderr.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");
const distClient = join(repoRoot, "dist/client");

// Markers chosen so each is unambiguously a harness artefact. testid strings
// are easier to grep than component names because component names get
// minified — testids survive as raw string literals.
const HARNESS_MARKERS = [
  "harness-acknowledge",
  "harness-version",
  "harness-banner-dismiss",
  "UpdateAvailableHarness",
  "UpdaterBannerHarness",
  "ConnectionBannerHarness",
  "ErrorBoundaryHarness",
  "StoreReadOnlyBannerHarness",
  "NotificationsHarness",
  "EditorHarness",
  "harness-root",
];

/**
 * Harness backend ports (#1492), kept in sync with scripts/test-ports.ts by
 * tests/scripts/e2e-guard-wiring.test.ts. A shipped client is only ever built
 * against DEFAULT_WS_PORT/DEFAULT_MCP_PORT, so any of these appearing in
 * dist/client means an ambient VITE_TANDEM_* was baked in.
 *
 * BARE DIGITS, matched on word boundaries — not `127.0.0.1:4729`. Verified
 * against real builds both directions: the URL never survives minification as
 * one literal (`MCP_BASE_URL` stays the template `http://127.0.0.1:${Xs}` with
 * the port as a variable), while the env value itself is inlined verbatim as
 * the resolver's first argument. A baked build emits ``Ys(`4729`,Va)``; a clean
 * one emits `Ys(void 0,Va)`. So the port number is the only form that is
 * actually there to find.
 *
 * A bare number is a wider net than a testid string, deliberately: the current
 * clean bundle contains none of these four anywhere. If a future dependency
 * ever minifies to one of them, the fix is to renumber the harness port in
 * scripts/test-ports.ts, not to weaken this check.
 */
const HARNESS_PORT_MARKERS = [4728, 4729, 4378, 4379];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

let leaks = 0;
for (const file of walk(distClient)) {
  if (!/\.(js|css|html|map)$/.test(file)) continue;
  // Skip .map files — sourcemaps reference the original module paths
  // (svelte-harness/...) which would false-positive on the source path
  // marker without telling us anything about runtime exposure.
  if (file.endsWith(".map")) continue;
  const content = readFileSync(file, "utf8");
  for (const marker of HARNESS_MARKERS) {
    if (content.includes(marker)) {
      process.stderr.write(`[verify-harness-stripped] LEAK: ${file} contains "${marker}"\n`);
      leaks += 1;
    }
  }
  for (const port of HARNESS_PORT_MARKERS) {
    if (new RegExp(`\\b${port}\\b`).test(content)) {
      process.stderr.write(
        `[verify-harness-stripped] LEAK: ${file} contains harness port ${port} — ` +
          `a VITE_TANDEM_* var was set when this client was built.\n`,
      );
      leaks += 1;
    }
  }
}

if (leaks > 0) {
  process.stderr.write(
    `[verify-harness-stripped] ${leaks} harness marker(s) leaked into dist/client. ` +
      `Check that no production-shipping module imports from svelte-harness/, ` +
      `and that no VITE_TANDEM_* port was set in the building shell ` +
      `(scripts/build-client.mjs deletes them; a bare \`vite build\` does not).\n`,
  );
  process.exit(1);
}

process.stderr.write("[verify-harness-stripped] OK\n");
