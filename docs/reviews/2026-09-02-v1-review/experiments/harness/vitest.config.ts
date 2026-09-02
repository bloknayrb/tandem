import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
// Run from the repo root:  npx vitest run --config docs/reviews/2026-09-02-v1-review/experiments/harness/vitest.config.ts
const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "../../../../..");
export default defineConfig({
  root: HERE,
  plugins: [svelte({ hot: false })],
  resolve: { conditions: ["browser"] },
  server: { fs: { allow: [ROOT, HERE] } },
  test: { environment: "happy-dom", include: ["*.test.ts"], testTimeout: 60_000, reporters: ["verbose"] },
});
