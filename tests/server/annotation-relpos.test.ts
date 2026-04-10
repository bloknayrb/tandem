import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  flatOffsetToRelPos,
  populateYDoc,
  relPosToFlatOffset,
} from "../../src/server/mcp/document.js";

// Tests server-side RelativePosition round-trip logic used by the client's annotation extension.
// The client-side functions (flatOffsetToPmPos, relRangeToPmPositions) require ProseMirror nodes
// and are tested in coordinate-conversion.test.ts. Here we test the CRDT position tracking.

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

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

    // Test positions in each paragraph — separator offsets (15, 32) return null
    // because they land on the \n between elements, not inside any XmlText.
    const validOffsets = [0, 5, 16, 20, 33, 40];
    for (const offset of validOffsets) {
      const relPos = flatOffsetToRelPos(doc, offset, 0);
      expect(relPos, `offset ${offset} should produce a relPos`).not.toBeNull();
      const roundTripped = relPosToFlatOffset(doc, relPos!);
      expect(roundTripped, `offset ${offset} should round-trip`).toBe(offset);
    }

    // Separator offsets (15, 32) resolve to the end of the preceding element —
    // they get a valid relPos, but may not round-trip exactly (they land on the boundary).
    for (const sepOffset of [15, 32]) {
      const relPos = flatOffsetToRelPos(doc, sepOffset, 0);
      // These may or may not be null depending on the resolver — just verify no crash
      if (relPos) {
        const resolved = relPosToFlatOffset(doc, relPos);
        expect(resolved).not.toBeNull();
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
