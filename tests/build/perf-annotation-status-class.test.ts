/**
 * Coupling pin for the perf gate's annotation-accept timing signal (#1734, code
 * review cr-2/general-purpose-2).
 *
 * `tests/perf/performance.spec.ts` measures "accept reflected" by waiting for
 * `[data-testid="annotation-card-${id}"] .ach-status.is-accepted` to attach
 * (#1734 — replacing a wait that mostly measured the resolved card's own exit
 * motion, per #1334). `.ach-status` / `.is-accepted` are presentational CSS
 * classes declared in `AnnotationCardHeader.svelte`, not `data-testid`
 * attributes — so they carry none of Critical Rule 7's contract (the
 * `data-testid` set is snapshotted by `testid-coverage.test.ts`; a bare CSS
 * class is invisible to that snapshot, to `check:tokens`, and to biome).
 *
 * A routine rename of either class (e.g. folding `ach-status` into a
 * token-named class during redesign work) leaves `svelte-check`, `vitest` and
 * the testid snapshot all green while the perf spec's locator silently stops
 * matching anything: `toHaveCount(1)` then burns the full 30s timeout and
 * fails as `annotation-accept: 30000ms [FAIL]` — reading exactly like a
 * catastrophic accept-latency regression instead of a stale selector.
 *
 * This test is the tripwire the perf spec itself cannot be: the perf suite
 * has no CI runner (#1825 Tests bullet 9), so a class rename there surfaces
 * only on a manual `npm run perf:gate` run. This one runs in `npm test` and
 * fails with a message that points straight at the two files to fix — the
 * class in the component AND the locator in the perf spec — instead of a
 * misleading timing failure days or weeks later.
 *
 * This group owns `tests/**`, not `src/client/**` behavior (see the K-tests
 * wave-7 coordination note) — so the fix for the underlying coupling is a
 * source-scan pin here, not a `data-testid` added to the component.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const COMPONENT_PATH = "src/client/panels/AnnotationCardHeader.svelte";
const PERF_SPEC_PATH = "tests/perf/performance.spec.ts";

describe("perf gate's annotation-accept signal stays coupled to AnnotationCardHeader", () => {
  it("AnnotationCardHeader.svelte still declares both classes the perf spec locates on", () => {
    const src = readFileSync(path.join(repoRoot, COMPONENT_PATH), "utf-8");
    expect(
      /class\s*=\s*"ach-status"/.test(src),
      `${COMPONENT_PATH} no longer has a bare class="ach-status" — update the locator in ${PERF_SPEC_PATH} (annotation-accept timing signal)`,
    ).toBe(true);
    expect(
      /class:is-accepted\s*=/.test(src),
      `${COMPONENT_PATH} no longer has a class:is-accepted binding — update the locator in ${PERF_SPEC_PATH} (annotation-accept timing signal)`,
    ).toBe(true);
  });

  it("the perf spec's annotation-accept locator still names both classes", () => {
    const src = readFileSync(path.join(repoRoot, PERF_SPEC_PATH), "utf-8");
    expect(
      src.includes(".ach-status.is-accepted"),
      `${PERF_SPEC_PATH} no longer locates on .ach-status.is-accepted — if this moved to a data-testid, delete this pin (it becomes redundant with the testid-coverage snapshot)`,
    ).toBe(true);
  });
});
