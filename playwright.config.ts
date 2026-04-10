import { defineConfig } from "@playwright/test";
import { DEFAULT_MCP_PORT } from "./src/shared/constants";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: 1,
  workers: 1, // server supports one MCP session at a time
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  // Two webServer entries instead of `npm run dev:standalone`:
  //   1. Vite dev server for the client (unchanged)
  //   2. Pre-built backend via `node dist/server/index.js`
  //
  // Why not `tsx watch src/server/index.ts`? On Windows the tsx watch spawn
  // chain has a reproducible cold-start stall under Playwright's webServer
  // supervision — webServer timed out at 60s (pass 1), 180s with the original
  // command (pass 2), and 180s even with `stdio: "ignore"` (also pass 2). A
  // pre-built server bundle skips the transpiler/watcher entirely and boots
  // deterministically in well under a second in local testing (see #230).
  //
  // Tradeoff: E2E runs do a ~200ms tsup build before Playwright launches the
  // server. Local dev loop (`npm run dev:standalone`) is unchanged.
  webServer: [
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npm run build:server && node dist/server/index.js",
      url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
