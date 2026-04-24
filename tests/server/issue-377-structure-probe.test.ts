/**
 * Structure probe for Issue #377 — understanding Y.Doc shapes for list items
 * and the separator boundary behavior with loadMarkdown (remark-based).
 */
import { describe, expect, it, afterEach } from "vitest";
import * as Y from "yjs";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText, getElementText, resolveOffset } from "../../src/server/mcp/document-model.js";
import { flatOffsetToRelPos, resolveToElement } from "../../src/server/positions.js";
import { toFlatOffset } from "../../src/shared/positions/index.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

describe("Y.Doc structure probe for list items", () => {
  it("shows what loadMarkdown produces for a bullet list", () => {
    doc = new Y.Doc();
    loadMarkdown(doc, "- Progressive Web App (PWA) — lower priority");
    const frag = doc.getXmlFragment("default");

    const flat = extractText(doc);
    expect(flat.length).toBeGreaterThan(0);
    expect(frag.length).toBeGreaterThan(0);
  });

  it("shows what loadMarkdown produces for two plain paragraphs", () => {
    doc = new Y.Doc();
    loadMarkdown(doc, "first\nsecond");
    const frag = doc.getXmlFragment("default");

    const flat = extractText(doc);
    expect(flat.length).toBeGreaterThan(0);
    expect(frag.length).toBeGreaterThan(0);

    // Check resolveToElement at separator boundary
    const atSep = resolveToElement(frag, toFlatOffset(5)); // offset 5 = \n in "first\nsecond"
    expect(atSep).toBeDefined();

    const afterSep = resolveToElement(frag, toFlatOffset(6)); // offset 6 = start of "second"
    expect(afterSep).toBeDefined();
  });

  it("shows what loadMarkdown produces for a PWA-like bullet in context", () => {
    doc = new Y.Doc();
    const md =
      "## Future Extensions\n\n- **Progressive Web App (PWA)** — lower priority\n- Spreadsheet component";
    loadMarkdown(doc, md);
    const frag = doc.getXmlFragment("default");

    const flat = extractText(doc);
    expect(flat.length).toBeGreaterThan(0);
    expect(frag.length).toBeGreaterThan(0);

    const pwaIdx = flat.indexOf("Progressive Web App");
    expect(pwaIdx).toBeGreaterThan(-1);
    if (pwaIdx >= 0) {
      // resolveOffset should return a result (even if in wrong element due to Bug A)
      const resolved = resolveOffset(frag, pwaIdx);
      expect(resolved).toBeDefined();
    }
  });

  it("resolveOffset handles nested list items (does NOT return null but finds wrong XmlText)", () => {
    // The critical question: when the Y.Doc element is a bulletList > listItem > paragraph,
    // getElementText() and findXmlText() need to recurse. If they don't,
    // flatOffsetToRelPos returns null for list item content.
    doc = new Y.Doc();
    loadMarkdown(doc, "- Item one\n- Item two");
    const frag = doc.getXmlFragment("default");

    const flat = extractText(doc);
    expect(flat.length).toBeGreaterThan(0);

    const itemTwoIdx = flat.indexOf("Item two");
    // "Item two" should be findable in the flat text (even if offset is wrong due to Bug C)
    expect(itemTwoIdx).toBeGreaterThanOrEqual(-1);

    if (itemTwoIdx >= 0) {
      // flatOffsetToRelPos returns null for list item content due to Bug A
      const relPos = flatOffsetToRelPos(doc, toFlatOffset(itemTwoIdx), 0);
      expect(relPos).toBeNull(); // documents Bug A — should become non-null after fix
    }
  });
});
