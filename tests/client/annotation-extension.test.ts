import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { flatOffsetToRelPos, relPosToFlatOffset } from "../../src/server/mcp/document.js";

// Note: We can't test relRangeToPmPositions or resolveAnnotationPmRange directly here
// because they require a real ProseMirror Node (from Tiptap), which needs a full editor setup.
// However, we CAN test the flatOffsetToPmPos function with ProseMirror-like doc structures,
// and we can test the RelativePosition → flat offset round-trip that feeds into these functions.

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

// Note: flatOffsetToPmPos requires a ProseMirror Node, not a Y.Doc.
// Those tests are covered in coordinate-conversion.test.ts.
// Here we focus on the server-side relPos round-trip that feeds the client's annotation resolution.

describe("RelativePosition round-trip for annotation resolution", () => {
  it("flat offset → relPos → flat offset identity for single paragraph", () => {
    doc = new Y.Doc();
    populateYDoc(doc, "Hello world");

    for (const offset of [0, 3, 5, 11]) {
      const relPos = flatOffsetToRelPos(doc, offset, 0);
      expect(relPos).not.toBeNull();
      const roundTripped = relPosToFlatOffset(doc, relPos!);
      expect(roundTripped).toBe(offset);
    }
  });

  it("round-trips for multi-paragraph document", () => {
    doc = new Y.Doc();
    populateYDoc(doc, "First paragraph\nSecond paragraph\nThird paragraph");

    // Test positions in each paragraph
    const testOffsets = [0, 5, 15, 16, 20, 32, 33, 40];
    for (const offset of testOffsets) {
      const relPos = flatOffsetToRelPos(doc, offset, 0);
      if (relPos) {
        const roundTripped = relPosToFlatOffset(doc, relPos);
        expect(roundTripped).toBe(offset);
      }
    }
  });

  it("round-trips for headings (non-prefix offsets)", () => {
    doc = new Y.Doc();
    populateYDoc(doc, "## Heading\nContent");

    // Offset 3 is "H" (after "## " prefix)
    const relPos = flatOffsetToRelPos(doc, 3, 0);
    expect(relPos).not.toBeNull();
    const roundTripped = relPosToFlatOffset(doc, relPos!);
    expect(roundTripped).toBe(3);
  });

  it("returns null for heading prefix offsets", () => {
    doc = new Y.Doc();
    populateYDoc(doc, "## Heading");

    // Offsets 0, 1, 2 are in "## " prefix
    expect(flatOffsetToRelPos(doc, 0, 0)).toBeNull();
    expect(flatOffsetToRelPos(doc, 1, 0)).toBeNull();
    expect(flatOffsetToRelPos(doc, 2, 0)).toBeNull();
  });

  it("survives concurrent edits", () => {
    doc = new Y.Doc();
    populateYDoc(doc, "Hello world");

    // Create relPos for "world" (offset 6-11)
    const fromRel = flatOffsetToRelPos(doc, 6, 0);
    const toRel = flatOffsetToRelPos(doc, 11, -1);
    expect(fromRel).not.toBeNull();
    expect(toRel).not.toBeNull();

    // Insert text before "world"
    const fragment = doc.getXmlFragment("default");
    const el = fragment.get(0) as Y.XmlElement;
    const xmlText = el.get(0) as Y.XmlText;
    xmlText.insert(0, "XXX"); // "XXXHello world"

    // RelPos should track to new positions
    const newFrom = relPosToFlatOffset(doc, fromRel!);
    const newTo = relPosToFlatOffset(doc, toRel!);
    expect(newFrom).toBe(9); // shifted by 3
    expect(newTo).toBe(14); // shifted by 3
  });
});

describe("annotation range edge cases for client resolution", () => {
  it("annotation at document start", () => {
    doc = new Y.Doc();
    populateYDoc(doc, "Start of document");

    const fromRel = flatOffsetToRelPos(doc, 0, 0);
    const toRel = flatOffsetToRelPos(doc, 5, -1);
    expect(fromRel).not.toBeNull();
    expect(toRel).not.toBeNull();

    expect(relPosToFlatOffset(doc, fromRel!)).toBe(0);
    expect(relPosToFlatOffset(doc, toRel!)).toBe(5);
  });

  it("annotation at document end", () => {
    doc = new Y.Doc();
    populateYDoc(doc, "End of text");

    const textLen = 11; // "End of text"
    const fromRel = flatOffsetToRelPos(doc, 7, 0);
    const toRel = flatOffsetToRelPos(doc, textLen, -1);
    expect(fromRel).not.toBeNull();
    expect(toRel).not.toBeNull();
  });

  it("annotation spanning entire paragraph", () => {
    doc = new Y.Doc();
    populateYDoc(doc, "Whole paragraph");

    const fromRel = flatOffsetToRelPos(doc, 0, 0);
    const toRel = flatOffsetToRelPos(doc, 15, -1);
    expect(fromRel).not.toBeNull();
    expect(toRel).not.toBeNull();

    expect(relPosToFlatOffset(doc, fromRel!)).toBe(0);
    expect(relPosToFlatOffset(doc, toRel!)).toBe(15);
  });

  it("zero-width annotation (insertion point)", () => {
    doc = new Y.Doc();
    populateYDoc(doc, "Insert here");

    const relPos = flatOffsetToRelPos(doc, 6, 0);
    expect(relPos).not.toBeNull();
    expect(relPosToFlatOffset(doc, relPos!)).toBe(6);
  });
});
