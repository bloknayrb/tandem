#!/usr/bin/env node
/**
 * Does the BUILT server bundle close the development allowance? (#2410)
 *
 * `src/server/models/dev-allowance-build.ts` tells a release build from a run
 * from source by `typeof __TANDEM_VERSION__`. That test fails open: a bundle
 * built without the define would still contain it and classify as source,
 * honouring `TANDEM_MODELS_DEV_ORIGIN` in a shipped build. So after Build this
 * reads `dist/server/index.js` (never the `.map`, which keeps the source) and
 * fails unless the leaf is in it (its `--tandem-e2e-harness` literal) and no
 * `typeof __TANDEM_VERSION__` survives anywhere in it: the define replaces
 * every occurrence. Pinned by tests/scripts/models-dev-allowance-wiring.test.ts.
 *
 * Usage: node scripts/ci/models-dev-allowance-bundle-check.mjs [bundle]
 * Exit 0 = closed; 1 = not; 3 = no bundle.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundle = process.argv[2] ?? path.join(ROOT, "dist/server/index.js");

if (!existsSync(bundle)) {
  console.error(`[models-dev-allowance] no bundle at ${bundle}: run the build first`);
  process.exit(3);
}
const text = readFileSync(bundle, "utf-8");
if (!text.includes('"--tandem-e2e-harness"')) {
  console.error("[models-dev-allowance] the bundle does not contain dev-allowance-build.ts");
  process.exit(1);
}
if (/typeof\s+__TANDEM_VERSION__/.test(text)) {
  console.error(
    "[models-dev-allowance] `typeof __TANDEM_VERSION__` survives in the bundle: it was built " +
      "without the define, so a release would honour TANDEM_MODELS_DEV_ORIGIN",
  );
  process.exit(1);
}
console.error(
  "[models-dev-allowance] ok: the release bundle ignores the allowance outside the E2E harness",
);
