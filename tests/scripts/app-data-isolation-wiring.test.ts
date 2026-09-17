import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import envPaths from "env-paths";
import { describe, expect, it } from "vitest";
import { resolveAppDataDir, SESSION_DIR } from "../../src/server/platform.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The guard on test-suite isolation from the developer's REAL application data.
 *
 * Why it exists: the suite spent months writing session files, annotation
 * records and document backups into `env-paths("tandem").data` — the same
 * directory the shipped app uses. It surfaced when a Tauri update restarted the
 * app and `restoreOpenDocuments` reopened ~40 test fixtures as tabs. At the time
 * of the fix that directory held 41 fixture sessions, 162 of 175 annotation
 * files, and 4,469 doc-backup directories belonging to tests.
 *
 * This is an ADR-051 wiring test, and it deliberately has TWO halves, because
 * each is blind to the other's failure:
 *
 *   - The **text half** reads `vitest.config.ts`. It catches the wiring being
 *     deleted or moved somewhere it does not run — specifically `setupFiles`
 *     being hoisted to the root `test` block, which is a plausible "tidy-up"
 *     and where it silently never executes at all (`setupFiles` is per-project
 *     with no root fallback; `env` does cascade, which is exactly the asymmetry
 *     that makes the mistake easy).
 *   - The **runtime half** asserts where `SESSION_DIR` actually points in THIS
 *     process. It is the one that survives a config refactor the text half
 *     cannot parse, and the only one that would have caught the original bug:
 *     `SESSION_DIR` is frozen at module load from `resolveAppDataDir()`, so a
 *     config that looks right but lands too late still fails here.
 *
 * Not asserted, deliberately: that `isolate` is not `false`. An earlier draft
 * appended the worker suffix to `TANDEM_APP_DATA_DIR` in place, which compounds
 * once per file when one process runs many files. The setup file now derives
 * the path from the immutable `TANDEM_TEST_APP_DATA_ROOT` instead, so the
 * result is idempotent under any `isolate` setting and there is no dependency
 * on the default to protect.
 */
describe("vitest app-data isolation", () => {
  const config = readFileSync(path.join(ROOT, "vitest.config.ts"), "utf-8");

  it("declares the throwaway app-data root in the cascading `env` block", () => {
    expect(config).toContain("TANDEM_TEST_APP_DATA_ROOT: TEST_APP_DATA_ROOT");
    expect(config).toContain("TANDEM_APP_DATA_DIR: TEST_APP_DATA_ROOT");
  });

  it("registers the setup file in EVERY project, not at the root", () => {
    // `setupFiles:` as well as the path — the file is also named in the prose
    // comment above the `env` block, and a doc mention must not count as
    // wiring.
    const setupLines = config
      .split("\n")
      .filter(
        (line) =>
          line.includes("setupFiles:") && line.includes("tests/setup/app-data-isolation.ts"),
      );
    // One per project. A single occurrence means someone hoisted it to the root
    // `test` block, where it does not run — the failure this test exists for.
    expect(setupLines).toHaveLength(2);

    // Both project blocks must be covered. Keyed on the project `name:` rather
    // than on position, so reordering the array does not read as a regression.
    for (const project of ["client", "node"]) {
      const start = config.indexOf(`name: "${project}"`);
      expect(start, `project '${project}' not found in vitest.config.ts`).toBeGreaterThan(-1);
      const block = config.slice(start, start + 400);
      expect(block, `project '${project}' does not load the isolation setup file`).toContain(
        "tests/setup/app-data-isolation.ts",
      );
    }
  });

  it("resolves SESSION_DIR away from the real app-data directory at runtime", () => {
    const real = envPaths("tandem", { suffix: "" }).data;
    expect(SESSION_DIR.startsWith(real)).toBe(false);
    expect(resolveAppDataDir().startsWith(real)).toBe(false);
  });

  it("gives this worker its own subdirectory under the shared test root", () => {
    const root = process.env.TANDEM_TEST_APP_DATA_ROOT;
    expect(
      root,
      "TANDEM_TEST_APP_DATA_ROOT is unset — `env` did not reach this worker",
    ).toBeTruthy();
    expect(root!.startsWith(os.tmpdir())).toBe(true);

    // The setup file ran: the directory is a per-worker child of the root, not
    // the root itself (which is what `env` alone would leave behind).
    const dir = resolveAppDataDir();
    expect(dir).not.toBe(root);
    expect(path.dirname(dir)).toBe(root);
    expect(path.basename(dir)).toMatch(/^worker-\d+$/);
  });
});
