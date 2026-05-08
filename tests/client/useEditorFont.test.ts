import { afterEach, describe, expect, it } from "vitest";
import { applyEditorFont, applyEditorFontToRoot } from "../../src/client/hooks/useEditorFont.js";

describe("applyEditorFont (scoped)", () => {
  it("sets the font family on the given element and returns cleanup", () => {
    const el = document.createElement("div");
    const cleanup = applyEditorFont("serif", el);
    const value = el.style.getPropertyValue("--tandem-editor-font-family");
    // Token var must be first so the design-system font resolves before platform fallbacks.
    expect(value).toMatch(/^var\(--tandem-font-serif\)/);
    expect(value).toContain("Georgia");
    cleanup();
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).toBe("");
  });

  it("applies each font variant with token prefix", () => {
    const el = document.createElement("div");

    applyEditorFont("sans", el);
    const sansValue = el.style.getPropertyValue("--tandem-editor-font-family");
    expect(sansValue).toMatch(/^var\(--tandem-font-sans\)/);
    expect(sansValue).toContain("Roboto");

    applyEditorFont("mono", el);
    const monoValue = el.style.getPropertyValue("--tandem-editor-font-family");
    expect(monoValue).toMatch(/^var\(--tandem-font-mono\)/);
    expect(monoValue).toContain("JetBrains Mono");
  });
});

describe("applyEditorFontToRoot", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--tandem-editor-font-family");
  });

  it("sets the font family on document.documentElement and returns cleanup", () => {
    const cleanup = applyEditorFontToRoot("serif");
    const value = document.documentElement.style.getPropertyValue("--tandem-editor-font-family");
    expect(value).toMatch(/^var\(--tandem-font-serif\)/);
    expect(value).toContain("Georgia");
    cleanup();
    expect(document.documentElement.style.getPropertyValue("--tandem-editor-font-family")).toBe("");
  });

  it("applies sans and mono variants to root with token prefix", () => {
    applyEditorFontToRoot("sans");
    const sansValue = document.documentElement.style.getPropertyValue(
      "--tandem-editor-font-family",
    );
    expect(sansValue).toMatch(/^var\(--tandem-font-sans\)/);
    expect(sansValue).toContain("Roboto");

    applyEditorFontToRoot("mono");
    const monoValue = document.documentElement.style.getPropertyValue(
      "--tandem-editor-font-family",
    );
    expect(monoValue).toMatch(/^var\(--tandem-font-mono\)/);
    expect(monoValue).toContain("JetBrains Mono");
  });
});
