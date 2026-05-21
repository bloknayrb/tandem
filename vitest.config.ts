import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@server": path.resolve(__dirname, "src/server"),
      "@client": path.resolve(__dirname, "src/client"),
    },
  },
  test: {
    projects: [
      {
        // Client tests: Svelte components need browser conditions + DOM environment
        plugins: [svelte({ hot: false })],
        resolve: {
          conditions: ["browser"],
          alias: {
            "@shared": path.resolve(__dirname, "src/shared"),
            "@server": path.resolve(__dirname, "src/server"),
            "@client": path.resolve(__dirname, "src/client"),
          },
        },
        test: {
          name: "client",
          environment: "happy-dom",
          include: ["tests/client/**/*.test.ts"],
        },
      },
      {
        // Server / CLI / other tests: Node environment, no browser conditions
        resolve: {
          alias: {
            "@shared": path.resolve(__dirname, "src/shared"),
            "@server": path.resolve(__dirname, "src/server"),
            "@client": path.resolve(__dirname, "src/client"),
          },
        },
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts", "!tests/client/**/*.test.ts"],
          // On Windows, integration tests that exercise `applyConfig`
          // spawn icacls + pwsh (Get-Acl) once per write. Under vitest's
          // parallel pool the spawn contention pushes some apply-heavy
          // tests past the 5s default. 15s is enough headroom for the
          // contended case; tests that genuinely hang still surface.
          testTimeout: 15_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
