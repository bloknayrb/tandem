import { describe, expect, it } from "vitest";
import {
  BUNDLE_BLOCKLIST_HEX,
  buildErrorGuidance,
  checkContent,
  isColorValuePosition,
  isLikelyIssueReference,
  normalizeHexForBlocklist,
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

    // --- helper-level units ------------------------------------------------

    it("recognizes the three color-value positions and nothing else", () => {
      const decl = `  border: 1px solid #333;`;
      expect(isColorValuePosition(decl, decl.indexOf("#333"), "#333")).toBe(true);

      const lit = `const c = "#333";`;
      expect(isColorValuePosition(lit, lit.indexOf("#333"), "#333")).toBe(true);

      const attr = `<svg fill=#333 />`;
      expect(isColorValuePosition(attr, attr.indexOf("#333"), "#333")).toBe(true);

      // Prose inside a string literal: not a value position.
      const prose = `console.warn("forced-colors failed (#1364):", e);`;
      expect(isColorValuePosition(prose, prose.indexOf("#1364"), "#1364")).toBe(false);

      // A partial literal is not a whole-string-literal match.
      const partial = `const c = "#333 solid";`;
      expect(isColorValuePosition(partial, partial.indexOf("#333"), "#333")).toBe(false);
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

    it("still reports a governing-colon issue ref (documented residual)", () => {
      // `mismatch:` reads as a property colon, so this one still reports. It is
      // why main() names the issue-reference possibility in its output rather
      // than only saying "raw hex color".
      const violations = checkContent(
        `  console.warn("[theme] border mismatch: #1364");\n`,
        "src/client/utils/log.ts",
      );

      expect(violations).toEqual(["src/client/utils/log.ts:1: #1364"]);
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
