import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bundledCssFiles, cssRulesBySelector, styleBlocks } from "../helpers/css-source";

/**
 * Guards the cascade contract of `src/client/editor/toolbar/toolbar-chrome.css`.
 *
 * Why this is a source-level test and not a Playwright one: Playwright drives
 * `npm run dev`, which injects each module's CSS separately, so whether the
 * shared sheet lands before or after a component's compiled `<style>` differs
 * between dev and build. Any rule whose outcome depends on that order is
 * structurally invisible to the entire E2E suite — it would ship green. The
 * only durable defence is to forbid the shape that needs ordering at all, and
 * that is a property of the authored text.
 *
 * The concrete bug this prevents: a global
 * `.tandem-toolbar-ctl:hover:not(:disabled):not(.is-active)` has specificity
 * (0,4,0) and outranks a *scoped* `.fmtbar-source.on` at (0,3,0) — and that
 * guard tests `.is-active` while FormattingBar's source-view toggle uses `.on`.
 * Hovering an ACTIVE source-view toggle would silently drop its accent back to
 * the plain hover fill. Nothing asserts hover-over-active anywhere, so it would
 * never be caught downstream.
 */

const SHARED = "src/client/editor/toolbar/toolbar-chrome.css";

/**
 * Every element that wears `.tandem-toolbar-ctl`, keyed by the file it lives in
 * — DERIVED, never enumerated.
 *
 * reduce-motion-guards.test.ts states the principle this follows: "an
 * enumeration seeded from a fix can only ever catch the bug that is already
 * fixed." A hardcoded list here would be blind to the seventh component that
 * adopts the class without declaring its own state rules — which is exactly
 * the coupling the first two tests forbid the shared sheet from absorbing.
 *
 * Per CONTROL, not per file. A file-level "does this file contain any :hover"
 * check is satisfied by any unrelated rule in the same file: mutation-testing
 * it by deleting `.highlight-swatch-toggle:hover` left the assertion green,
 * because `.highlight-picker-swatch:hover` sits 40 lines below it. So each
 * control is matched against its OWN class names.
 *
 * The scan reads MARKUP with `<style>` blocks stripped, so a file that only
 * names the class in a CSS comment ("resting metrics come from
 * .tandem-toolbar-ctl") is not swept in. That is why FormattingToolbar.svelte
 * falls out on its own: it imports the sheet for `.tandem-toolbar-sep` only.
 */
interface Control {
  file: string;
  /** The control's own class names — the shared `tandem-*` ones removed. */
  classes: string[];
}

function deriveControls(): Control[] {
  const out: Control[] = [];
  for (const file of bundledCssFiles("src/client")) {
    if (!file.endsWith(".svelte")) continue;
    const markup = readFileSync(file, "utf-8").replace(/<style[\s\S]*?<\/style>/g, "");
    for (const [, attr] of markup.matchAll(/class="([^"]*\btandem-toolbar-ctl\b[^"]*)"/g)) {
      const classes = attr.split(/\s+/).filter((c) => c && !c.startsWith("tandem-"));
      out.push({ file, classes });
    }
  }
  return out;
}

describe("toolbar-chrome.css cascade contract", () => {
  const rules = cssRulesBySelector(styleBlocks(SHARED));

  it("declares only resting metrics — no interaction or state selectors", () => {
    const stateful = rules.filter((r) =>
      r.fullSelectors.some((sel) =>
        /:hover|:focus|:active|:disabled|\.is-active|\.on\b|\[aria-pressed/.test(sel),
      ),
    );
    expect(
      stateful.map((r) => r.fullSelectors.join(", ")),
      "toolbar-chrome.css must carry no state rules — a global one outranks the " +
        "scoped component rules it would override (see this file's header)",
    ).toEqual([]);
  });

  it("declares no transition, so every reduced-motion guard stays with its target", () => {
    // reduce-motion-guards.test.ts requires a transition's guards to live in the
    // SAME FILE and AFTER the rule. Keeping transitions out of the shared sheet
    // is what lets every existing guard block stay co-located and valid.
    const animated = rules.filter((r) => /(^|[;{\s])(transition|animation)\s*:/.test(r.body));
    expect(
      animated.map((r) => r.fullSelectors.join(", ")),
      "toolbar-chrome.css must declare no transition/animation",
    ).toEqual([]);
  });

  it("uses no :global(), which Svelte never compiles in a plain .css file", () => {
    // Svelte does not run over a .css file, so a `:global(...)` wrapper would
    // ship as a literal, never-matching selector. The bare form is correct
    // here — this test exists because copy-pasting the guard from a .svelte file
    // is the natural failure mode.
    //
    // Comments are stripped first: the file's own header explains this rule, and
    // scanning raw bytes would match that prose rather than any real selector.
    expect(styleBlocks(SHARED)).not.toContain(":global(");
  });

  it("is composed, never relied upon, for state by each control", () => {
    // Every control that wears .tandem-toolbar-ctl must still own its own
    // hover/focus rules locally. If one stops declaring them, it has started
    // depending on the shared sheet for state — the exact coupling the first
    // two tests forbid the shared sheet from providing.
    const controls = deriveControls();

    // Fail closed: a regex that silently matches nothing would make this
    // assertion vacuous rather than red. Seven controls composed the class when
    // it was introduced; fewer means the scan broke, not that the code shrank.
    expect(
      controls.length,
      "derived no controls wearing .tandem-toolbar-ctl — the scan is broken, not the code",
    ).toBeGreaterThanOrEqual(7);

    const stateSelectorsByFile = new Map<string, string[]>();
    for (const { file } of controls) {
      if (stateSelectorsByFile.has(file)) continue;
      stateSelectorsByFile.set(
        file,
        cssRulesBySelector(styleBlocks(file))
          .flatMap((r) => r.fullSelectors)
          .filter((sel) => /:hover|:focus-visible/.test(sel)),
      );
    }

    for (const { file, classes } of controls) {
      const stateSelectors = stateSelectorsByFile.get(file)!;
      const covered = classes.some((cls) =>
        stateSelectors.some((sel) => new RegExp(`\\.${cls}(?![\\w-])`).test(sel)),
      );
      expect(
        covered,
        `${file}: the control .${classes.join(".")} composes .tandem-toolbar-ctl but no ` +
          "local :hover/:focus-visible rule targets any of its own classes — state must " +
          "not be inherited from the shared sheet",
      ).toBe(true);
    }
  });

  it("keeps the separator on the pill recipe's 18px / 0 3px metrics", () => {
    const sep = rules.find((r) => r.fullSelectors.includes(".tandem-toolbar-sep"));
    expect(sep, ".tandem-toolbar-sep must exist").toBeDefined();
    expect(sep!.body).toContain("height: 18px");
    expect(sep!.body).toContain("margin: 0 3px");
    // flex-shrink is load-bearing: one of the inline copies this replaced was
    // missing it, so the separator collapsed when the bar ran out of room.
    expect(sep!.body).toContain("flex-shrink: 0");
  });
});
