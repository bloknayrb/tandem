import { defineConfig } from "@playwright/test";
import { DEFAULT_MCP_PORT } from "./src/shared/constants";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: 1,
  workers: 1, // server supports one MCP session at a time
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
  },
  // Two webServer entries instead of `npm run dev:standalone`:
  //   1. Vite dev server for the client
  //   2. Backend via the tsx CLI invoked through `node` directly
  //
  // Why `node node_modules/tsx/dist/cli.mjs`, not `tsx watch` / `npx tsx` /
  // `node_modules/.bin/tsx`? (issue #244)
  //
  // On Windows under Playwright's webServer supervision, the following all
  // deadlock — Playwright's pipe never sees any child output, the server
  // never binds the port, and webServer times out:
  //   - `tsx watch src/server/index.ts`           (watch parent holds pipe)
  //   - `node_modules/.bin/tsx watch ...`         (same — watcher, not npx)
  //   - `npx tsx src/server/index.ts`             (npx wrapper buffers stdio)
  //   - `npx tsx watch src/server/index.ts`       (both wrappers compound)
  //
  // `node_modules/.bin/tsx` (no watch) starts fine when the shell can resolve
  // the .cmd shim — but Playwright spawns the command via cmd.exe and a path
  // with forward slashes does not match the PATHEXT shim resolution there,
  // producing `'node_modules' is not recognized as an internal or external
  // command`. Hard-coding `node_modules\.bin\tsx.cmd` works on Windows but
  // breaks on Unix CI.
  //
  // What works reliably cross-platform (cold start ~3-5s):
  //   - `node node_modules/tsx/dist/cli.mjs src/server/index.ts`
  //
  // Invoking the tsx CLI script through `node` bypasses both shell shim
  // resolution and the watch-mode parent process, while using a forward-slash
  // path that Node accepts on every OS.
  //
  // Root cause is upstream — tsx's watch-mode parent process keeps the
  // stdout pipe to its supervisor (Playwright) open without flushing under
  // Windows anonymous-pipe stdio, and `npx` adds its own buffering layer.
  // Local dev (`npm run dev:server`) keeps `tsx watch` for hot-reload; it
  // works there because there's no parent process holding the pipe.
  //
  // Tradeoff vs the prior `npm run build:server && node dist/...` workaround:
  // no tsup build step (~2-3s faster cold start). First request may be
  // marginally slower due to on-demand transpilation but is well within
  // test timeouts.
  webServer: [
    {
      command: "npm run dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // tsx internal entry path — bypasses both `tsx watch` parent-process
      // stdout-pipe deadlock on Windows AND `npx`/`.bin` shim buffering issues
      // (see rationale block above). If tsx restructures this path, fall back
      // to `npm exec tsx -- src/server/index.ts` or update the path here.
      // See PR #672 investigation notes.
      command: "node node_modules/tsx/dist/cli.mjs src/server/index.ts",
      url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      // 3c-ii-b: the integration wizard now auto-opens on first run via
      // `GET /api/integrations/first-run-needed`. In E2E, a clean home
      // directory makes the server say `needed: true` and the wizard would
      // cover every unrelated test's editor surface. The integration-wizard
      // spec exercises the manual-reopen affordance with this var still set
      // (Reopen button always works).
      env: {
        TANDEM_DISABLE_FIRST_RUN_WIZARD: "1",
      },
    },
  ],
});
