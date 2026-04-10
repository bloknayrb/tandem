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
  webServer: {
    command: "npm run dev:standalone",
    url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/health`,
    reuseExistingServer: !process.env.CI,
    // 180s absorbs cold-start jitter on slow machines (tsx watch JIT compile +
    // Vite pre-bundle + freePort() serial inside concurrently); see #230.
    // A creeping baseline over ~60s should be investigated rather than bumped
    // further — track root-cause follow-up in the issue linked from #230.
    timeout: 180_000,
  },
});
