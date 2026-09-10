import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WAKE_URL_PRODUCERS } from "../../src/server/mcp/wake-url.js";

/**
 * Guards the "ask Claude to watch for updates" claim against the form it shipped
 * in on 2026-08-08 and had to be corrected on 2026-08-09.
 *
 * The self-armed wake (ADR-049) has two preconditions Tandem cannot observe:
 * the host must expose a `Monitor` tool — gated remotely, per account, not per
 * version — and on Windows that tool additionally requires Git Bash. Track F
 * shipped the path as "nothing to install, no flag" on five surfaces and led
 * with it on four, because every measurement anyone had taken was taken on the
 * one account where it works.
 *
 * Two things make this worth a tripwire rather than a one-time sweep:
 *
 *  1. The claim is *marketing-shaped* — short, appealing, and the kind of line
 *     that gets re-added to a new surface by someone summarising the feature.
 *     The first sweep missed CHANGELOG.md and the setup wizard for exactly that
 *     reason: they phrase it differently every time.
 *  2. The obvious fallback is only conditionally useful. The plugin monitor
 *     reads the same remote account gate, so it cannot help when that gate is
 *     off. It does not share the built-in Monitor's Windows Git Bash requirement,
 *     however, so it can help when that is the missing precondition. Only the
 *     channel shim is independent of both, and the copy must preserve that split.
 *
 * Scoped to the PARAGRAPH, not the file, so a caveat buried in an unrelated
 * section three screens away does not count as qualifying the claim. Note the
 * honest limit: this catches *deletion* of the caveat and catches a *new*
 * carrier surface making the bare claim. It cannot judge whether the caveat is
 * prominent enough — that stays a review question.
 */

const ROOT = join(__dirname, "..", "..");

/**
 * The release whose notes describe this behaviour. Once shipped, that record is
 * permanent and lives in its own section -- it is not a property of whatever
 * happens to be unreleased today, which is what the previous sliding window
 * assumed. Bump this only if the claims are re-described in a later release.
 */
const INTRODUCED_IN = "## [0.22.0]";

/**
 * Slice one CHANGELOG section by heading, exclusive of the next `## [` heading.
 *
 * Throws rather than returning "" on a missing heading: `indexOf` returning -1 is
 * exactly how the previous version of this guard degraded into silently asserting
 * against an empty or whole-file window. If the section is archived out of
 * CHANGELOG.md this must fail loudly and name the heading -- the record moved,
 * and that is a real finding rather than something to paper over.
 */
function changelogSection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start === -1) throw new Error(`CHANGELOG.md has no ${heading} heading`);
  const rest = text.slice(start + heading.length);
  const end = rest.indexOf("\n## [");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Files that pitch the watch to a user. Add a surface here when one appears. */
const CARRIERS = [
  "README.md",
  "CHANGELOG.md",
  "docs/troubleshooting.md",
  "docs/user-guide.md",
  "skills/tandem/SKILL.md",
];

/**
 * The carriers that describe WHEN the automatic attempt happens. Derived from `CARRIERS`
 * rather than retyped: a fifth doc joining that list should join this sweep too, and a
 * third hand-maintained literal in this file is how one gets missed. `CHANGELOG.md` is
 * excluded because its entries are dated history — a past release's line describing the
 * trigger as it was then is correct and must not be rewritten. `SKILL.md` is excluded
 * because `skill-instruction-contract.test.ts` pins its trigger prose far more precisely.
 */
const TRIGGER_CARRIERS = [
  ...CARRIERS.filter((f) => f !== "CHANGELOG.md" && f !== "skills/tandem/SKILL.md"),
  "docs/workflows.md",
];

/** Phrasings that promise the watch costs nothing. Deliberately loose. */
const PROMISE =
  /(nothing to install|needs? nothing installed|no install(ation)?( at all)?|needs no install)/i;

/** The watch specifically — not the plugin, which legitimately installs things. */
const ABOUT_THE_WATCH = /watch|wake stream|update stream/i;

