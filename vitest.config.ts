import fs from "node:fs";
import os from "node:os";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Root of the throwaway app-data tree every test worker writes under.
 *
 * A fixed name rather than `mkdtemp`: this config is evaluated on every vitest
 * invocation (`vitest list` included), and a fresh temp root per invocation
 * would litter `%TEMP%` the way the suite's own `tandem-test-*` fixture dirs
 * already do — there are tens of thousands of those on the machine this was
 * written on. Per-worker subdirectories under this root come from
 * `tests/setup/app-data-isolation.ts`; concurrent runs cannot collide because
 * that suffix is the worker PID.
 */
const TEST_APP_DATA_ROOT = path.join(os.tmpdir(), "tandem-vitest-appdata");
fs.mkdirSync(TEST_APP_DATA_ROOT, { recursive: true });

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
    // Point the whole run at a throwaway app-data tree BEFORE any source module
    // is imported. `src/server/platform.ts` freezes `SESSION_DIR` and
    // `LAST_SEEN_VERSION_FILE` at module scope, so a per-test `beforeEach`
    // override cannot reach them — measured, against the real module. Without
    // this, any of the ~39 `tests/server/**` files that open a document writes
    // session files into the developer's REAL store, where the next app restart
    // reopens them as tabs. Every other consumer (annotations, doc-backups,
    // license, integrations, models) resolves the directory lazily and was
    // equally unisolated for the simpler reason that nothing set the variable.
    //
    // `env` at the root DOES cascade into `projects` (verified on vitest
    // 4.1.11) and beats a same-named variable already in the developer's shell,
    // which is what makes it fail-closed. `setupFiles` does NOT cascade — it is
    // a per-project array with no root fallback, so a root-level entry never
    // runs at all. It is declared in both project blocks below for that reason;
    // `tests/scripts/app-data-isolation-wiring.test.ts` is the guard.
    //
    // This value is the fallback if the setup file is ever removed: still a
    // temp directory, never the user's real one.
    env: {
      TANDEM_TEST_APP_DATA_ROOT: TEST_APP_DATA_ROOT,
      TANDEM_APP_DATA_DIR: TEST_APP_DATA_ROOT,
    },
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
          // Per-project: `setupFiles` has no root fallback (see the root `env` note).
          setupFiles: ["./tests/setup/app-data-isolation.ts"],
          include: ["tests/client/**/*.test.ts"],
          // Same reason the node project below carries 15s, and the same
          // number: under vitest's parallel pool this project's specs exceed
          // the 5s default while doing nothing unusual. `useTauriFileDrop`
          // runs 18 specs in 2.9s alone (~160ms each) and times out at 5s when
          // the machine is loaded -- a ~30x spread, so the ceiling was
          // measuring contention, not the code.
          //
          // The asymmetry was the bug: the node project was given headroom
          // when it hit this and the client project never was, so every
          // developer running the suite alongside anything else lost time to
          // a red run that reproduced nowhere. Tests that genuinely hang still
          // surface at 15s.
          testTimeout: 15_000,
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
          // Per-project: `setupFiles` has no root fallback (see the root `env` note).
          setupFiles: ["./tests/setup/app-data-isolation.ts"],
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
