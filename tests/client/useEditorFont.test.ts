import { afterEach, describe, expect, it } from "vitest";
import { applyEditorFont, applyEditorFontToRoot } from "../../src/client/hooks/useEditorFont.js";

describe("applyEditorFont (scoped)", () => {
  it("sets the font family on the given element and returns cleanup", () => {
    const el = document.createElement("div");
    const cleanup = applyEditorFont("serif", el);
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).toContain("Georgia");
    cleanup();
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).toBe("");
  });

  it("applies each font variant", () => {
    const el = document.createElement("div");
    applyEditorFont("sans", el);
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).toContain("Roboto");

    applyEditorFont("mono", el);
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).toContain("JetBrains Mono");
  });
});

describe("applyEditorFontToRoot", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--tandem-editor-font-family");
  });

  it("sets the font family on document.documentElement and returns cleanup", () => {
    const cleanup = applyEditorFontToRoot("serif");
    expect(
      document.documentElement.style.getPropertyValue("--tandem-editor-font-family"),
    ).toContain("Georgia");
    cleanup();
    expect(document.documentElement.style.getPropertyValue("--tandem-editor-font-family")).toBe("");
  });

  it("applies sans and mono variants to root", () => {
    applyEditorFontToRoot("sans");
    expect(
      document.documentElement.style.getPropertyValue("--tandem-editor-font-family"),
    ).toContain("Roboto");

    applyEditorFontToRoot("mono");
    expect(
      document.documentElement.style.getPropertyValue("--tandem-editor-font-family"),
    ).toContain("JetBrains Mono");
  });
});
