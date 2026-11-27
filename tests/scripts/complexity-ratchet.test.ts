import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  BASELINE_PATH,
  collect,
  compare,
  MAX,
  SCOPE,
} from "../../scripts/ci/complexity-ratchet.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The complexity ratchet (`scripts/ci/complexity-ratchet.mjs`) runs in CI's
 * `check` job; this pins its logic and its wiring (ADR-051), without running
 * the ESLint scan itself, which `check` already does.
 */

const result = (
  rel: string,
  messages: Array<{ message: string; ruleId?: string; fatal?: boolean }>,
) => ({
  filePath: path.join(ROOT, rel),
  messages: messages.map((m) => ({ ruleId: "complexity", ...m })),
});
const over = (label: string, n: number) => ({
  message: `${label} has a complexity of ${n}. Maximum allowed is 15.`,
});

describe("complexity ratchet logic", () => {
  it("keys by file and ESLint's label, numbering repeats, never by line", () => {
    const got = collect(
      [
        result("src/a.ts", [
          over("Function 'foo'", 20),
          over("Arrow function", 16),
          over("Arrow function", 30),
          { message: "unused", ruleId: "no-unused-vars" },
        ]),
      ],
      ROOT,
    );
    expect(got).toEqual({
      "src/a.ts|Function 'foo'": 20,
      "src/a.ts|Arrow function": 16,
      "src/a.ts|Arrow function#2": 30,
    });
  });

  it("refuses a file it cannot parse rather than skipping it", () => {
    expect(() =>
      collect(
        [result("src/b.ts", [{ message: "Parsing error", fatal: true, ruleId: undefined }])],
        ROOT,
      ),
    ).toThrow(/cannot parse src\/b\.ts/);
  });

  it("classifies new, grown, lowered and fixed functions separately", () => {
    const baseline = { "f|a": 20, "f|b": 20, "f|c": 20 };
    const current = { "f|a": 20, "f|b": 25, "f|c": 18, "f|d": 16 };
    expect(compare(current, baseline)).toEqual({
      added: ["f|d = 16"],
      grew: ["f|b: 25 > ceiling 20"],
      lowered: ["f|c: 20 -> 18"],
      fixed: [],
    });
    expect(compare({}, { "f|a": 20 }).fixed).toEqual(["f|a"]);
    expect(compare(baseline, baseline)).toEqual({ added: [], grew: [], lowered: [], fixed: [] });
  });

  it("caps src TypeScript at 15, and the baseline agrees", () => {
    expect(MAX).toBe(15);
    expect(SCOPE).toEqual(["src/**/*.ts"]);
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
      max: number;
      functions: Record<string, number>;
    };
    expect(baseline.max).toBe(MAX);
    const entries = Object.entries(baseline.functions);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, n] of entries) {
      expect(key, "keys are file|label").toMatch(/^src\/.+\.ts\|.+/);
      expect(Number.isInteger(n) && n > MAX, `${key} must be an integer above ${MAX}`).toBe(true);
    }
  });

  it("owns its rule config and ignores inline directives", () => {
    const script = readFileSync(path.join(ROOT, "scripts/ci/complexity-ratchet.mjs"), "utf8");
    expect(script).toContain("overrideConfigFile: true");
    expect(script).toContain("allowInlineConfig: false");
    const flags = [...script.matchAll(/process\.argv\.includes\("(--[a-z-]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(flags, "--prune is the only mode, and it never adds or raises").toEqual(["--prune"]);
  });
});

describe("complexity ratchet wiring", () => {
  type Step = { run?: string; "continue-on-error"?: unknown; if?: unknown };
  const ci = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps?: Step[]; "continue-on-error"?: unknown }>;
  };

  it("runs in the required check job and can fail it", () => {
    const check = ci.jobs.check;
    const steps = (check?.steps ?? []).filter(
      (s) => s.run === "node scripts/ci/complexity-ratchet.mjs",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]["continue-on-error"]).toBeUndefined();
    expect(steps[0].if).toBeUndefined();
    expect(check?.["continue-on-error"]).toBeUndefined();
  });
});
