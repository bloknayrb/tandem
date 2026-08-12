import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards ADR-012's refuted stateless-transport claim (#1332, evidence #1253).
 *
 * ADR-012 asserted, as fact, that the SDK "crashes in stateless mode after the
 * first `server.connect()`". The #1253 probe refuted both the mechanism and the
 * severity, measured against `@modelcontextprotocol/sdk` **1.30.0**:
 *
 *   - There is no crash. `StreamableHTTPServerTransport.handleRequest` carries a
 *     deliberate guard that throws `Stateless transport cannot be reused across
 *     requests` once a transport built without a `sessionIdGenerator` has
 *     handled one request (`_hasHandledRequest`), so the boundary is the SECOND
 *     REQUEST on a given transport, not the handshake.
 *   - `server.connect()` is not involved. `Protocol.connect()` does throw when a
 *     server already holds a transport, but that is a DIFFERENT and still-true
 *     guard — the one ADR-045 Decision 2 and `transport-registry.ts` rest on.
 *     Conflating the two is the specific mistake this test exists to catch,
 *     because it has already been made once during triage.
 *   - Under the Node wrapper the throw reaches the client as a bare 500 with an
 *     empty body, which is the plausible origin of the 2024 "crash" reading.
 *
 * Full evidence: `docs/spikes/stateless-transport-probe.md`.
 *
 * WHY A TEST. The claim had propagated: `docs/decisions.md`:53 quoted it as
 * "untested", :54 asserted it, and ADR-045's amendment (~:995) quotes it again.
 * That is the same "authoritative-sounding prose that is now false, restated
 * across files" class `tests/docs/loopback-gate-claims.test.ts` was built for,
 * and the same remedy: pin the correction so a later "harmonization" pass
 * cannot quietly restore the false version.
 *
 * WHY THREE LIMBS. The claim propagated in three different wordings, so a
 * matcher pinned to any one of them leaves the others free to re-assert it.
 * `docs/lessons-learned.md` lesson 15 carried the second and third ("still
 * doesn't work — each transport needs `sessionIdGenerator`") and is corrected
 * in this same change; the limbs and the prose fix have to land together, since
 * either one alone is red. Note the third limb must not fire on "cannot be
 * REused", which is the SDK's own TRUE rule.
 *
 * `docs/decisions.md`'s ADR-045 amendment passes on its own merits, not by
 * exemption: it names #1253 and says the claim "has never been re-tested".
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/**
 * Budget for the corpus walk, matching the sibling guard's rationale: this walk
 * reads ~1500 `.ts` files synchronously, and under the full suite vitest is
 * already saturating the disk. A timing verdict wearing the costume of a
 * documentation failure is the most expensive kind of false alarm.
 */
const CORPUS_TIMEOUT_MS = 90_000;

/** Recursive `.md` listing, repo-relative and forward-slashed. */
function markdownUnder(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf-8" })
    .filter((p) => p.endsWith(".md"))
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
 */
function scannedFiles(): string[] {
  const docs = ["CLAUDE.md", "AGENTS.md", ...markdownUnder("docs")];
  const code = ["src", "tests"].flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf-8" })
      .filter((p) => p.endsWith(".ts"))
      .map((p) => `${dir}/${p.replace(/\\/g, "/")}`),
  );
  return [...docs, ...code].filter(
    (p) =>
      !p.startsWith("docs/triage/") &&
      // This file quotes the wording it is hunting for.
      !p.endsWith("stateless-transport-claims.test.ts"),
  );
}

/** Read every scanned file once, memoized at module scope. */
let cachedCorpus: Array<{ rel: string; lines: string[] }> | null = null;
function corpus(): Array<{ rel: string; lines: string[] }> {
  if (!cachedCorpus) {
    cachedCorpus = scannedFiles().map((rel) => ({
      rel,
      lines: readFileSync(join(REPO_ROOT, rel), "utf-8").split("\n"),
    }));
  }
  return cachedCorpus;
}

/** The refuted assertion, in each of the three phrasings it has taken. */
function assertsStatelessCrash(line: string): boolean {
  if (!/stateless/i.test(line)) return false;
  if (/crash(es|ed|ing)?\b/i.test(line)) return true;
  if (/does ?n.t work|is unusable|cannot be used|never works?\b/i.test(line)) return true;
  // "cannot be REused" is the SDK's own TRUE rule — never let it match here.
  return (
    /\b(needs|requires)\b/i.test(line) && /sessionIdGenerator/.test(line) && !/re-?us/i.test(line)
  );
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
function isMarkedAsOverturned(line: string): boolean {
  return /~~/.test(line) || (/#1253|#1332/.test(line) && /refuted|never|untested/i.test(line));
}

describe("stateless-transport documentation claims (#1332 / #1253)", () => {
  it(
    "nothing asserts that stateless mode crashes without marking it as overturned",
    () => {
      const offenders: string[] = [];

      for (const { rel, lines } of corpus()) {
        lines.forEach((line, i) => {
          if (assertsStatelessCrash(line) && !isMarkedAsOverturned(line)) {
            offenders.push(`${rel}:${i + 1}`);
          }
        });
      }

      expect(offenders).toEqual([]);
    },
    CORPUS_TIMEOUT_MS,
  );

  it("the corrected ADR-012 passage and its evidence file are both present", () => {
    // Non-vacuity control. The guard above can only pass honestly if the
    // corrected text is what is actually in the tree; without this, deleting
    // ADR-012's whole rationale would also make it green.
    const decisions = readFileSync(join(REPO_ROOT, "docs", "decisions.md"), "utf-8");
    expect(decisions).toContain("Stateless transport cannot be reused across requests");
    expect(decisions).toContain("spikes/stateless-transport-probe.md");

    const spike = readFileSync(
      join(REPO_ROOT, "docs", "spikes", "stateless-transport-probe.md"),
      "utf-8",
    );
    // The distinction that makes the correction correct rather than merely different.
    expect(spike).toContain("_hasHandledRequest");
    expect(spike).toContain("Protocol.connect()");
  });
});
