import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `CLAUDE.md` states a COUNT of open security findings and then enumerates
 * them; `docs/security.md` is their tracked home. Nothing checked that the two
 * agreed, and on 2026-08-28 they drifted in the way that costs the most: both
 * files listed #1420 as open when its tracker issue had been closed a week
 * earlier, so a session reading either one inherited a wrong posture and the
 * count was off by one in the direction that looks more careful, not less.
 *
 * **What this pins, and what it deliberately does not.** It pins the two docs
 * against EACH OTHER: the count word matches the enumeration, every finding
 * CLAUDE.md calls open has an entry in the register, and nothing the register
 * marks as not-counted is being counted. It cannot pin either against GitHub —
 * a unit test has no tracker — so doc-versus-tracker drift, which is exactly
 * what happened with #1420, stays human review. `docs/security.md` records the
 * date of the last reconciliation for that reason, and this file asserts the
 * marker is present so the review has somewhere to land; it cannot tell you
 * whether the date is stale. Do not read a green run here as "the findings list
 * is correct" — only as "the two files still say the same thing."
 */

const REPO_ROOT = join(__dirname, "../..");
const CLAUDE_MD = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf-8");
const SECURITY_MD = readFileSync(join(REPO_ROOT, "docs/security.md"), "utf-8");

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

/**
 * Issue references at parenthetical depth zero.
 *
 * Depth matters and a bare `/#\d+/` scan is wrong here: every enumerated
 * finding carries a parenthetical that cites OTHER issues as context (#1292
 * cites #1340, #1609 cites #1417). Those are references, not members, and
 * counting them would make the count assertion fail against a correct doc.
 */
function issueRefsAtTopLevel(passage: string): number[] {
  const refs: number[] = [];
  let depth = 0;
  const text = blankCodeSpans(passage);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "#" && depth === 0) {
      const m = /^#(\d+)/.exec(text.slice(i));
      if (m) refs.push(Number(m[1]));
    }
  }
  return [...new Set(refs)];
}

/**
 * Replace the contents of backtick code spans with spaces, preserving length.
 *
 * A single unbalanced paren inside a code span — `stripOwnedFields(extras` —
 * pins the depth counter above zero for the rest of the passage and silently
 * drops every remaining finding. This repo's prose quotes partial calls
 * constantly, so that is a live hazard rather than a theoretical one; it was
 * demonstrated against this parser, not imagined. Blanking rather than deleting
 * keeps every offset intact, so nothing downstream shifts.
 */
function blankCodeSpans(text: string): string {
  return text.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
}

/** Index of `marker` outside every parenthetical, or -1. Offsets are preserved. */
function indexAtTopLevel(haystack: string, marker: string): number {
  const text = blankCodeSpans(haystack);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.startsWith(marker, i)) return i;
  }
  return -1;
}

/** `docs/security.md`'s "## Open findings" section, up to the next `##`. */
function registerSection(): string {
  const start = SECURITY_MD.indexOf("## Open findings");
  expect(start, "docs/security.md no longer has an `## Open findings` section").toBeGreaterThan(-1);
  const next = SECURITY_MD.indexOf("\n## ", start + 1);
  return SECURITY_MD.slice(start, next === -1 ? undefined : next);
}

/**
 * The opening of each top-level bullet in the register — where an entry
 * announces which finding it is about.
 *
 * The head slice is what separates an entry from a cross-reference: every real
 * entry names its issue in the first clause, while a sibling entry citing
 * another finding does so well into its prose. 240 characters is comfortably
 * past the longest current opening (#1654's, at ~115) and comfortably short of
 * where cross-references appear.
 */
function entryOpenings(): string[] {
  const openings = registerSection()
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(0, 240));
  expect(openings.length, "the register section has no top-level bullets").toBeGreaterThan(0);
  return openings;
}

/**
 * The register's `### Accepted (bounded)` subsection.
 *
 * It is NESTED inside `## Open findings`, which is why the entry-existence spec
 * above cannot stand in for this one: an entry filed under Accepted satisfies
 * "has its own entry in the register" while saying the opposite of open.
 */
function acceptedSubsection(): string {
  const section = registerSection();
  const start = section.indexOf("### Accepted (bounded)");
  if (start === -1) return "";
  const next = section.indexOf("\n### ", start + 1);
  return section.slice(start, next === -1 ? undefined : next);
}

/** The single CLAUDE.md bullet that carries the count and the enumeration. */
function claimBullet(): string {
  const start = CLAUDE_MD.indexOf("security findings are open");
  expect(start, "CLAUDE.md no longer states an open-findings count").toBeGreaterThan(-1);
  const lineStart = CLAUDE_MD.lastIndexOf("\n", start) + 1;
  const lineEnd = CLAUDE_MD.indexOf("\n", start);
  return CLAUDE_MD.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
}

