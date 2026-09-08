import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { extractText, getOrCreateXmlText } from "../../src/server/mcp/document.js";
import {
  __testResetHoistMismatchCounts,
  anchoredRange,
  flatOffsetToRelPos,
  refreshAllRanges,
  refreshRange,
  relPosToFlatOffset,
  resolveToElement,
  validateFlatRange,
  validateRange,
} from "../../src/server/positions.js";
import type {
  FlatOffset,
  RangeValidation,
  SerializedRelPos,
} from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types.js";
import { off } from "../helpers/positions.js";
import {
  getAnnotationsMap,
  getFragment,
  makeAnnotation,
  makeDoc,
  makeMarkdownDoc,
} from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

describe("validateRange", () => {
  it("accepts a valid range", () => {
    doc = makeDoc("hello world");
    const result = validateRange(doc, off(0), off(5));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.range).toEqual({ from: 0, to: 5 });
  });

  it("rejects from > to", () => {
    doc = makeDoc("hello");
    const result = validateRange(doc, off(5), off(0));
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

    const result = validateRange(doc, off(0), off(5), { textSnapshot: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RANGE_MOVED");
      if (result.code === "RANGE_MOVED") {
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

    const result = validateRange(doc, off(0), off(5), { textSnapshot: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RANGE_GONE");
    }
  });

  it("passes when textSnapshot matches", () => {
    doc = makeDoc("hello world");
    const result = validateRange(doc, off(0), off(5), { textSnapshot: "hello" });
    expect(result.ok).toBe(true);
  });

  it("rejects heading overlap when option is set", () => {
    doc = makeDoc("## Title");
    const result = validateRange(doc, off(0), off(3), { rejectHeadingOverlap: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("HEADING_OVERLAP");
  });

  it("allows heading prefix range when rejectHeadingOverlap is false", () => {
    doc = makeDoc("## Title");
    const result = validateRange(doc, off(0), off(3));
    expect(result.ok).toBe(true);
  });

  it("rejects an offset past the end of an empty document before the heading walk", () => {
    doc = new Y.Doc();
    // Empty fragment — no elements to resolve against, so the flat projection
    // is "" and every non-zero offset is out of bounds. Before #1752 this
    // reached the `rejectHeadingOverlap` walk and came back "unresolvable";
    // the upper bound now answers first, which is the more accurate reason.
    doc.getXmlFragment("default");
    const result = validateRange(doc, off(0), off(5), { rejectHeadingOverlap: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_RANGE");
      if (result.code === "INVALID_RANGE") expect(result.reason).toBe("out-of-bounds");
    }
  });
});

/**
 * #1752: `validateRange` used to check only ordering, staleness and heading
 * overlap. Out-of-bounds, negative, fractional, zero-length and mid-surrogate
 * offsets all passed and reached a Y.Doc write.
 */
describe("validateRange — bounds, integrality, emptiness and surrogates", () => {
  /** The INVALID_RANGE reason, or the code when it is some other failure. */
  function failure(result: RangeValidation): string {
    if (result.ok) return "ok";
    return result.code === "INVALID_RANGE" ? result.reason : result.code;
  }

  describe("one case per reason", () => {
    it("non-integer: a fractional from", () => {
      doc = makeDoc("hello world");
      expect(failure(validateRange(doc, off(1.5), off(3)))).toBe("non-integer");
    });

    it("non-integer: NaN and Infinity", () => {
      doc = makeDoc("hello world");
      expect(failure(validateRange(doc, off(Number.NaN), off(3)))).toBe("non-integer");
      expect(failure(validateRange(doc, off(0), off(Number.POSITIVE_INFINITY)))).toBe(
        "non-integer",
      );
    });

    it("inverted: from > to", () => {
      doc = makeDoc("hello world");
      expect(failure(validateRange(doc, off(5), off(0)))).toBe("inverted");
    });

    it("out-of-bounds: to past the end", () => {
      doc = makeDoc("hello world");
      expect(failure(validateRange(doc, off(0), off(99999)))).toBe("out-of-bounds");
    });

    it("out-of-bounds: a negative from", () => {
      doc = makeDoc("hello world");
      expect(failure(validateRange(doc, off(-3), off(5)))).toBe("out-of-bounds");
    });

    it("empty: from === to, with no snapshot", () => {
      // Deliberately snapshot-free: with a snapshot the slice is "" and the
      // staleness gate answers first, so the "empty" arm is unreachable.
      doc = makeDoc("hello world");
      expect(failure(validateRange(doc, off(3), off(3)))).toBe("empty");
    });

    it("surrogate: an offset between the halves of a pair", () => {
      doc = makeDoc("a\u{1F600}b");
      expect(failure(validateRange(doc, off(2), off(3)))).toBe("surrogate");
    });

    it("unresolvable: constructed directly — no caller reaches it", () => {
      // Needs rejectHeadingOverlap AND allowEmpty AND an element-free fragment:
      // on such a fragment text.length === 0, so every other range dies at the
      // upper bound and (0, 0) dies at "empty". No production caller passes both.
      doc = new Y.Doc();
      doc.getXmlFragment("default");
      const result = validateRange(doc, off(0), off(0), {
        rejectHeadingOverlap: true,
        allowEmpty: true,
      });
      expect(failure(result)).toBe("unresolvable");
    });
  });

  describe("bounds", () => {
    it("accepts to === text.length", () => {
      doc = makeDoc("hello world");
      const result = validateRange(doc, off(0), off(11));
      expect(result.ok).toBe(true);
    });

    it("refuses from === to by default and accepts it with allowEmpty", () => {
      doc = makeDoc("hello world");
      expect(failure(validateRange(doc, off(3), off(3)))).toBe("empty");
      expect(validateRange(doc, off(3), off(3), { allowEmpty: true }).ok).toBe(true);
    });
  });

  describe("surrogates — the predicate is the PAIRED form", () => {
    it('"a😀b": rejects at from and at to, accepts either side', () => {
      doc = makeDoc("a\u{1F600}b");
      expect(extractText(doc)).toBe("a\u{1F600}b");
      expect(failure(validateRange(doc, off(2), off(3)))).toBe("surrogate");
      expect(failure(validateRange(doc, off(0), off(2)))).toBe("surrogate");
      expect(validateRange(doc, off(0), off(1)).ok).toBe(true);
      expect(validateRange(doc, off(3), off(4)).ok).toBe(true);
    });

    it("accepts to === text.length when the document ends in an emoji", () => {
      doc = makeDoc("hi \u{1F600}");
      // charCodeAt(text.length) is NaN — not a low surrogate, so the end is legal.
      expect(validateRange(doc, off(0), off(5)).ok).toBe(true);
    });

    it('"😀😀": the boundary BETWEEN two adjacent astral characters is legal', () => {
      // The control that kills a one-sided "the unit at i is any surrogate"
      // predicate: offset 2 has no alternative, so rejecting it is a bug.
      doc = makeDoc("\u{1F600}\u{1F600}");
      expect(validateRange(doc, off(0), off(2)).ok).toBe(true);
      expect(validateRange(doc, off(2), off(4)).ok).toBe(true);
      expect(validateRange(doc, off(0), off(4)).ok).toBe(true);
      expect(failure(validateRange(doc, off(1), off(3)))).toBe("surrogate");
    });

    it("sees the heading prefix shift at document level", () => {
      // Every other surrogate case runs on a raw string and cannot see the
      // 3-char "## " prefix. The heading must be TOP-LEVEL — one nested in a
      // list item gets no prefix.
      doc = makeMarkdownDoc("## A\u{1F600}B\n\np\u{1F600}\n\n\u{1F600}q\n\nli\u{1F600}\n");
      expect(extractText(doc)).toBe("## A\u{1F600}B\np\u{1F600}\n\u{1F600}q\nli\u{1F600}");
      expect(failure(validateRange(doc, off(0), off(5)))).toBe("surrogate");
      expect(validateRange(doc, off(0), off(6)).ok).toBe(true);
    });
  });

  describe("check order", () => {
    it("a negative from is answered before staleness, not relocated", () => {
      // String.prototype.slice wraps a negative start:
      // "hello world".slice(-3, 11) === "rld". Bounds-after-staleness would
      // hand this back ok:true with {from: -3, to: 11} — which it did.
      doc = makeDoc("hello world");
      expect("hello world".slice(-3, 11)).toBe("rld");
      expect(failure(validateRange(doc, off(-3), off(11), { textSnapshot: "rld" }))).toBe(
        "out-of-bounds",
      );
    });

    it("staleness is answered before the upper bound, so a shortened document relocates", () => {
      // The watcher's relocation probe passes stale offsets past the new end
      // with a snapshot and relies on RANGE_MOVED. Bounds-first would return
      // INVALID_RANGE and pin the annotation to dead offsets.
      doc = makeDoc("aaaa target bbbb cccc dddd");
      const fragment = getFragment(doc);
      const el = fragment.get(0) as Y.XmlElement;
      const xmlText = el.get(0) as Y.XmlText;
      xmlText.delete(11, 15); // drop " bbbb cccc dddd" → "aaaa target"
      expect(extractText(doc)).toBe("aaaa target");
      const result = validateRange(doc, off(20), off(26), { textSnapshot: "target" });
      expect(result.ok).toBe(false);
      expect(failure(result)).toBe("RANGE_MOVED");
      if (!result.ok && result.code === "RANGE_MOVED") {
        expect(result.resolvedFrom).toBe(5);
        expect(result.resolvedTo).toBe(11);
      }
    });

    it("integrality is answered before ordering", () => {
      doc = makeDoc("hello world");
      expect(failure(validateRange(doc, off(1.5), off(0)))).toBe("non-integer");
    });

    it("ordering is answered before the upper bound", () => {
      doc = makeDoc("short");
      expect(failure(validateRange(doc, off(99999), off(5)))).toBe("inverted");
    });

    it("the surrogate check is answered before emptiness is allowed to pass", () => {
      doc = makeDoc("a\u{1F600}b");
      expect(failure(validateRange(doc, off(2), off(2), { allowEmpty: true }))).toBe("surrogate");
    });

    it("bounds are answered before the heading walk", () => {
      doc = makeDoc("## Title");
      // Today this returns HEADING_OVERLAP — the offsets are nonsense first.
      expect(failure(validateRange(doc, off(0), off(99999), { rejectHeadingOverlap: true }))).toBe(
        "out-of-bounds",
      );
    });
  });

  describe("the hoisted `text` guard", () => {
    // `hoistMismatchCounts` is module-global and deliberately never cleared in
    // production, so the throttle spec's expected log count would otherwise
    // depend on which tags earlier specs in the run touched.
    beforeEach(() => {
      __testResetHoistMismatchCounts();
    });

    it("recomputes and warns when the supplied text has the wrong length", () => {
      doc = makeDoc("hello world");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // A longer `text` would make (0, 20) look in-bounds. It must not.
        const result = validateRange(doc, off(0), off(20), {
          text: "hello world and then some more",
        });
        expect(failure(result)).toBe("out-of-bounds");
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("accepts a correct hoisted text without warning", () => {
      doc = makeDoc("hello world");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(validateRange(doc, off(0), off(5), { text: "hello world" }).ok).toBe(true);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("a stale hoist reaches the SAME verdict the un-hoisted call would", () => {
      // The guard's contract in one line: passing `text` may make the call
      // noisier, never wronger. A spec that only asserted the log would pass on
      // a guard that logged and then used the stale string anyway.
      doc = makeDoc("hello world");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // One character short — the smallest mismatch the length walk can see.
        // (0, 11) is in bounds against the real document and out of bounds
        // against the hoist, so the two answers are distinguishable.
        const hoisted = validateRange(doc, off(0), off(11), { text: "hello worl" });
        const unhoisted = validateRange(doc, off(0), off(11));
        expect(hoisted).toEqual(unhoisted);
        expect(hoisted.ok).toBe(true);
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls.flat().join(" ")).toContain("changed shape under the hoist");
      } finally {
        spy.mockRestore();
      }
    });

    it("does NOT build the projection string when the hoisted text matches", () => {
      // This is the whole point of the option, and nothing else pins it: the
      // guard shipped for one round as an unconditional `extractText` compare,
      // which was correct and made `text` cost MORE than omitting it. Every
      // other spec here is green under that version.
      //
      // `Y.XmlText.prototype.toDelta` is the observable: `extractText` reads the
      // text through it (`document-model.ts:206`), while `flatDocLength` reads
      // only `child.length`. Spying on the Y.js prototype rather than mocking
      // `document-model` keeps the module under test unmocked.
      doc = makeDoc("hello world");
      const toDelta = vi.spyOn(Y.XmlText.prototype, "toDelta");
      try {
        expect(validateRange(doc, off(0), off(5), { text: "hello world" }).ok).toBe(true);
        expect(toDelta).not.toHaveBeenCalled();

        // Control: the same call WITHOUT the hoist does materialize, so the
        // assertion above is about the hoist and not about `validateRange`
        // having stopped reading the document.
        toDelta.mockClear();
        expect(validateRange(doc, off(0), off(5)).ok).toBe(true);
        expect(toDelta).toHaveBeenCalled();
      } finally {
        toDelta.mockRestore();
      }
    });

    it("throttles a tagged site to occurrences 1, 10 and 100 — and never throttles an untagged one", () => {
      doc = makeDoc("hello world");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // 100 bad calls under one tag. A per-occurrence log prints 100 lines; a
        // plain "log once" prints 1. Only `/^10*$/` prints exactly 3, so this
        // discriminates the throttle from both alternatives — asserting 1-in-9
        // did not, since `n !== 1` also passes it.
        //
        // The tag must be one of the five `HoistTag` literals (the union exists
        // so the module-global counter cannot grow unboundedly). The count
        // starts at zero because of the `beforeEach` reset above, not because
        // this literal happens to be unique in the file.
        for (let i = 0; i < 100; i++) {
          validateRange(doc, off(0), off(5), {
            text: "hello worlds",
            textTag: "docx-capture/score",
          });
        }
        expect(spy).toHaveBeenCalledTimes(3);

        // An untagged call is a one-off, not a loop: it always reports, and is
        // never silenced by an unrelated site's count.
        spy.mockClear();
        for (let i = 0; i < 5; i++) {
          validateRange(doc, off(0), off(5), { text: "hello worlds" });
        }
        expect(spy).toHaveBeenCalledTimes(5);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("anchoredRange passes every new opt through", () => {
    it("allowEmpty", () => {
      doc = makeDoc("hello world");
      expect(anchoredRange(doc, off(3), off(3)).ok).toBe(false);
      expect(anchoredRange(doc, off(3), off(3), undefined, { allowEmpty: true }).ok).toBe(true);
    });

    it('surrogates: "ignore"', () => {
      doc = makeDoc("a\u{1F600}b");
      expect(anchoredRange(doc, off(2), off(3)).ok).toBe(false);
      expect(anchoredRange(doc, off(2), off(3), undefined, { surrogates: "ignore" }).ok).toBe(true);
    });

    it("text", () => {
      doc = makeDoc("hello world");
      expect(anchoredRange(doc, off(0), off(5), undefined, { text: "hello world" }).ok).toBe(true);
    });
  });
});

describe("anchoredRange", () => {
  it("returns both flat and rel range", () => {
    doc = makeDoc("hello world");
    const result = anchoredRange(doc, off(0), off(5));
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

    const result = anchoredRange(doc, off(0), off(5), "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RANGE_MOVED");
  });

  it("omits relRange when offset is in heading prefix", () => {
    doc = makeDoc("## Title");
    const result = anchoredRange(doc, off(0), off(3));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // from=0 is inside "## " prefix → flatOffsetToRelPos returns null
      expect(result.relRange).toBeUndefined();
    }
  });

  it("succeeds without textSnapshot", () => {
    doc = makeDoc("hello");
    const result = anchoredRange(doc, off(0), off(5));
    expect(result.ok).toBe(true);
  });
});

describe("resolveToElement", () => {
  it("resolves offset in first paragraph", () => {
    doc = makeDoc("hello world");
    const fragment = getFragment(doc);
    const result = resolveToElement(fragment, off(3));
    expect(result).toEqual({ elementIndex: 0, textOffset: 3, clampedFromPrefix: false });
  });

  it("resolves offset in second paragraph", () => {
    doc = makeDoc("first\nsecond");
    const fragment = getFragment(doc);
    // "first" = 5 chars, \n = 1, "second" starts at 6
    const result = resolveToElement(fragment, off(8));
    expect(result).toEqual({ elementIndex: 1, textOffset: 2, clampedFromPrefix: false });
  });

  it("clamps offset in heading prefix", () => {
    doc = makeDoc("## Title");
    const fragment = getFragment(doc);
    // "## " is 3 chars, offset 1 is inside prefix
    const result = resolveToElement(fragment, off(1));
    expect(result).toEqual({ elementIndex: 0, textOffset: 0, clampedFromPrefix: true });
  });

  it("returns null for empty fragment", () => {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const result = resolveToElement(fragment, off(0));
    expect(result).toBeNull();
  });

  it("clamps past-end offset to last element", () => {
    doc = makeDoc("hello");
    const fragment = getFragment(doc);
    const result = resolveToElement(fragment, off(100));
    expect(result).toEqual({ elementIndex: 0, textOffset: 5, clampedFromPrefix: false });
  });

  it("resolves offset on separator boundary to end of preceding element", () => {
    doc = makeDoc("first\nsecond");
    const fragment = getFragment(doc);
    // "first" = 5 chars, separator at offset 5
    const result = resolveToElement(fragment, off(5));
    expect(result).toEqual({ elementIndex: 0, textOffset: 5, clampedFromPrefix: false });
  });
});

describe("flatOffsetToRelPos / relPosToFlatOffset round-trip", () => {
  it("round-trips a simple offset", () => {
    doc = makeDoc("hello world");
    const relPos = flatOffsetToRelPos(doc, off(6), 0);
    expect(relPos).not.toBeNull();
    const flat = relPosToFlatOffset(doc, relPos!);
    expect(flat).toBe(6);
  });

  it("returns null for heading prefix offset", () => {
    doc = makeDoc("## Title");
    const relPos = flatOffsetToRelPos(doc, off(1), 0); // inside "## "
    expect(relPos).toBeNull();
  });

  it("round-trips across multiple paragraphs", () => {
    doc = makeDoc("first\nsecond\nthird");
    const relPos = flatOffsetToRelPos(doc, off(13), 0); // start of "third"
    expect(relPos).not.toBeNull();
    const flat = relPosToFlatOffset(doc, relPos!);
    expect(flat).toBe(13);
  });

  it("survives concurrent edits", () => {
    doc = makeDoc("hello world");
    const relPos = flatOffsetToRelPos(doc, off(6), 0); // start of "world"
    expect(relPos).not.toBeNull();

    // Insert before
    const fragment = getFragment(doc);
    const el = fragment.get(0) as Y.XmlElement;
    getOrCreateXmlText(el).insert(0, "XXX");

    const flat = relPosToFlatOffset(doc, relPos!);
    expect(flat).toBe(9); // shifted by 3
  });

  it("returns null for malformed relRange JSON", () => {
    doc = makeDoc("hello");
    // Deliberately malformed input to verify defensive handling — the cast
    // documents that these values violate SerializedRelPos on purpose.
    expect(relPosToFlatOffset(doc, "not-json" as unknown as SerializedRelPos)).toBeNull();
    expect(relPosToFlatOffset(doc, { garbage: true } as unknown as SerializedRelPos)).toBeNull();
    expect(relPosToFlatOffset(doc, null as unknown as SerializedRelPos)).toBeNull();
    expect(relPosToFlatOffset(doc, 42 as unknown as SerializedRelPos)).toBeNull();
  });
});

describe("refreshRange (via positions module)", () => {
  function makeAnchoredAnnotation(
    map: Y.Map<unknown>,
    from: FlatOffset,
    to: FlatOffset,
    ydoc?: Y.Doc,
  ): Annotation {
    const result = ydoc
      ? anchoredRange(ydoc, from, to)
      : { ok: true as const, range: { from, to } };
    if (!result.ok) throw new Error("Failed");
    const id = `ann_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const ann = makeAnnotation({
      id,
      range: result.range,
      ...("relRange" in result && result.relRange ? { relRange: result.relRange } : {}),
    });
    map.set(id, ann);
    return ann;
  }

  it("lazily attaches relRange", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = makeAnchoredAnnotation(map, off(0), off(5)); // no ydoc → no relRange

    expect(ann.relRange).toBeUndefined();
    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.kind).toBe("attached");
    expect(refreshed.annotation.relRange).toBeDefined();
  });

  it("updates stale flat offsets after edit", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = makeAnchoredAnnotation(map, off(6), off(11), doc);

    // Insert before annotation
    const fragment = getFragment(doc);
    const el = fragment.get(0) as Y.XmlElement;
    getOrCreateXmlText(el).insert(0, "XXX");

    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.kind).toBe("updated");
    expect(refreshed.annotation.range).toEqual({ from: 9, to: 14 });
  });

  it("returns the original annotation when CRDT resolves to inverted range", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = makeAnchoredAnnotation(map, off(0), off(5), doc); // "hello"

    // Manually craft an inverted relRange by swapping fromRel and toRel
    const invertedAnn: Annotation = {
      ...ann,
      relRange: ann.relRange
        ? { fromRel: ann.relRange.toRel, toRel: ann.relRange.fromRel }
        : undefined,
    };
    map.set(invertedAnn.id, invertedAnn);

    const refreshed = refreshRange(invertedAnn, doc, map);
    // Inverted ranges surface as kind: "failed" (ADR-032) with the annotation
    // returned unchanged so callers can decide how to handle the degradation.
    expect(refreshed.kind).toBe("failed");
    expect(refreshed.annotation.range).toEqual(invertedAnn.range);
  });
});

/**
 * #1764 — `refreshRange` runs from a READ path (`listAnnotationsRefreshed`) and
 * writes through the caller's map on three arms. Each of those arms would
 * otherwise mint or overwrite an anchor from the annotation's STORED flat
 * offsets with nothing checking that those offsets still describe the text the
 * record captured.
 */
describe("refreshRange — the stored-range gate (#1764)", () => {
  /** Anchor `[from, to)` and store the record, with whatever extras are given. */
  function seed(
    d: Y.Doc,
    map: Y.Map<unknown>,
    from: number,
    to: number,
    extras: Partial<Annotation> = {},
    opts?: { allowEmpty?: boolean },
  ): Annotation {
    const result = anchoredRange(d, off(from), off(to), undefined, opts);
    if (!result.ok) throw new Error(`anchoredRange failed: ${JSON.stringify(result)}`);
    const ann = makeAnnotation({
      id: "ann_gate",
      range: result.range,
      ...(result.fullyAnchored ? { relRange: result.relRange } : {}),
      ...extras,
    });
    map.set(ann.id, ann);
    return ann;
  }

  /** The `default` fragment's single paragraph, as a Y.XmlText. */
  function textOf(d: Y.Doc): Y.XmlText {
    return getOrCreateXmlText(getFragment(d).get(0) as Y.XmlElement);
  }

  /**
   * Replace the whole fragment with one paragraph holding `text`, which is what
   * kills a relRange: the referenced Y.XmlText is deleted outright, so
   * `relPosToFlatOffset` answers null and the dead-relRange arm runs.
   */
  function replaceContent(d: Y.Doc, text: string): void {
    const fragment = getFragment(d);
    fragment.delete(0, fragment.length);
    const el = new Y.XmlElement("paragraph");
    fragment.insert(0, [el]);
    el.insert(0, [new Y.XmlText(text)]);
  }

  it("preserves a SPURIOUS collapse: degraded, and nothing is written", () => {
    // Both anchors resolve onto one offset while the annotated text is still
    // there — the block-split / heading-toggle / join shape. Persisting {6,6}
    // would destroy the stored flat range the watcher's snapshot relocation
    // needs, and undo would then resolve the two zero-width anchors to opposite
    // ends and strand the record as `failed` forever.
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = seed(doc, map, 6, 11, { textSnapshot: "world" });
    const stored = map.get(ann.id);

    const xt = textOf(doc);
    xt.delete(6, 5);
    xt.insert(6, "world");
    expect(extractText(doc)).toBe("hello world");
    expect(relPosToFlatOffset(doc, ann.relRange!.fromRel)).toBe(6);
    expect(relPosToFlatOffset(doc, ann.relRange!.toRel)).toBe(6);

    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.kind).toBe("degraded");
    expect(refreshed.annotation.range).toEqual({ from: 6, to: 11 });
    // `toBe`, not `toEqual`: a fix that returns `degraded` but still writes
    // would leave an equal-looking but different object here.
    expect(map.get(ann.id)).toBe(stored);
  });

  it("still refreshes an ALREADY-empty range normally", () => {
    // Kills a bare `newFrom === newTo` guard: a point annotation (Word's
    // insertion markers are exactly this) legitimately resolves to an equal
    // pair and must keep tracking the document.
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = seed(doc, map, 6, 6, { textSnapshot: "" }, { allowEmpty: true });

    textOf(doc).insert(0, "XX");

    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.kind).toBe("updated");
    expect(refreshed.annotation.range).toEqual({ from: 8, to: 8 });
  });

  it("still collapses a GENUINE deletion, and writes it", () => {
    // The same {n,n} shape with the opposite cause: the annotated span is gone,
    // so the stored slice no longer holds the snapshot and {6,6} is correct.
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = seed(doc, map, 6, 11, { textSnapshot: "world" });

    textOf(doc).delete(6, 5);

    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.kind).toBe("updated");
    expect(refreshed.annotation.range).toEqual({ from: 6, to: 6 });
    expect((map.get(ann.id) as Annotation).range).toEqual({ from: 6, to: 6 });
  });

  it("refuses the dead-relRange REPAIR when the stored range contradicts its snapshot", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = seed(doc, map, 6, 11, { textSnapshot: "world" });

    // Content replacement: the relRange dies, and [6,11) now holds "planet"'s
    // text rather than "world".
    replaceContent(doc, "hello planet!");
    expect(relPosToFlatOffset(doc, ann.relRange!.fromRel)).toBeNull();

    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.kind).toBe("degraded");
    // The dead relRange is STRIPPED, never preserved — that is unchanged, and
    // it is what keeps the lazy re-attachment path reachable. What is NOT done
    // is minting a fresh one over the wrong span.
    expect(refreshed.annotation.relRange).toBeUndefined();
    expect((map.get(ann.id) as Annotation).relRange).toBeUndefined();
  });

  it("still REPAIRS a dead relRange when the stored range still holds its snapshot", () => {
    // The negative twin. Without it the fix could refuse everything.
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = seed(doc, map, 6, 11, { textSnapshot: "world" });

    replaceContent(doc, "hello world");

    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.kind).toBe("repaired");
    expect(refreshed.annotation.relRange).toBeDefined();
    expect(refreshed.annotation.range).toEqual({ from: 6, to: 11 });
  });

  it("still REPAIRS a byte-exact clone — the #1800 regression guard", () => {
    // `repairClonedAnchors` (`documents/annotation-wiring.ts`) runs
    // `refreshAllRanges` over a document whose content was rebuilt identically:
    // every relRange is dead and every stored range is exactly right.
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const a = seed(doc, map, 0, 5, { id: "a", textSnapshot: "hello" });
    const b = seed(doc, map, 6, 11, { id: "b", textSnapshot: "world" });

    replaceContent(doc, "hello world");

    expect(refreshAllRanges([a, b], doc, map).map((r) => r.kind)).toEqual(["repaired", "repaired"]);
  });

  it("refuses the LAZY ATTACH when the stored range contradicts its snapshot", () => {
    // Kills fixing only the `repaired` arm: a stripped record comes back here
    // on the very next call, and this arm is the same unverified mint.
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const ann = makeAnnotation({
      id: "ann_lazy",
      range: { from: off(6), to: off(11) },
      textSnapshot: "planet",
    });
    map.set(ann.id, ann);

    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.kind).toBe("degraded");
    expect(refreshed.annotation.relRange).toBeUndefined();
    expect((map.get(ann.id) as Annotation).relRange).toBeUndefined();
  });

  describe("a record with NO textSnapshot — the two carve-outs point opposite ways", () => {
    // Assumptions is not a test, and a "consistency" tidy here changes .docx
    // export bytes silently: `docx-comments.ts` strips the snapshot off every
    // imported Word comment, and `docx-comment-export.ts` writes the refreshed
    // range back into the user's file.

    it("still ATTACHES on the lazy arm", () => {
      doc = makeDoc("hello world");
      const map = getAnnotationsMap(doc);
      const ann = makeAnnotation({ id: "ann_ns", range: { from: off(6), to: off(11) } });
      map.set(ann.id, ann);

      const refreshed = refreshRange(ann, doc, map);
      expect(refreshed.kind).toBe("attached");
      expect(refreshed.annotation.relRange).toBeDefined();
    });

    it("still REPAIRS a dead relRange over text that moved", () => {
      doc = makeDoc("hello world");
      const map = getAnnotationsMap(doc);
      const ann = seed(doc, map, 6, 11);
      expect(ann.textSnapshot).toBeUndefined();

      replaceContent(doc, "hello planet!");

      const refreshed = refreshRange(ann, doc, map);
      expect(refreshed.kind).toBe("repaired");
      expect(refreshed.annotation.relRange).toBeDefined();
    });

    it("but a COLLAPSE is still written as {n, n}", () => {
      // The opposite carve-out, and the one that keeps the .docx export's bytes
      // unchanged for the snapshot-less population. A preserve here would turn
      // a zero-width anchor at the deletion point into a stale non-empty span
      // and export a Word comment over unrelated text.
      doc = makeDoc("hello world");
      const map = getAnnotationsMap(doc);
      const ann = seed(doc, map, 6, 11);

      const xt = textOf(doc);
      xt.delete(6, 5);
      xt.insert(6, "world");

      const refreshed = refreshRange(ann, doc, map);
      expect(refreshed.kind).toBe("updated");
      expect(refreshed.annotation.range).toEqual({ from: 6, to: 6 });
      expect((map.get(ann.id) as Annotation).range).toEqual({ from: 6, to: 6 });
    });
  });
});

describe("refreshAllRanges", () => {
  it("batch refreshes in a transaction", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);

    // Create two annotations with relRange
    const result1 = anchoredRange(doc, off(0), off(5));
    const result2 = anchoredRange(doc, off(6), off(11));
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
    expect(refreshed[0].annotation.range).toEqual({ from: 2, to: 7 });
    expect(refreshed[1].annotation.range).toEqual({ from: 8, to: 13 });
    expect(refreshed[0].kind).toBe("updated");
    expect(refreshed[1].kind).toBe("updated");
  });
});

// ---------------------------------------------------------------------------
// Phase B: list content position tests
// ---------------------------------------------------------------------------

describe("list content positions (Phase B)", () => {
  it("flatOffsetToRelPos returns non-null for list item content", () => {
    doc = makeMarkdownDoc("- Item in a list\n- Second item");
    const flat = extractText(doc);
    const itemIdx = flat.indexOf("Item in a list");
    expect(itemIdx).toBeGreaterThanOrEqual(0);

    const relPos = flatOffsetToRelPos(doc, off(itemIdx), 0);
    expect(relPos).not.toBeNull();
  });

  it("flatOffsetToRelPos / relPosToFlatOffset round-trips for list item content", () => {
    doc = makeMarkdownDoc("- First item\n- Second item\n- Third item");
    const flat = extractText(doc);

    const secondIdx = flat.indexOf("Second item");
    expect(secondIdx).toBeGreaterThanOrEqual(0);

    const relPos = flatOffsetToRelPos(doc, off(secondIdx), 0);
    expect(relPos).not.toBeNull();

    const resolved = relPosToFlatOffset(doc, relPos!);
    expect(resolved).toBe(secondIdx);
  });

  it("anchoredRange produces fullyAnchored: true for list content", () => {
    doc = makeMarkdownDoc("- Alpha item\n- Beta item");
    const flat = extractText(doc);

    const target = "Alpha item";
    const idx = flat.indexOf(target);
    expect(idx).toBeGreaterThanOrEqual(0);

    const result = anchoredRange(doc, off(idx), off(idx + target.length), target);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fullyAnchored).toBe(true);
      expect(result.relRange).toBeDefined();
    }
  });

  it("flatOffsetToRelPos / relPosToFlatOffset round-trips across all list item offsets", () => {
    doc = makeMarkdownDoc("- Alpha\n- Beta");
    const flat = extractText(doc);
    // Test every offset in the flat text
    for (let offset = 0; offset < flat.length; offset++) {
      if (flat[offset] === "\n") continue; // separators are gaps, skip
      const relPos = flatOffsetToRelPos(doc, off(offset), 0);
      if (relPos !== null) {
        const resolved = relPosToFlatOffset(doc, relPos!);
        expect(resolved).toBe(offset);
      }
    }
  });
});

/**
 * The pure core, for the two callers that hold the flat text but deliberately
 * no `Y.Doc`: `tandem_getContext` (through a `YDocStore`) and the `.docx`
 * comment export resolver.
 */
describe("validateFlatRange (pure)", () => {
  function failure(result: RangeValidation): string {
    if (result.ok) return "ok";
    return result.code === "INVALID_RANGE" ? result.reason : result.code;
  }

  it("answers on the string it is given, in the same order", () => {
    expect(validateFlatRange("hello world", 0, 5).ok).toBe(true);
    expect(validateFlatRange("hello world", 0, 11).ok, "to === length").toBe(true);
    expect(failure(validateFlatRange("hello world", 0, 12))).toBe("out-of-bounds");
    expect(failure(validateFlatRange("hello world", -1, 5))).toBe("out-of-bounds");
    expect(failure(validateFlatRange("hello world", 1.5, 5))).toBe("non-integer");
    expect(failure(validateFlatRange("hello world", 7, 2))).toBe("inverted");
    expect(failure(validateFlatRange("hello world", 3, 3))).toBe("empty");
    expect(validateFlatRange("hello world", 3, 3, { allowEmpty: true }).ok).toBe(true);
  });

  it("applies the paired surrogate predicate, and honours the ignore policy", () => {
    expect(failure(validateFlatRange("a\u{1F600}b", 2, 3))).toBe("surrogate");
    expect(failure(validateFlatRange("a\u{1F600}b", 0, 2))).toBe("surrogate");
    // The adjacent-astral control: offset 2 has no alternative and must pass.
    expect(validateFlatRange("\u{1F600}\u{1F600}", 2, 4).ok).toBe(true);
    expect(validateFlatRange("a\u{1F600}b", 2, 3, { surrogates: "ignore" }).ok).toBe(true);
  });
});
