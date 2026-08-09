import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the plugin monitor's arming claim, which #1354 inverted.
 *
 * The monitor used to arm with `when: "always"` — every Claude Code session,
 * whatever you were working on. It now arms on `on-skill-invoke`, so a session
 * that never dispatches the Tandem skill has no monitor. Six user-facing
 * surfaces stated the old behaviour in the words "every session automatically"
 * or a paraphrase, and all six were false the moment the manifest changed.
 *
 * Worth a tripwire rather than a one-time sweep, for the same reason as its
 * sibling `wake-availability-claims.test.ts`:
 *
 *  1. "Install it once and every session picks it up" is the *appealing*
 *     sentence. It is what someone summarising the feature will write, and it
 *     is what the previous six surfaces converged on independently — they were
 *     not copies of each other.
 *  2. The correction is a *conditional*, and conditionals decay into their
 *     unconditional form under editing pressure far more readily than the
 *     reverse.
 *
 * Scoped to the PARAGRAPH so a qualification three screens away in another
 * section does not count. Honest limits, same as the sibling: this catches a
 * paragraph that promises unconditional arming without naming the trigger, and
 * it catches a new carrier surface making the bare claim. It cannot judge
 * whether the qualification is prominent or well-written.
 *
 * It deliberately does NOT assert on `.claude-plugin/plugin.json` — the
 * manifest itself is pinned by `tests/plugin-manifest.test.ts`, which checks
 * the `when` values directly rather than through prose.
 */

const ROOT = join(__dirname, "..", "..");

/** Files that pitch the plugin monitor to a user. Add a surface when one appears. */
const CARRIERS = [
  "README.md",
  "CHANGELOG.md",
  "docs/troubleshooting.md",
  "docs/user-guide.md",
  "docs/cli.md",
  "src/cli/setup.ts",
  "src/cli/doctor.ts",
  "src/cli/index.ts",
  "src/client/components/IntegrationWizardModal.svelte",
];

/**
 * Phrasings that promise the monitor covers sessions unconditionally.
 * Deliberately loose — the offenders all said it differently. `every session`
 * with no preposition is included because `docs/cli.md` said "reports `exit
 * 127` every session", which the earlier `in every … session` form missed
 * while the file sat in CARRIERS looking covered.
 */
const UNCONDITIONAL =
  /(every session automatically|every `?claude`? you start afterwards picks it up|applies to every session|does the same for every session|(in|for) every (Claude Code )?session|(reports?|dies|fails|exits|spawns?|starts?|runs?)[^.]{0,60}every session)/i;

/** The plugin monitor specifically — not the watch, not the shim. */
const ABOUT_THE_MONITOR = /plugin|monitor/i;

/**
 * Phrasing that names the ACTUAL trigger. Deliberately narrow, and it was not
 * always: the first version excused a paragraph on `used to`, `by name` or a
 * bare `skill`. All three are generic English, and `skill` in particular
 * appears in every carrier because the self-armed watch's own paragraph says
 * Tandem's skill explains how to arm it. Measured consequence: reverting one
 * CHANGELOG clause to its false pre-#1354 wording left the sweep 8/8 green,
 * because an unrelated "which Tandem used to recommend first" elsewhere in the
 * same bullet supplied the excuse. An excuse token must be one that cannot
 * plausibly appear except when describing this trigger.
 */
