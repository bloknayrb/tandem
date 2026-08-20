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
 * Located by the driver archive it downloads — the step's whole reason to exist —
 * and NOT by any of the strings this file goes on to assert about, which would
 * make those assertions self-satisfying.
 *
 * The anchor is the ARCHIVE NAME rather than the CDN host it is fetched from,
 * even though the host reads as the more natural landmark. A `.includes()` of a
 * URL prefix is the shape of `js/incomplete-url-substring-sanitization`, and
 * CodeQL flags it on sight — correctly in general, since `https://host/` can sit
 * anywhere in a longer string. It is not a security decision here (this only
 * picks a YAML step out of a file we control), but an alert that has to be
 * explained away on every future read is worse than an anchor that raises none.
 * `edgedriver_win64.zip` is just as unique — one occurrence in the whole
 * workflow, inside this step — and just as load-bearing.
 */
function driverStepRun(): string {
  const step = workflow.jobs.webdriver?.steps?.find(
    (s) => typeof s.run === "string" && s.run.includes("edgedriver_win64.zip"),
  );
  if (!step?.run) {
    throw new Error(
      `${WORKFLOW}: the "webdriver" job has no step downloading edgedriver_win64.zip`,
    );
  }
  return step.run;
}

const run = driverStepRun();

/**
 * `run` with PowerShell comments removed — BOTH forms. Everything that asserts
 * the script still DOES something must use this; a comment marker disables a
 * line while leaving its text intact for `toContain`.
 *
 * The block form `<# … #>` is not optional. With only the whole-line `#` filter,
 * wrapping the last-resort net in a block comment disabled it while the suite
 * stayed fully green — the exact "grep-shaped test asserting a string while
 * claiming a semantic property" failure this file exists to avoid. The span is
 * blanked rather than deleted so that character offsets in the rest of its own
 * line are unshifted — `at()` compares offsets, and a block comment opened and
 * closed mid-line would otherwise drag the code after it leftwards. (Nothing
 * here reads `runCode` by line NUMBER; the whole-line filter below deletes
 * lines outright, so `runCode` is much shorter than `run`.)
 *
 * `<#` and `#>` are also counted for balance in a test below: the non-greedy
 * match simply does not fire on an UNTERMINATED `<#`, so the disabled code
 * survives into `runCode` and every `toContain` stays green. What no
 * string-shaped test can catch is `if ($false) { … }` around the same code —
 * that is acknowledged, not solved, here.
 */
