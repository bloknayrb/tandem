import { readFileSync } from "node:fs";
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
 * The enumeration and the sweeps do different jobs and neither replaces the
 * other. `PRESSED_TOGGLES` is a POSITIVE pin: these specific rules must exist
 * and must carry the inset, which catches a rule being deleted outright — a
 * derived scan cannot see a rule that is gone. The sweeps are the part that
 * survives contact with future code: no activated state may reintroduce an
 * accent fill, and any activated state reaching for the sunk surface must carry
 * the inset with it, whether or not anyone updates the list.
 */

/** Selector text with every `:not(…)` argument removed. */
const outsideNot = (sel: string) => sel.replace(/:not\([^)]*\)/g, "");

/**
 * Rules whose selector marks an activated/selected state.
 *
 * `[aria-pressed` is here because DecorationsMenu already publishes it and a
 * future toggle could be styled off the attribute rather than a class — the
 * cascade suite's equivalent regex has always included it.
 *
 * Applied to `outsideNot(selector)`: `.toolbar-btn:hover:not(.is-active)` is a
 * HOVER rule that merely names the active state in order to exclude itself
 * from it, and counting it as activated made the sunk/inset sweep below
 * unadoptable.
 */
const ACTIVE_STATE_RE =
  /\.on\b|\.is-active\b|\.is-selected\b|\[data-active="true"\]|\[aria-pressed/;

/**
 * An accent FILL — the thing being banned. Detected by PROPERTY, not by one
 * token name: the first version of this check tested only for the literal
 * `--tandem-accent-bg` anywhere in the body, and mutation-testing walked
 * straight through it with `background: var(--tandem-accent)`, a louder fill
 * than the one it was written to ban. "An enumeration seeded from a fix can
 * only catch the bug already fixed" applies to token names too.
 *
 * A ring (`box-shadow: 0 0 0 2px var(--tandem-accent)`) and an accent `color`
 * are deliberately outside this: they are the selection-indicator and
 * emphasis idioms, not a toggle wearing a category colour.
 */
const ACCENT_FILL_RE =
  /(?:^|[;{\s])(?:background|background-color|border-color)\s*:[^;]*--tandem-accent/;

/**
 * Selection INDICATORS, deliberately still accent-filled. None is a toggle
 * button: each marks "which one of these is current", where the accent is doing
 * the job it does everywhere else in the app. A depressed key would be the
 * wrong metaphor — a colour swatch cannot be pressed while still showing its
 * colour, and a nav item marks a location, not a state you switched on.
 *
 * Adding to this list is a design decision. Entries are `file::selector`, and
 * a STALE entry fails too: the test asserts the scan hits every one of them, so
 * a rule that is deleted or restyled cannot leave a fossil behind here.
 */
const ACCENT_SELECTION_INDICATORS = new Set([
  "src/client/components/IntegrationTargetCard.svelte::.itc-card.is-selected",
  'src/client/components/SettingsModal.svelte::.settings-modal-nav-btn[data-active="true"]',
  "src/client/shell/TitleBar.svelte::.brand-theme-sw.on",
  // The Decorations dropdown's checkmark — a checked-item marker inside a menu,
  // the same category as a menuitemradio. The menu ROW is not accent-filled.
  "src/client/shell/DecorationsMenu.svelte::.mi.on .chk",
]);

/**
 * The same decision, for an accent fill written as an INLINE style, which
 * `styleBlocks()` cannot see (it returns `<style>` blocks only). Scoped to the
 * surfaces this idiom governs — the toolbars, the formatting bar and find &
 * replace — because settings and dialogs are a different design language and
 * sweeping them here would assert a claim this file has not reasoned about.
 */
const INLINE_ACCENT_DIRS = ["/editor/toolbar/", "/editor/find-replace/", "/shell/"];
const INLINE_ACCENT_INDICATORS = new Set([
  // The heading menu's checked item. `role="menuitemradio"`: it marks which of
  // a set is current, so it belongs with the swatches above rather than with
  // the bar's toggles. Inline because the background is conditional.
  "src/client/editor/toolbar/FormattingToolbar.svelte",
]);

/** The toggles converted to the pressed idiom. */
const PRESSED_TOGGLES: Array<[string, string]> = [
  ["src/client/editor/toolbar/ToolbarButton.svelte", ".toolbar-btn.is-active"],
  ["src/client/shell/FormattingBar.svelte", ".fmtbar-source.on"],
  ["src/client/editor/find-replace/FindReplaceBar.svelte", ".fr-toggle.on"],
  ["src/client/editor/find-replace/FindReplaceBar.svelte", ".fr-scope-pill.on"],
  ["src/client/shell/DecorationsMenu.svelte", ".half-main.on"],
];

/** Normalise a path for comparison against the literals above. */
const norm = (file: string) => file.replace(/\\/g, "/");

/** Every authored rule in `src/client`, paired with its file. */
function allRules() {
  return bundledCssFiles("src/client").flatMap((file) =>
    cssRulesBySelector(styleBlocks(file)).map((rule) => ({ file: norm(file), rule })),
  );
}

describe("activated toggles read as pressed, not as accent-coloured", () => {
  it("each converted toggle carries the shared inset", () => {
    for (const [file, selector] of PRESSED_TOGGLES) {
      const rules = cssRulesBySelector(styleBlocks(file));
      const rule = rules.find((r) => r.fullSelectors.includes(selector));
      expect(rule, `${file}: no rule for ${selector}`).toBeDefined();
      expect(
        rule!.body,
        `${file} ${selector} lost var(--tandem-shadow-inset) — the press would ` +
          "then be a bare fill change, which is what the accent it replaced " +
          "already did better",
      ).toContain("var(--tandem-shadow-inset)");
      expect(
        rule!.body,
        `${file} ${selector} is painting an activated state with the accent again`,
      ).not.toMatch(ACCENT_FILL_RE);
    }
  });

  it("every converted toggle stays legible under forced colors", () => {
    // Forced colors suppresses `box-shadow` outright and overrides
    // `background-color`, so BOTH of the pressed idiom's signals are gone
    // there. The accent state this replaced survived because
    // `--tandem-accent-fg-strong` remapped to HighlightText; the pressed idiom
    // has no such fallback and needs an explicit forced border. Nothing else in
    // the suite would notice: the E2E assertions read computed style in a
    // normal rendering mode.
    for (const [file, selector] of PRESSED_TOGGLES) {
      const forced = cssRulesBySelector(styleBlocks(file)).filter(
        (r) =>
          r.atRules.some((a) => /forced-colors:\s*active/.test(a)) &&
          r.fullSelectors.includes(selector),
      );
      expect(
        forced.length,
        `${file} ${selector} has no @media (forced-colors: active) carve-out. ` +
          "Both the inset and the sunk fill are suppressed there, so the " +
          "pressed state is invisible without a forced border-color",
      ).toBeGreaterThan(0);
      expect(
        forced.map((r) => r.body).join(""),
        `${file} ${selector}'s forced-colors rule must set border-color — that is ` +
          "the only channel forced colors leaves open",
      ).toMatch(/border-color\s*:/);
    }
  });

  it("hover never borrows the pressed fill where the two must stay apart", () => {
    // DecorationsMenu's halves sit on a RAISED container, so a sunk hover would
    // read as a click that already happened. It is the one converted control
    // whose hover was deliberately given a different token
    // (`--tandem-surface-muted`), and the rule carries three lines of reasoning
    // and no assertion — exactly the shape that gets "simplified" back.
    const deco = "src/client/shell/DecorationsMenu.svelte";
    const hover = cssRulesBySelector(styleBlocks(deco)).find((r) =>
      r.fullSelectors.includes(".ib:hover"),
    );
    expect(
      hover,
      `${deco}: .ib:hover must exist — it is the split's only resting hover`,
    ).toBeDefined();
    expect(
      hover!.body,
      `${deco}: .ib:hover uses --tandem-surface-sunk, the pressed fill. The halves ` +
        "press INTO a raised container, so hover must stay lighter than the press",
    ).not.toContain("--tandem-surface-sunk");
  });

  it("no activated state reintroduces an accent fill", () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    let activeStateRules = 0;
    for (const { file, rule } of allRules()) {
      for (const selector of rule.fullSelectors) {
        if (!ACTIVE_STATE_RE.test(outsideNot(selector))) continue;
        activeStateRules++;
        if (!ACCENT_FILL_RE.test(rule.body)) continue;
        const key = `${file}::${selector}`;
        if (ACCENT_SELECTION_INDICATORS.has(key)) seen.add(key);
        else offenders.push(key);
      }
    }

    // Fail closed. A negative scan is worthless if it can silently match
    // nothing — a postcss upgrade, a Svelte nesting rewrite or a change to
    // `styleBlocks` would each turn this green on zero input.
    expect(
      activeStateRules,
      "swept no activated-state rules at all — the scan is broken, not the code",
    ).toBeGreaterThanOrEqual(25);

    expect(
      offenders,
      "an activated state is painted with an accent background/border. Toggles use " +
        "--tandem-surface-sunk + var(--tandem-shadow-inset); if this is a " +
        "selection indicator rather than a toggle, add it to " +
        "ACCENT_SELECTION_INDICATORS with the reasoning",
    ).toEqual([]);

    expect(
      [...ACCENT_SELECTION_INDICATORS].filter((k) => !seen.has(k)),
      "ACCENT_SELECTION_INDICATORS lists a rule the scan never found. Either it " +
        "was deleted or restyled (drop the entry) or the scan stopped reaching it",
    ).toEqual([]);
  });

  it("no activated state reintroduces an accent fill inline", () => {
    // `styleBlocks()` returns `<style>` blocks only, so an inline `style=`
    // attribute is structurally invisible to the sweep above — and the heading
    // menu's checked item is exactly that shape, in a file this idiom governs.
    // Without this the guard's failure message asserts a global property it
    // cannot actually check.
    const found = new Set<string>();
    let scanned = 0;
    for (const file of bundledCssFiles("src/client")) {
      if (!file.endsWith(".svelte")) continue;
      const name = norm(file);
      if (!INLINE_ACCENT_DIRS.some((d) => name.includes(d))) continue;
      scanned++;
      const markup = readFileSync(file, "utf-8").replace(/<style[\s\S]*?<\/style>/g, "");
      if (/background\s*:[^;]*--tandem-accent/.test(markup)) found.add(name);
    }

    expect(
      scanned,
      "swept no toolbar/shell components — the scan is broken",
    ).toBeGreaterThanOrEqual(5);
    expect(
      [...found].filter((f) => !INLINE_ACCENT_INDICATORS.has(f)),
      "an inline style paints an accent background in a toolbar surface. Toggles " +
        "use the pressed idiom; a one-of-N selection marker belongs in " +
        "INLINE_ACCENT_INDICATORS with the reasoning",
    ).toEqual([]);
    expect(
      [...INLINE_ACCENT_INDICATORS].filter((f) => !found.has(f)),
      "INLINE_ACCENT_INDICATORS lists a file with no inline accent background left",
    ).toEqual([]);
  });

  it("any activated state reaching for the sunk surface carries the inset", () => {
    // The part that does not depend on anyone updating PRESSED_TOGGLES. A sixth
    // toggle adopting `--tandem-surface-sunk` without the inset is the drift
    // this catches — it would read as hover, permanently.
    const offenders: string[] = [];
    for (const { file, rule } of allRules()) {
      if (!rule.body.includes("--tandem-surface-sunk")) continue;
      if (rule.body.includes("--tandem-shadow-inset")) continue;
      for (const selector of rule.fullSelectors) {
        if (ACTIVE_STATE_RE.test(outsideNot(selector))) offenders.push(`${file}::${selector}`);
      }
    }
    expect(
      offenders,
      "an activated state uses the sunk fill without var(--tandem-shadow-inset). " +
        "The fill alone is what :hover already does, so the two states become " +
        "indistinguishable",
    ).toEqual([]);
  });

  /**
   * The band's STRENGTH, not merely its presence.
   *
   * `.toolbar-btn` and `.fr-scope-pill` declare the identical fill for hover and
   * for pressed, so this inset is the only thing separating the two states.
   * Asserting the token exists says nothing about whether it can be seen — and
   * the value was under-measured once already: compositing the alpha in LINEAR
   * light rather than gamma-encoded sRGB under-reports the band by ~16%, which
   * is how a review concluded the press was a "1.1:1 nothing" (PR #1667). The
   * floor below is the corrected light-theme value; lowering it is a design
   * decision that has to come here first.
   */
  const LIGHT_INSET_DELTA_L_FLOOR = 12;

  /** `--tandem-shadow-inset`'s declared value inside a slice of index.html. */
  const INSET_RE = /--tandem-shadow-inset:\s*([^;]+);/;
  const insetIn = (css: string) => css.match(INSET_RE)?.[1]?.trim();

  /**
   * The light and dark declarations, with the slice boundary asserted.
   *
   * Hoisted because four specs need it and three of them used to re-derive the
   * same slice-and-regex — the shape `tests/helpers/css-source.ts` warns about
   * in its own header ("one copy is a bug to fix; N copies is a bug plus N-1
   * silent false negatives"). One of those copies did not guard `indexOf`
   * returning -1, so a moved marker would have handed it `slice(0, -1)`, i.e.
   * nearly the whole file, and passed.
   */
  function insetValues() {
    const html = styleBlocks("index.html");
    const darkAt = html.indexOf('[data-theme="dark"]');
    expect(darkAt, "index.html has no [data-theme='dark'] block").toBeGreaterThan(-1);
    return {
      html,
      darkAt,
      light: insetIn(html.slice(0, darkAt)),
      dark: insetIn(html.slice(darkAt)),
    };
  }

  /** The trailing alpha of an `rgba(r, g, b, a)` inside a shadow value. */
  const alphaOf = (value: string | undefined) =>
    value ? Number(value.match(/rgba\([^)]*,\s*([0-9.]+)\s*\)/)?.[1]) : Number.NaN;

  /** The `rgba(r, g, b, a)` inside a shadow value, as 0-255 channels + alpha. */
  function rgbaOf(value: string | undefined): [number, number, number, number] {
    const m = value?.match(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
    expect(m, `could not parse an rgba() out of ${value}`).toBeTruthy();
    return [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])];
  }

  /**
   * |ΔL*| of `overlay` composited over an oklch base — the perceptual step the
   * band actually makes.
   *
   * Pinning the ALPHA alone pins a proxy, and mutation-testing walked straight
   * through it: swapping `rgba(0,0,0,0.16)` for `rgba(255,255,255,0.16)` keeps
   * the alpha and destroys the band, and an alpha-only check stayed green. So
   * this composites the real colour and measures the result, which also catches
   * `--tandem-surface-sunk` being retuned underneath it.
   *
   * COMPOSITE ON GAMMA-ENCODED sRGB. CSS composites `box-shadow` alpha in the
   * encoded space; doing it in linear light under-reports by ~16% and is how a
   * review and the first fix for it both called this band a "1.1:1 nothing".
   */
  function insetDeltaL(sunk: [number, number, number], overlay: string | undefined): number {
    const [L, C, Hdeg] = sunk;
    const h = (Hdeg * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const [l, m, sm] = [l_ ** 3, m_ ** 3, s_ ** 3];
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sm,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sm,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * sm,
    ].map((c) => Math.max(0, Math.min(1, c)));

    const enc = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
    const dec = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [orr, og, ob, alpha] = rgbaOf(overlay);
    const over = [orr, og, ob].map((c) => c / 255);
    const out = lin.map((c, i) => dec(enc(c) * (1 - alpha) + over[i] * alpha));

    const lumOf = (v: number[]) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    const lstar = (Y: number) => (Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (Y * 24389) / 27);
    return Math.abs(lstar(lumOf(lin)) - lstar(lumOf(out)));
  }

  /** `--tandem-surface-sunk` for a theme, as oklch components. */
  function sunkOf(css: string): [number, number, number] {
    const m = css.match(/--tandem-surface-sunk:\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/);
    expect(m, "could not parse --tandem-surface-sunk").toBeTruthy();
    return [Number(m![1]), Number(m![2]), Number(m![3])];
  }

  it("the light inset still makes a visible band over the surface it sits on", () => {
    const { html, darkAt, light } = insetValues();
    const delta = insetDeltaL(sunkOf(html.slice(0, darkAt)), light);
    expect(
      delta,
      `the light pressed band dropped to deltaL* ${delta.toFixed(2)}, under the ` +
        `${LIGHT_INSET_DELTA_L_FLOOR} floor. It is the ONLY separator between hover ` +
        "and pressed on .toolbar-btn and .fr-scope-pill, which declare the same " +
        "fill — so weakening it removes the state cue rather than softening it. " +
        "Changing the alpha, the overlay colour or --tandem-surface-sunk can all " +
        "land here",
    ).toBeGreaterThanOrEqual(LIGHT_INSET_DELTA_L_FLOOR);
  });

  it("warm inherits the light inset rather than overriding it", () => {
    // Deliberate, and it looks wrong at a glance: warm's --tandem-surface-sunk
    // is much darker than light's, which reads as needing more alpha. It does
    // not — a fixed alpha is near-constant in contrast across light bases, so
    // warm measures within 0.6 deltaL* of light at the same value. Pinned
    // because "add the missing warm override" is the obvious wrong fix, and it
    // was proposed once.
    const { html } = insetValues();
    const warmAt = html.indexOf('[data-theme="warm"]');
    expect(warmAt, "index.html has no [data-theme='warm'] block").toBeGreaterThan(-1);
    const end = html.indexOf('[data-high-contrast="true"]', warmAt);
    expect(end, "the warm block's end marker moved — this slice is now wrong").toBeGreaterThan(
      warmAt,
    );
    expect(
      html.slice(warmAt, end),
      "the warm theme now overrides --tandem-shadow-inset. Warm inherits the " +
        "light value on purpose; if this is intentional, re-measure both and " +
        "update docs/semantic-tokens.md and index.html's comment together",
    ).not.toContain("--tandem-shadow-inset:");
  });

  it("docs/semantic-tokens.md carries the inset's actual values, not just its name", () => {
    // A mention-only assertion is what this suite already rejects two specs
    // below ("asserting the dark block merely *mentions* the token is not the
    // check"). Pin the doc to the VALUES instead: retune either alpha without
    // touching the doc and this goes red, which is the drift that actually
    // happens. CLAUDE.md points every future author at that file as the full
    // enumeration, and nothing else in tests/ reads it.
    const { light, dark } = insetValues();
    const [lightAlpha, darkAlpha] = [alphaOf(light), alphaOf(dark)];
    const doc = readFileSync("docs/semantic-tokens.md", "utf-8");

    expect(
      doc,
      "docs/semantic-tokens.md never names --tandem-shadow-inset. Its Elevation " +
        "line is the enumeration CLAUDE.md treats as complete",
    ).toContain("--tandem-shadow-inset");
    for (const [theme, alpha] of [
      ["light", lightAlpha],
      ["dark", darkAlpha],
    ] as const) {
      expect(Number.isNaN(alpha), `could not parse the ${theme} inset alpha`).toBe(false);
      expect(
        doc,
        `docs/semantic-tokens.md does not record the ${theme} inset alpha ` +
          `(${alpha}). The doc and index.html have drifted apart`,
      ).toContain(String(alpha));
    }
  });

  it("the inset token is defined for light and given a DIFFERENT dark value", () => {
    // A single :root definition would render the dark press nearly invisible: a
    // black overlay saturates on a near-black base, so the light value measures
    // deltaL* 3.85 there against 13.69 on the light surface. Asserting the dark
    // block merely *mentions* the token is therefore not the check — re-declaring
    // the identical value would pass while changing nothing. Dark deliberately
    // has no deltaL* floor of its own; it cannot meet light's, and #1683 holds
    // that decision.
    const { light, dark } = insetValues();

    expect(light, "--tandem-shadow-inset is not defined for the light theme").toBeTruthy();
    expect(
      dark,
      "--tandem-shadow-inset has no dark-theme override, so the pressed state " +
        "is nearly invisible there",
    ).toBeTruthy();
    expect(
      dark,
      "--tandem-shadow-inset's dark value is identical to the light one. The " +
        "override exists because the light alpha is below the just-noticeable " +
        "threshold against the dark sunk surface",
    ).not.toBe(light);
  });
});