/**
 * Prose about WHERE the wake address comes from and what arms on it. Wider than
 * `ABOUT_THE_WATCH`, which the trigger sweep cannot reuse: `docs/user-guide.md`'s trigger
 * paragraph says "wake-stream address" with a hyphen and never says "watch", so the
 * narrower predicate matched no paragraph there and the sweep silently checked nothing.
 */
const ABOUT_THE_TRIGGER = /wake[-\s]?stream|wakeUrl|\bwatch\b|Monitor/i;

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/);
}

function expectPullAuthorityContract(text: string): void {
  expect(text).not.toMatch(/without needing to poll `tandem_checkInbox`/i);
  expect(text).toMatch(/best-effort wake signal/i);
  expect(text).toMatch(/`tandem_checkInbox`[^.]*remains authoritative/i);
}

describe("wake-availability claims stay qualified", () => {
  for (const rel of CARRIERS) {
    it(`${rel} does not promise the watch without naming its precondition`, () => {
      const text = readFileSync(join(ROOT, rel), "utf-8");
      const offenders = paragraphs(text).filter(
        (p) => PROMISE.test(p) && ABOUT_THE_WATCH.test(p) && !/Monitor/.test(p),
      );
      expect(
        offenders,
        `${rel}: paragraph promises a no-install watch without mentioning the Monitor tool`,
      ).toEqual([]);
    });
  }

  it("names the channel shim as the fallback independent of every Monitor precondition", () => {
    // A plugin can cover the Windows Git Bash-only gap, but not the shared
    // remote account gate. Assert the two user-facing surfaces still name the
    // one route that works independently of either failure.
    for (const rel of ["README.md", "docs/troubleshooting.md"]) {
      const text = readFileSync(join(ROOT, rel), "utf-8");
      const paras = paragraphs(text).filter((p) => /Monitor/.test(p) && ABOUT_THE_WATCH.test(p));
      expect(paras.length, `${rel}: no qualified watch paragraph found at all`).toBeGreaterThan(0);
      expect(
        paras.some((p) => /shim|third option/i.test(p)),
        `${rel}: qualified the watch but pointed at no gate-independent fallback`,
      ).toBe(true);
    }
  });
});

describe("real-time push does not replace the authoritative inbox", () => {
  it("keeps pull authority explicit in the user guide", () => {
    expectPullAuthorityContract(readFileSync(join(ROOT, "docs/user-guide.md"), "utf-8"));
  });

  it("rejects the previous claim that push eliminates polling", () => {
    const shipped = readFileSync(join(ROOT, "docs/user-guide.md"), "utf-8");
    const authoritative =
      "Real-time push is a best-effort wake signal, not the authority on what Claude sees. Wakes can be dropped or rate-limited and carry no message content, so Claude still polls `tandem_checkInbox`; that inbox remains authoritative and de-duplicates items already pushed.";
    const mutant = shipped.replace(
      authoritative,
      "With channel push active, Claude receives events automatically without needing to poll `tandem_checkInbox`.",
    );

    expect(mutant, "the mutation did not alter the guarded documentation").not.toBe(shipped);
    expect(() => expectPullAuthorityContract(mutant)).toThrow();
  });
});