/** Splits the bullet into its open / fixed-but-unverified / accepted segments. */
function segments(): { open: string; notCounted: string } {
  const bullet = claimBullet();
  const openStart = bullet.indexOf("— open:");
  expect(openStart, "CLAUDE.md's findings bullet no longer opens with `— open:`").toBeGreaterThan(
    -1,
  );

  // Both trailing labels are optional in principle — there may be no accepted
  // or no fixed-but-unverified finding — so take the earliest that is present.
  //
  // Only at paren depth zero, and only outside code spans. A plain `indexOf`
  // was defeated: an aside INSIDE an open finding's own parenthetical that
  // happens to bold the word "Accepted" pre-empted the real label, silently
  // reclassifying the findings after it. They then vanished from the derived
  // open set entirely, so the register and double-count specs stopped checking
  // them while still reporting green. A real label never sits inside a
  // parenthetical, which is what makes depth the discriminator.
  const tailMarkers = ["**Fixed but unverified:**", "**Accepted"];
  const tailAt = tailMarkers
    .map((m) => indexAtTopLevel(bullet, m))
    .filter((i) => i > openStart)
    .sort((a, b) => a - b)[0];
  expect(tailAt, "no trailing label separates the open set from the rest").toBeGreaterThan(
    openStart,
  );

  return { open: bullet.slice(openStart, tailAt), notCounted: bullet.slice(tailAt) };
}

describe("open security-findings claims (CLAUDE.md vs docs/security.md)", () => {
  it("CLAUDE.md's count word matches the findings it actually enumerates", () => {
    const open = issueRefsAtTopLevel(segments().open);

    // Positive control. A parser that returned nothing would satisfy every
    // set assertion below by finding no counterexample, so the enumeration
    // being non-empty is the thing that makes the rest evidence.
    expect(open.length, "derived no open findings — the parser found nothing").toBeGreaterThan(0);

    const word = NUMBER_WORDS[open.length];
    expect(word, `no number word for ${open.length} findings`).toBeTruthy();
    expect(claimBullet()).toContain(`**${word} security findings are open`);
  });

  it("every finding CLAUDE.md calls open has its OWN entry in the register", () => {
    // "The number appears somewhere in the section" is not the claim, and
    // testing it that way was a real hole: deleting #1609's entry outright
    // left the suite green, because #1609 is also cited in a prose line about
    // unit ownership 39 lines further down. An entry is a top-level bullet
    // that ANNOUNCES the finding, so the ref must fall in the bullet's own
    // opening — not in an indented continuation, not deep inside a sibling
    // entry that merely cross-references it.
    //
    // Both spellings count. Most entries are markdown links, but #1292's is a
    // bare `#1292`, and requiring a link style would be a formatting rule
    // dressed up as a claim check.
    const openings = entryOpenings();
    const missing = issueRefsAtTopLevel(segments().open).filter(
      (n) => !openings.some((o) => o.includes(`issues/${n}`) || new RegExp(`#${n}(?!\\d)`).test(o)),
    );
    expect(missing, "docs/security.md has no entry of its own for these findings").toEqual([]);
  });

  it("nothing labelled fixed-but-unverified or accepted is also counted as open", () => {
    const { open, notCounted } = segments();
    const openSet = new Set(issueRefsAtTopLevel(open));
    const overlap = issueRefsAtTopLevel(notCounted).filter((n) => openSet.has(n));
    expect(overlap, "a finding is listed as both open and not-open").toEqual([]);
  });

  it("the register records when it was last reconciled against the tracker", () => {
    // The half no test can check. Without a date here, a finding closed
    // upstream sits in this file indefinitely and reads as current — which is
    // how #1420 survived nine days after its issue was closed.
    const openSection = SECURITY_MD.slice(SECURITY_MD.indexOf("## Open findings"));
    expect(openSection).toMatch(/reconciled against the tracker \d{4}-\d{2}-\d{2}/);
  });

  it("nothing CLAUDE.md calls open is filed under Accepted in the register", () => {
    // The hole the sibling specs leave, demonstrated rather than imagined.
    // "Every open finding has its own entry in the register" is satisfied by an
    // entry in the `### Accepted (bounded)` SUBSECTION, because that subsection
    // is nested inside `## Open findings` and `registerSection()` swallows it.
    // And the open-vs-not-open overlap spec reads only CLAUDE.md's own bullet,
    // so it cannot see the register disagreeing with it.
    //
    // Measured against the real case that produced this: resolving the #1654
    // merge by taking either side's sentence unchanged leaves the bullet
    // calling #1654 open while the register files it as Accepted, and all four
    // sibling specs stayed green. This is the one that fails.
    const accepted = acceptedSubsection();
    expect(accepted, "the register no longer has an `### Accepted (bounded)` subsection").not.toBe(
      "",
    );

    const acceptedOpenings = accepted
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(0, 240));
    // Positive control: an empty opening list would satisfy the filter below
    // by finding no counterexample, exactly as the parser control above guards.
    expect(acceptedOpenings.length, "derived no accepted entries").toBeGreaterThan(0);

    const contradicted = issueRefsAtTopLevel(segments().open).filter((n) =>
      acceptedOpenings.some((o) => o.includes(`issues/${n}`) || new RegExp(`#${n}(?!\\d)`).test(o)),
    );
    expect(
      contradicted,
      "CLAUDE.md calls these findings open, but docs/security.md files them under Accepted",
    ).toEqual([]);
  });
});
