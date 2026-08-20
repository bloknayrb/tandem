import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = ".github/workflows/tauri-webdriver.yml";

/**
 * `.github/workflows/tauri-webdriver.yml` resolves an Edge WebDriver for the
 * runner's WebView2 Runtime by walking an ordered in-major candidate list, whose
 * last resort is a hand-pinned `$pinned` table (#1197, PR #1261). Until this file
 * existed, NOTHING in the repo read that workflow — `grep -rn tauri-webdriver`
 * found only prose — so the table could be edited, mis-keyed or deleted with
 * every check green.
 *
 * That matters more here than for a workflow CI runs, because this job is
 * `workflow_dispatch`-only (disabled 2026-08-08, #1345). Its own `::warning::`
 * annotations only render on a run, and nobody has run it since. Those
 * annotations therefore cannot be the guard; a vitest file, which runs on every
 * PR, is the only thing that can see this table at all.
 *
 * Two silent failure shapes are pinned below. A **missing** row leaves
 * `$pinned[$major]` as `$null`, and `Add-Candidate` returns at its `if (-not $v)`
 * guard, so the net vanishes without an error. A **mis-keyed** row
 * (`'152' = '151.0...'`) is worse: `Add-Candidate`'s in-major filter drops it just
 * as silently, and unlike a missing row it does NOT trip the workflow's
 * `ContainsKey` warning, because the key is present.
 *
 * What is deliberately NOT asserted: that the table covers the WebView2 majors
 * Microsoft currently ships. No offline test can know that, and checking it
 * against a hand-maintained constant elsewhere in this repo would be circular.
 * That criterion is dated and human-reviewed, in #1345 (2026-11-01), which
 * already names this table among the evidence it weighs.
 *
 * Following `tests/scripts/acceptance-harness-wiring.test.ts`: PARSE the YAML
 * rather than substring-matching the file (a commented-out step then simply does
 * not exist), locate the step by its `run` content rather than its prose `name`
 * (a rename must not be able to blind the guard), and make every extractor THROW
 * rather than return a sentinel — an assertion built on `-1` or `null` passes
 * vacuously the moment the thing it guards is deleted.
 *
 * One more, learned the hard way while mutation-testing this file: assertions
 * about the SCRIPT run against `runCode`, which has PowerShell comment lines
 * stripped. An early draft matched the raw `run`, and prefixing
 * `Add-Candidate $pinned[$major]` with a single `#` — disabling the last-resort
 * net outright — left all nine assertions green, because the string was still
 * there inside the comment. That is the same reversion
 * `acceptance-harness-wiring.test.ts` records surviving its own first draft.
 * Only the two issue-number assertions read the full `run`, because the
 * references they guard deliberately live in comments.
 */

type Step = { name?: string; run?: string; uses?: string };

const workflow = parse(readFileSync(path.join(ROOT, WORKFLOW), "utf-8")) as {
  on: Record<string, unknown>;
  jobs: Record<string, { steps: Step[] }>;
};

/**
 * Located by the CDN host it downloads from — the step's whole reason to exist —
 * and NOT by any of the strings this file goes on to assert about, which would
 * make those assertions self-satisfying.
 */
function driverStepRun(): string {
  const step = workflow.jobs.webdriver?.steps?.find(
    (s) => typeof s.run === "string" && s.run.includes("https://msedgedriver.microsoft.com/"),
  );
  if (!step?.run) {
    throw new Error(
      `${WORKFLOW}: the "webdriver" job has no step downloading from msedgedriver.microsoft.com`,
    );
  }
  return step.run;
}

const run = driverStepRun();

/**
 * `run` with whole-line PowerShell comments removed. Everything that asserts the
 * script still DOES something must use this — see the header note; a `#` prefix
 * disables a line while leaving its text intact for `toContain`.
 */
const runCode = run
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** Throws rather than returning `[]`: an empty table must fail, not pass quietly. */
function pinnedRows(): [string, string][] {
  const block = runCode.match(/\$pinned = @\{([\s\S]*?)\n\s*\}/);
  if (!block?.[1]) {
    throw new Error(`${WORKFLOW}: cannot find a '$pinned = @{ ... }' hashtable in the driver step`);
  }
  const rows = [...block[1].matchAll(/'([^']+)'\s*=\s*'([^']+)'/g)].map(
    (m) => [m[1], m[2]] as [string, string],
  );
  if (rows.length === 0) {
    throw new Error(
      `${WORKFLOW}: '$pinned' parsed to zero rows — the last-resort driver net is empty`,
    );
  }
  return rows;
}

describe("tauri-webdriver.yml — trigger surface", () => {
  it("is workflow_dispatch-only (#1345 owns the decision to re-enable)", () => {
    // Every claim below, plus docs/release-smoke-checklist.md's "not applicable:
    // disabled 2026-08-08" row and .claude/skills/release/SKILL.md, rests on this
    // job not running on a tag. Re-adding a trigger has to update those too.
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  });
});

describe("tauri-webdriver.yml — Edge WebDriver candidate chain (#1197)", () => {
  it("still tries the live sources before the hand-pinned net", () => {
    // Order is load-bearing: an exact runtime match first, then Microsoft's
    // pointer, then the walk-back, and only then the pin. A refactor that drops
    // any of these leaves the remaining ones doing more work than they should.
    expect(runCode).toContain("Add-Candidate $pv");
    expect(runCode).toContain("Add-Candidate $latest");
    expect(runCode).toContain("Add-Candidate $pinned[$major]");
  });

  it("still warns when the runners reach a major with no pinned row", () => {
    expect(runCode).toContain("$pinned.ContainsKey($major)");
    expect(runCode).toContain("::warning::No hand-pinned Edge WebDriver");
  });

  it("still warns when ONLY the hand-pinned net resolved", () => {
    // The other half of #1197's "fail loudly": if the pin wins, every live
    // candidate missed — the CDN failure that opened #1197, recurring — and
    // without this the run is an ordinary green.
    expect(runCode).toContain("::warning::Only the hand-pinned Edge WebDriver");
    expect(runCode).toContain("$driverVersion -eq $pinned[$major]");
  });
});

describe("tauri-webdriver.yml — the $pinned last-resort table", () => {
  const rows = pinnedRows();

  it("has at least one row", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("keys are bare WebView2 majors", () => {
    expect(rows.filter(([major]) => !/^\d+$/.test(major))).toEqual([]);
  });

  it("values are four-part driver versions", () => {
    expect(rows.filter(([, version]) => !/^\d+\.\d+\.\d+\.\d+$/.test(version))).toEqual([]);
  });

  it("every row's version is IN the major it is keyed under", () => {
    // The silent one. `Add-Candidate` drops any candidate outside `$major`, so a
    // mis-keyed row is discarded with no error — and the ContainsKey warning
    // above does not fire either, because the key exists. The row looks present
    // and maintained while providing no net whatsoever.
    const misKeyed = rows.filter(([major, version]) => version.split(".")[0] !== major);
    expect(misKeyed).toEqual([]);
  });

  it("names its dated review home so the pin cannot outlive its gate", () => {
    // CLAUDE.md's dated-gate rule: a version pin needs a review path answerable
    // from tracked files. #1345 (2026-11-01) is that path and already lists this
    // table as evidence. Deleting the reference breaks this test rather than
    // silently dropping the link.
    expect(run).toContain("#1345");
    expect(run).toContain("#1197");
  });
});
