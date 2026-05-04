import { beforeEach, describe, expect, it } from "vitest";
import { applyEditorFont } from "../../src/client/hooks/useEditorFont";

/**
 * Minimal HTMLElement stub that tracks style custom properties, mirroring the
 * pattern in useTheme.test.ts (no DOM environment required).
 */
function makeEl() {
  const props = new Map<string, string>();
  return {
    style: {
      setProperty: (name: string, value: string) => props.set(name, value),
      removeProperty: (name: string) => props.delete(name),
      getPropertyValue: (name: string) => props.get(name) ?? "",
    },
  } as unknown as HTMLElement;
}

describe("applyEditorFont", () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = makeEl();
  });

  it("sets --tandem-editor-font-family for 'sans'", () => {
    applyEditorFont("sans", el);
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).toContain("sans-serif");
  });

  it("sets --tandem-editor-font-family for 'serif'", () => {
    applyEditorFont("serif", el);
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).toContain("serif");
  });

  it("sets a different stack for 'mono' vs 'serif'", () => {
    applyEditorFont("mono", el);
    const monoValue = el.style.getPropertyValue("--tandem-editor-font-family");
    applyEditorFont("serif", el);
    const serifValue = el.style.getPropertyValue("--tandem-editor-font-family");
    expect(monoValue).not.toBe(serifValue);
  });

  it("'mono' stack includes a monospace font name", () => {
    applyEditorFont("mono", el);
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).toContain("monospace");
  });

  it("cleanup removes --tandem-editor-font-family", () => {
    const cleanup = applyEditorFont("sans", el);
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).not.toBe("");
    cleanup();
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).toBe("");
  });

  it("switching from mono to serif updates the property", () => {
    applyEditorFont("mono", el);
    const monoValue = el.style.getPropertyValue("--tandem-editor-font-family");
    applyEditorFont("serif", el);
    expect(el.style.getPropertyValue("--tandem-editor-font-family")).not.toBe(monoValue);
  });
});
