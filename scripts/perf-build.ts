import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERF_MCP_PORT, PERF_WS_PORT } from "./test-ports";

/**
 * Build step for `npm run perf:gate` (#1492).
 *
 * Two builds, deliberately, and the separation is the point:
 *
 *  1. `npm run build` with the VITE_TANDEM_* vars explicitly REMOVED — so
 *     `dist/client` and `dist/server` stay exactly what a release build
 *     produces. A perf-baked client in `dist/client` would leave a developer
 *     who later runs `node dist/server/index.js` staring at a client
 *     permanently "Disconnected" on the product ports with zero diagnosis.
 *     `npm run build` now strips those vars itself, in
 *     `scripts/build-client.mjs` — this deletion is the caller restating its
 *     own requirement, and survives if that wrapper is ever routed around.
 *  2. `vite build --outDir dist/perf-client` with the vars set from
 *     `scripts/test-ports.ts` — the client the perf harness actually serves,
 *     baked to the perf backend pair. `tests/perf/playwright.config.ts` reads
 *     this outDir, package.json's `files` excludes it from the published
 *     tarball with an explicit `"!dist/perf-client"`, and nothing else ever
 *     looks at it.
 *
 * A tsx script rather than inline package.json env prefixes because the env
 * literals must come from the single source of truth and survive Windows
 * (no `VAR=x` in npm scripts there).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: string[], extraEnv: Record<string, string | undefined>): void {
  const env = { ...process.env, ...extraEnv };
  // `undefined` values delete the key: an outer shell exporting VITE_TANDEM_*
  // must not leak into the production-identical build.
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
  }
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm", ["run", "build"], {
  VITE_TANDEM_WS_PORT: undefined,
  VITE_TANDEM_MCP_PORT: undefined,
});

run("npx", ["vite", "build", "--outDir", "dist/perf-client"], {
  VITE_TANDEM_WS_PORT: String(PERF_WS_PORT),
  VITE_TANDEM_MCP_PORT: String(PERF_MCP_PORT),
});
