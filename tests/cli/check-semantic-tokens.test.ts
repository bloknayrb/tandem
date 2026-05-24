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
});
