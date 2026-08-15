import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CWD_DEPENDENT_CHECKS } from "../../src/cli/doctor.js";

/**
 * Guards the prose copies of `CWD_DEPENDENT_CHECKS` — the doctor checks whose
 * answer depends on `process.cwd()` and which `/api/diagnostics` therefore
 * strips from field reports.
 *
 * Three English enumerations across two docs stand against one authoritative
 * constant, and the shared rationale sentence has already been falsified once:
 * `mcp-json` stopped being able to FAIL from an arbitrary cwd in #1404, which
 * left "would fail for every desktop / npm-global install" untrue in every
 * copy. That is the kind of sentence a sweep misses — it reads as an argument
 * rather than as a fact, so nothing in a diff points at it.
 *
 * Two claims are pinned, because they rot independently:
 *
 *  1. **Membership.** Each enumeration must name every member, and must agree
 *     with the constant on how many there are. A short enumeration is worse
 *     than none — a reader concludes the omitted check is unfiltered and goes
 *     looking for a bug that is not there.
 *  2. **The rationale.** Neither remaining member can FAIL from an arbitrary
 *     cwd, so the filter is noise-suppression. The falsified sentence is
 *     hunted repo-wide rather than in a curated carrier list, because it had
 *     copies in `src/` and `tests/` as well as in the docs, and a list of
 *     places to look is exactly what let it survive the first sweep.
 *
 * The set is imported from source, never transcribed. A test seeded with the
 * names the docs already claim would confirm the docs against themselves and
 * could not fail when a NEW cwd-dependent check is added.
 */
const ROOT = join(import.meta.dirname, "..", "..");

/**
 * The line that introduces each enumeration. Membership is asserted per
 * MATCHED LINE, not against the whole file: a doc that carries the list twice
 * (`docs/mcp-tools.md` does) would otherwise pass with one copy complete and
 * one short, and a whole-file `includes` also matches incidental prose — the
 * word "dev-repo" appears in `mcp-tools.md` outside any enumeration.
 */
const ENUMERATION_LINE = /source-checkout-only/;

/** Docs expected to enumerate the filtered set by CHECK ID. */
const MEMBERSHIP_CARRIERS = ["docs/cli.md", "docs/mcp-tools.md"];

/**
 * How many enumerations each carrier must have. Pinned so that deleting one —
 * the failure mode a per-line assertion is otherwise blind to — fails here.
 */
const EXPECTED_ENUMERATIONS: Record<string, number> = {
  "docs/cli.md": 1,
  "docs/mcp-tools.md": 2,
};

/** Number words the enumerations spell out, so the count can be pinned too. */
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/**
 * The sentence that was true only while `mcp-json` and `node-modules` could
 * FAIL from an arbitrary cwd. Matched loosely (any casing, any spacing around
 * the slash) so a re-wrap or a re-punctuation cannot smuggle one back.
 */
const FALSIFIED_RATIONALE = /would fail for every desktop\s*\/?\s*npm-global install/i;

/** Text files to sweep for the falsified sentence — this file excepted. */
const SWEEP_GLOBS = ["docs/**/*.md", "src/**/*.ts", "tests/**/*.ts"];

describe("docs: the cwd-dependent doctor checks", () => {
  for (const carrier of MEMBERSHIP_CARRIERS) {
    it(`${carrier} names every member of CWD_DEPENDENT_CHECKS in every enumeration`, () => {
      const lines = readFileSync(join(ROOT, carrier), "utf-8")
        .split("\n")
        .filter((line) => ENUMERATION_LINE.test(line));

      // The positive half. Without it every assertion below is vacuous on a
      // file that no longer mentions the filtered set at all — which is a
      // documentation regression, not a pass.
      expect(lines.length, `${carrier} no longer enumerates the filtered checks`).toBe(
        EXPECTED_ENUMERATIONS[carrier],
      );

      for (const line of lines) {
        const missing = CWD_DEPENDENT_CHECKS.filter((name) => !line.includes(`\`${name}\``));
        expect(missing, `${carrier} omits ${missing.join(", ")} from an enumeration`).toEqual([]);
        // The count word has to move with the list. A reader who trusts "five"
        // and counts six is being told one of them is not really filtered.
        expect(line, `${carrier} miscounts the filtered checks`).toContain(
          NUMBER_WORDS[CWD_DEPENDENT_CHECKS.length],
        );
      }
    });
  }

  it("no tracked source or doc still claims these checks would FAIL outside a checkout", async () => {
    const { glob } = await import("node:fs/promises");
    const offenders: string[] = [];
    let scanned = 0;
    for (const pattern of SWEEP_GLOBS) {
      for await (const rel of glob(pattern, { cwd: ROOT })) {
        const file = String(rel).replace(/\\/g, "/");
        if (file.endsWith("cwd-dependent-checks-claims.test.ts")) continue;
        scanned += 1;
        if (FALSIFIED_RATIONALE.test(readFileSync(join(ROOT, file), "utf-8"))) offenders.push(file);
      }
    }
    // Positive half again: a glob that silently matched nothing would make the
    // assertion below true for the wrong reason.
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it("the release smoke checklist expects a clean doctor run, not a known-failing one", () => {
    // The checklist previously told the operator to expect "exactly two [FAIL]
    // lines" and tick the box anyway — which is the one thing a smoke run
    // cannot afford, since it trains past a real regression at the moment the
    // run exists to catch it.
    const text = readFileSync(join(ROOT, "docs/release-smoke-checklist.md"), "utf-8");
    expect(text).toMatch(/tandem doctor/);
    expect(text).not.toMatch(/exactly two `?\[FAIL\]`? lines/i);
  });
});
