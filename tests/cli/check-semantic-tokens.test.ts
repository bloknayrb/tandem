import { describe, expect, it } from "vitest";
import {
  BUNDLE_BLOCKLIST_HEX,
  buildErrorGuidance,
  checkContent,
  isColorValuePosition,
  isCssPropertyName,
  isLikelyIssueReference,
  looksLikeCssValueString,
  normalizeHexForBlocklist,
  scanStringLiterals,
  shouldSkipFile,
} from "../../scripts/check-semantic-tokens.js";

describe("check-semantic-tokens", () => {
  it("flags raw hex colors inside Svelte style blocks", () => {
    const violations = checkContent(
      `<script lang="ts">
        const label = "test";
      </script>

      <style>
        .danger {
          color: #dc2626;
        }
      </style>`,
      "src/client/components/Example.svelte",
    );

    expect(violations).toEqual(["src/client/components/Example.svelte:7: #dc2626"]);
  });

  it("skips only the known legacy Svelte harness files", () => {
    expect(shouldSkipFile("src/client/svelte-harness/Harness.svelte")).toBe(true);
    expect(shouldSkipFile("src/client/svelte-harness/HookDebug.svelte")).toBe(true);
    expect(shouldSkipFile("src/client/svelte-harness/NewHarnessFile.svelte")).toBe(false);
  });

  it("allows neutral rgba values", () => {
    const violations = checkContent(
      `<style>
        .modal {
          background: rgba(0, 0, 0, 0.45);
          box-shadow: 0 8px 32px rgba(0,0,0,0.24);
        }
      </style>`,
      "src/client/components/Modal.svelte",
    );

    expect(violations).toEqual([]);
  });

  it("flags raw border radius pixels", () => {
    const violations = checkContent(
      `<div style="border-radius: 6px; background: var(--tandem-surface);"></div>`,
      "src/client/components/RadiusExample.svelte",
    );

    expect(violations).toEqual([
      "src/client/components/RadiusExample.svelte:1: border-radius: 6px",
    ]);
  });

  it("flags inline box-shadow rgba so surfaces migrate to shadow tokens", () => {
    const violations = checkContent(
      `<div style="box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);"></div>`,
      "src/client/components/ShadowExample.svelte",
    );

    expect(violations).toEqual([
      "src/client/components/ShadowExample.svelte:1: box-shadow: 0 4px 12px rgba(",
    ]);
  });

  describe("bundle-token blocklist (#799)", () => {
    it("normalizes hex shorthand and alpha forms to a 6-char lowercase key", () => {
      // 3-char shorthand → expanded 6-char
      expect(normalizeHexForBlocklist("#ccc")).toBe("#cccccc");
      expect(normalizeHexForBlocklist("#CCC")).toBe("#cccccc");
      // 4-char shorthand (#rgba) → drop alpha, expand rgb
      expect(normalizeHexForBlocklist("#cccF")).toBe("#cccccc");
      // 6-char passthrough lowercases
      expect(normalizeHexForBlocklist("#FAF9F5")).toBe("#faf9f5");
      // 8-char #rrggbbaa → drop alpha
      expect(normalizeHexForBlocklist("#faf9f5aa")).toBe("#faf9f5");
      // malformed → null
      expect(normalizeHexForBlocklist("#xyz")).toBeNull();
      expect(normalizeHexForBlocklist("notahex")).toBeNull();
    });

    it("publishes a non-empty blocklist that excludes pure neutrals and approved tokens", () => {
      // Sanity: blocklist is populated.
      expect(BUNDLE_BLOCKLIST_HEX.size).toBeGreaterThan(10);
      // Pure neutrals are not on the blocklist — they're foundational primitives.
      expect(BUNDLE_BLOCKLIST_HEX.has("#000000")).toBe(false);
      expect(BUNDLE_BLOCKLIST_HEX.has("#ffffff")).toBe(false);
      // Approved bundle colors (Claude author orange) are not on the blocklist.
      expect(BUNDLE_BLOCKLIST_HEX.has("#d97757")).toBe(false);
      expect(BUNDLE_BLOCKLIST_HEX.has("#e89a78")).toBe(false);
      // All entries are normalized (lowercase, 6-char) so lookups are consistent.
      for (const entry of BUNDLE_BLOCKLIST_HEX) {
        expect(entry).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    it("flags a bundle-blocklisted hex used in a non-CSS surface (string literal)", () => {
      // `#F57018` is from the redesign bundle's calm-aesthetic palette. With no
      // `color:`/`background:` keyword on the line, the CSS-keyword pass skips
      // it; the bundle-blocklist pass must still surface it.
      const violations = checkContent(
        `const BUNDLE_ORANGE = "#F57018";\n`,
        "src/client/components/BundleLeak.svelte",
      );

      expect(violations).toEqual([
        "src/client/components/BundleLeak.svelte:1: #F57018 [bundle-blocklist]",
      ]);
    });

    it("flags a bundle-blocklisted hex in a CSS surface only once (no double-report)", () => {
      // `#c96442` is from the bundle. The CSS-keyword pass flags it first;
      // the bundle-blocklist pass must dedupe so we don't get two violations
      // for the same `file:line:hex`.
      const violations = checkContent(
        `<style>\n  .x { color: #c96442; }\n</style>\n`,
        "src/client/components/DoubleCheck.svelte",
      );

      expect(violations).toEqual(["src/client/components/DoubleCheck.svelte:2: #c96442"]);
    });

    it("flags shorthand `#ccc` even though the literal is 3 characters", () => {
      // `#ccc` normalizes to `#cccccc`, which is on the blocklist.
      const violations = checkContent(
        `const subtle = "#ccc";\n`,
        "src/client/components/Shorthand.ts",
      );

      expect(violations).toEqual(["src/client/components/Shorthand.ts:1: #ccc [bundle-blocklist]"]);
    });

    it("lets approved adoptions through (production token values, neutrals, non-bundle hex)", () => {
      // Each line uses an approved color: production tokens, pure neutrals,
      // or hex values not present in the bundle. None should be flagged by the
      // bundle-blocklist pass; the CSS-keyword pass still flags raw hex in
      // CSS context, so we only assert blocklist behavior with non-CSS lines.
      const violations = checkContent(
        [
          `const claudeOrange = "#d97757";`, // approved (bundle hex but in production tokens)
          `const claudeOrangeDark = "#e89a78";`, // approved
          `const lightBg = "#fafaf9";`, // approved (production token)
          `const black = "#000";`, // pure neutral
          `const white = "#fff";`, // pure neutral
          `const arbitrary = "#abcdef";`, // not in bundle
        ].join("\n"),
        "src/client/components/Approved.ts",
      );

      expect(violations).toEqual([]);
    });

    it("flags `#1e1e2e` (D7 onboarding prototype dark stand-in; cluster 3.11 source)", () => {
      // Added in the 2026-05-27 refreshed-bundle pass: the D7 BrandMenu swatch
      // mock hardcodes `#1e1e2e` where production uses --tandem-swatch-dark. The
      // blocklist pass must catch it even outside CSS context.
      const violations = checkContent(
        `const darkSwatch = "#1e1e2e";\n`,
        "src/client/components/OnboardingTutorial.svelte",
      );

      expect(violations).toEqual([
        "src/client/components/OnboardingTutorial.svelte:1: #1e1e2e [bundle-blocklist]",
      ]);
    });

    it("flags two distinct bundle hex values on the same non-CSS line", () => {
      // Position-keyed dedupe (not value-keyed) so both occurrences land.
      const violations = checkContent(
        `const palette = ["#F57018", "#c96442"];\n`,
        "src/client/components/Palette.ts",
      );

      expect(violations).toEqual([
        "src/client/components/Palette.ts:1: #F57018 [bundle-blocklist]",
        "src/client/components/Palette.ts:1: #c96442 [bundle-blocklist]",
      ]);
    });

    it("does not flag a bundle hex inside a line comment", () => {
      // Single-line comments are skipped wholesale by the scanner.
      const violations = checkContent(
        `// reference: bundle warm tan is #c96442\n`,
        "src/client/components/CommentOnly.ts",
      );

      expect(violations).toEqual([]);
    });
  });

  describe("comment stripping (#826 review)", () => {
    it("does not flag a bundle hex inside a mid-line-opened CSS block comment", () => {
      // The `/*` opens AFTER live code on the same line and the comment spans
      // several lines. Hex inside the comment body must be ignored, while the
      // live `color: var(--x)` declaration on the opener line stays clean.
      const violations = checkContent(
        ["  color: var(--x); /* legacy bundle", "   was #c96442 here", "   end */"].join("\n"),
        "src/client/components/MidLineBlock.css",
      );

      expect(violations).toEqual([]);
    });

    it("still flags live hex BEFORE a mid-line `/*` and AFTER a mid-line `*/`", () => {
      // Code before the opener and after the closer on the same physical line
      // must still be scanned. Both are CSS-context hex, so both are flagged.
      const violations = checkContent(
        [
          "  color: #1095d4; /* bundle blue note",
          "    #f57018 inside comment, ignored",
          "  */ background: #28c840;",
        ].join("\n"),
        "src/client/components/AroundComment.css",
      );

      expect(violations).toEqual([
        "src/client/components/AroundComment.css:1: #1095d4",
        "src/client/components/AroundComment.css:3: #28c840",
      ]);
    });

    it("does not flag a bundle hex inside an HTML comment in a .html file", () => {
      const violations = checkContent(
        `<div>before</div><!-- palette #f57018 --><div>after</div>\n`,
        "src/client/index.html",
      );

      expect(violations).toEqual([]);
    });

    it("does not flag a bundle hex inside a multi-line HTML comment", () => {
      const violations = checkContent(
        ["<!-- palette notes", "  warm tan #c96442", "  bundle blue #1095d4", "-->"].join("\n"),
        "src/client/index.html",
      );

      expect(violations).toEqual([]);
    });

    it("flags a bundle hex in live HTML code (positive control)", () => {
      // Inline style with a bundle-blocklisted hex outside any comment is real.
      const violations = checkContent(
        `<div style="color: #f57018;">live</div>\n`,
        "src/client/index.html",
      );

      expect(violations).toEqual(["src/client/index.html:1: #f57018"]);
    });

    it("flags live hex following an HTML comment close on the same line", () => {
      const violations = checkContent(
        `<!-- skip #c96442 --><span style="color: #1095d4">x</span>\n`,
        "src/client/index.html",
      );

      expect(violations).toEqual(["src/client/index.html:1: #1095d4"]);
    });

    it("flags a bundle hex in live CSS code (positive control)", () => {
      const violations = checkContent(
        `.x { color: #f57018; }\n`,
        "src/client/components/LiveCss.css",
      );

      expect(violations).toEqual(["src/client/components/LiveCss.css:1: #f57018"]);
    });

    it("does not flag a hex inside an indented `//` line comment", () => {
      // Regression: an indented `// ...` comment must be masked even when it
      // contains a CSS keyword (e.g. "style" in "Word-style") that would
      // otherwise satisfy the CSS-indicator heuristic.
      const violations = checkContent(
        `  // #649: opt-in Word-style margin annotation view\n`,
        "src/client/hooks/Example.ts",
      );

      expect(violations).toEqual([]);
    });

    it("treats `<!--` as live code in non-html files (no HTML comment stripping)", () => {
      // HTML comment recognition is gated on the `.html`/`.svelte` extensions; a
      // literal `<!--` in a .ts string must not swallow a following bundle hex.
      const violations = checkContent(
        `const s = "<!-- #f57018 -->";\n`,
        "src/client/components/NotHtml.ts",
      );

      expect(violations).toEqual([
        "src/client/components/NotHtml.ts:1: #f57018 [bundle-blocklist]",
      ]);
    });

    it("does not flag a bundle hex inside a single-line HTML comment in a .svelte file", () => {
      // `.svelte` markup uses `<!-- -->` comments just like `.html`, so the
      // HTML-comment gate must apply to .svelte files too.
      const violations = checkContent(
        `<div>before</div><!-- legacy color was #c96442 --><div>after</div>\n`,
        "src/client/components/SvelteComment.svelte",
      );

      expect(violations).toEqual([]);
    });

    it("does not flag a bundle/CSS-keyword hex inside a multi-line HTML comment in a .svelte file", () => {
      // A multi-line `<!-- -->` comment whose body contains a `color:` keyword
      // (which would otherwise satisfy the CSS-indicator heuristic) must be
      // masked across all spanned lines.
      const violations = checkContent(
        ["<!-- palette notes", "  legacy color: #c96442", "  bundle blue #1095d4", "-->"].join(
          "\n",
        ),
        "src/client/components/SvelteMultiComment.svelte",
      );

      expect(violations).toEqual([]);
    });

    it("flags a bundle hex in live .svelte markup/script (positive control)", () => {
      // Bundle-blocklisted hex outside any comment is real, both in an inline
      // style attribute (CSS context) and in a script string literal.
      const violations = checkContent(
        [
          `<script lang="ts">`,
          `  const c = "#f57018";`,
          `</script>`,
          `<div style="color: #c96442;">live</div>`,
        ].join("\n"),
        "src/client/components/SvelteLive.svelte",
      );

      expect(violations).toEqual([
        "src/client/components/SvelteLive.svelte:2: #f57018 [bundle-blocklist]",
        "src/client/components/SvelteLive.svelte:4: #c96442",
      ]);
    });
  });
  describe("issue references vs colors (#1534)", () => {
    it("does not flag the reported repro: a 4-digit issue ref in a live log string", () => {
      // Verbatim from commit 2147224a (the fix for #1364), whose author had to
      // drop the issue number to get past the gate. `forced-colors` satisfies
      // the line-level CSS-keyword heuristic; `#1364` is a valid `#RGBA`.
      // Note the `#` is preceded by `(` — the issue's own suggested "value
      // position means preceded by `:`, `,`, `(` or whitespace" rule would NOT
      // have fixed this line, which is why the rule is written differently.
      const violations = checkContent(
        `  console.warn("[useTauriTheme] forced-colors unlisten failed (#1364):", e);\n`,
        "src/client/hooks/useTauriTheme.ts",
      );

      expect(violations).toEqual([]);
    });

    it("does not flag issue refs in live strings across the other keyword shapes", () => {
      const violations = checkContent(
        [
          `  throw new Error("border sync failed, see #1364");`,
          `  logger.info(\`background reload #798 done\`);`,
          `  console.warn("styles reset (#1123)");`,
          `  toast(\`fill retry #649\`);`,
        ].join("\n"),
        "src/client/utils/log.ts",
      );

      expect(violations).toEqual([]);
    });

    it("does not flag a 5- or 7-digit run, which is not a valid CSS color length", () => {
      // For when the repo passes issue #10000. `normalizeHexForBlocklist`
      // already treats 5/7-digit bodies as out of scope; this aligns the
      // CSS-keyword pass with it.
      const violations = checkContent(
        `  color: #12345;\n  background: #1234567;\n`,
        "src/client/components/Length.css",
      );

      expect(violations).toEqual([]);
    });

    // --- POSITIVE CONTROLS -------------------------------------------------
    // The gate exists to keep raw hex out of src/client/**. A narrowing that
    // lets a real color through is far worse than the false positive it fixes,
    // so every color-value position gets an explicit test.

    it("still flags an all-digit gray in a CSS declaration (positive control)", () => {
      const violations = checkContent(
        `<style>\n  .x { color: #333333; }\n</style>\n`,
        "src/client/components/Gray.svelte",
      );

      expect(violations).toEqual(["src/client/components/Gray.svelte:2: #333333"]);
    });

    it("still flags an all-digit gray that is a whole string literal (positive control)", () => {
      const violations = checkContent(
        [
          `const borderGrey = "#333";`,
          `const borderInk = '#000';`,
          "const borderTpl = `#111`;",
        ].join("\n"),
        "src/client/utils/palette.ts",
      );

      expect(violations).toEqual([
        "src/client/utils/palette.ts:1: #333",
        "src/client/utils/palette.ts:2: #000",
        "src/client/utils/palette.ts:3: #111",
      ]);
    });

    it("still flags all-digit grays in every other color-value position (positive control)", () => {
      const violations = checkContent(
        [
          `  border: 1px solid #333;`,
          `  background: linear-gradient(#333, #444);`,
          `  <span style="border-color:#333">x</span>`,
          `  <svg fill=#000 />`,
          `  const p = { borderColor: "#333", fill: "#000" };`,
          `  --tandem-border: #333;`,
          // The counterexample that keeps the declaration rule loose: the
          // governing property here is `box-shadow`, which carries none of the
          // CSS keywords. A rule that demanded a color-ish property name would
          // drop this real color.
          `  <div class="border-box" style="box-shadow: 0 0 1px #333">x</div>`,
        ].join("\n"),
        "src/client/components/Positions.svelte",
      );

      expect(violations).toEqual([
        "src/client/components/Positions.svelte:1: #333",
        "src/client/components/Positions.svelte:2: #333",
        "src/client/components/Positions.svelte:2: #444",
        "src/client/components/Positions.svelte:3: #333",
        "src/client/components/Positions.svelte:4: #000",
        "src/client/components/Positions.svelte:5: #333",
        "src/client/components/Positions.svelte:5: #000",
        "src/client/components/Positions.svelte:6: #333",
        "src/client/components/Positions.svelte:7: #333",
      ]);
    });

    it("still flags any hex carrying an a-f character, wherever it sits (positive control)", () => {
      // The narrowing can only ever fire on an all-decimal-digit body, so a hex
      // with letters keeps the previous behavior exactly — including in the
      // prose position that an issue reference would be forgiven in.
      const violations = checkContent(
        [
          `  console.warn("border sync failed #1a2b");`,
          `  color: #0f0;`,
          `  background: #abc123;`,
          `  border-color: #ff00aa80;`,
        ].join("\n"),
        "src/client/components/Letters.svelte",
      );

      expect(violations).toEqual([
        "src/client/components/Letters.svelte:1: #1a2b",
        "src/client/components/Letters.svelte:2: #0f0",
        "src/client/components/Letters.svelte:3: #abc123",
        "src/client/components/Letters.svelte:4: #ff00aa80",
      ]);
    });

    it("still flags `#3333` when it sits in a declaration value (positive control)", () => {
      // `#3333` is both a valid `#RGBA` gray and issue-reference shaped. In a
      // value position the color reading wins.
      const violations = checkContent(`  border-color: #3333;\n`, "src/client/components/Rgba.css");

      expect(violations).toEqual(["src/client/components/Rgba.css:1: #3333"]);
    });

    it("leaves the #799 bundle blocklist untouched for its all-digit entries", () => {
      // The narrowing is scoped to the CSS-keyword pass. The blocklist matches
      // on exact value, which is strong evidence regardless of position, so
      // `#222222`/`#666666`/`#999999` must still be caught in bare prose.
      expect(BUNDLE_BLOCKLIST_HEX.has("#222222")).toBe(true);
      const violations = checkContent(
        `  console.warn("border drift #222222 and #666666");\n`,
        "src/client/components/BundleProse.ts",
      );

      expect(violations).toEqual([
        "src/client/components/BundleProse.ts:1: #222222 [bundle-blocklist]",
        "src/client/components/BundleProse.ts:1: #666666 [bundle-blocklist]",
      ]);
    });

    it("leaves the rgba, border-radius and box-shadow passes untouched", () => {
      const violations = checkContent(
        [
          `  background: rgba(99, 102, 241, 0.5);`,
          `<div style="border-radius: 6px"></div>`,
          `<div style="box-shadow: 0 4px 12px rgba(99, 102, 241, 0.12);"></div>`,
        ].join("\n"),
        "src/client/components/OtherPasses.svelte",
      );

      expect(violations).toEqual([
        "src/client/components/OtherPasses.svelte:1: rgba(",
        "src/client/components/OtherPasses.svelte:2: border-radius: 6px",
        "src/client/components/OtherPasses.svelte:3: rgba(",
        "src/client/components/OtherPasses.svelte:3: box-shadow: 0 4px 12px rgba(",
      ]);
    });

    // --- REGRESSION CONTROLS: hex that is NOT the first token of its value ---
    // The first cut of this narrowing recognized only three positions, and all
    // three assume the hex begins the value. Every shape below is a real raw
    // color that the pre-#1534 scanner reported and that cut let through — a
    // silent hole in the gate, which is strictly worse than the false positive
    // being fixed. `CSS_VALUE_TAIL_RE` is what closes them; each is pinned so a
    // future simplification of that regex goes red instead of quiet.

    it("still flags a hex after a length token in a JS style assignment", () => {
      const violations = checkContent(
        [
          `  el.style.boxShadow = "0 0 0 1px #333";`,
          `  el.style.border = "1px solid #333";`,
          "  el.style.boxShadow = `0 0 0 ${w}px #333`;",
        ].join("\n"),
        "src/client/utils/paint.ts",
      );

      expect(violations).toEqual([
        "src/client/utils/paint.ts:1: #333",
        "src/client/utils/paint.ts:2: #333",
        "src/client/utils/paint.ts:3: #333",
      ]);
    });

    it("still flags a hex whose property colon is hidden behind an interpolation", () => {
      // The nastiest shape. `cut` takes the LAST of `;`/`{`/`}` before the hex,
      // so a Svelte `{expr}` or a JS `${expr}` inside a style value puts a `}`
      // between the property colon and the hex — the declaration walk-back
      // never sees `border:` at all. The `}`-with-optional-unit branch of
      // `CSS_VALUE_TAIL_RE` is the only thing catching these.
      const violations = checkContent(
        [
          `  <div style="border: {w}px solid #333">x</div>`,
          `  <div style="box-shadow: 0 0 {r}px #333">x</div>`,
          "  <div style:box-shadow={`0 0 ${w}px #333`}>x</div>",
        ].join("\n"),
        "src/client/components/Interp.svelte",
      );

      expect(violations).toEqual([
        "src/client/components/Interp.svelte:1: #333",
        "src/client/components/Interp.svelte:2: #333",
        "src/client/components/Interp.svelte:3: #333",
      ]);
    });

    it("still flags a hex in a multi-token rule held in a plain variable", () => {
      // No `=`-adjacency (the string opens first), no whole-string-literal
      // match (the literal holds more than the hex), and for the first line no
      // colon anywhere on it.
      const violations = checkContent(
        [`  const borderRule = "1px solid #333";`, "  const s = `border: ${w}px solid #333`;"].join(
          "\n",
        ),
        "src/client/utils/rules.ts",
      );

      expect(violations).toEqual([
        "src/client/utils/rules.ts:1: #333",
        "src/client/utils/rules.ts:2: #333",
      ]);
    });

    it("still flags a hex inside a CSS color function, but not one in prose", () => {
      // `isInsideCssColorFunction` names its callees explicitly. The generic
      // "any identifier before a `(`" form gets line 4 wrong, and a rule keyed
      // on the paren being adjacent to the hex gets line 3 wrong — the hex is
      // the second argument there, and `color-mix` is how a themed color that
      // should have been a token most often gets written by hand.
      const violations = checkContent(
        [
          `  background: linear-gradient(#333, #444);`,
          `  const borderGrad = "linear-gradient(#333, #444)";`,
          `  ctx.fillStyle = "color-mix(in srgb, #333 50%, white)";`,
          `  console.warn("border sync failed (#1364)");`,
          // Nesting: the scan must take the INNERMOST still-open paren. Taking
          // the outermost reads the wrapper call's name and misses this.
          `  el.style.background = withFallback("linear-gradient(#333, #444)");`,
          // A CLOSED color-function call earlier on the line must not govern
          // prose after it — the depth counter has to pop on `)`.
          `  console.warn("linear-gradient(a,b) mismatch for border #1364");`,
          // The list is case-insensitive but closed: an unlisted callee leaves
          // the argument reading as prose.
          `  logBorder(REPORTED, "#1364 regressed");`,
        ].join("\n"),
        "src/client/components/Paren.svelte",
      );

      expect(violations).toEqual([
        "src/client/components/Paren.svelte:1: #333",
        "src/client/components/Paren.svelte:1: #444",
        "src/client/components/Paren.svelte:2: #333",
        "src/client/components/Paren.svelte:2: #444",
        "src/client/components/Paren.svelte:3: #333",
        "src/client/components/Paren.svelte:5: #333",
        "src/client/components/Paren.svelte:5: #444",
      ]);
    });

    it("still flags a hex after a border-style keyword with no length in front", () => {
      const violations = checkContent(
        [
          `  const borderA = "solid #333";`,
          `  const borderB = "dashed #444";`,
          `  const borderC = "inset #555";`,
        ].join("\n"),
        "src/client/utils/keywords.ts",
      );

      expect(violations).toEqual([
        "src/client/utils/keywords.ts:1: #333",
        "src/client/utils/keywords.ts:2: #444",
        "src/client/utils/keywords.ts:3: #555",
      ]);
    });

    it("keeps the length guard and the position guard on all-digit bodies only", () => {
      // A 5- or 7-digit run carrying an `a`-`f` is not a valid CSS color
      // either, but it IS the shape of a typo'd one, so it must still report —
      // that is what gating BOTH narrowings on all-digit-ness buys. Without
      // the gate this line scans clean and a mistyped color ships.
      const violations = checkContent(
        [`  color: #abcdef1;`, `  background: #12a45;`, `  border-color: #12345;`].join("\n"),
        "src/client/components/Typos.css",
      );

      expect(violations).toEqual([
        "src/client/components/Typos.css:1: #abcdef1",
        "src/client/components/Typos.css:2: #12a45",
      ]);
    });

    // --- helper-level units ------------------------------------------------

    it("recognizes each color-value position in isolation", () => {
      // One case per branch, each chosen so that ONLY that branch can satisfy
      // it. The previous version of this test asserted "three positions and
      // nothing else" while the code had more than three, and its declaration
      // case was satisfied by a different branch before the declaration
      // walk-back was ever reached — so it isolated nothing.

      // Declaration walk-back, in raw CSS. No literal, no `=`, no function.
      const decl = `  border: 1px solid #333;`;
      expect(isColorValuePosition(decl, decl.indexOf("#333"), "#333")).toBe(true);

      // Whole string literal.
      const lit = `const c = "#333";`;
      expect(isColorValuePosition(lit, lit.indexOf("#333"), "#333")).toBe(true);

      // Bare (unquoted) attribute.
      const attr = `<svg fill=#333 />`;
      expect(isColorValuePosition(attr, attr.indexOf("#333"), "#333")).toBe(true);

      // Governed literal: the governor is what decides, and the content alone
      // would not — `unset` is a value word but `thing` is not.
      const governed = `el.style.background = "thing 0 0 #333";`;
      expect(isColorValuePosition(governed, governed.indexOf("#333"), "#333")).toBe(true);

      // Self-evident literal: no governor (`const x =` is not one), decided
      // purely by its own words.
      const selfEvident = `const x = "1px solid #333";`;
      expect(isColorValuePosition(selfEvident, selfEvident.indexOf("#333"), "#333")).toBe(true);

      // Color-function argument inside an ungoverned, non-value-word literal.
      const fn = `const g = wrap("linear-gradient(#333, transparent)");`;
      expect(isColorValuePosition(fn, fn.indexOf("#333"), "#333")).toBe(true);

      // Prose inside a string literal: none of the above.
      const prose = `console.warn("forced-colors failed (#1364):", e);`;
      expect(isColorValuePosition(prose, prose.indexOf("#1364"), "#1364")).toBe(false);

      // A partial literal is not a whole-string-literal match, and `#333 wat`
      // is not a value string either.
      const partial = `const c = "#333 wat";`;
      expect(isColorValuePosition(partial, partial.indexOf("#333"), "#333")).toBe(false);
    });

    it("decides a string literal as a WHOLE, so prose stays prose throughout", () => {
      // The organising rule of the rewrite, and the one that resolves the two
      // findings at once. A per-TOKEN test cannot: the shape that makes the
      // first line a color (a length immediately before the hex) is present in
      // the second line too, and the second line is an issue reference.
      const color = `el.style.boxShadow = "0 0 4px 0 #333";`;
      expect(isColorValuePosition(color, color.indexOf("#333"), "#333")).toBe(true);

      const notColor = `console.log("border shifted 4px #1364");`;
      expect(isColorValuePosition(notColor, notColor.indexOf("#1364"), "#1364")).toBe(false);

      // Same for an interpolation brace, which the old value-tail regex read as
      // CSS syntax wherever it appeared.
      const interp = "console.warn(`style ${name} #1364`);";
      expect(isColorValuePosition(interp, interp.indexOf("#1364"), "#1364")).toBe(false);
    });

    it("requires a color function to CLOSE inside its own literal", () => {
      // Otherwise an unbalanced bracket in a sentence swallows the rest of the
      // line: `rgba(` here is punctuation, not a call. This is the only thing
      // separating the two.
      const real = `const g = wrap("linear-gradient(#333, #444)");`;
      expect(isColorValuePosition(real, real.indexOf("#333"), "#333")).toBe(true);

      const sentence = `console.warn("border rgba( parse fail #1364");`;
      expect(isColorValuePosition(sentence, sentence.indexOf("#1364"), "#1364")).toBe(false);

      // A call that closes BEFORE the hex must not govern what follows it.
      const closed = `console.warn("linear-gradient(a,b) mismatch for border #1364");`;
      expect(isColorValuePosition(closed, closed.indexOf("#1364"), "#1364")).toBe(false);
    });

    it("takes the INNERMOST still-open paren, and pops on every close", () => {
      // The paren walk has two independent halves and each fails silently.
      // Reaching it at all takes care: an ungoverned literal whose words are
      // ALL value words is decided by `looksLikeCssValueString` first, so every
      // fixture here carries a non-value word (`zzz`, `wat`) to get past that
      // arm. Both mutations below were green until these cases existed.

      // INNERMOST: the wrapper call is not a color function, the inner one is.
      // Taking the outermost open paren reads `wrap` and misses the gradient.
      const nested = `const g = note("zzz wrap(linear-gradient(#333, transparent))");`;
      expect(isColorValuePosition(nested, nested.indexOf("#333"), "#333")).toBe(true);

      // POP ON CLOSE: `rgb(…)` is a color function but it CLOSED before the
      // hex, so nothing is open at the hex and this is prose. Without the pop
      // the spent `rgb(` stays registered and governs the issue reference.
      // The trailing `)` is deliberate — it is what lets the must-close check
      // pass, which is the only way the missing pop can show itself.
      const spent = `const s = note("rgb(1,2,3) and border #1364)");`;
      expect(isColorValuePosition(spent, spent.indexOf("#1364"), "#1364")).toBe(false);

      // Same pair in code rather than in a literal — the two call sites of the
      // walk must agree.
      const spentCode = `  .x { width: calc(1px * 2); } note(border #1364)`;
      expect(isColorValuePosition(spentCode, spentCode.indexOf("#1364"), "#1364")).toBe(false);
    });

    it("anchors the in-literal property name at a word boundary", () => {
      // `CSS_PROPERTY_COLON_RE` looks for a CSS-ish property name before a
      // colon. Unanchored, it finds those names INSIDE longer words, which is
      // the same substring trap that produced #1534 one level up — `styles`,
      // `borderline` and `forced-colors` are all real strings in this codebase.
      const embedded = `  console.warn("[theme] recolor: #1364 pending");`;
      expect(isColorValuePosition(embedded, embedded.indexOf("#1364"), "#1364")).toBe(false);

      // A name that legitimately STARTS with a property word still counts —
      // the anchor is at the start, not at both ends, so `border-color` and
      // `borderColor` keep working.
      const real = "  const s = `border-color: #1364;`;";
      expect(isColorValuePosition(real, real.indexOf("#1364"), "#1364")).toBe(true);
    });

    it("does not read a plain assignment as a bare attribute", () => {
      // The bare-attribute arm exists for `<svg fill=#333>`. Written as the
      // loose `/=\s*$/` it also fires on the token after ANY `=`, which is how
      // a hex opening an ungoverned string used to scan as a color — and,
      // worse, how the arm silently substitutes for the literal machinery.
      const attr = `<svg fill=#333 />`;
      expect(isColorValuePosition(attr, attr.indexOf("#333"), "#333")).toBe(true);

      // No identifier before the `=`, and prose after it: not an attribute.
      const notAttr = `  const n = counts[i] == #1364 ? a : b;`;
      expect(isColorValuePosition(notAttr, notAttr.indexOf("#1364"), "#1364")).toBe(false);

      // The shape the loose form got wrong: an ungoverned literal whose FIRST
      // token is the hex is decided by the literal rules, not by the `=`.
      // `#1364 wat` is neither a whole literal nor a value string.
      const opener = "const msg = `#1364 wat, border`;";
      expect(isColorValuePosition(opener, opener.indexOf("#1364"), "#1364")).toBe(false);
    });

    it("keeps CSS property names out of the value-word list", () => {
      // The discriminator `looksLikeCssValueString` rests on: prose about CSS
      // names the PROPERTY, a real value never does. Adding `border` or
      // `color` to CSS_VALUE_WORDS to "be more complete" re-opens #1534, so
      // both directions are pinned here.
      expect(looksLikeCssValueString("1px solid #333")).toBe(true);
      expect(looksLikeCssValueString("0 0 0 #333")).toBe(true);
      expect(looksLikeCssValueString("-webkit-linear-gradient(#333, #444)")).toBe(true);
      expect(looksLikeCssValueString("no-repeat center #333")).toBe(true);

      expect(looksLikeCssValueString("border shifted 4px #1364")).toBe(false);
      expect(looksLikeCssValueString("color hidden #1364")).toBe(false);
      expect(looksLikeCssValueString("background transparent #1364")).toBe(false);
      expect(looksLikeCssValueString("styles off by 2rem #1364")).toBe(false);

      // Directly: each property name must be ABSENT from the value-word list.
      // Adding any one of them makes a prose line above pass.
      for (const property of ["border", "color", "background", "fill", "stroke", "style"]) {
        expect(looksLikeCssValueString(`${property} #1364`)).toBe(false);
      }
    });

    it("tracks string-literal boundaries the way the host language does", () => {
      const spansOf = (line: string) => scanStringLiterals(line, null).spans;
      const quoteAt = (line: string, needle: string) => {
        const at = line.indexOf(needle);
        const sp = spansOf(line)
          .filter((s) => s.start < at && at < s.end)
          .reduce<{ start: number; end: number } | undefined>(
            (best, s) => (!best || s.start > best.start ? s : best),
            undefined,
          );
        return sp === undefined ? null : line[sp.start];
      };

      // Only the quote that opened a literal can close it.
      expect(quoteAt(`console.warn("don't touch the border #1364");`, "#1364")).toBe('"');
      expect(quoteAt('console.warn(`he said "border" #1364`);', "#1364")).toBe("`");
      expect(quoteAt(`console.warn("a \\" border #1364");`, "#1364")).toBe('"');

      // Closed literal: the hex is in code, not in a string.
      expect(quoteAt(`  const a = "x"; border-color: #1364;`, "#1364")).toBeNull();

      // A nested literal inside `${…}` is its own literal, and the INNERMOST
      // one is the one that governs. Reading the inner backtick as closing the
      // outer template puts the hex in code and loses it entirely.
      const nested = "el.style.cssText = `border: ${d ? `1px solid #333` : `none`}`;";
      expect(quoteAt(nested, "#333")).toBe("`");
      expect(isColorValuePosition(nested, nested.indexOf("#333"), "#333")).toBe(true);

      // And the INNERMOST span is the one that decides. Here the outer literal
      // is prose and the inner one is a CSS value, so reading the outer loses a
      // real color; the reverse nesting would report an issue reference.
      const innerValue = "console.warn(`saw ${`1px solid #333`} applied to border`);";
      expect(isColorValuePosition(innerValue, innerValue.indexOf("#333"), "#333")).toBe(true);
    });

    it("carries a multi-line literal across the line break, both directions", () => {
      // The per-literal decision has to survive a newline or continuation lines
      // silently fall back to the per-token walk-back this design replaced.
      // Both of these shapes exist: `CommandPalette.svelte` wraps six `style="…"`
      // attributes, and multi-line template literals are ordinary TS.
      expect(
        checkContent(
          [
            "<div",
            '  style="',
            "    background: linear-gradient(",
            "      var(--tandem-border) 0%, #333 100%);",
            '  "',
            ">",
            "",
          ].join("\n"),
          "src/client/components/Wrapped.svelte",
        ),
      ).toEqual(["src/client/components/Wrapped.svelte:4: #333"]);

      expect(
        checkContent(
          "el.style.background = `linear-gradient(\n  #333 0%, var(--tandem-border) 100%)`;\n",
          "src/client/utils/grad.ts",
        ),
      ).toEqual(["src/client/utils/grad.ts:2: #333"]);

      // And the other direction: prose in a multi-line template stays prose.
      expect(
        checkContent(
          "console.warn(`\n  the border broke: see #1364\n`);\n",
          "src/client/utils/log.ts",
        ),
      ).toEqual([]);
    });

    it("keeps the accumulated literal text, not just the current line", () => {
      // The declaration that makes this literal a CSS value (`border:`) is on
      // line 1; the hex is on line 2. Judge line 2 in isolation and the content
      // is `${borderWidth}px solid #333` — it opens with no declaration, and
      // `borderWidth` is not a value word, so the whole-literal arm says no and
      // the color is lost. Only the carried text reaches the declaration.
      //
      // The interpolated identifier is doing double duty on purpose: the line
      // gate (`hasCssIndicator`) is a per-LINE substring test, so line 2 has to
      // carry one of the six keywords itself or the hex is never even a
      // candidate. `borderWidth` supplies `border` to the gate while staying a
      // non-value word for the predicate under test.
      expect(
        checkContent(
          "const s = `border:\n  ${borderWidth}px solid #333`;\n",
          "src/client/utils/rules.ts",
        ),
      ).toEqual(["src/client/utils/rules.ts:2: #333"]);
    });

    it("opens a literal on a single quote too", () => {
      // The fast path that skips quote-free lines has to know about all three
      // quote characters. Missing one means those literals never open, and the
      // hex silently falls through to the code walk-back — which answers
      // differently: `mismatch:` reads as a property colon there.
      expect(
        checkContent(`  console.warn('border mismatch: #1364');\n`, "src/client/utils/log.ts"),
      ).toEqual([]);

      // And a real color in a single-quoted attribute still reports.
      expect(
        checkContent(`  <div style='color: #333'>x</div>\n`, "src/client/components/S.svelte"),
      ).toEqual(["src/client/components/S.svelte:1: #333"]);
    });

    it("carries ONLY a template or an attribute value across a line break", () => {
      // 103 lines in src/client end mid-`'`/mid-`"` from prose apostrophes
      // alone. Carrying those would poison every following line of the file, so
      // a literal continues only if it is a template or opened after `=`.
      const apostrophe = [
        "  <p>the document's border</p>",
        '  <span style="color: #333">x</span>',
        "",
      ].join("\n");
      expect(checkContent(apostrophe, "src/client/components/Prose.svelte")).toEqual([
        "src/client/components/Prose.svelte:2: #333",
      ]);
    });

    it("pins the governor arms that the value-word test would otherwise mask", () => {
      // Every fixture carries a non-value word (`thing`) so
      // `looksLikeCssValueString` CANNOT satisfy it — without that, each of
      // these arms could be deleted with the suite still green, which is the
      // isolation failure the previous version of this file's positions test
      // was written to warn about and then committed anyway.
      const arms: [string, string][] = [
        [".style.* assignment", `el.style.cssText = "thing 0 0 #333";`],
        [".setProperty", `el.style.setProperty("--border", "thing 0 0 #333");`],
        ["css-in-js tag", "const s = css`thing 0 0 #333; border: 0`;"],
        ["object property", `const s = { borderColor: "thing 0 0 #333" };`],
        ["camelCase property", `const s = { boxShadow: "thing 0 0 #333", border: 1 };`],
      ];
      for (const [name, line] of arms) {
        expect([name, isColorValuePosition(line, line.indexOf("#333"), "#333")]).toEqual([
          name,
          true,
        ]);
      }

      // The object arm is restricted to CSS-ish names. src/client holds 121
      // `label: "…"` shapes; the loose form reported an issue reference in one.
      const label = `    label: "Toggle authorship colors (#1364)",`;
      expect(isColorValuePosition(label, label.indexOf("#1364"), "#1364")).toBe(false);
      expect(isCssPropertyName("borderColor")).toBe(true);
      expect(isCssPropertyName("boxShadow")).toBe(true);
      expect(isCssPropertyName("box-shadow")).toBe(true);
      expect(isCssPropertyName("label")).toBe(false);
      expect(isCssPropertyName("message")).toBe(false);
    });

    it("keeps the whole-literal arm as the fallback when quote parity breaks", () => {
      // This arm is the only one that does not need the literal to be
      // resolvable, and that is its whole remaining job: a regex literal
      // containing a quote desynchronises the scan, and every other arm then
      // fails to see a hex that is plainly a color.
      const desync = `const RE = /['"]/; el.style.color = "#333";`;
      expect(isColorValuePosition(desync, desync.indexOf("#333"), "#333")).toBe(true);
    });

    it("anchors the in-literal declaration to the START of the literal", () => {
      // Unanchored, a CSS-ish word plus a colon ANYWHERE before the hex counted,
      // so ordinary log punctuation read as CSS.
      for (const line of [
        `  console.warn("border ok. shadow: see #1364");`,
        `  console.warn("styles: regressed in #1364, border");`,
        `  console.warn("border ok, accent: regressed in #1364");`,
      ]) {
        expect([line, isColorValuePosition(line, line.indexOf("#1364"), "#1364")]).toEqual([
          line,
          false,
        ]);
      }

      // A real declaration still counts, in both spellings.
      const decl = "  const s = `border-color: ${w}px solid #333`;";
      expect(isColorValuePosition(decl, decl.indexOf("#333"), "#333")).toBe(true);
    });

    it("keeps border widths and filter functions as CSS values", () => {
      // Real values master caught that a word list must not lose.
      expect(looksLikeCssValueString("thin solid #333")).toBe(true);
      expect(looksLikeCssValueString("medium solid #333")).toBe(true);
      expect(looksLikeCssValueString("drop-shadow(0 0 2px #333)")).toBe(true);

      // `shadow` is a hyphen PART only: `box-shadow` names a property, so prose
      // about it must still fail even though `drop-shadow` passes.
      expect(looksLikeCssValueString("box-shadow #1364")).toBe(false);
      expect(looksLikeCssValueString("shadow #1364")).toBe(false);
    });

    it("needs the vendor-prefix strip on the color-function callee too", () => {
      // Reaching the function arm needs a non-value word, or the value-word arm
      // answers first and the strip looks unnecessary.
      const prefixed = `const g = note("thing -webkit-linear-gradient(#333, #444)");`;
      expect(isColorValuePosition(prefixed, prefixed.indexOf("#333"), "#333")).toBe(true);
    });

    it("needs `color` as a hyphen part for color-mix outside the parens", () => {
      // Inside the parens the function arm would rescue it; outside, only the
      // value-word test can, and that needs `color-mix` to parse as a value word.
      const mix = `const g = "color-mix(in srgb, red 50%, white) #333";`;
      expect(isColorValuePosition(mix, mix.indexOf("#333"), "#333")).toBe(true);
    });

    it("only ever treats an all-decimal-digit token as an issue reference", () => {
      const withLetters = `console.warn("border failed #1a2b");`;
      expect(isLikelyIssueReference(withLetters, withLetters.indexOf("#1a2b"), "#1a2b")).toBe(
        false,
      );

      const digits = `console.warn("border failed #1364");`;
      expect(isLikelyIssueReference(digits, digits.indexOf("#1364"), "#1364")).toBe(true);

      // Same token, value position -> color wins.
      const valued = `  border-color: #1364;`;
      expect(isLikelyIssueReference(valued, valued.indexOf("#1364"), "#1364")).toBe(false);
    });

    it("scopes the declaration walk-back to the innermost `;`/`{`/`}` segment", () => {
      // `cut` and `PROPERTY_COLON_RE` are the load-bearing pair of the
      // declaration branch and nothing else pins them directly. A colon in an
      // EARLIER declaration must not license a later prose token, and a colon
      // in the SAME segment must license the value after it.
      const earlier = `  .x { color: red; } console.warn("border ok #1364");`;
      expect(isColorValuePosition(earlier, earlier.indexOf("#1364"), "#1364")).toBe(false);

      const same = `  .x { color: red; border-color: #1364; }`;
      expect(isColorValuePosition(same, same.indexOf("#1364"), "#1364")).toBe(true);

      // Any identifier before the colon counts, deliberately — see the
      // `box-shadow` counterexample above. A bare `:` with no identifier does
      // not, so a ternary or a URL does not turn prose into a value position.
      const ternary = `  const s = ok ? "a" : "border #1364";`;
      expect(isColorValuePosition(ternary, ternary.indexOf("#1364"), "#1364")).toBe(false);
    });

    it("offers the issue-reference Note for a 4-digit token only", () => {
      // A reported all-digit token of length 3, 6 or 8 is a gray, and telling
      // its author to "drop the `#`" yields `color: 000000`. Five- and
      // seven-digit runs never reach the output. Four is what is left.
      expect(buildErrorGuidance(["src/client/a.css:1: #1364"])).toContain("issue reference");
      for (const gray of ["#000", "#333333", "#00000000"]) {
        expect(buildErrorGuidance([`src/client/a.css:1: ${gray}`])).not.toContain(
          "issue reference",
        );
      }
      // A bundle-blocklist suffix must not defeat the match for a real 4-digit
      // token, nor create one for a 6-digit entry.
      expect(buildErrorGuidance(["src/client/a.css:1: #222222 [bundle-blocklist]"])).not.toContain(
        "issue reference",
      );
    });

    it("retires the prose-colon residual, and keeps the narrowed one", () => {
      // The first cut at #1534 accepted this line as a residual: `mismatch:`
      // read as a property colon, so a log message reported as a raw color.
      // Deciding per-literal retires it — the declaration walk-back is not
      // consulted for text inside a string at all.
      expect(
        checkContent(
          `  console.warn("[theme] border mismatch: #1364");\n`,
          "src/client/utils/log.ts",
        ),
      ).toEqual([]);

      // What replaces it is strictly narrower: inside a literal the property
      // name itself must be CSS-ish. A sentence that genuinely opens with one
      // still reports, and that is the same shape the raw-CSS walk-back
      // accepts, so the two agree rather than disagreeing.
      expect(
        checkContent(
          `  console.warn("background: still wrong, see #1364");\n`,
          "src/client/utils/log.ts",
        ),
      ).toEqual(["src/client/utils/log.ts:1: #1364"]);

      // And the CSS-ish name is what carries a real declaration held in a
      // template literal, which is why the arm exists.
      expect(
        checkContent("  const s = `border: ${w}px solid #333`;\n", "src/client/utils/rules.ts"),
      ).toEqual(["src/client/utils/rules.ts:1: #333"]);
    });

    it("prints an unconditional Fix: line, and the issue-reference Note only when apt", () => {
      // The confusing half of #1534: the pre-commit path printed a bare count
      // and no remedy at all.
      const colorOnly = buildErrorGuidance(["src/client/a.svelte:2: #abc123"]);
      expect(colorOnly).toContain("Fix: use a semantic var(--tandem-*) token");
      expect(colorOnly).not.toContain("issue reference");

      const digitToken = buildErrorGuidance(["src/client/utils/log.ts:1: #1364"]);
      expect(digitToken).toContain("Fix: use a semantic var(--tandem-*) token");
      expect(digitToken).toContain("may be an issue reference rather than a color");
      expect(digitToken).toContain("move the reference into a comment or drop the `#`");

      expect(buildErrorGuidance([])).not.toContain("issue reference");
    });
  });
});
