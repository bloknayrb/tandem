import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards ADR-012's refuted stateless-transport claim (#1332, evidence #1253).
 *
 * ADR-012 asserted, as fact, that the SDK "crashes in stateless mode after the
 * first `server.connect()`". The #1253 probe refuted it. The mechanism is
 * explained in `docs/spikes/stateless-transport-probe.md`, and the behaviour
 * itself is pinned by `tests/server/stateless-transport-sdk.test.ts` — this
 * file guards only the WORDS, and is the weaker of the two by construction.
 *
 * The one distinction the matcher depends on: "cannot be **re**used" is the
 * SDK's own TRUE rule, and `Protocol.connect()` throwing on an already-connected
 * server is a DIFFERENT and still-true guard. Conflating the two is the specific
 * mistake this test exists to catch, because it was already made once.
 *
 * WHY SENTENCES, NOT LINES. A markdown paragraph here is a single line —
 * `docs/decisions.md`:53 is ~1900 characters. A line-scoped exemption therefore
 * exempted the whole paragraph, so appending "stateless mode crashes on Windows"
 * to a corrected passage passed green. Measured, not theorised: that mutation
 * was run against the line-scoped version and the suite stayed 2/2. Scoring each
 * sentence separately makes the exemption mean "this claim is marked" rather
 * than "something in this paragraph is marked".
 *
 * WHAT THIS CANNOT DO. It matches phrasings, not meaning, so a sufficiently
 * novel paraphrase escapes it. `KNOWN_REASSERTIONS` below is the honest record
 * of what it does catch: extend that table when a new phrasing is found in the
 * wild, rather than trusting the regexes to generalise.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/**
 * The subject. Widened past the literal word `stateless` because ADR-012's
 * claim is equally sayable in the SDK's own API terms, and
 * `docs/lessons-learned.md` already framed it that way.
 *
 * INVARIANT — `corpus()` uses THIS regex to skip files, and the matcher uses it
 * to reject units. That prefilter is verdict-preserving only because every unit
 * is a contiguous substring of the file text and `TOPIC` is unanchored, so
 * `TOPIC.test(unit)` implies `TOPIC.test(text)`. If you widen the matcher's
 * subject, widen it HERE — a second, wider subject regex used only downstream
 * would make the prefilter start hiding offenders, silently.
 */
const TOPIC = /stateless|session-?less|sessionIdGenerator\s*(?:[:=]|is|being)?\s*undefined/i;

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
 * opposite of what a triage record is for.
 *
 * `tests/docs/` is out wholesale rather than this file by name, and the SDK
 * probe is out by name: both quote the phrasings they pin. Without the second
 * carve-out the probe passes only by accident of where its sentences break —
 * rewrapping one of its comments, with no change of wording, turned it into an
 * offender.
 */
function scannedFiles(): string[] {
  return [
    "CLAUDE.md",
    "AGENTS.md",
    ...filesUnder("docs", ".md"),
    ...["src", "tests"].flatMap((dir) => filesUnder(dir, ".ts")),
  ].filter(
    (p) =>
      !p.startsWith("docs/triage/") &&
      !p.startsWith("tests/docs/") &&
      p !== "tests/server/stateless-transport-sdk.test.ts",
  );
}

/**
 * Only files that mention the subject can carry the claim, and most do not.
 * Reading the rest into line arrays retains tens of megabytes to examine a few
 * dozen lines. See the INVARIANT on `TOPIC` for why this cannot change verdicts.
 */
function corpus(): Array<{ rel: string; lines: string[] }> {
  return scannedFiles().flatMap((rel) => {
    const text = readFileSync(join(REPO_ROOT, rel), "utf-8");
    return TOPIC.test(text) ? [{ rel, lines: text.split("\n") }] : [];
  });
}

/** The refuted assertion, in the wordings it has taken or plausibly could. */
const BROKEN_PHRASING =
  /crash(es|ed|ing)?\b|does ?n.t work|is unusable|cannot be used|never works?\b|is broken|fails? (after|on|with|once)|hangs?\b|(is )?(not supported|unsupported)|blows? up|errors? out|panics?\b/i;

/**
 * A denial of the claim is not the claim. Without this, writing the correction
 * in plain English — "stateless mode does not crash" — fails the build, and a
 * guard that punishes stating the truth is a guard someone deletes.
 */
const NEGATOR = /\b(no|not|never|cannot|can'?t|isn'?t|does ?n'?t|do ?n'?t|without)\b/i;

/**
 * The SDK's own TRUE rule, quoted verbatim. Exempted as a literal string rather
 * than on the substring "reus", which suppressed any sentence containing it —
 * including `The SDK crashes in stateless mode, so we reuse one stateful
 * transport.`, the single most likely shape for the claim to return in.
 */
const SDK_REUSE_RULE = /transport cannot be reused across requests/i;