const runCode = run
  .replace(/<#[\s\S]*?#>/g, (m) => m.replace(/[^\n]/g, " "))
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** Index of `needle` in `runCode`, throwing rather than returning -1. */
function at(needle: string): number {
  const i = runCode.indexOf(needle);
  if (i < 0) throw new Error(`${WORKFLOW}: the driver step no longer contains \`${needle}\``);
  return i;
}

/**
 * The walk-back's `-le <n>` loop bound, read out of the script rather than
 * duplicated as a literal here. Two assertions below depend on it — the prose
 * candidate counts and how far a pinned row must sit under its pointer — and a
 * second hard-coded 16 in this file would just be a third place to drift.
 */
function walkBackBound(): number {
  const m = runCode.match(/-le (\d+) -and/);
  if (!m?.[1]) throw new Error(`${WORKFLOW}: cannot find the walk-back's '-le <n> -and' bound`);
  return Number(m[1]);
}

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
  it("still tries the live sources BEFORE the hand-pinned net", () => {
    // Order is load-bearing, and asserting only PRESENCE does not capture it:
    // `Add-Candidate` appends, and the first candidate whose zip downloads wins,
    // so hoisting the pin above `$pv` makes a stale driver outrank the exact
    // runtime match — the silent degradation this chain exists to prevent.
    // Measured: with three order-blind `toContain` calls, that hoist left the
    // suite 9/9 green.
    //
    // All FOUR positions are pinned, not three. With only the outer two, moving
    // the whole walk-back `foreach` block BELOW `Add-Candidate $pinned[$major]`
    // left the suite 10/10 green — and that reordering makes the stale hand-pin
    // outrank every live near-miss build, which is the same degradation one step
    // further down the chain.
    expect(at("Add-Candidate $pv")).toBeLessThan(at("Add-Candidate $latest"));
    expect(at("Add-Candidate $latest")).toBeLessThan(at("foreach ($seed in @($latest, $pv))"));
    expect(at("foreach ($seed in @($latest, $pv))")).toBeLessThan(
      at("Add-Candidate $pinned[$major]"),
    );
  });

  it("cannot be blinded by an unterminated PowerShell block comment", () => {
    // `runCode`'s block-comment stripper is `<#[\s\S]*?#>`, which is non-greedy
    // and therefore does not fire at all on an unterminated `<#`. Measured: a
    // bare `<# disabled` inserted above `Add-Candidate $pinned[$major]` — which
    // comments out the whole rest of the script in real pwsh — left the suite
    // 10/10 green, because the text still reached every `toContain`. Balance is
    // the cheap invariant that catches it, and it is also a genuine syntax error
    // in the workflow, so there is no legitimate reason for it to be unbalanced.
    const opens = (run.match(/<#/g) ?? []).length;
    const closes = (run.match(/#>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("keeps the candidate-count prose derived from the walk-back bound", () => {
    // Both `::warning::`-adjacent comments quote a maximum list length, and the
    // review that produced this test found one saying 34 while the other said 35
    // (the real max is 1 `$pv` + 1 `$latest` + 16 + 16 + 1 pin). A hard-coded
    // number in prose next to a `-le N` loop bound is drift waiting to happen,
    // so derive it: change the bound and this fails until the prose follows.
    const walkBack = walkBackBound();
    const max = 2 * walkBack + 3; // $pv + $latest + two walk-backs + the pin
    const noPointer = walkBack + 2; // $pv + its walk-back + the pin
    expect(run).toContain(`with up to ${max} candidates`);
    expect(run).toContain(`the list is ${max} builds`);
    expect(run).toContain(`leaves ${noPointer}`);
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

  it("records that a pinned row must differ from its LATEST_RELEASE pointer", () => {
    // This invariant cannot be checked offline — it needs a live fetch of
    // LATEST_RELEASE_<major> — so what is pinned here is that the RULE stays
    // written down where the #1345 reviewer will meet it. (Same shape as
    // tests/docs/loopback-gate-claims.test.ts: deleting the prose breaks a test
    // rather than silently dropping the check.)
    //
    // Why it matters: Add-Candidate deduplicates, so a pin equal to the pointer
    // is dropped, and in exactly the #1197 failure — the pointer naming a build
    // whose zip is missing — the net contributes no candidate at all. Both new
    // rows were byte-identical to their pointer when first written.
    expect(run).toContain("must NOT equal today's LATEST_RELEASE_<major>");
    // Not /2026-\d\d-\d\d/, which accepts "Verified 2026-99-99" — a date that
    // reads as maintained and cannot be a real fetch.
    expect(run).toMatch(/Verified \d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])/);
  });

  it("records a live pointer for EVERY row, and every row sits clear of it", () => {
    // The prose above pins that the RULE stays written down. This pins that the
    // rule was actually FOLLOWED — possible offline only because the comment now
    // records the pointers as tracked text, so the fetch is a one-time cost paid
    // by whoever edits the table rather than a network call on every PR run.
    //
    // (a) is the assertion that would have caught the bug this test was added
    // for: '149' was pinned to a build byte-identical to its own pointer while
    // the comment verified only 151 and 152, so the degenerate row was invisible.
    const recorded = new Map(
      [...run.matchAll(/LATEST_RELEASE_(\d+)\s*=\s*(\d+\.\d+\.\d+\.\d+)/g)].map(
        (m) => [m[1], m[2]] as [string, string],
      ),
    );

    for (const [major, pin] of rows) {
      const pointer = recorded.get(major);

      // (a) recorded at all — an unverified row is not a verified one.
      expect(
        pointer,
        `${WORKFLOW}: '$pinned' has a row for major ${major} but the comment records no ` +
          `"LATEST_RELEASE_${major} = <version>" line. Fetch the pointer and record it.`,
      ).toBeDefined();
      if (!pointer) continue;

      // (b) differs from the pointer — Add-Candidate deduplicates an equal row
      // away, leaving the net present-but-degenerate.
      expect(
        pin,
        `${WORKFLOW}: pinned row '${major}' equals its recorded LATEST_RELEASE_${major}, so ` +
          `Add-Candidate deduplicates it away and the last-resort net is degenerate.`,
      ).not.toBe(pointer);

      // (c) further below the pointer than the walk-back reaches — that loop
      // emits pointer-1 .. pointer-N, and deduplicates a row landing in there
      // for exactly the same reason as (b). Only comparable on the same version
      // line; a row on a different build line cannot collide with that walk-back.
      const pinParts = pin.split(".");
      const ptrParts = pointer.split(".");
      if (pinParts.slice(0, 3).join(".") !== ptrParts.slice(0, 3).join(".")) continue;
      const walkBack = walkBackBound();
      const distance = Number(ptrParts[3]) - Number(pinParts[3]);
      expect(
        distance,
        `${WORKFLOW}: pinned row '${major}' (${pin}) sits ${distance} patches below ` +
          `LATEST_RELEASE_${major} (${pointer}); the ${walkBack}-patch walk-back under the ` +
          `pointer swallows it, so the row adds no candidate. Pin more than ${walkBack} below.`,
      ).toBeGreaterThan(walkBack);
    }
  });

  it("names its dated review home so the pin cannot outlive its gate", () => {
    // CLAUDE.md's dated-gate rule: a version pin needs a review path answerable
    // from tracked files. #1345 (2026-11-01) is that path and already lists this
    // table as evidence. Deleting the reference breaks this test rather than
    // silently dropping the link.
    // Pin the SENTENCE, not the number. `#1345` occurs three times and `#1197`
    // seven times in this step, so a bare `toContain("#1345")` survives rewriting
    // the one line that names the review home — measured: rewriting it to
    // "REVIEW HOME: nowhere" left the suite 9/9 green.
    expect(run).toContain("REVIEW HOME: #1345");
    expect(run).toMatch(/REVIEW HOME: #1345[\s\S]{0,80}2026-11-01/);
    expect(run).toContain("#1197");
  });
});
