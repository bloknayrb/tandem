import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledCssFiles, cssRulesBySelector, styleBlocks } from "../helpers/css-source";

/**
 * Document headings must inherit the user's editor font from `.tandem-editor`,
 * so no rule targeting a document heading may name a family (or re-point the
 * editor-font token): H1/H2 once used the serif `--tandem-h1-font` /
 * `--tandem-h2-font` roles, so choosing Sans left them serif.
 *
 * Scans every CSS source — bundled `.css`/`.svelte` under src/client and
 * index.html's inline `<style>` — and matches on `fullSelectors`, so a nested
 * rule or a variant like `.tandem-editor > h1`, `.ProseMirror h2.x` or
 * `:is(h1, h2)` is checked too. A rule whose TARGET is something inside a
 * heading (`.tandem-editor h1:hover .tandem-heading-chevron`) is not a heading
 * rule. The positive control keeps the scan from passing over an empty set.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SOURCES = [...bundledCssFiles(join(ROOT, "src", "client")), join(ROOT, "index.html")];

const EDITOR_SCOPE = /\.tandem-editor\b|\.ProseMirror\b/;
const HEADING_TYPE = /(^|[^\w-])h[1-6](?![\w-])/;

/** The last compound selector — what the rule actually styles. */
const target = (selector: string): string =>
  selector
    .replace(/\(\s*([^)]*?)\s*\)/g, (_, inner: string) => `(${inner.replace(/\s*,\s*/g, ",")})`)
    .trim()
    .split(/\s*[>+~]\s*|\s+/)
    .pop() ?? "";

const isEditorHeading = (selector: string): boolean =>
  EDITOR_SCOPE.test(selector) && HEADING_TYPE.test(target(selector));

const FAMILY_DECL = /^(font(-family)?|--tandem-editor-font-family)\s*:/;

const headingRules = SOURCES.flatMap((file) =>
  cssRulesBySelector(styleBlocks(file))
    .filter((r) => r.fullSelectors.some(isEditorHeading))
    .map((r) => ({ file, ...r })),
);

describe("editor headings use the user's editor font", () => {
  it("finds the .tandem-editor h1 and h2 rules (positive control)", () => {
    const selectors = headingRules.flatMap((r) => r.fullSelectors);
    expect(selectors).toContain(".tandem-editor h1");
    expect(selectors).toContain(".tandem-editor h2");
  });

  it("matches heading variants and skips descendants of a heading", () => {
    expect(isEditorHeading(".tandem-editor > h1")).toBe(true);
    expect(isEditorHeading(".ProseMirror h2.x")).toBe(true);
    expect(isEditorHeading(":global(.tandem-editor) :is(h1, h2)")).toBe(true);
    expect(isEditorHeading(".tandem-editor h1:hover .tandem-heading-chevron")).toBe(false);
    expect(isEditorHeading(".tandem-markdown h1")).toBe(false);
  });

  it("no document heading rule sets its own font family", () => {
    for (const r of headingRules) {
      const decl = r.body
        .split(";")
        .map((d) => d.trim())
        .find((d) => FAMILY_DECL.test(d));
      expect(decl, `${r.file}: ${r.fullSelectors.join(", ")}`).toBeUndefined();
    }
  });
});
