import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

/** Files that pitch the watch to a user. Add a surface here when one appears. */
const CARRIERS = [
  "README.md",
  "CHANGELOG.md",
  "docs/troubleshooting.md",
  "docs/user-guide.md",
  "skills/tandem/SKILL.md",
];

/** Phrasings that promise the watch costs nothing. Deliberately loose. */
const PROMISE =
  /(nothing to install|needs? nothing installed|no install(ation)?( at all)?|needs no install)/i;

/** The watch specifically — not the plugin, which legitimately installs things. */
const ABOUT_THE_WATCH = /watch|wake stream|update stream/i;

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

  it("keeps unavoidable plugin overlap and recovery visible in both guides", () => {
    for (const rel of ["README.md", "docs/user-guide.md"]) {
      const text = readFileSync(join(ROOT, rel), "utf-8");
      expect(text).toMatch(/plugin[^.]*built-in (?:watch|Monitor)[^.]*both automatically/i);
      expect(text).toMatch(/TaskStop/);
    }
  });

  it("records the combined release behavior and plugin-only timing under Unreleased", () => {
    const text = readFileSync(join(ROOT, "CHANGELOG.md"), "utf-8");
    const unreleased = text.slice(text.indexOf("## [Unreleased]"), text.indexOf("## [0.21.0]"));
    expect(unreleased).toMatch(/automatically/i);
    expect(unreleased).toMatch(/missing[^.]*skill[^.]*not install/i);
    expect(unreleased).toMatch(/plugin-only[^.]*Claude Code[^.]*cache/i);
  });
});
