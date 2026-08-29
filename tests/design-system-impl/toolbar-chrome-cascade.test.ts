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
 *
 * Scope note, because the sheet's own header used to overclaim it: this governs
 * the SHARED-SHEET boundary. Conflicts *within* one component's `<style>` are a
 * different matter — Svelte 5 emits the scoping class on a descendant compound
 * inside `:where()`, which contributes no specificity, so in-file pairs like
 * `.ib svg` / `.half-caret svg` can tie and resolve on source order. Those are
 * same-file and therefore not order-dependent across the bundle, which is what
 * this file is about.
 */

const SHARED = "src/client/editor/toolbar/toolbar-chrome.css";
const CTL = "tandem-toolbar-ctl";

/**
 * Every element that wears `.tandem-toolbar-ctl`, keyed by the file it lives in
 * — DERIVED, never enumerated.
 *
 * reduce-motion-guards.test.ts states the principle this follows: "an
 * enumeration seeded from a fix can only ever catch the bug that is already
 * fixed." A hardcoded list here would be blind to the next component that
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

/** Markup with `<style>` blocks removed. */
function markupOf(file: string): string {
  return readFileSync(file, "utf-8").replace(/<style[\s\S]*?<\/style>/g, "");
}

/**
 * The value of every `class` attribute in `markup`, in any of the forms Svelte
 * accepts: `class="…"`, `class='…'`, and `class={…}` (expression, including a
 * template literal). The brace form is scanned with a depth counter rather than
 * a regex because an expression can nest braces and quotes.
 *
 * The `class:name={cond}` DIRECTIVE form is deliberately NOT handled here; the
 * test below asserts no control uses it for this class, so the gap is loud
 * rather than silent. That matters because a missed control is a PASS: it
 * simply drops out of the derived set.
 */
