import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the one fact about the channel shim that keeps coming back wrong:
 * **nothing in the app can register it.** The CLI's `--with-channel-shim` is
 * the only opt-in.
 *
 * `shouldRegisterChannelShim` (`src/server/integrations/apply.ts`) is
 * `override ?? false`, and the wizard's apply route calls it with no override —
 * its own comment says "There is deliberately NO wizard checkbox: the CLI flag
 * is the only opt-in, and any docs claiming otherwise are wrong (that claim was
 * in three places until 2026-08-09)."
 *
 * Those three were swept. Two more were live when #1432 went looking, four
 * months later:
 *
 *  1. `IntegrationWizardModal.svelte` — "If Claude reports no Monitor tool at
 *     all, come back here and register the channel shim". Its sibling arm said
 *     the shim was "registered HERE", which is the ambiguity that makes the
 *     false one read as consistent, so both were rewritten.
 *  2. `apply.ts`'s own `BuildMcpEntriesOptions.withChannelShim` docblock —
 *     "opt-in via `--with-channel-shim` or the wizard's checkbox" — in the
 *     docblock of the function that returns `override ?? false`. The worst of
 *     the five, because it is where a maintainer goes to check.
 *
 * A one-time sweep has now failed twice, which is the argument for a tripwire
 * rather than a third sweep. Both of the above are fixtures below: this test
 * was RED at two sites on the tree it was written against.
 *
 * SHAPE, and why it is this shape.
 *
 * The claim is scored on a ±1-line window (`context`), the topic on the
 * blank-line block, exactly like `monitor-arming-claims.test.ts` — prose wraps,
 * and a claim and its qualifier land on different lines routinely.
 *
 * The gaps inside the patterns are `[^.]`, not `[^.\n]`: they must cross a line
 * break, because every real instance wrapped mid-claim ("or the wizard's /
 * checkbox"), and a sentence boundary — not a line boundary — is what ends a
 * claim. Measured while writing this: with `[^.\n]` the `apply.ts` fixture below
 * scored clean, i.e. the guard would have shipped blind to the worse of the two
 * live instances.
 *
 * The offending patterns are WIZARD-ANCHORED. "Register the channel shim with
 * `tandem setup --apply --with-channel-shim`" is correct and common; what is
 * false is naming the wizard, Settings, or "here" as the thing that does it.
 *
 * The ONLY excuse is an explicit negation next to the wizard noun. It is
 * deliberately NOT "`--with-channel-shim` appears nearby", which is the
 * tempting version and would have excused fixture 2 — there the false clause
 * shares a LINE with the correct flag. An excuse token must be one that cannot
 * plausibly appear except when denying the claim.
 *
 * Honest limits: it cannot judge whether a correct sentence is prominent or
 * well-written, and it only reads the surfaces listed.
 */

const ROOT = join(import.meta.dirname, "..", "..");

/** Files that tell a user, or a maintainer, how the shim gets registered. */
const SURFACES = [
  "README.md",
  "docs/troubleshooting.md",
  "docs/user-guide.md",
  "docs/cli.md",
  "skills/tandem/SKILL.md",
  "src/cli/doctor.ts",
  "src/cli/setup.ts",
  "src/server/integrations/apply.ts",
  "src/server/integrations/api-routes.ts",
  "src/client/components/IntegrationWizardModal.svelte",
  "src/client/components/PushRoutesInfo.svelte",
  "src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte",
];

/**
 * Something in the app named as the registrar. Three shapes, because the five
 * known instances used three different ones: "the wizard's checkbox",
 * "come back here and register", and "register it from the wizard".
 */
const APP_REGISTERS = [
  /\b(wizard|settings)\b[^.]{0,40}\b(checkbox|registers?|register)\b/i,
  /\bcome back here\b[^.]{0,40}\bregister\b/i,
  /\bregist\w*[^.]{0,30}\b(from|in|via)\b[^.]{0,20}(the )?(setup |integration )?\b(wizard|settings)\b/i,
];

/** The shim specifically — not the plugin, not the built-in watch. */
const ABOUT_THE_SHIM = /shim|tandem-channel|channel entry/i;

/**
 * Explicit denial, in either word order. "cannot" before the noun
 * ("no wizard checkbox") and after it ("the wizard cannot register it") are
 * both natural English and both appear in the corrected copy.
 */
const DENIES =
  /(\b(no|not|never|cannot|can't|neither)\s+\w*\s*(wizard|settings|checkbox|equivalent)\b)|(\b(wizard|settings)\b[^.]{0,25}\b(cannot|can't|does not|doesn't|never|no)\b[^.]{0,15}(regist|checkbox))/i;

/**
 * Strip comment furniture before scoring. Without this a JSDoc continuation
 * (`   *  wizard checkbox`) puts the `*` between the denial on the line above
 * and the noun below, so a ±1-line window that plainly contains "There is no
 * wizard checkbox" scores as unexcused. Measured on `apply.ts` while writing
 * the fix: the corrected docblock reported as an offender until this landed.
 *
 * The `--!?>` alternations are not decoration. `--!>` is a comment terminator
 * the HTML parser accepts (its "comment end bang" state), so a pattern that
 * knows `-->` and not `--!>` is an incomplete HTML-comment matcher — which is
 * what CodeQL's `js/bad-tag-filter` flagged here on the first push. Nothing
 * untrusted reaches this function (it reads tracked files in this repo), but
 * the rule is right about the pattern, and the widening cannot change a score:
 * it only strips more furniture, and every scanned surface is 0 offenders
 * either way (measured before and after).
 */
function decomment(line: string): string {
  return line.replace(/^\s*(\*|\/\/|<!--|--!?>)\s?/, "").replace(/--!?>\s*$/, "");
}

interface Fragment {
  context: string;
  topic: string;
}

function fragments(text: string): Fragment[] {
  return text.split(/\n\s*\n/).flatMap((block) => {
    const lines = block.split("\n").map(decomment);
    const topic = lines.join("\n");
    return lines.map((_, i) => ({
      context: lines.slice(Math.max(0, i - 1), i + 2).join("\n"),
      topic,
    }));
  });
}

/** Exported shape so the fixtures below and the surfaces above score identically. */
export function offendingFragments(text: string): string[] {
  return fragments(text)
    .filter(
      (f) =>
        APP_REGISTERS.some((re) => re.test(f.context)) &&
        ABOUT_THE_SHIM.test(f.topic) &&
        !DENIES.test(f.context),
    )
    .map((f) => f.context);
}

describe("channel-shim opt-in claims", () => {
  for (const rel of SURFACES) {
    it(`${rel} does not say anything in the app registers the shim`, () => {
      const text = readFileSync(join(ROOT, rel), "utf-8");
      expect(
        offendingFragments(text),
        [
          `${rel}: names the wizard/Settings as registering the channel shim.`,
          "It cannot: `shouldRegisterChannelShim` is `override ?? false` and the",
          "wizard's apply route passes no override. Say `tandem setup --apply",
          "--with-channel-shim` instead.",
        ].join(" "),
      ).toEqual([]);
    });
  }

  // The regexes are the test. Pin them against both known offender wordings and
  // against the four correct surfaces they must NOT flag — a guard that is
  // merely green proves nothing about which half it is measuring.
  it("flags the two wordings that were live on this tree", () => {
    expect(
      offendingFragments(
        "If Claude reports no Monitor tool at all, come back here and register the\nchannel shim — it is the one route that depends on neither gate.",
      ),
    ).not.toEqual([]);
    expect(
      offendingFragments(
        "Include the stdio channel shim. Defaults to false, and since Track E\n(2026-08-07) `shouldRegisterChannelShim` no longer turns it on by default\neither — the shim is opt-in via `--with-channel-shim` or the wizard's\ncheckbox.",
      ),
    ).not.toEqual([]);
  });

  it("does not flag a correct sentence that names the CLI flag", () => {
    expect(
      offendingFragments(
        "*Or* register the channel shim and start Claude Code with the channel flag:\n\n```bash\ntandem setup --apply --with-channel-shim\n```",
      ),
    ).toEqual([]);
  });

  it("does not flag an explicit denial, in either word order", () => {
    expect(
      offendingFragments(
        "There is deliberately NO wizard checkbox: the CLI flag is the only opt-in\nfor the channel shim, and any docs claiming otherwise are wrong.",
      ),
    ).toEqual([]);
    expect(
      offendingFragments(
        "If Claude reports no Monitor tool at all, the channel shim is the one route\nthat depends on neither gate. This wizard cannot register it — run\n`tandem setup --apply --with-channel-shim` from a terminal.",
      ),
    ).toEqual([]);
  });
});
