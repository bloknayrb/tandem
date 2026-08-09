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
 *  2. The obvious fallback is wrong. The plugin monitor reads the *same* remote
 *     gate, so "if that fails, install the plugin" moves the reader from one
 *     unavailable remedy to another. Only the channel shim is independent, and
 *     nothing but a test will keep that distinction alive in copy.
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

  it("names the channel shim — not the plugin — as the fallback when the tool is absent", () => {
    // The plugin monitor reads the same remote gate (ADR-049 amendment,
    // 2026-08-09), so routing a Monitor-less reader to it is advice that cannot
    // work. Asserted on the two surfaces that actually give a next step.
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
