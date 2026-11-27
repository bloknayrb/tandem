import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the complexity cap and its frozen baseline (ADR-051 pattern: the gate
 * itself is `eslint .` in CI's `check`; this test, also inside `check`, pins
 * the pieces that would let the gate go quiet without failing).
 *
 * `eslint.config.js` caps cyclomatic complexity at 15 for `src/**\/*.ts`. The
 * functions that already exceeded it are frozen in `eslint-suppressions.json`
 * (ESLint bulk suppressions), so `eslint .` fails only on new ones. Three ways
 * that could silently stop holding, each pinned below:
 *
 *  1. Someone re-runs `eslint --suppress-rule complexity` (or `--suppress-all`)
 *     to make a new violation go away. ESLint accepts that happily, so the
 *     frozen total is pinned here and may only go down.
 *  2. The rule or its scope is loosened in the config.
 *  3. CI's lint stops being strict about unused suppressions. Lint-staged
 *     passes `--pass-on-unpruned-suppressions` on purpose, so that fixing a
 *     frozen function never blocks a commit; CI must not, so that the fix is
 *     followed by `--prune-suppressions` and the total really drops.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

/** The frozen total. Lower it when you prune; never raise it. */
const FROZEN_COMPLEXITY_VIOLATIONS = 186;

type Suppressions = Record<string, Record<string, { count: number }>>;

describe("complexity cap wiring", () => {
  it("caps complexity at 15 for src TypeScript", () => {
    const config = read("eslint.config.js");
    expect(config).toMatch(
      /files:\s*\["src\/\*\*\/\*\.ts"\],\s*rules:\s*\{\s*complexity:\s*\["error",\s*15\]\s*\}/,
    );
  });

  it("freezes only complexity, and the frozen total only goes down", () => {
    const suppressions = JSON.parse(read("eslint-suppressions.json")) as Suppressions;
    const rules = new Set(Object.values(suppressions).flatMap((byRule) => Object.keys(byRule)));
    expect(
      [...rules],
      "eslint-suppressions.json may only freeze `complexity`; other rules are not ratcheted " +
        "and must be fixed, not suppressed",
    ).toEqual(["complexity"]);

    let total = 0;
    for (const byRule of Object.values(suppressions)) total += byRule.complexity?.count ?? 0;
    expect(
      total,
      total > FROZEN_COMPLEXITY_VIOLATIONS
        ? "More complexity violations are frozen than before. A new over-complex function " +
            "was suppressed instead of simplified: split it so `eslint .` passes without a " +
            "new suppression."
        : "Fewer complexity violations are frozen — well done. Lower " +
            `FROZEN_COMPLEXITY_VIOLATIONS to ${total} in this file.`,
    ).toBe(FROZEN_COMPLEXITY_VIOLATIONS);
  });

  it("lets commits pass on unpruned suppressions, but not CI", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
      "lint-staged": Record<string, string[]>;
    };
    const stagedEslint = Object.values(pkg["lint-staged"])
      .flat()
      .filter((cmd) => cmd.startsWith("eslint"));
    expect(stagedEslint.length, "lint-staged runs eslint somewhere").toBeGreaterThan(0);
    for (const cmd of stagedEslint) {
      expect(cmd, "every lint-staged eslint call must tolerate unpruned suppressions").toContain(
        "--pass-on-unpruned-suppressions",
      );
    }

    expect(pkg.scripts.lint, "`npm run lint` must stay a plain, strict `eslint .`").toBe(
      "eslint .",
    );
    expect(read(".github/workflows/ci.yml"), "CI's check job must run `npm run lint`").toMatch(
      /run:\s*npm run lint\s*$/m,
    );
  });
});
