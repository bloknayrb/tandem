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
