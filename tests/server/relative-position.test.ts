import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import {
  flatOffsetToRelPos,
  relPosToFlatOffset,
  getOrCreateXmlText,
  extractText,
} from "../../src/server/mcp/document.js";
import { makeDoc, getFragment } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

describe("flatOffsetToRelPos", () => {
  it("returns JSON-serializable RelativePosition for paragraph text", () => {
    doc = makeDoc("hello world");
    const relPos = flatOffsetToRelPos(doc, 6, 0);
    expect(relPos).not.toBeNull();
    expect(typeof relPos).toBe("object");
  });

  it("returns null for offset inside heading prefix", () => {
    doc = makeDoc("## Title");
    // Offset 0-2 are inside "## " prefix
    expect(flatOffsetToRelPos(doc, 0, 0)).toBeNull();
    expect(flatOffsetToRelPos(doc, 1, 0)).toBeNull();
    expect(flatOffsetToRelPos(doc, 2, 0)).toBeNull();
  });

  it("works for text after heading prefix", () => {
    doc = makeDoc("## Title");
    // "## " is 3 chars, so offset 3 = start of "Title"
    const relPos = flatOffsetToRelPos(doc, 3, 0);
    expect(relPos).not.toBeNull();
  });
});

describe("relPosToFlatOffset", () => {
  it("returns null for invalid relPos JSON", () => {
    doc = makeDoc("hello");
    // Create a relPos from a different doc — should resolve to null
    const otherDoc = new Y.Doc();
    Y.applyUpdate(otherDoc, Y.encodeStateAsUpdate(new Y.Doc()));
    const fragment = otherDoc.getXmlFragment("default");
    const el = new Y.XmlElement("paragraph");
    el.insert(0, [new Y.XmlText("other")]);
    fragment.insert(0, [el]);
    const xmlText = getOrCreateXmlText(el);
    const rpos = Y.createRelativePositionFromTypeIndex(xmlText, 2, 0);
    const json = Y.relativePositionToJSON(rpos);
    otherDoc.destroy();

    // Resolving against a different doc returns null
    expect(relPosToFlatOffset(doc, json)).toBeNull();
  });
});

describe("round-trip: flatOffset → relPos → flatOffset", () => {
  it("is identity for single paragraph", () => {
    doc = makeDoc("hello world");
    for (const offset of [0, 5, 11]) {
      const relPos = flatOffsetToRelPos(doc, offset, 0);
      expect(relPos).not.toBeNull();
      const back = relPosToFlatOffset(doc, relPos!);
      expect(back).toBe(offset);
    }
  });

  it("is identity for multi-paragraph text", () => {
    doc = makeDoc("first\nsecond\nthird");
    // "first" is offsets 0-4, "\n" is 5, "second" is 6-11, "\n" is 12, "third" is 13-17
    for (const offset of [0, 4, 6, 11, 13, 17]) {
      const relPos = flatOffsetToRelPos(doc, offset, 0);
      expect(relPos).not.toBeNull();
      const back = relPosToFlatOffset(doc, relPos!);
      expect(back).toBe(offset);
    }
  });

  it("is identity for heading text (after prefix)", () => {
    doc = makeDoc("## Title\nBody text");
    // "## " = 3 chars, "Title" starts at 3, "\n" at 8, "Body text" starts at 9
    for (const offset of [3, 7, 9, 17]) {
      const relPos = flatOffsetToRelPos(doc, offset, 0);
      expect(relPos).not.toBeNull();
      const back = relPosToFlatOffset(doc, relPos!);
      expect(back).toBe(offset);
    }
  });

  it("preserves assoc parameter", () => {
    doc = makeDoc("hello world");
    const relStart = flatOffsetToRelPos(doc, 5, 0);
    const relEnd = flatOffsetToRelPos(doc, 5, -1);
    expect(relStart).not.toBeNull();
    expect(relEnd).not.toBeNull();
    // Both should resolve to the same flat offset
    expect(relPosToFlatOffset(doc, relStart!)).toBe(5);
    expect(relPosToFlatOffset(doc, relEnd!)).toBe(5);
  });
});

