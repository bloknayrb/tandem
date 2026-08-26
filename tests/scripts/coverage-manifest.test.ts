import { describe, expect, it } from "vitest";
import { buildManifest, MAX_EXEMPT_STATEMENTS } from "../../scripts/ci/coverage-manifest.mjs";

type Result = ReturnType<typeof buildManifest>;
type Refusal = Extract<Result, { ok: false }>;
type Accepted = Extract<Result, { ok: true }>;

/**
 * Narrow to a refusal, failing loudly when the call was accepted.
 *
 * A test that reads `r.message` off an un-narrowed union gets `undefined`
 * when the call SUCCEEDED, and `expect(undefined).toContain(...)` throws for
 * the wrong reason -- a passing check would be indistinguishable from a
 * broken one at a glance. These two throw with the actual outcome instead.
 */
function refused(r: Result): Refusal {
  if (r.ok) throw new Error("expected a refusal, got an accepted manifest");
  return r;
}

function accepted(r: Result): Accepted {
  if (!r.ok) throw new Error(`expected acceptance, got refusal: ${r.message}`);
  return r;
}

/**
 * Behavioural tests for the coverage baseline's refusal paths.
 *
 * The sibling `coverage-manifest-wiring.test.ts` pins the surrounding
 * configuration -- the Vitest config shape, the npm script, the CI job. This
 * file drives the script's actual logic, and it exists because review found
 * that pinning source text was not enough: the anti-partial-run check, by the
 * script's own comment the most load-bearing thing in it, could be deleted
 * outright with the whole suite staying green. Mutation proofs had been run by
 * hand and did not persist, which is the same as not having them.
 *
 * Every refusal below is a case that once had to be reasoned about rather than
 * executed. The rule this file enforces on itself: an assertion that only
 * checks `ok === false` is not enough -- it must pin WHICH refusal fired, or a
 * bug in one check is satisfied by another check's message.
 */

const ROOT = process.cwd();

