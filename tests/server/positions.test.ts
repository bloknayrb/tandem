import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import {
  validateRange,
  anchoredRange,
  resolveToElement,
  flatOffsetToRelPos,
  relPosToFlatOffset,
  refreshRange,
  refreshAllRanges,
} from "../../src/server/positions.js";
import { makeDoc, getAnnotationsMap, getFragment } from "../helpers/ydoc-factory.js";
import { getOrCreateXmlText } from "../../src/server/mcp/document.js";
import type { Annotation } from "../../src/shared/types.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

describe("validateRange", () => {
  it("accepts a valid range", () => {
    doc = makeDoc("hello world");
    const result = validateRange(doc, 0, 5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.range).toEqual({ from: 0, to: 5 });
  });

  it("rejects from > to", () => {
    doc = makeDoc("hello");
    const result = validateRange(doc, 5, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_RANGE");
  });

  it("detects stale text via textSnapshot", () => {
    doc = makeDoc("hello world");
    // Edit the doc
    const fragment = getFragment(doc);
    const el = fragment.get(0) as Y.XmlElement;
    const xmlText = el.get(0) as Y.XmlText;
    xmlText.insert(0, "XXX");

    const result = validateRange(doc, 0, 5, { textSnapshot: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RANGE_STALE");
      if (!result.gone) {
        expect(result.resolvedFrom).toBe(3);
        expect(result.resolvedTo).toBe(8);
      }
    }
  });

  it("returns gone when text is deleted", () => {
    doc = makeDoc("hello");
    // Replace all text
    const fragment = getFragment(doc);
    fragment.delete(0, fragment.length);
    const el = new Y.XmlElement("paragraph");
    el.insert(0, [new Y.XmlText("goodbye")]);
    fragment.insert(0, [el]);

    const result = validateRange(doc, 0, 5, { textSnapshot: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RANGE_STALE");
      expect(result.gone).toBe(true);
    }
  });

  it("passes when textSnapshot matches", () => {
    doc = makeDoc("hello world");
    const result = validateRange(doc, 0, 5, { textSnapshot: "hello" });
    expect(result.ok).toBe(true);
  });

  it("rejects heading overlap when option is set", () => {
    doc = makeDoc("## Title");
    const result = validateRange(doc, 0, 3, { rejectHeadingOverlap: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("HEADING_OVERLAP");
  });

  it("allows heading prefix range when rejectHeadingOverlap is false", () => {
    doc = makeDoc("## Title");
    const result = validateRange(doc, 0, 3);
    expect(result.ok).toBe(true);
  });
});

describe("anchoredRange", () => {
  it("returns both flat and rel range", () => {
    doc = makeDoc("hello world");
    const result = anchoredRange(doc, 0, 5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.range).toEqual({ from: 0, to: 5 });
      expect(result.relRange).toBeDefined();
      expect(result.relRange!.fromRel).not.toBeNull();
      expect(result.relRange!.toRel).not.toBeNull();
    }
  });

  it("returns validation error for stale text", () => {
    doc = makeDoc("hello world");
    const fragment = getFragment(doc);
    const el = fragment.get(0) as Y.XmlElement;
    (el.get(0) as Y.XmlText).insert(0, "XXX");

    const result = anchoredRange(doc, 0, 5, "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RANGE_STALE");
  });

  it("omits relRange when offset is in heading prefix", () => {
    doc = makeDoc("## Title");
    const result = anchoredRange(doc, 0, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // from=0 is inside "## " prefix → flatOffsetToRelPos returns null
      expect(result.relRange).toBeUndefined();
    }
  });

  it("succeeds without textSnapshot", () => {
    doc = makeDoc("hello");
    const result = anchoredRange(doc, 0, 5);
    expect(result.ok).toBe(true);
  });
});

describe("resolveToElement", () => {
  it("resolves offset in first paragraph", () => {
    doc = makeDoc("hello world");
    const fragment = getFragment(doc);
    const result = resolveToElement(fragment, 3);
    expect(result).toEqual({ elementIndex: 0, textOffset: 3, clampedFromPrefix: false });
  });

  it("resolves offset in second paragraph", () => {
    doc = makeDoc("first\nsecond");
    const fragment = getFragment(doc);
    // "first" = 5 chars, \n = 1, "second" starts at 6
    const result = resolveToElement(fragment, 8);
    expect(result).toEqual({ elementIndex: 1, textOffset: 2, clampedFromPrefix: false });
  });

  it("clamps offset in heading prefix", () => {
    doc = makeDoc("## Title");
    const fragment = getFragment(doc);
    // "## " is 3 chars, offset 1 is inside prefix
    const result = resolveToElement(fragment, 1);
    expect(result).toEqual({ elementIndex: 0, textOffset: 0, clampedFromPrefix: true });
  });

  it("returns null for empty fragment", () => {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const result = resolveToElement(fragment, 0);
    expect(result).toBeNull();
  });

  it("clamps past-end offset to last element", () => {
    doc = makeDoc("hello");
    const fragment = getFragment(doc);
    const result = resolveToElement(fragment, 100);
    expect(result).toEqual({ elementIndex: 0, textOffset: 5, clampedFromPrefix: false });
  });
});

describe("flatOffsetToRelPos / relPosToFlatOffset round-trip", () => {
  it("round-trips a simple offset", () => {
    doc = makeDoc("hello world");
    const relPos = flatOffsetToRelPos(doc, 6, 0);
    expect(relPos).not.toBeNull();
    const flat = relPosToFlatOffset(doc, relPos);
    expect(flat).toBe(6);
  });

  it("returns null for heading prefix offset", () => {
    doc = makeDoc("## Title");
    const relPos = flatOffsetToRelPos(doc, 1, 0); // inside "## "
    expect(relPos).toBeNull();
  });

  it("round-trips across multiple paragraphs", () => {
    doc = makeDoc("first\nsecond\nthird");
    const relPos = flatOffsetToRelPos(doc, 13, 0); // start of "third"
    expect(relPos).not.toBeNull();
    const flat = relPosToFlatOffset(doc, relPos);
    expect(flat).toBe(13);
  });

  it("survives concurrent edits", () => {
    doc = makeDoc("hello world");
    const relPos = flatOffsetToRelPos(doc, 6, 0); // start of "world"
    expect(relPos).not.toBeNull();

    // Insert before
    const fragment = getFragment(doc);
    const el = fragment.get(0) as Y.XmlElement;
    getOrCreateXmlText(el).insert(0, "XXX");

    const flat = relPosToFlatOffset(doc, relPos);
    expect(flat).toBe(9); // shifted by 3
  });
});

describe("refreshRange (via positions module)", () => {
  function makeAnnotation(map: Y.Map<unknown>, from: number, to: number, ydoc?: Y.Doc): Annotation {
    const result = ydoc
      ? anchoredRange(ydoc, from, to)
      : { ok: true as const, range: { from, to } };
    if (!result.ok) throw new Error("Failed");
    const id = `ann_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const ann: Annotation = {
      id,
      author: "claude",
      type: "comment",
      range: result.range,
      ...("relRange" in result && result.relRange ? { relRange: result.relRange } : {}),
      content: "test",
      status: "pending",
      timestamp: Date.now(),
    };
    map.set(id, ann);
    return ann;
  }

  it("lazily attaches relRange", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = makeAnnotation(map, 0, 5); // no ydoc → no relRange

    expect(ann.relRange).toBeUndefined();
    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.relRange).toBeDefined();
  });

  it("updates stale flat offsets after edit", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = makeAnnotation(map, 6, 11, doc);

    // Insert before annotation
    const fragment = getFragment(doc);
    const el = fragment.get(0) as Y.XmlElement;
    getOrCreateXmlText(el).insert(0, "XXX");

    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.range).toEqual({ from: 9, to: 14 });
  });
});

describe("refreshAllRanges", () => {
  it("batch refreshes in a transaction", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);

    // Create two annotations with relRange
    const result1 = anchoredRange(doc, 0, 5);
    const result2 = anchoredRange(doc, 6, 11);
    if (!result1.ok || !result2.ok) throw new Error("Failed");

    const ann1: Annotation = {
      id: "a1",
      author: "claude",
      type: "comment",
      range: result1.range,
      relRange: result1.relRange,
      content: "1",
      status: "pending",
      timestamp: Date.now(),
    };
    const ann2: Annotation = {
      id: "a2",
      author: "claude",
      type: "comment",
      range: result2.range,
      relRange: result2.relRange,
      content: "2",
      status: "pending",
      timestamp: Date.now(),
    };
    map.set("a1", ann1);
    map.set("a2", ann2);

    // Edit
    const fragment = getFragment(doc);
    const el = fragment.get(0) as Y.XmlElement;
    getOrCreateXmlText(el).insert(0, "XX");

    const refreshed = refreshAllRanges([ann1, ann2], doc, map);
    expect(refreshed[0].range).toEqual({ from: 2, to: 7 });
    expect(refreshed[1].range).toEqual({ from: 8, to: 13 });
  });
});
