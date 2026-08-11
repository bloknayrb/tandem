#!/usr/bin/env node
/**
 * Tandem stdio bridge — standalone binary entry.
 *
 * This exists so a generated `mcpServers.tandem` entry can name an ABSOLUTE
 * Node binary and an ABSOLUTE script, instead of the bare `npx` that every
 * stdio target used to get. A bare command word is resolved through the MCP
 * client's PATH at spawn time, and a GUI-launched client does not inherit a
 * login shell's PATH — on macOS it gets roughly
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which contains no Node. The client then
 * reports `Failed to spawn process: No such file or directory` and Tandem is
 * unreachable with nothing in Tandem's own logs. Same argument, same evidence
 * as `src/server/integrations/node-binary.ts`, which fixed it for
 * `tandem-channel`; this is the `tandem` half.
 *
 * WHY A SEPARATE BUNDLE INSTEAD OF `dist/cli/index.js`. The CLI is the one
 * tsup entry that does not spread `selfContained`, so it leaves every runtime
 * dependency external and resolves them from a sibling `node_modules`. That
 * works for an npm global install and cannot work from a Tauri resource dir,
 * which ships no `node_modules` — the entry would exist (so an `existsSync`
 * guard would happily write it into the user's config) and then die on
 * `ERR_MODULE_NOT_FOUND`, which is strictly worse than the `npx` it replaced.
 * `dist/channel/` and `dist/monitor/` are the same pattern for the same
 * reason; this is the third.
 *
 * The runtime stays in `src/cli/mcp-stdio.ts` so `tandem mcp-stdio` — still
 * used by the npx fallback, the plugin manifest and the Cowork bridge — and
 * this bundle cannot drift apart.
 */

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
// Importing this module installs its own `uncaughtException` /
// `unhandledRejection` handlers and calls `redirectConsoleToStderr()` at module
// scope. Do NOT add a second pair here the way `src/channel/index.ts` does —
// its runtime (`channel/run.ts`) installs none, ours already has them, and a
// duplicate `process.once` handler would write two stderr lines and race two
// `process.exit(1)` calls for one fault.
import { runMcpStdio } from "../cli/mcp-stdio.js";

const IS_VITEST = process.env.VITEST === "true";

// Auto-run only when invoked directly, and never under vitest, so a test can
// import this entry to assert its shape without spawning a live bridge.
//
// The guard is load-bearing beyond tests: `tandem mcp-stdio` reaches the same
// runtime through a dynamic import, and in the bundled `dist/cli/index.js` both
// `process.argv[1]` and an imported module's `import.meta.url` collapse onto the
// CLI bundle. Without this check a future bundling change could start the bridge
// twice — once here, once from the subcommand dispatch — and two
// `StdioServerTransport`s reading the same stdin corrupt the JSON-RPC wire.
// Mirrors `src/monitor/index.ts`, which documents the same hazard.
//
// Compare resolved paths, not URL strings: Windows `file://` URLs normalize
// differently from `process.argv[1]` backslashes, and drive-letter case drifts
// depending on how the process was launched.
function normalizeForCompare(p: string): string {
  const r = resolvePath(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}
const __thisFileNormalized = normalizeForCompare(fileURLToPath(import.meta.url));
const isDirectRun =
  typeof process.argv[1] === "string" &&
  normalizeForCompare(process.argv[1]) === __thisFileNormalized;

if (isDirectRun && !IS_VITEST) {
  runMcpStdio().catch((err) => {
    // stderr only — stdout is the MCP wire (Critical Rule 3).
    console.error("[Tandem stdio-bridge] Fatal error:", err);
    process.exit(1);
  });
}
