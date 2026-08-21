#!/usr/bin/env node
/**
 * The release client build (#1492).
 *
 * `npm run build` shells out to this instead of `vite build` for exactly one
 * reason: `src/client/utils/backend-ports.ts` reads
 * `import.meta.env.VITE_TANDEM_WS_PORT` / `VITE_TANDEM_MCP_PORT`, and Vite
 * substitutes those **statically at build time from the ambient environment**.
 * A developer who exported a harness port into their shell — which
 * `.claude/skills/e2e-debug/SKILL.md` walks you into doing, since it has you
 * run Vite standalone against a relocated backend — and then ran `npm run
 * build`, `npm publish` (via `prepublishOnly`) or `cargo tauri build` (via
 * tauri.conf.json's `beforeBuildCommand`, which is this same script) would bake
 * `http://127.0.0.1:4729` into the shipped client. The app would be
 * permanently "Disconnected" with no diagnosis, because nothing at runtime
 * reveals which port was compiled in.
 *
 * So the release build deletes the vars before invoking Vite: the shipped
 * client always falls back to `DEFAULT_WS_PORT`/`DEFAULT_MCP_PORT`, whatever
 * the shell holds. Deleting rather than erroring is deliberate — the ambient
 * value is meaningless to a release build, and a hard failure would make an
 * unrelated stale export block the build.
 *
 * The harness builds are unaffected: they never come through here.
 * `scripts/perf-build.ts` invokes `vite build --outDir dist/perf-client`
 * directly with the vars SET, and the E2E harness sets them on the dev server
 * from `playwright.config.ts`.
 *
 * Second line of defence, in case this one is ever routed around:
 * `scripts/ci/verify-harness-stripped.mjs` greps the emitted bundle for the
 * harness port literals. `tests/scripts/e2e-guard-wiring.test.ts` pins both.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const env = { ...process.env };
for (const key of ["VITE_TANDEM_WS_PORT", "VITE_TANDEM_MCP_PORT"]) {
  if (env[key] !== undefined) {
    process.stderr.write(
      `[build-client] ignoring ambient ${key}=${env[key]} — a release build always targets the default ports.\n`,
    );
    delete env[key];
  }
}

const result = spawnSync("npx", ["vite", "build", ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
