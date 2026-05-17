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
}

if (leaks > 0) {
  process.stderr.write(
    `[verify-harness-stripped] ${leaks} harness marker(s) leaked into dist/client. ` +
      `Check that no production-shipping module imports from svelte-harness/.\n`,
  );
  process.exit(1);
}

process.stderr.write("[verify-harness-stripped] OK\n");