function assertsStatelessCrash(text: string): boolean {
  if (!TOPIC.test(text) || SDK_REUSE_RULE.test(text)) return false;

  const broken = BROKEN_PHRASING.exec(text);
  if (broken && !NEGATOR.test(text.slice(Math.max(0, broken.index - 60), broken.index))) {
    return true;
  }
  return /\b(needs|requires)\b/i.test(text) && /sessionIdGenerator/.test(text);
}

/**
 * Sentence-sized units within one markdown line. Em- and en-dashes count with
 * or without surrounding spaces: `Refuted #1253—stateless mode crashes.` would
 * otherwise keep marker and claim in one unit and exempt itself.
 *
 * Colons are deliberately NOT boundaries — `sessionIdGenerator: undefined`
 * appears inside the corrected passages, and splitting there would tear a
 * struck claim away from its own strikethrough.
 */
function sentences(line: string): string[] {
  return line.split(/(?<=[.!?])\s+|\s*[—–]\s*|;\s+/);
}

/**
 * A quotation is allowed to survive — an ADR that deletes what it got wrong
 * keeps no audit trail. It has to be visibly marked, though.
 *
 * A strikethrough only counts if the struck span is itself about the subject:
 * `Stateless mode crashes, unlike ~~stdio~~.` marks the wrong thing. And the
 * bare past tense (`was`) is not a marker — nor is `never`, which appears in
 * the offending text at least as often as in a correction.
 */
function isMarkedAsOverturned(text: string): boolean {
  const struckAboutTopic = [...text.matchAll(/~~(.+?)~~/g)].some(([, span]) => TOPIC.test(span));
  return (
    struckAboutTopic ||
    (/#1253|#1332/.test(text) && /refuted|overturned|untested|superseded/i.test(text))
  );
}

function offendersIn(lines: string[]): number[] {
  const hits: number[] = [];
  lines.forEach((line, i) => {
    for (const unit of sentences(line)) {
      if (assertsStatelessCrash(unit) && !isMarkedAsOverturned(unit)) {
        hits.push(i + 1);
        return;
      }
    }
  });
  return hits;
}

/**
 * The guard's coverage, stated rather than implied. Every entry was verified to
 * slip past an earlier version of the matcher, so this table is a regression
 * record, not a wish list.
 */
const KNOWN_REASSERTIONS = [
  "Stateless mode crashes once a transport is reused.",
  "The SDK crashes in stateless mode, so we reuse one stateful transport.",
  "Stateless mode fails after the first request.",
  "Stateless mode is not supported by the SDK.",
  "Stateless mode is broken.",
  "Stateless mode hangs the server.",
  "Refuted #1253—stateless mode crashes after the first connect().",
  "The SDK crashes when sessionIdGenerator is undefined, after the first server.connect().",
  "Stateless mode crashes, unlike ~~stdio~~.",
  "Stateless mode crashes and never recovers (#1253).",
];

/** Statements that are TRUE and must not fail the build. */
const MUST_NOT_FLAG = [
  "Stateless mode does not crash.",
  "There is no crash in stateless mode.",
  "Stateless mode never crashes after the first connect().",
  "A stateless transport cannot be reused across requests.",
  "~~Stateless mode still doesn't work~~ — refuted (#1332).",
  "ADR-012 asserted the SDK crashes in stateless mode, refuted by #1253.",
];

describe("stateless-transport documentation claims (#1332 / #1253)", () => {
  it("nothing asserts that stateless mode crashes without marking it as overturned", () => {
    const offenders = corpus().flatMap(({ rel, lines }) =>
      offendersIn(lines).map((n) => `${rel}:${n}`),
    );
    expect(offenders).toEqual([]);
  });

  it("catches every re-assertion phrasing it claims to", () => {
    const missed = KNOWN_REASSERTIONS.filter((s) => offendersIn([s]).length === 0);
    expect(missed).toEqual([]);
  });

  it("does not flag true statements about stateless mode", () => {
    const falsePositives = MUST_NOT_FLAG.filter((s) => offendersIn([s]).length > 0);
    expect(falsePositives).toEqual([]);
  });

  it("the corpus actually reaches the files this guard exists for", () => {
    // Without this, a docs/ reorg or a readdirSync behaviour change that made
    // `filesUnder` return nothing would leave test 1 green forever — passing
    // because it looked at nothing. The fixture tables above exercise the
    // matcher, but only this exercises the walk that feeds it. Every sibling
    // guard carries an equivalent; `wake-availability-claims.test.ts` is the
    // closest in idiom.
    const scanned = corpus().map(({ rel }) => rel);
    expect(scanned).toContain("docs/decisions.md");
    expect(scanned).toContain("docs/lessons-learned.md");
    expect(scanned).toContain("docs/spikes/stateless-transport-probe.md");
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
