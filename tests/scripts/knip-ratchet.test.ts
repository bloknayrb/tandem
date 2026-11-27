import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BASELINE_PATH, compare, findingsFrom } from "../../scripts/ci/knip-ratchet.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The knip ratchet (`scripts/ci/knip-ratchet.mjs`) runs in CI's `check` job.
 * This pins (a) that it is wired there and can fail the job, and (b) the two
 * pure halves it rests on — flattening knip's report to stable keys, and the
 * comparison — without running knip itself, which `check` already does.
 */

describe("knip ratchet logic", () => {
  const report = {
    issues: [
      {
        file: "src/a.ts",
        files: [],
        exports: [
          { name: "foo", line: 3 },
          { name: "bar", line: 9 },
        ],
        types: [],
        duplicates: [[{ name: "X" }, { name: "A" }]],
        enumMembers: [
          { namespace: "Mode", name: "Unused" },
          { namespace: "Other", name: "Unused" },
        ],
      },
      { file: "package.json", dependencies: [{ name: "left-pad" }], exports: [] },
    ],
  };

  it("keys findings by category, file and name, without line numbers", () => {
    expect(findingsFrom(report)).toEqual([
      "dependencies|package.json|left-pad",
      "duplicates|src/a.ts|A|X",
      "enumMembers|src/a.ts|Mode.Unused",
      "enumMembers|src/a.ts|Other.Unused",
      "exports|src/a.ts|bar",
      "exports|src/a.ts|foo",
    ]);
  });

  it("refuses a report that is not knip JSON", () => {
    expect(() => findingsFrom({})).toThrow(/no `issues` array/);
  });

  it("refuses a category shape it does not know, rather than skipping it", () => {
    expect(() =>
      findingsFrom({ issues: [{ file: "src/a.ts", classMembers: { C: [{ name: "m" }] } }] }),
    ).toThrow(/"classMembers" .* is not an array/);
  });

  it("reports new findings and fixed ones separately", () => {
    expect(compare(["a", "b", "new"], ["a", "b", "gone"])).toEqual({
      added: ["new"],
      fixed: ["gone"],
    });
    expect(compare(["a"], ["a"])).toEqual({ added: [], fixed: [] });
  });

  it("has a sorted, duplicate-free baseline", () => {
    const { findings } = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { findings: string[] };
    expect(findings.length).toBeGreaterThan(0);
    expect(findings).toEqual([...new Set(findings)].sort());
  });
});

describe("knip ratchet wiring", () => {
  type Step = { run?: string; "continue-on-error"?: unknown; if?: unknown };
  const ci = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps?: Step[]; "continue-on-error"?: unknown }>;
  };

  it("runs in the required check job and can fail it", () => {
    const check = ci.jobs.check;
    const steps = (check?.steps ?? []).filter((s) => s.run === "node scripts/ci/knip-ratchet.mjs");
    expect(steps).toHaveLength(1);
    expect(steps[0]["continue-on-error"]).toBeUndefined();
    expect(steps[0].if).toBeUndefined();
    expect(check?.["continue-on-error"]).toBeUndefined();
  });

  it("offers no mode that adds findings to the baseline", () => {
    const script = readFileSync(path.join(ROOT, "scripts/ci/knip-ratchet.mjs"), "utf8");
    const flags = [...script.matchAll(/process\.argv\.includes\("(--[a-z-]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(flags).toEqual(["--prune"]);
  });
});