describe("edit survival", () => {
  it("relPos tracks forward when text is inserted before it", () => {
    doc = makeDoc("hello world");
    // Create relPos at offset 6 (start of "world")
    const relPos = flatOffsetToRelPos(doc, 6, 0);
    expect(relPos).not.toBeNull();

    // Insert "big " before "world" → "hello big world"
    const fragment = getFragment(doc);
    const firstElement = fragment.get(0) as Y.XmlElement;
    const xmlText = getOrCreateXmlText(firstElement);
    xmlText.insert(6, "big ");

    // Verify document changed
    expect(extractText(doc)).toBe("hello big world");

    // relPos should now resolve to offset 10 (start of "world" in new text)
    const newOffset = relPosToFlatOffset(doc, relPos!);
    expect(newOffset).toBe(10);
  });

  it("relPos tracks backward when text is deleted before it", () => {
    doc = makeDoc("hello world");
    // Create relPos at offset 6 (start of "world")
    const relPos = flatOffsetToRelPos(doc, 6, 0);
    expect(relPos).not.toBeNull();

    // Delete "hel" (0-3) → "lo world"
    const fragment = getFragment(doc);
    const firstElement = fragment.get(0) as Y.XmlElement;
    const xmlText = getOrCreateXmlText(firstElement);
    xmlText.delete(0, 3);

    expect(extractText(doc)).toBe("lo world");

    const newOffset = relPosToFlatOffset(doc, relPos!);
    expect(newOffset).toBe(3); // "world" now starts at 3
  });

  it("returns null when the containing element is deleted", () => {
    doc = makeDoc("first\nsecond");
    // Create relPos in "second" (offset 6)
    const relPos = flatOffsetToRelPos(doc, 6, 0);
    expect(relPos).not.toBeNull();

    // Delete the second element entirely
    const fragment = getFragment(doc);
    fragment.delete(1, 1);

    expect(extractText(doc)).toBe("first");

    const newOffset = relPosToFlatOffset(doc, relPos!);
    expect(newOffset).toBeNull();
  });

  it("annotation range survives insert between from and to", () => {
    doc = makeDoc("abcdefghij");
    const fromRel = flatOffsetToRelPos(doc, 2, 0); // after "ab"
    const toRel = flatOffsetToRelPos(doc, 8, -1); // before "ij"
    expect(fromRel).not.toBeNull();
    expect(toRel).not.toBeNull();

    // Insert "XYZ" at position 5 → "abcdeXYZfghij"
    const fragment = getFragment(doc);
    const el = fragment.get(0) as Y.XmlElement;
    const xmlText = getOrCreateXmlText(el);
    xmlText.insert(5, "XYZ");

    expect(extractText(doc)).toBe("abcdeXYZfghij");

    const newFrom = relPosToFlatOffset(doc, fromRel!);
    const newTo = relPosToFlatOffset(doc, toRel!);
    expect(newFrom).toBe(2); // "ab" boundary unchanged
    expect(newTo).toBe(11); // shifted by 3 ("XYZ".length)
  });
});

describe("separator boundary", () => {
  it("offset at separator position between elements resolves correctly", () => {
    doc = makeDoc("abc\ndef");
    // Offset 3 = end of "abc" (last char index)
    const relAtEnd = flatOffsetToRelPos(doc, 3, 0);
    expect(relAtEnd).not.toBeNull();
    expect(relPosToFlatOffset(doc, relAtEnd!)).toBe(3);

    // Offset 4 = start of "def"
    const relAtStart = flatOffsetToRelPos(doc, 4, 0);
    expect(relAtStart).not.toBeNull();
    expect(relPosToFlatOffset(doc, relAtStart!)).toBe(4);
  });
});