describe("hand-started sessions get the automatic first-use contract", () => {
  it("describes the built-in watch as automatic rather than user-requested", () => {
    for (const rel of ["README.md", "docs/user-guide.md"]) {
      const text = readFileSync(join(ROOT, rel), "utf-8");
      expect(text, `${rel}: still tells the user to request the default watch`).not.toMatch(
        /ask Claude to watch(?: Tandem)? for updates/i,
      );
      expect(text, `${rel}: does not say when the automatic attempt happens`).toMatch(
        /first (?:successful read-mode )?`?tandem_status`?|first (?:Tandem|skill) use/i,
      );
      expect(text, `${rel}: omits the built-in Monitor precondition`).toMatch(/built-in Monitor/i);
    }
  });

  // The trigger is no longer read-mode `tandem_status` alone: `tandem_open` and
  // `tandem_scratchpad` return `wakeUrl` too, because a task that fits in one call
  // (`tandem_scratchpad({ content })`) never needed a status read and so could never arm.
  //
  // The assertion above cannot catch a carrier left behind, by construction — it accepts
  // the OLD phrasing as one of its alternatives, so a doc still describing the narrow
  // trigger stays green there. This is the fail-closed half.
  //
  // It asserts the CLAIM, not a spelling. The first version of this test banned the literal
  // /first successful read-mode/ and was green over two README sentences that said "the first
  // successful `tandem_status`" without the words "read-mode" — a negative keyed on phrasing
  // passes every restatement it did not anticipate, which is the failure mode it existed to
  // prevent. Naming two or more producers is a positive fact about the prose: it cannot be
  // satisfied by a doc that still describes a single-tool trigger, however that doc spells it.
  it("every user-facing carrier describes the trigger as multi-producer", () => {
    for (const rel of TRIGGER_CARRIERS) {
      const text = readFileSync(join(ROOT, rel), "utf-8");
      // Scoped to the PARAGRAPH, like every other assertion in this file. A file-wide count
      // is the same looseness the phrasing-negative had: `docs/workflows.md` names
      // `tandem_open` in unrelated prose, so a trigger paragraph narrowed back to
      // `tandem_status` alone still cleared a whole-file check. Verified by mutation.
      // Scoped to paragraphs that describe the trigger MOMENT, not every paragraph that
      // mentions the topic. Without the `first` conjunct this also caught per-tool payload
      // EXAMPLES — a `tandem_scratchpad` response block showing `wakeUrl` names one producer
      // and matches ABOUT_THE_TRIGGER, so documenting the field correctly turned this red.
      // A response example is not a trigger description; the trigger is the sentence that says
      // WHEN the attempt happens, and every carrier phrases that with "first".
      const triggerParas = paragraphs(text).filter(
        (p) =>
          ABOUT_THE_TRIGGER.test(p) &&
          /\bfirst\b/i.test(p) &&
          WAKE_URL_PRODUCERS.some((tool) => p.includes(tool)),
      );
      expect(
        triggerParas.length,
        `${rel}: no paragraph describes the watch AND names a wakeUrl producer`,
      ).toBeGreaterThan(0);

      for (const para of triggerParas) {
        const named = WAKE_URL_PRODUCERS.filter((tool) => para.includes(tool));
        expect(
          named.length,
          `${rel}: a watch paragraph names only ${named.join(", ")}. The arm trigger is no ` +
            "longer read-mode tandem_status alone — tandem_open and tandem_scratchpad return " +
            "wakeUrl too. A paragraph naming one producer describes a trigger that a session " +
            "whose whole task is one call can never reach, so it never arms.",
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("keeps unavoidable plugin overlap and recovery visible in both guides", () => {
    for (const rel of ["README.md", "docs/user-guide.md"]) {
      const text = readFileSync(join(ROOT, rel), "utf-8");
      expect(text).toMatch(/plugin[^.]*built-in (?:watch|Monitor)[^.]*both automatically/i);
      expect(text).toMatch(/TaskStop/);
    }
  });

  it("records the combined release behavior and plugin-only timing in the release that shipped it", () => {
    const text = readFileSync(join(ROOT, "CHANGELOG.md"), "utf-8");
    const section = changelogSection(text, INTRODUCED_IN);
    // Fail closed. The bug this replaced sliced `## [Unreleased]` -> `## [0.21.0]`,
    // a window that grew by a whole section every release and was in fact satisfied
    // by shipped 0.22.0 text -- while the test's name said "under Unreleased". The
    // naive re-anchor (to the first heading after Unreleased) is worse: the release
    // convention preserves an EMPTY `## [Unreleased]`, so the window becomes "" and
    // every assertion below fails as `expected '' to match /automatically/i`, naming
    // nothing the editor touched. An empty window must be an error, never a pass.
    expect(section.trim().length).toBeGreaterThan(0);
    expect(section).toMatch(/automatically/i);
    expect(section).toMatch(/missing[^.]*skill[^.]*not install/i);
    expect(section).toMatch(/plugin-only[^.]*Claude Code[^.]*cache/i);
  });
});
