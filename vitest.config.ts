import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

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
          // `exclude`, NOT a negated `include` entry. `include: [..., "!tests/client/**"]`
          // selects exactly the same 324 files -- verified by diffing
          // `vitest list --project=node --filesOnly` across both spellings -- but it
          // silently collects NO V8 coverage for any of them. Measured: with the
          // negation, `vitest run --project=node <any test> --coverage` reports
          // `Unknown% ( 0/0 )` and exits 0; with this spelling the same command
          // reports real per-file numbers. Because a run spanning both projects
          // aggregates to the same 0/0, every coverage run of the whole suite was
          // reporting nothing while exiting successfully -- the #1229 shape, and it
          // would have seeded Unit 13's floors from a measurement that never happened.
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "tests/client/**"],
          // On Windows, integration tests that exercise `applyConfig`
          // spawn icacls + pwsh (Get-Acl) once per write. Under vitest's
          // parallel pool the spawn contention pushes some apply-heavy
          // tests past the 5s default. 15s is enough headroom for the
          // contended case; tests that genuinely hang still surface.
          testTimeout: 15_000,
        },
      },
    ],
    // Coverage belongs HERE, at the root, even though `projects` is set above.
    // `TestProject._configureServer` overwrites any project-level `coverage` with
    // the root's unconditionally, and the types are identical at both levels, so a
    // per-project coverage block is discarded with no error. There is one provider
    // per run, not one per project.
    coverage: {
      provider: "v8",
      // `.svelte` is included because it is measurable, not as an aspiration.
      // Verified: rendering ActivityTray.svelte reports it at 88.62% statements /
      // 92.39% lines, all 101 components appear in the report, and the uncovered
      // ranges map to real source lines (Root.svelte's are 6-7, its only two markup
      // lines). The previous glob `src/**/*.ts` could never match a bare `.svelte`
      // filename, so every component was absent from the report by construction --
      // indistinguishable, in the output, from a component that is measured at 0%.
      //
      // `scripts/ci/coverage-manifest.mjs` re-derives this family set from disk and
      // fails if a family this glob claims turns up zero files in the report, so a
      // future narrowing here cannot quietly shrink what "coverage" means.
      include: ["src/**/*.ts", "src/**/*.svelte"],
      exclude: ["src/**/*.d.ts"],
      reportsDirectory: "coverage",
    },
  },
});
