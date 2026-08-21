import { execFileSync } from "node:child_process";
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

/**
 * The fixed, case-insensitive head of `FALSIFIED_RATIONALE`, used to let `git
 * grep` narrow the sweep to candidate files before the real regex runs. It is
 * only safe as a prefilter because it is a literal *prefix* of everything the
 * regex can match — a fixed-string search on it can over-match but never
 * under-match. The test below pins that relationship against the regex source
 * rather than trusting this comment.
 */
const FALSIFIED_PREFIX = "would fail for every desktop";

/**
 * A literal that a carrier doc certainly contains, used to prove the `git grep`
 * prefilter actually searches something. Without it a broken grep returns no
 * candidates, the offender list is empty for the wrong reason, and the sweep
 * reports health on a search that never ran.
 */
const PREFILTER_CONTROL = "source-checkout-only";

/**
 * Pathspecs to sweep for the falsified sentence — this file excepted.
 *
 * The `:(glob)` magic is load-bearing. A bare `docs/**` + `/*.md` pathspec is
 * matched with `FNM_PATHNAME` off, so `*` eats slashes and the pattern requires
 * one — which silently drops every top-level `docs/*.md`, `docs/cli.md`
 * included. `:(glob)` switches git to wildmatch, where `**` also matches zero
 * directories, and the set then matches the filesystem walk this sweep replaced
 * file for file.
 */
const SWEEP_PATHSPECS = [":(glob)docs/**/*.md", ":(glob)src/**/*.ts", ":(glob)tests/**/*.ts"];

/** Tracked files under `SWEEP_PATHSPECS`, forward-slashed on every platform. */
function trackedSweepFiles(): string[] {
  return execFileSync("git", ["ls-files", "--", ...SWEEP_PATHSPECS], {
    cwd: ROOT,
    encoding: "utf-8",
  })
    .split("\n")
    .filter(Boolean);
}

/**
 * Tracked files containing any of `literals`, case-insensitively. `git grep` is what
 * keeps this sweep off the per-file read path: reading all ~1,200 tracked docs
 * and sources cost well over a second even unloaded, and blew the 15s budget
 * under full-suite disk contention (the same shape as #1434).
 */
function trackedFilesContainingAny(literals: string[]): string[] {
  const patterns = literals.flatMap((literal) => ["-e", literal]);
  try {
    return execFileSync(
      "git",
      ["grep", "-I", "-l", "-F", "-i", ...patterns, "--", ...SWEEP_PATHSPECS],
      {
        cwd: ROOT,
        encoding: "utf-8",
      },
    )
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    // `git grep` exits 1 for "no matches", which is not a failure. Anything
    // else is a broken search and must not read as a clean sweep.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

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

  it("no tracked source or doc still claims these checks would FAIL outside a checkout", () => {
    // The prefilter is only sound while the literal is a prefix of the regex.
    // Loosening the regex's head — an alternation, an optional word — silently
    // makes `git grep` miss matches the regex would catch, so pin it here
    // rather than in a comment nobody re-reads.
    expect(FALSIFIED_RATIONALE.source.toLowerCase().startsWith(FALSIFIED_PREFIX)).toBe(true);

    // Both literals go through one `git grep`, so the sweep costs two child
    // processes total rather than one per literal.
    const candidates = trackedFilesContainingAny([FALSIFIED_PREFIX, PREFILTER_CONTROL]);
    const bodies = new Map(
      // `git grep` narrows; the regex still decides. Only the candidates are
      // read, so the authority over what counts as an offender stays in one
      // place and the sweep reads a handful of files instead of ~1,200.
      candidates.map((file) => [file, readFileSync(join(ROOT, file), "utf-8")] as const),
    );

    // Positive halves. A sweep over an empty file list, or a `git grep` that
    // finds nothing because it is broken rather than because the repo is
    // clean, makes the offender assertion true for the wrong reason.
    expect(trackedSweepFiles().length).toBeGreaterThan(100);
    expect(
      [...bodies.values()].filter((text) => text.toLowerCase().includes(PREFILTER_CONTROL)).length,
      "the git-grep prefilter found nothing it was guaranteed to find",
    ).toBeGreaterThan(0);

    const offenders = candidates
      .filter((file) => !file.endsWith("cwd-dependent-checks-claims.test.ts"))
      .filter((file) => FALSIFIED_RATIONALE.test(bodies.get(file) ?? ""));
    expect(offenders).toEqual([]);
    // A generous budget on top of the speedup, not instead of it. What this
    // test measures is repo-wide I/O, whose wall clock is set by machine load
    // rather than by anything the assertion is about — the previous 15s default
    // was reached under full-suite disk contention alone, which made a real
    // regression here indistinguishable from a busy laptop.
  }, 60_000);

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
