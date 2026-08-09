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
  "src/client/components/IntegrationWizardModal.svelte",
];

/**
 * Phrasings that promise the monitor covers sessions unconditionally.
 * Deliberately loose — the six offenders all said it differently.
 */
const UNCONDITIONAL =
  /(every session automatically|every `?claude`? you start afterwards picks it up|applies to every session|does the same for every session|in every (Claude Code )?session)/i;

/** The plugin monitor specifically — not the watch, not the shim. */
const ABOUT_THE_MONITOR = /plugin|monitor/i;

/** Any phrasing that names the actual trigger. */
const NAMES_THE_TRIGGER = /skill|on-skill-invoke|by name|used to|before this change|it used to/i;

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/);
}

describe("plugin-monitor arming claims name the trigger", () => {
  for (const rel of CARRIERS) {
    it(`${rel} does not promise unconditional arming`, () => {
      const text = readFileSync(join(ROOT, rel), "utf-8");
      const offenders = paragraphs(text).filter(
        (p) => UNCONDITIONAL.test(p) && ABOUT_THE_MONITOR.test(p) && !NAMES_THE_TRIGGER.test(p),
      );
      expect(
        offenders,
        `${rel}: paragraph claims the monitor covers sessions unconditionally without naming the skill-dispatch trigger`,
      ).toEqual([]);
    });
  }

  it("at least one surface actually explains the trigger, so the sweep is not vacuous", () => {
    // A regex that only ever removes text passes trivially once every mention
    // is deleted. Require the explanation to exist somewhere a user reads.
    const explained = ["README.md", "docs/troubleshooting.md", "docs/user-guide.md"].filter(
      (rel) => {
        const text = readFileSync(join(ROOT, rel), "utf-8");
        return paragraphs(text).some(
          (p) => ABOUT_THE_MONITOR.test(p) && /skill/i.test(p) && /watch|start/i.test(p),
        );
      },
    );
    expect(
      explained.length,
      "no user-facing surface explains when the monitor starts",
    ).toBeGreaterThan(0);
  });
});
