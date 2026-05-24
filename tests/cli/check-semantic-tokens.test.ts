import { describe, expect, it } from "vitest";
import {
  BUNDLE_BLOCKLIST_HEX,
  checkContent,
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
});
