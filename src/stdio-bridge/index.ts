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

// Importing this module installs its own `uncaughtException` /
// `unhandledRejection` handlers and calls `redirectConsoleToStderr()` at module
// scope. Do NOT add a second pair here the way `src/channel/index.ts` does —
// its runtime (`channel/run.ts`) installs none, ours already has them, and a
// duplicate `process.once` handler would write two stderr lines and race two
// `process.exit(1)` calls for one fault.
import { runMcpStdio } from "../cli/mcp-stdio.js";

// Run unconditionally. `src/monitor/index.ts` guards its equivalent with an
// `isDirectRun` check, and that guard is load-bearing THERE because it
// re-exports its runtime and is imported by `tests/monitor/*` — importing it
// must not start a monitor. This file exports nothing and nothing imports it;
// it exists only to be `node dist/stdio-bridge/index.js`. Copying the guard
// across would be ceremony protecting against a caller that cannot exist.
runMcpStdio().catch((err) => {
  // stderr only — stdout is the MCP wire (Critical Rule 3).
  console.error("[Tandem stdio-bridge] Fatal error:", err);
  process.exit(1);
});
