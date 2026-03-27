import { defineConfig } from "@playwright/test";

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
    url: "http://127.0.0.1:3479/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
