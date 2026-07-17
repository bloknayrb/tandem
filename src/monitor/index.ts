/**
 * Tandem Monitor — Claude Code plugin monitor standalone binary entry.
 *
 * Two ways the monitor runs:
 *   1. `node dist/monitor/index.js` (the built standalone; used by
 *      `--plugin-dir <repo>` dev loads and the pre-npx manifest form) —
 *      the auto-run block below fires.
 *   2. `npx -y tandem-editor@<version> monitor` (the CLI subcommand the
 *      shipping manifest uses) — the CLI dynamically imports `./run.js`
 *      directly, so this file (and its auto-run) is never loaded.
 *
 * The runtime lives in `./run.ts` so `tandem monitor` can share it WITHOUT
 * pulling this auto-run block. That split is deliberate: in the bundled
 * `dist/cli/index.js`, `process.argv[1]` and this file's `import.meta.url`
 * both resolve to the CLI bundle, so `isDirectRun` would be TRUE and `main()`
 * would fire once here AND once from the subcommand dispatch — a doubled SSE
 * subscription that emits every event twice. Keeping the auto-run out of the
 * imported runtime is what prevents that. Mirrors `src/channel/index.ts`.
 */

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./run.js";

// Re-export the full runtime surface so existing importers (and the many
// `tests/monitor/*` suites that import from `../../src/monitor/index.js`)
// keep resolving `main`, `connectAndStream`, `getCachedMode`, the test
// helpers, etc. against this entry.
export * from "./run.js";

const IS_VITEST = process.env.VITEST === "true";

// Auto-run when invoked directly (e.g. `node dist/monitor/index.js` or
// `tsx src/monitor/index.ts`). Skipped under vitest so tests can import
// and drive individual functions.
//
// Cross-platform direct-run detection: compare resolved file paths
// (not URL strings) because Windows file:// URLs normalize differently
// than process.argv[1] backslashes. Case-insensitive on win32 because
// C:\ vs c:\ drive letters can drift depending on how the CLI was invoked.
function normalizeForCompare(p: string): string {
  const r = resolvePath(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}
const __thisFileNormalized = normalizeForCompare(fileURLToPath(import.meta.url));
const isDirectRun =
  typeof process.argv[1] === "string" &&
  normalizeForCompare(process.argv[1]) === __thisFileNormalized;
if (isDirectRun && !IS_VITEST) {
  main().catch((err) => {
    console.error(`[Monitor] Fatal error:`, err);
    process.exit(1);
  });
}
