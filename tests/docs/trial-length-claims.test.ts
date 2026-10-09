import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TRIAL_DAYS } from "../../src/shared/constants.js";

/**
 * Drift guard: every human-readable statement of the trial length must equal
 * `TRIAL_DAYS`.
 *
 * `shared/constants.ts` already argues why the *code* copies must derive from
 * one number — "a silent drift between the copy and the enforcement would be an
 * accusation of bad faith, not a typo" — and the banner, the wall and the CLI
 * all import it. **Prose could not**, and it drifted exactly as predicted: the
 * BUSL Additional Use Grant said evaluation was permitted "for up to 30 days"
 * while the shipped clock was 14, so the legal document and the enforcement
 * disagreed by a factor of two in the user's favour on paper and against them
 * in the binary. Nothing detected it for the life of the file; #1821's docs
 * sweep found it by reading.
 *
 * The LICENSE is the reason this test exists rather than a `tests/docs` claim
 * about a doc: it is the artefact a user is held to, and it is the one file in
 * the repo that no test had any opinion about.
 *
 * **Paragraph-scoped, not file-scoped**, because these files legitimately carry
 * other day counts (a rotate-token grace window, a backup retention) that have
 * nothing to do with the trial. A paragraph mentioning "trial", "evaluation" or
 * "first launch"
 * is scoped tightly enough that any `N day` inside it is about the trial, and
 * loosely enough to survive rewording — which a fixed-substring assertion would
 * not, and a reworded claim is precisely the moment drift gets introduced.
 *
 * "First launch" is the third context word because `LICENSE` names the period
 * by its clock rather than by its purpose: since the 2026-10-09 rewrite its
 * clause reads "for up to 14 days from the first launch", with neither "trial"
 * nor "evaluation" in the paragraph. Without that word the LICENSE presence
 * check below would fail, and dropping LICENSE from `CLAIM_FILES` instead would
 * stop checking the one file that is the reason this test exists.
 *
 * The presence assertion is the other half: without it, deleting the sentence
 * passes. A file that stops stating the trial length at all is a change
 * someone should make on purpose.
 */

const ROOT = path.resolve(__dirname, "../..");

/** Files that state the trial length to a human. */
const CLAIM_FILES = ["LICENSE", "README.md", "docs/licensing-explained.md"] as const;

/** A paragraph is about the trial if it says so, or names the trial's clock. */
// `\s+`, not a space: LICENSE wraps its Parameters at a fixed column, and the
// phrase falls across a line break there ("the first\n<indent>launch").
const TRIAL_CONTEXT = /trial|evaluat|first\s+launch/i;

/** `14 days`, `14-day`, `14 day` — the shapes prose actually uses. */
const DAY_COUNT = /(\d+)[\s-]+day/gi;

type Claim = { file: string; days: number; excerpt: string };

function collectClaims(file: string): Claim[] {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  const claims: Claim[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (!TRIAL_CONTEXT.test(paragraph)) continue;
    for (const match of paragraph.matchAll(DAY_COUNT)) {
      claims.push({
        file,
        days: Number(match[1]),
        excerpt: paragraph.replace(/\s+/g, " ").trim().slice(0, 120),
      });
    }
  }
  return claims;
}

describe("trial-length claims track TRIAL_DAYS", () => {
  it.each(CLAIM_FILES)("%s states the trial length at least once", (file) => {
    expect(
      collectClaims(file).length,
      `${file} no longer states a trial length in any paragraph mentioning a trial, evaluation or first launch. ` +
        `If that is deliberate, remove it from CLAIM_FILES in this test and say why.`,
    ).toBeGreaterThan(0);
  });

  it("every stated trial length equals TRIAL_DAYS", () => {
    const wrong = CLAIM_FILES.flatMap(collectClaims).filter((c) => c.days !== TRIAL_DAYS);
    expect(
      wrong,
      `These say a trial length that is not TRIAL_DAYS (${TRIAL_DAYS}):\n` +
        wrong.map((c) => `  ${c.file}: "${c.days} day..." in "${c.excerpt}"`).join("\n"),
    ).toEqual([]);
  });

  it("the BUSL Additional Use Grant names the beta boundary and the one-time purchase", () => {
    const license = readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    // Not a substring check on the whole sentence — just the two commitments
    // the README makes on the licence's behalf, so the two cannot part ways.
    expect(license).toMatch(/one-time purchase/i);
    expect(license).toMatch(/before version 1\.0\.0/i);
  });
});
