import { describe, expect, it } from "vitest";
import { bundledCssFiles, cssRulesBySelector, styleBlocks } from "../helpers/css-source";

/**
 * A toggle button's "on" state is a PRESS, not a colour category.
 *
 * Every toggle in the toolbars used to paint its active state with
 * `--tandem-accent-bg` + `--tandem-accent-fg-strong`. In the same bars the
 * accent also marks formatting actively applied to the selection, so a view
 * toggle (source view, decorations, find-scope) wearing it read as the same
 * kind of thing as an applied bold. They now share one idiom instead:
 * `--tandem-surface-sunk` plus `var(--tandem-shadow-inset)`, which reads as the
 * key being pushed into its surrounding surface.
 *
 * Two assertions, and the second is the one that survives contact with future
 * code: the four converted toggles must keep the inset, AND no new rule may
 * reintroduce an accent fill on an activated state without joining the
 * allowlist below — which is a deliberate, reviewed set, not a list seeded from
 * whatever this change happened to touch.
 */

/** Rules whose selector marks an activated/selected state. */
const ACTIVE_STATE_RE = /\.on\b|\.is-active\b|\.is-selected\b|\[data-active="true"\]/;

/**
 * Selection INDICATORS, deliberately still accent-tinted. None is a toggle
 * button: each marks "which one of these is current", where the accent is doing
 * the job it does everywhere else in the app. A depressed key would be the
 * wrong metaphor — a colour swatch cannot be pressed while still showing its
 * colour, and a nav item marks a location, not a state you switched on.
 *
 * Adding to this list is a design decision. Each entry is `file::selector`.
 */
const ACCENT_SELECTION_INDICATORS = new Set([
  "src/client/components/IntegrationTargetCard.svelte::.itc-card.is-selected",
  'src/client/components/SettingsModal.svelte::.settings-modal-nav-btn[data-active="true"]',
  "src/client/shell/TitleBar.svelte::.brand-theme-sw.on",
  "src/client/editor/toolbar/HighlightColorPicker.svelte::.highlight-picker-swatch.is-selected",
]);

/** The toggles converted to the pressed idiom, keyed by file. */
const PRESSED_TOGGLES: Array<[string, string]> = [
  ["src/client/editor/toolbar/ToolbarButton.svelte", ".toolbar-btn.is-active"],
  ["src/client/shell/FormattingBar.svelte", ".fmtbar-source.on"],
  ["src/client/editor/find-replace/FindReplaceBar.svelte", ".fr-toggle.on"],
  ["src/client/editor/find-replace/FindReplaceBar.svelte", ".fr-scope-pill.on"],
  ["src/client/shell/DecorationsMenu.svelte", ".half-main.on"],
];

/** Normalise a path for comparison against the literals above. */
const norm = (file: string) => file.replace(/\\/g, "/");

describe("activated toggles read as pressed, not as accent-coloured", () => {
  it("each converted toggle carries the shared inset", () => {
    for (const [file, selector] of PRESSED_TOGGLES) {
      const rules = cssRulesBySelector(styleBlocks(file));
      const rule = rules.find((r) => r.fullSelectors.includes(selector));
      expect(rule, `${file}: no rule for ${selector}`).toBeDefined();
      expect(
        rule!.body,
        `${file} ${selector} lost var(--tandem-shadow-inset) — without it the ` +
          "active state is the same sunk fill as :hover and the two become " +
          "indistinguishable, which is worse than the accent it replaced",
      ).toContain("var(--tandem-shadow-inset)");
      expect(
        rule!.body,
        `${file} ${selector} is painting an activated state with the accent again`,
      ).not.toContain("--tandem-accent-bg");
    }
  });

  it("no new activated state reintroduces an accent fill", () => {
    const offenders: string[] = [];
    for (const file of bundledCssFiles("src/client")) {
      for (const rule of cssRulesBySelector(styleBlocks(file))) {
        if (!rule.body.includes("--tandem-accent-bg")) continue;
        for (const selector of rule.fullSelectors) {
          if (!ACTIVE_STATE_RE.test(selector)) continue;
          // A hover/focus preview is not an activated state.
          if (/:hover|:focus/.test(selector)) continue;
          const key = `${norm(file)}::${selector}`;
          if (!ACCENT_SELECTION_INDICATORS.has(key)) offenders.push(key);
        }
      }
    }
    expect(
      offenders,
      "an activated state is painted with --tandem-accent-bg. Toggles use " +
        "--tandem-surface-sunk + var(--tandem-shadow-inset); if this is a " +
        "selection indicator rather than a toggle, add it to " +
        "ACCENT_SELECTION_INDICATORS with the reasoning",
    ).toEqual([]);
  });

  it("the inset token is defined for light and overridden for dark", () => {
    // A single :root definition would render the dark press nearly invisible —
    // a 0.12-alpha black inset on the dark sunk surface is below the JND.
    const html = styleBlocks("index.html");
    expect(html).toContain("--tandem-shadow-inset:");
    const darkBlock = html.slice(html.indexOf('[data-theme="dark"]'));
    expect(
      darkBlock,
      "--tandem-shadow-inset has no dark-theme override, so the pressed state " +
        "is nearly invisible there",
    ).toContain("--tandem-shadow-inset:");
  });
});