function classAttrValues(markup: string): string[] {
  const out: string[] = [];
  const re = /\bclass\s*=\s*/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = re.exec(markup)) !== null) {
    let i = m.index + m[0].length;
    const opener = markup[i];
    if (opener === '"' || opener === "'") {
      const end = markup.indexOf(opener, i + 1);
      if (end === -1) continue;
      out.push(markup.slice(i + 1, end));
      re.lastIndex = end + 1;
      continue;
    }
    if (opener !== "{") continue;
    let depth = 0;
    const start = i;
    for (; i < markup.length; i++) {
      const ch = markup[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    // Every string literal inside the expression, concatenated — a conditional
    // like `{on ? "a ctl" : "b"}` contributes both branches, which is right:
    // either branch putting the class on the element makes it a control.
    const expr = markup.slice(start, i + 1);
    out.push([...expr.matchAll(/["'`]([^"'`]*)["'`]/g)].map((s) => s[1]).join(" "));
    re.lastIndex = i + 1;
  }
  return out;
}

function deriveControls(): Control[] {
  const out: Control[] = [];
  for (const file of bundledCssFiles("src/client")) {
    if (!file.endsWith(".svelte")) continue;
    for (const attr of classAttrValues(markupOf(file))) {
      if (!new RegExp(`\\b${CTL}\\b`).test(attr)) continue;
      const classes = attr.split(/\s+/).filter((c) => c && !c.startsWith("tandem-"));
      out.push({ file, classes });
    }
  }
  return out;
}

/** Selector text with every `:not(…)` argument removed. */
const outsideNot = (sel: string) => sel.replace(/:not\([^)]*\)/g, "");

/** A selector that also pins an activated/selected/open state. */
const isStateQualified = (sel: string) =>
  /\.on\b|\.is-active\b|\.is-selected\b|\[aria-|:active\b/.test(outsideNot(sel));

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

  it("is reached by an explicit import in every file that wears the class", () => {
    // HighlightColorPicker carried the class with its local metrics deleted
    // while relying on the sheet arriving TRANSITIVELY, through an unrelated
    // `import ToolbarButton` it happened to need for a different button. Delete
    // that usage in a refactor and the toggle silently falls back to UA button
    // chrome — no type error, no failing unit test.
    const files = [...new Set(deriveControls().map((c) => c.file))];
    for (const file of files) {
      expect(
        readFileSync(file, "utf-8"),
        `${file} wears .${CTL} but never imports toolbar-chrome.css — it is ` +
          "relying on another module's import to pull the sheet in",
      ).toMatch(/import\s+["'][^"']*toolbar-chrome\.css["']/);
    }
  });

  it("is composed, never relied upon, for state by each control", () => {
    // Every control that wears .tandem-toolbar-ctl must still own its own
    // hover AND focus rules locally. If one stops declaring them, it has started
    // depending on the shared sheet for state — the exact coupling the first
    // two tests forbid the shared sheet from providing.
    const controls = deriveControls();

    // Fail closed on an EXACT count, not a floor. A floor absorbs precisely the
    // regression this is here for: removing `tandem-toolbar-ctl` from
    // HighlightColorPicker's markup drops that control out of the derived set,
    // and under `>= 7` the remaining seven still passed. Adding a control is a
    // one-line update here and should be a visible decision.
    expect(
      controls.length,
      "the set of controls wearing .tandem-toolbar-ctl changed. If you ADDED one, " +
        "bump this number. If you did not, a control lost the class (or lost the " +
        "attribute form this scan understands) and is now silently un-styled",
    ).toBe(8);

    // The directive form would be invisible to `classAttrValues`, and invisible
    // means PASS. 80+ `class:` directives already exist in src/client, so this
    // is a live idiom rather than a hypothetical.
    for (const file of bundledCssFiles("src/client")) {
      if (!file.endsWith(".svelte")) continue;
      expect(
        markupOf(file),
        `${file}: \`class:${CTL}\` is not seen by this file's scan. Put the class ` +
          "in a plain `class` attribute, or teach classAttrValues the directive form",
      ).not.toContain(`class:${CTL}`);
    }

    const stateSelectorsByFile = new Map<string, string[]>();
    for (const { file } of controls) {
      if (stateSelectorsByFile.has(file)) continue;
      stateSelectorsByFile.set(
        file,
        cssRulesBySelector(styleBlocks(file)).flatMap((r) => r.fullSelectors),
      );
    }

    for (const { file, classes } of controls) {
      const selectors = stateSelectorsByFile.get(file)!;
      const owns = (pseudo: RegExp, restingOnly: boolean) =>
        classes.some((cls) =>
          selectors.some(
            (sel) =>
              pseudo.test(sel) &&
              !(restingOnly && isStateQualified(sel)) &&
              new RegExp(`\\.${cls}(?![\\w-])`).test(sel),
          ),
        );

      // The hover evidence must be a RESTING hover. Mutation-testing found the
      // gap: deleting `.ib:hover` — DecorationsMenu's only resting hover rule —
      // stayed green because `.half-main.on:hover` and
      // `.half-caret[aria-expanded="true"]:hover` both match /:hover/. A
      // hover-over-ACTIVE rule is not evidence of a hover affordance; it is the
      // coupling this test exists to forbid, wearing the answer's clothes.
      expect(
        owns(/:hover/, true),
        `${file}: .${classes.join(".")} composes .${CTL} but has no RESTING :hover ` +
          "rule of its own (a hover-over-active rule does not count) — the hover " +
          "affordance must not be inherited from the shared sheet",
      ).toBe(true);

      expect(
        owns(/:focus-visible/, false),
        `${file}: .${classes.join(".")} composes .${CTL} but no local ` +
          ":focus-visible rule targets any of its own classes",
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

/**
 * `ToolbarButton`'s `style` prop is a documented layout/typography escape
 * hatch. The properties it forbids are forbidden for a cascade reason: a
 * non-important inline style outranks every author rule regardless of
 * specificity, so a `background` passed through here would silently defeat
 * `.toolbar-btn.is-active`'s pressed fill — the signal the whole toolbar
 * restyle depends on — and leave no trace anywhere else.
 *
 * The prohibition was prose only. This PR widened the hatch (four buttons now
 * ride `font-size` through it), which is exactly when a prose-only contract
 * starts getting tested by accident.
 */
describe("ToolbarButton style-prop escape hatch", () => {
  const BANNED =
    /(^|;)\s*(background|background-color|color|border|border-color|border-radius)\s*:/;

  /** Attribute text of every `<ToolbarButton …>` opening tag in `markup`. */
  function toolbarButtonTags(markup: string): string[] {
    const out: string[] = [];
    const re = /<ToolbarButton\b/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
    while ((m = re.exec(markup)) !== null) {
      // Walk to the tag's closing `>`, tracking braces and quotes so an arrow
      // function or a generic in an attribute value cannot end the tag early.
      let depth = 0;
      let quote: string | null = null;
      let i = m.index + m[0].length;
      for (; i < markup.length; i++) {
        const ch = markup[i];
        if (quote) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (ch === ">" && depth === 0) break;
      }
      out.push(markup.slice(m.index, i));
      re.lastIndex = i;
    }
    return out;
  }

  it("no call site injects a property the .toolbar-btn rules own", () => {
    const tags: Array<{ file: string; style: string }> = [];
    for (const file of bundledCssFiles("src/client")) {
      if (!file.endsWith(".svelte")) continue;
      for (const tag of toolbarButtonTags(markupOf(file))) {
        const m = tag.match(/\bstyle\s*=\s*"([^"]*)"/);
        if (m) tags.push({ file, style: m[1] });
      }
    }

    // Fail closed: this scan reporting nothing must mean "no styled call site",
    // not "the tag walker broke". Four buttons ride font-size through the prop.
    expect(
      tags.length,
      "found no styled <ToolbarButton> call sites — the tag scan is broken, not the code",
    ).toBeGreaterThanOrEqual(4);

    for (const { file, style } of tags) {
      expect(
        BANNED.test(style),
        `${file}: <ToolbarButton style="${style}"> injects a property the ` +
          ".toolbar-btn rules own. An inline style outranks every author rule, so " +
          "this silently defeats :hover / .is-active / :disabled / :focus-visible. " +
          "See the `style` prop's doc comment in ToolbarButton.svelte",
      ).toBe(false);
    }
  });
});
