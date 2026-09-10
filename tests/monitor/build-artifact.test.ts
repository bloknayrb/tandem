import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MONITOR_DIST = resolve(import.meta.dirname, "../../dist/monitor/index.js");

/**
 * #1748 item 2 — both `it`s used to `return` early when the bundle was absent,
 * so they PASSED with zero assertions on every CI run (`Test` ran before
 * `Build`). A `describe.skipIf` makes a missing bundle a visible skip instead,
 * which is the shape `tests/build/version-baked.test.ts` already had.
 *
 * `Build` now runs before `Test` in `ci.yml`'s `check` job, pinned by
 * `tests/scripts/release-ci-hygiene.test.ts`, so these assert for real in CI.
 */
describe.skipIf(!existsSync(MONITOR_DIST))("monitor build artifact", () => {
  it("dist/monitor/index.js exists after build (run `npm run build` first)", () => {
    expect(statSync(MONITOR_DIST).size).toBeGreaterThan(1000);
  });

  it("dist/monitor/index.js references /api/events (not accidentally a different endpoint)", () => {
    const content = readFileSync(MONITOR_DIST, "utf-8");
    expect(content).toContain("/api/events");
    expect(content).toContain("/api/mode");
  });
});
