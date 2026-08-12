import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards ADR-012's refuted stateless-transport claim (#1332, evidence #1253).
 *
 * ADR-012 asserted, as fact, that the SDK "crashes in stateless mode after the
 * first `server.connect()`". The #1253 probe refuted it. The mechanism is
 * recorded once, in `docs/spikes/stateless-transport-probe.md` — this file
 * deliberately does not restate it, because four copies of one explanation is
 * the drift this change exists to correct.
 *
 * The one distinction the matcher below depends on: "cannot be **re**used" is
 * the SDK's own TRUE rule, and `Protocol.connect()` throwing on an
 * already-connected server is a DIFFERENT and still-true guard — the one
 * ADR-045 and `transport-registry.ts` rest on. Conflating the two is the
 * specific mistake this test exists to catch, because it was already made once
 * during triage.
 *
 * WHY A TEST. The claim had propagated across files as authoritative-sounding
 * prose — the same class `tests/docs/loopback-gate-claims.test.ts` was built
 * for, and the same remedy: pin the correction so a later "harmonization" pass
 * cannot quietly restore the false version.
 *
 * WHY THREE LIMBS. It propagated in three wordings, so a matcher pinned to one
 * leaves the others free to re-assert it. `docs/lessons-learned.md` lesson 15
 * carried the second and third and is corrected in this same change.
 *
 * WHY SENTENCES, NOT LINES. A markdown paragraph here is a single line —
 * `docs/decisions.md`:53 is 1893 characters. A line-scoped exemption therefore
 * exempts the whole paragraph, so appending "stateless mode crashes on Windows"
 * to a corrected passage passed green. Measured, not theorised: that mutation
 * was run against the line-scoped version and the suite stayed 2/2. The guard
 * covered everything EXCEPT the three passages the claim actually lives in,
 * which are exactly the ones a future edit would touch. Scoring each sentence
 * separately is what makes the exemption mean "this claim is marked" rather
 * than "something in this paragraph is marked".
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** Recursive listing under `dir`, repo-relative and forward-slashed. */
function filesUnder(dir: string, ext: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf-8" })
    .filter((p) => p.endsWith(ext))
    .map((p) => `${dir}/${p.replace(/\\/g, "/")}`);
}

/**
 * Prose docs plus source and test comments — the sibling guard's corpus shape,
 * kept because its stated reason applies here too: the last carrier its own
 * manual sweep turned up was a header comment under `tests/`.
 *
 * `CLAUDE.md` is in deliberately. Its MCP/Server section carries the TRUE
 * `Protocol.connect()` sentence, which is the one most likely to be "corrected"
 * into the false claim by someone reconciling the two.
 *
 * `docs/triage/` is out. Those are dated snapshots of what was believed on a
 * given day; they were accurate when written, and rewriting them is the
 * opposite of what a triage record is for. Same honest carve-out
 * `tests/docs/tool-count-drift.test.ts` makes for `docs/decisions.md`.
 *
 * `tests/docs/` is out wholesale rather than just this file by name. Every
 * guard in that directory quotes the phrases it hunts, so a future guard
 * quoting THIS one's phrasings would fail here — pointing at a file its author
 * never touched.
 */
function scannedFiles(): string[] {
  return [
    "CLAUDE.md",
    "AGENTS.md",
    ...filesUnder("docs", ".md"),
    ...["src", "tests"].flatMap((dir) => filesUnder(dir, ".ts")),
  ].filter((p) => !p.startsWith("docs/triage/") && !p.startsWith("tests/docs/"));
}

/**
 * Only files that mention the topic at all can carry the claim. Of ~1050 files
 * in the corpus, 8 contain `stateless`; reading the rest into line arrays
 * retains ~28 MB to examine two dozen lines. `assertsStatelessCrash` already
 * early-returns on the same predicate, so this changes cost, not verdicts.
 */
function corpus(): Array<{ rel: string; lines: string[] }> {
  return scannedFiles().flatMap((rel) => {
    const text = readFileSync(join(REPO_ROOT, rel), "utf-8");
    return TOPIC.test(text) ? [{ rel, lines: text.split("\n") }] : [];
  });
}

const TOPIC = /stateless/i;

/** The SDK's own TRUE rule. It must never be read as the refuted claim. */
const SDK_REUSE_RULE = /re-?us/i;

/** The refuted assertion, in each of the wordings it has taken. */
const BROKEN_PHRASING =
  /crash(es|ed|ing)?\b|does ?n.t work|is unusable|cannot be used|never works?\b/i;

function assertsStatelessCrash(text: string): boolean {
  if (!TOPIC.test(text) || SDK_REUSE_RULE.test(text)) return false;
  if (BROKEN_PHRASING.test(text)) return true;
  return /\b(needs|requires)\b/i.test(text) && /sessionIdGenerator/.test(text);
}

/**
 * Sentence-sized units within one markdown line. Boundaries are sentence-final
 * punctuation, spaced em-dashes, and semicolons — the three the corrected
 * passages actually use to separate a struck claim from its correction.
 */
function sentences(line: string): string[] {
  return line.split(/(?<=[.!?])\s+|\s+—\s+|;\s+/);
}

/**
 * A quotation is allowed to survive — an ADR that deletes what it got wrong
 * keeps no audit trail. It has to be visibly marked, though: struck through, or
 * carrying the issue number together with a word that tenses it as overturned.
 *
 * The bare past tense (`was`) is NOT a marker. "the 2024 finding was correct:
 * the SDK crashes in stateless mode (#1253)" would sail through on it, which is
 * precisely the re-assertion this guard exists to stop.
 */
function isMarkedAsOverturned(text: string): boolean {
  return /~~/.test(text) || (/#1253|#1332/.test(text) && /refuted|never|untested/i.test(text));
}

describe("stateless-transport documentation claims (#1332 / #1253)", () => {
  it("nothing asserts that stateless mode crashes without marking it as overturned", () => {
    const offenders: string[] = [];

    for (const { rel, lines } of corpus()) {
      lines.forEach((line, i) => {
        for (const unit of sentences(line)) {
          if (assertsStatelessCrash(unit) && !isMarkedAsOverturned(unit)) {
            offenders.push(`${rel}:${i + 1}`);
            return;
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("the corrected ADR-012 passage and its evidence file are both present", () => {
    // Non-vacuity control. The guard above can only pass honestly if the
    // corrected text is what is actually in the tree; without this, deleting
    // ADR-012's whole rationale would also make it green.
    //
    // The mechanism strings are asserted against the SPIKE, which is their
    // single source. Asserting them against `decisions.md` would have made the
    // prose duplication load-bearing — pinning the copies in place.
    const decisions = readFileSync(join(REPO_ROOT, "docs", "decisions.md"), "utf-8");
    expect(decisions).toContain("spikes/stateless-transport-probe.md");

    const spike = readFileSync(
      join(REPO_ROOT, "docs", "spikes", "stateless-transport-probe.md"),
      "utf-8",
    );
    // The distinction that makes the correction correct rather than merely different.
    expect(spike).toContain("Stateless transport cannot be reused across requests");
    expect(spike).toContain("_hasHandledRequest");
    expect(spike).toContain("Protocol.connect()");
  });
});