const NAMES_THE_TRIGGER =
  /on-skill-invoke|first uses|first use of|asking for Tandem by name|ask for Tandem by name|dispatch(es|ed|ing)? the|uses (the |Tandem's )?(Tandem )?skill|skill dispatch/i;

/**
 * The three regexes above ask three different questions, so they are asked of
 * three different-sized units. Collapsing any two of them has already produced
 * a hole, each one measured:
 *
 *  - **`claim`** — the narrowest unit, what `UNCONDITIONAL` is tested on. Small
 *    so that a qualification elsewhere cannot cover a false claim here.
 *  - **`context`** — the claim plus a line either side, what `NAMES_THE_TRIGGER`
 *    is tested on. Prose wraps, so a claim and the clause qualifying it land on
 *    different lines routinely; judging the excuse on the claim alone reported
 *    the *corrected* doctor.ts wording as an offender, because "…reporting it in
 *    every session on the machine)" wrapped away from the `on-skill-invoke` that
 *    qualifies it.
 *  - **`topic`** — the whole blank-line block, what `ABOUT_THE_MONITOR` is tested
 *    on. Topicality is a property of the passage, not of one line. Judging it on
 *    the claim is what made coverage uneven: `src/cli/doctor.ts` reverted to its
 *    verbatim pre-#1354 wording ("Claude Code reports it in EVERY session —
 *    including ones with nothing to do with Tandem") left the sweep **12/12
 *    green**, because the offending line names neither "plugin" nor "monitor" —
 *    both sit on the line above. The same mutation in `index.ts` and the Svelte
 *    carrier WAS caught, which is the shape of the hazard: a tripwire that fires
 *    on some carriers and not others reads as coverage.
 *
 * `context` must be a window around the claim rather than a fragment in its own
 * right. Overlapping windows were tried and leak: with each window scored as
 * both claim and excuse, the offending line reappears as the middle of the NEXT
 * window, this time without the qualifying line, and the offence resurfaces.
 */
interface Fragment {
  claim: string;
  context: string;
  topic: string;
}

function lineFragments(block: string, topic: string): Fragment[] {
  const lines = block.split("\n");
  return lines.map((claim, i) => ({
    claim,
    context: lines.slice(Math.max(0, i - 1), i + 2).join("\n"),
    topic,
  }));
}

/**
 * Markdown and source files fragment differently, and conflating them is what
 * produced the doctor.ts hole.
 *
 * The bullet split `\n(?=\s*[-*]\s)` cannot tell a markdown `* ` bullet from a
 * JSDoc continuation line, which is also whitespace-then-`*`-then-space. So in
 * a `.ts` file it silently split every comment line into its own paragraph,
 * with no window to restore the sentence. That inverts the split's purpose:
 * markdown bullets are separate assertions and must NOT excuse each other,
 * while wrapped comment prose is one sentence and must.
 *
 * The 1500-char escape hatch stays for markdown only, because the carrier it
 * exists for is a `.svelte` file — 11k chars with no blank line, where a stray
 * token anywhere excused a false claim anywhere.
 */
function fragments(rel: string, text: string): Fragment[] {
  const isMarkdown = rel.endsWith(".md");
  return text.split(/\n\s*\n/).flatMap((block) => {
    if (!isMarkdown) return lineFragments(block, block);
    return block
      .split(/\n(?=\s*[-*]\s)/)
      .flatMap((bullet) =>
        bullet.length > 1500
          ? lineFragments(bullet, block)
          : [{ claim: bullet, context: bullet, topic: block }],
      );
  });
}

describe("plugin-monitor arming claims name the trigger", () => {
  for (const rel of CARRIERS) {
    it(`${rel} does not promise unconditional arming`, () => {
      const text = readFileSync(join(ROOT, rel), "utf-8");
      const offenders = fragments(rel, text)
        .filter(
          (f) =>
            UNCONDITIONAL.test(f.claim) &&
            ABOUT_THE_MONITOR.test(f.topic) &&
            !NAMES_THE_TRIGGER.test(f.context),
        )
        .map((f) => f.claim);
      expect(
        offenders,
        `${rel}: paragraph claims the monitor covers sessions unconditionally without naming the skill-dispatch trigger`,
      ).toEqual([]);
    });
  }

  // A sweep that only ever removes text passes trivially once every mention is
  // deleted, so each of these files must positively CARRY the explanation.
  //
  // The first version of this guard was one test over three files, satisfied by
  // `ABOUT_THE_MONITOR && /skill/i && /watch|start/i` in ANY of them — and it
  // passed after every sentence about plugin-monitor arming was deleted from
  // all three, because paragraphs about the self-armed `Monitor` tool match
  // `ABOUT_THE_MONITOR` on the word "Monitor". Per-file, and requiring the
  // paragraph to be about the *plugin* and to name the trigger.
  for (const rel of ["README.md", "docs/troubleshooting.md", "docs/user-guide.md"]) {
    it(`${rel} explains when the plugin monitor starts`, () => {
      const text = readFileSync(join(ROOT, rel), "utf-8");
      const explains = fragments(rel, text).some(
        (f) => /plugin/i.test(f.context) && NAMES_THE_TRIGGER.test(f.context),
      );
      expect(explains, `${rel} no longer says when the plugin monitor arms`).toBe(true);
    });
  }
});