/** A summary key as the coverage provider writes it: absolute, host separators. */
const key = (repoPath: string) => `${ROOT}/${repoPath}`.replace(/\//g, sep());
const sep = () => (process.platform === "win32" ? "\\" : "/");

type Counts = { total: number; covered: number; skipped: number; pct: number };
const counts = (total: number, covered: number): Counts => ({
  total,
  covered,
  skipped: 0,
  pct: total === 0 ? 0 : Number(((covered / total) * 100).toFixed(2)),
});

const fileEntry = (total: number, covered: number) => ({
  statements: counts(total, covered),
  branches: counts(total, covered),
  functions: counts(total, covered),
  lines: counts(total, covered),
});

/**
 * A minimal but VALID input: one area per key of AREA_PROJECTS, each with
 * coverage, plus one file of each measured family.
 *
 * Built to pass, so that each test below changes exactly one thing and the
 * refusal it triggers is attributable to that change. A fixture that already
 * fails for an unrelated reason proves nothing about the check under test.
 */
const AREAS = ["server", "client", "shared", "cli", "channel", "monitor", "stdio-bridge"];

function validInput(overrides: { onDisk?: string[]; summary?: Record<string, unknown> } = {}) {
  const onDisk = [
    ...AREAS.map((a) => `src/${a}/index.ts`),
    "src/client/state.svelte.ts",
    "src/client/Root.svelte",
  ];
  const summary: Record<string, unknown> = {
    total: {
      statements: counts(100, 70),
      branches: counts(100, 60),
      functions: counts(100, 65),
      lines: counts(100, 72),
    },
  };
  for (const f of onDisk) {
    // stdio-bridge is the one genuinely-exempt area; give it zero covered so
    // the fixture matches the real repo's shape.
    summary[key(f)] = f.startsWith("src/stdio-bridge/") ? fileEntry(3, 0) : fileEntry(10, 7);
  }
  return {
    onDisk: overrides.onDisk ?? onDisk,
    summary: overrides.summary ?? summary,
  };
}

/** Deep-ish clone that keeps the absolute keys intact. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("coverage baseline: the valid case", () => {
  it("accepts a whole-suite measurement and names every family and area", () => {
    const result = accepted(buildManifest(validInput()));

    // The fixture is the negative control for every test below it: if this
    // stops passing, none of the refusals proved anything about their own check.
    expect(result.manifest.areas.map((a: { id: string }) => a.id).sort()).toEqual(
      [...AREAS].sort(),
    );
    expect(result.manifest.measured.map((f: { id: string }) => f.id)).toEqual([
      "ts",
      "svelte-runes",
      "svelte-components",
    ]);
    // Every measured family found its file, so none is silently absent.
    for (const f of result.manifest.measured) {
      expect(f.filesInReport, `${f.id} absent from report`).toBe(f.filesOnDisk);
    }
    // All four metrics survive to the artifact.
    expect(Object.keys(result.manifest.totals).sort()).toEqual([
      "branches",
      "functions",
      "lines",
      "statements",
    ]);
    expect(result.manifest.thresholds.enforced).toBe(false);
  });

  it("says `not walked` rather than zero for a family outside src/", () => {
    // The artifact's own central distinction, applied to its own output: a `0`
    // formatted like the genuinely-counted families reads as "there is none of
    // this" when it means "we did not look".
    const { manifest } = accepted(buildManifest(validInput()));
    // Throw on a missing family rather than reading through an optional. An
    // absent entry would otherwise make `undefined?.filesOnDisk` compare equal
    // to null and pass -- the assertion agreeing with the family having
    // vanished, which is the opposite of what it is for.
    const omitted = (id: string) => {
      const found = manifest.omitted.find((f: { id: string }) => f.id === id);
      if (!found) throw new Error(`no omitted family "${id}" in the manifest`);
      return found;
    };
    expect(omitted("rust").filesOnDisk).toBeNull();
    expect(omitted("rust").notWalked).toBeTruthy();
    expect(omitted("css").filesOnDisk, "a walked family must report a real count").toBe(0);
  });
});

describe("coverage baseline: refusals", () => {
  it("refuses a summary with no total", () => {
    const input = validInput();
    const summary = clone(input.summary) as Record<string, unknown>;
    delete summary.total;
    const r = refused(buildManifest({ ...input, summary }));
    expect(r.message).toContain("no `total` key");
  });

  it.each([
    "statements",
    "branches",
    "functions",
    "lines",
  ])("refuses a summary missing total.%s", (metric) => {
    // Only `statements` was validated before review; the other three were
    // published unchecked. A provider bump that drops one yields
    // `undefined`, which JSON.stringify removes silently, and Unit 13 seeds
    // a floor from a totals object missing a metric.
    const input = validInput();
    const summary = clone(input.summary) as { total: Record<string, unknown> };
    delete summary.total[metric];
    const r = refused(buildManifest({ ...input, summary }));
    expect(r.message).toContain(metric);
  });

  it("refuses a run that measured zero statements", () => {
    // The bug this unit found: a negated glob in `test.include` selects the
    // right files and instruments none of them. Tests pass, exit code is 0.
    const input = validInput();
    const summary = clone(input.summary) as { total: { statements: Counts } };
    summary.total.statements = counts(0, 0);
    const r = refused(buildManifest({ ...input, summary }));
    expect(r.message).toContain("ZERO statements");
  });

  it("refuses an empty file list rather than passing every check vacuously", () => {
    // A check over zero items passes. With no files, family accounting and
    // area accounting both iterate nothing and report success.
    const r = refused(buildManifest({ ...validInput(), onDisk: [] }));
    expect(r.message).toContain("no files found under src/");
  });

  it("refuses when a measured family has files on disk but none in the report", () => {
    // How all 101 .svelte components were absent rather than at 0%: the
    // coverage `include` glob could not match a bare .svelte filename.
    const input = validInput();
    const summary = clone(input.summary) as Record<string, unknown>;
    delete summary[key("src/client/Root.svelte")];
    const r = refused(buildManifest({ ...input, summary }));
    expect(r.message).toContain("NO files in the report");
    expect(r.message).toContain("svelte-components");
  });

  it("refuses a file sitting directly in src/, which belongs to no area", () => {
    const input = validInput();
    const r = refused(buildManifest({ ...input, onDisk: [...input.onDisk, "src/loose.ts"] }));
    expect(r.message).toContain("belong to no area");
    expect(r.message).toContain("src/loose.ts");
  });

  it("refuses an area on disk that AREA_PROJECTS does not label", () => {
    // A new top-level directory must be a decision someone makes, not an
    // "unknown" string published in an artifact whose job is saying what ran.
    const input = validInput();
    const onDisk = [...input.onDisk, "src/brandnew/index.ts"];
    const summary = {
      ...(input.summary as object),
      [key("src/brandnew/index.ts")]: fileEntry(9, 4),
    };
    const r = refused(buildManifest({ onDisk, summary }));
    expect(r.message).toContain("no entry in AREA_PROJECTS");
    expect(r.message).toContain("brandnew");
  });

  it("refuses when a labelled area is missing from the walk", () => {
    // The "reduced set" half of the empty-input problem: a walk that returns
    // less than the repo holds shrinks every check below it, and is otherwise
    // indistinguishable from the directory having been deleted.
    const input = validInput();
    const r = refused(
      buildManifest({
        ...input,
        onDisk: input.onDisk.filter((f) => !f.startsWith("src/monitor/")),
      }),
    );
    expect(r.message).toContain("not on disk");
    expect(r.message).toContain("monitor");
  });

  it("refuses an area with zero covered statements", () => {
    // THE anti-partial-run check, and the one that had no automated anchor
    // until this file existed. Deleting the block left the suite green.
    const input = validInput();
    const summary = clone(input.summary) as Record<string, { statements: Counts }>;
    summary[key("src/cli/index.ts")].statements = counts(10, 0);
    const r = refused(buildManifest({ ...input, summary }));
    expect(r.message).toContain("ZERO covered statements");
    expect(r.message).toContain("src/cli/");
  });

  it("names the vitest project that should have covered a dark area", () => {
    // The message has to say which project failed to run, or the reader learns
    // that something is dark without learning what to re-run.
    const input = validInput();
    const summary = clone(input.summary) as Record<string, { statements: Counts }>;
    summary[key("src/client/index.ts")].statements = counts(10, 0);
    summary[key("src/client/state.svelte.ts")].statements = counts(10, 0);
    summary[key("src/client/Root.svelte")].statements = counts(10, 0);
    const r = refused(buildManifest({ ...input, summary }));
    expect(r.message).toContain("vitest project: client");
  });

  it("refuses a known-untested exemption once the area gains coverage", () => {
    // The hatch has to shrink on its own. A stale exemption is worse than none:
    // it holds the door open for the exact failure the check exists to catch.
    const input = validInput();
    const summary = clone(input.summary) as Record<string, { statements: Counts }>;
    summary[key("src/stdio-bridge/index.ts")].statements = counts(3, 2);
    const r = refused(buildManifest({ ...input, summary }));
    expect(r.message).toContain("now HAS coverage");
    expect(r.message).toContain("stdio-bridge");
  });

  it("refuses an exemption over an area too large to be plausibly untested", () => {
    // The other bound on the hatch. A big area at zero is far more likely a run
    // that never reached it than code nobody ever tested -- exactly the case an
    // exemption must not be able to silence.
    const input = validInput();
    const summary = clone(input.summary) as Record<string, { statements: Counts }>;
    summary[key("src/stdio-bridge/index.ts")].statements = counts(MAX_EXEMPT_STATEMENTS + 1, 0);
    const r = refused(buildManifest({ ...input, summary }));
    expect(r.message).toContain("too large to be plausibly untested");
  });

  it("still honours an exemption at exactly the ceiling", () => {
    // The boundary in the passing direction. Without this, the ceiling could be
    // off by one in a way every failing test above would agree with.
    const input = validInput();
    const summary = clone(input.summary) as Record<string, { statements: Counts }>;
    summary[key("src/stdio-bridge/index.ts")].statements = counts(MAX_EXEMPT_STATEMENTS, 0);
    accepted(buildManifest({ ...input, summary }));
  });
});
