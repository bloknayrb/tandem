import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CWD_DEPENDENT_CHECKS } from "../../src/cli/doctor";

/**
 * Guards the prose copies of `CWD_DEPENDENT_CHECKS` — the doctor checks whose
 * answer depends on `process.cwd()` and which `/api/diagnostics` therefore
 * strips from field reports.
 *
 * There are three English copies of a five-name list against one authoritative
 * constant, and they have already drifted twice: the `.mcp.json` fix (#1404)
 * falsified the shared rationale in `docs/mcp-tools.md`, and the `node-modules`
 * sibling fix falsified it again. Both times the sweep that fixed the code
 * missed a prose copy, because nothing points at them from one place.
 *
 * Two separate claims are pinned, because they rot independently:
 *
 *  1. **Membership.** Each copy must name every member. A short enumeration is
 *     worse than none — a reader concludes the omitted check is unfiltered and
 *     goes looking for a bug that is not there.
 *  2. **The rationale.** "would fail for every desktop / npm-global install"
 *     was true when two members could FAIL from an arbitrary cwd. Neither can
 *     now, so the filter is noise-suppression. The old wording is the specific
 *     false sentence this test exists to keep out, and it is exactly the kind
 *     that survives a sweep: it reads as an argument, not as a fact.
 *
 * The set is imported from source, never transcribed. A test seeded with the
 * names the docs already claim would confirm the docs against themselves and
 * could not fail when a NEW cwd-dependent check is added.
 */
const ROOT = join(__dirname, "..", "..");

/**
 * Docs that enumerate the filtered set by CHECK ID. `docs/troubleshooting.md`
 * is deliberately absent: it is end-user prose that names the checks in English
 * ("`node_modules/` present"), never by id, so an id-membership assertion there
 * would be vacuous — it would fail today for a reason that is not drift.
 */
const MEMBERSHIP_CARRIERS = ["docs/cli.md", "docs/mcp-tools.md"];

/** Every doc carrying the shared rationale, id-listing or not. */
const RATIONALE_CARRIERS = [...MEMBERSHIP_CARRIERS, "docs/troubleshooting.md"];

/**
 * Sentences that were true only while `mcp-json` and `node-modules` could FAIL
 * from an arbitrary cwd. Matched loosely (any casing, any spacing around the
 * slash) so a re-wrap or a re-punctuation cannot smuggle one back.
 */
const FALSIFIED_RATIONALE = /would fail for every desktop\s*\/?\s*npm-global install/i;

describe("docs: the cwd-dependent doctor checks", () => {
  for (const carrier of MEMBERSHIP_CARRIERS) {
    it(`${carrier} names every member of CWD_DEPENDENT_CHECKS`, () => {
      const text = readFileSync(join(ROOT, carrier), "utf-8");
      const missing = CWD_DEPENDENT_CHECKS.filter((name) => !text.includes(name));
      expect(
        missing,
        `${carrier} omits ${missing.join(", ")} from its filtered-check list`,
      ).toEqual([]);
    });
  }

  for (const carrier of RATIONALE_CARRIERS) {
    it(`${carrier} does not claim these checks would FAIL outside a checkout`, () => {
      const text = readFileSync(join(ROOT, carrier), "utf-8");
      expect(FALSIFIED_RATIONALE.test(text)).toBe(false);
    });
  }

  it("the release smoke checklist expects a clean doctor run, not a known-failing one", () => {
    // The checklist previously told the operator to expect "exactly two [FAIL]
    // lines" and tick the box anyway — which is the one thing a smoke run
    // cannot afford, since it trains past a real regression at the moment the
    // run exists to catch it.
    const text = readFileSync(join(ROOT, "docs/release-smoke-checklist.md"), "utf-8");
    expect(text).not.toMatch(/exactly two `?\[FAIL\]`? lines/i);
  });
});
