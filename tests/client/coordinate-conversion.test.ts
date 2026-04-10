import { describe, expect, it } from "vitest";
import {
  annotationToPmRange,
  flatOffsetToPmPos,
  pmPosToFlatOffset,
  relRangeToPmPositions,
} from "../../src/client/positions";
import { flatOffsetToRelPos } from "../../src/server/positions";
import { getFragment, makeAnnotation, makeDoc } from "../helpers/ydoc-factory";

// Minimal ProseMirror-compatible mock. Assumes single flat text run per block
// (no inline marks). nodeSize = 1 (open) + text.length + 1 (close).
type MockBlock = {
  type: { name: string };
  attrs: { level: number };
  textContent: string;
  nodeSize: number;
};

function makeMockDoc(
  blocks: Array<{ type: "heading" | "paragraph"; level?: number; text: string }>,
) {
  const children: MockBlock[] = blocks.map((b) => ({
    type: { name: b.type },
    attrs: { level: b.level ?? 0 },
    textContent: b.text,
    nodeSize: 2 + b.text.length,
  }));
  return {
    childCount: children.length,
    child: (i: number) => children[i],
    content: { size: children.reduce((s, c) => s + c.nodeSize, 0) },
  };
}

describe("flatOffsetToPmPos", () => {
  it("single paragraph", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    // Flat: "Hello" (length 5). PM: para open at 0, text at 1–5, close at 6. content.size=7
    expect(flatOffsetToPmPos(doc as any, 0)).toBe(1);
    expect(flatOffsetToPmPos(doc as any, 2)).toBe(3);
    expect(flatOffsetToPmPos(doc as any, 4)).toBe(5);
    expect(flatOffsetToPmPos(doc as any, 5)).toBe(doc.content.size); // past end → content.size
  });

  it('H1 heading — prefix "# " (length 2) clamps to text start', () => {
    const doc = makeMockDoc([{ type: "heading", level: 1, text: "Hello" }]);
    // Flat: "# Hello" — prefix at 0-1, text at 2-6
    expect(flatOffsetToPmPos(doc as any, 0)).toBe(1); // inside prefix → clamp
    expect(flatOffsetToPmPos(doc as any, 1)).toBe(1); // inside prefix → clamp
    expect(flatOffsetToPmPos(doc as any, 2)).toBe(1); // first text char 'H'
    expect(flatOffsetToPmPos(doc as any, 3)).toBe(2); // second text char 'e'
  });

  it("H2 heading + paragraph", () => {
    const doc = makeMockDoc([
      { type: "heading", level: 2, text: "Title" },
      { type: "paragraph", text: "Body" },
    ]);
    // Flat: "## Title\nBody"
    // Prefix "## " at 0-2 (len=3), "Title" at 3-7, separator at 8, "Body" at 9-12
    // PM: heading node start=1; para node start=8 (heading nodeSize=7, para childStart=7+1=8)
    expect(flatOffsetToPmPos(doc as any, 0)).toBe(1); // prefix → clamp
    expect(flatOffsetToPmPos(doc as any, 1)).toBe(1); // prefix → clamp
    expect(flatOffsetToPmPos(doc as any, 2)).toBe(1); // prefix → clamp
    // PM pos 1 = "start of heading text content" — the heading prefix has no PM representation
    expect(flatOffsetToPmPos(doc as any, 3)).toBe(1); // first char 'T', textOffset = max(0, 3-3) = 0
    expect(flatOffsetToPmPos(doc as any, 5)).toBe(3); // 't' in Title
    expect(flatOffsetToPmPos(doc as any, 7)).toBe(5); // last char 'e'
    expect(flatOffsetToPmPos(doc as any, 8)).toBe(6); // separator → end of heading (childStart+textLen = 1+5)
    expect(flatOffsetToPmPos(doc as any, 9)).toBe(8); // first char of para
    expect(flatOffsetToPmPos(doc as any, 12)).toBe(11); // last char of para
  });

  it('H3 heading — prefix "### " (length 4) clamps to text start', () => {
    const doc = makeMockDoc([{ type: "heading", level: 3, text: "Test" }]);
    // Flat: "### Test" — prefix at 0-3, text at 4-7
    expect(flatOffsetToPmPos(doc as any, 0)).toBe(1); // prefix → clamp
    expect(flatOffsetToPmPos(doc as any, 3)).toBe(1); // last prefix char → clamp
    expect(flatOffsetToPmPos(doc as any, 4)).toBe(1); // first text char 'T', textOffset = max(0, 4-4) = 0
    expect(flatOffsetToPmPos(doc as any, 5)).toBe(2); // 'e'
  });

  it("empty doc", () => {
    const doc = makeMockDoc([]);
    expect(flatOffsetToPmPos(doc as any, 0)).toBe(0); // doc.content.size = 0
  });
});

describe("pmPosToFlatOffset", () => {
  it("single paragraph", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    // nodeStart=1, textLen=5, nodeEnd=6
    expect(pmPosToFlatOffset(doc as any, 0)).toBe(0); // pmPos <= nodeStart → flatOffset+0 = 0
    expect(pmPosToFlatOffset(doc as any, 1)).toBe(0); // pmPos <= nodeStart → 0
    expect(pmPosToFlatOffset(doc as any, 3)).toBe(2); // offsetInNode=2
    expect(pmPosToFlatOffset(doc as any, 5)).toBe(4); // offsetInNode=4
    expect(pmPosToFlatOffset(doc as any, 6)).toBe(5); // past end → loop exhausted
  });

  it("H2 heading + paragraph", () => {
    const doc = makeMockDoc([
      { type: "heading", level: 2, text: "Title" },
      { type: "paragraph", text: "Body" },
    ]);
    // Heading: nodeStart=1, prefixLen=3, textLen=5, nodeEnd=6
    // Para: nodeStart=8 (pmOffset=7 after heading), prefixLen=0, textLen=4
    expect(pmPosToFlatOffset(doc as any, 0)).toBe(3); // pmPos=0 <= nodeStart=1 → 0+3=3
    expect(pmPosToFlatOffset(doc as any, 1)).toBe(3); // pmPos=1 <= nodeStart=1 → 0+3=3
    expect(pmPosToFlatOffset(doc as any, 3)).toBe(5); // offsetInNode=2 → 0+3+2=5
    expect(pmPosToFlatOffset(doc as any, 6)).toBe(8); // offsetInNode=5 → 0+3+5=8 (separator)
    expect(pmPosToFlatOffset(doc as any, 8)).toBe(9); // para: pmPos=8 <= nodeStart=8 → 9+0=9
    expect(pmPosToFlatOffset(doc as any, 11)).toBe(12);
  });

  it("empty doc", () => {
    const doc = makeMockDoc([]);
    expect(pmPosToFlatOffset(doc as any, 0)).toBe(0);
  });
});

describe("round-trip: pmPosToFlatOffset(flatOffsetToPmPos(offset)) === offset", () => {
  it("identity for non-prefix flat offsets in H2 heading + paragraph doc", () => {
    const doc = makeMockDoc([
      { type: "heading", level: 2, text: "Title" },
      { type: "paragraph", text: "Body" },
    ]);
    // Flat: "## Title\nBody" — text starts at offset 3
    const identityOffsets = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    for (const offset of identityOffsets) {
      const pm = flatOffsetToPmPos(doc as any, offset);
      expect(pmPosToFlatOffset(doc as any, pm)).toBe(offset);
    }
  });

  it("prefix offsets collapse to first text char (expected behavior)", () => {
    const doc = makeMockDoc([
      { type: "heading", level: 2, text: "Title" },
      { type: "paragraph", text: "Body" },
    ]);
    // Prefix positions (0, 1, 2) have no PM representation — they all map to PM 1,
    // and PM 1 maps back to flat offset 3 (first text char, after "## ").
    for (const prefixOffset of [0, 1, 2]) {
      const pm = flatOffsetToPmPos(doc as any, prefixOffset);
      expect(pm).toBe(1);
      expect(pmPosToFlatOffset(doc as any, pm)).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// annotationToPmRange
// ---------------------------------------------------------------------------

describe("annotationToPmRange", () => {
  it("relRange path returns method 'rel'", () => {
    // Y.Doc: single paragraph "Hello"
    const ydoc = makeDoc("Hello");
    const pmDoc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);

    const fromRel = flatOffsetToRelPos(ydoc, 0, 0);
    const toRel = flatOffsetToRelPos(ydoc, 5, -1);
    const ann = makeAnnotation({
      range: { from: 0, to: 5 },
      relRange: { fromRel: fromRel!, toRel: toRel! },
    });

    const result = annotationToPmRange(ann, pmDoc as any, ydoc);
    expect(result).not.toBeNull();
    expect(result!.method).toBe("rel");
    expect(result!.from).toBe(1); // PM pos 1 = start of paragraph text
    expect(result!.to).toBe(6); // PM pos 6 = end of paragraph text
  });

  it("flat fallback returns method 'flat' when no relRange", () => {
    const pmDoc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    const ann = makeAnnotation({ range: { from: 0, to: 5 } });

    const result = annotationToPmRange(ann, pmDoc as any, null);
    expect(result).not.toBeNull();
    expect(result!.method).toBe("flat");
  });

  it("flat fallback when ydoc is null", () => {
    const pmDoc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    const ydoc = makeDoc("Hello");
    const fromRel = flatOffsetToRelPos(ydoc, 0, 0);
    const toRel = flatOffsetToRelPos(ydoc, 5, -1);
    const ann = makeAnnotation({
      range: { from: 0, to: 5 },
      relRange: { fromRel: fromRel!, toRel: toRel! },
    });

    // Even though relRange exists, ydoc=null forces flat fallback
    const result = annotationToPmRange(ann, pmDoc as any, null);
    expect(result).not.toBeNull();
    expect(result!.method).toBe("flat");
  });

  it("returns null when no range at all", () => {
    const pmDoc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    const ann = makeAnnotation({});
    // Remove range to simulate missing data
    (ann as any).range = undefined;

    const result = annotationToPmRange(ann, pmDoc as any, null);
    expect(result).toBeNull();
  });

  it("falls back to flat when relRange resolves from > to (CRDT inversion)", () => {
    // Create a Y.Doc, get relRange, then delete content to cause inversion
    const ydoc = makeDoc("ABCDE");
    const pmDoc = makeMockDoc([{ type: "paragraph", text: "ABCDE" }]);

    const fromRel = flatOffsetToRelPos(ydoc, 3, 0); // points to 'D'
    const toRel = flatOffsetToRelPos(ydoc, 1, -1); // points to 'B'
    // Construct an inverted relRange (from > to)
    const ann = makeAnnotation({
      range: { from: 1, to: 3 },
      relRange: { fromRel: fromRel!, toRel: toRel! },
    });

    const result = annotationToPmRange(ann, pmDoc as any, ydoc);
    // Should fall back to flat since rel resolves inverted
    expect(result).not.toBeNull();
    expect(result!.method).toBe("flat");
  });

  it("returns null for malformed relRange JSON", () => {
    const ydoc = makeDoc("Hello");
    const pmDoc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    const ann = makeAnnotation({
      range: { from: 0, to: 5 },
      relRange: { fromRel: "garbage", toRel: "garbage" },
    });

    // Should fall back to flat (malformed relRange caught internally)
    const result = annotationToPmRange(ann, pmDoc as any, ydoc);
    expect(result).not.toBeNull();
    expect(result!.method).toBe("flat");
  });
});

// ---------------------------------------------------------------------------
// relRangeToPmPositions
// ---------------------------------------------------------------------------

describe("relRangeToPmPositions", () => {
  it("correct positions for single paragraph", () => {
    const ydoc = makeDoc("Hello");
    const pmDoc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);

    const fromRel = flatOffsetToRelPos(ydoc, 1, 0)!;
    const toRel = flatOffsetToRelPos(ydoc, 4, -1)!;

    const result = relRangeToPmPositions(ydoc, pmDoc as any, { fromRel, toRel });
    expect(result).not.toBeNull();
    // Flat offset 1 = 'e' → PM pos 2; flat offset 4 = 'o' → PM pos 5
    expect(result!.from).toBe(2);
    expect(result!.to).toBe(5);
  });

  it("returns null for deleted content", () => {
    const ydoc = makeDoc("Hello");
    const fromRel = flatOffsetToRelPos(ydoc, 0, 0)!;
    const toRel = flatOffsetToRelPos(ydoc, 5, -1)!;

    // Delete all content — RelativePositions now point to deleted items
    const fragment = getFragment(ydoc);
    fragment.delete(0, fragment.length);

    const pmDoc = makeMockDoc([]);
    const result = relRangeToPmPositions(ydoc, pmDoc as any, { fromRel, toRel });
    expect(result).toBeNull();
  });

  it("returns null for malformed relRange JSON", () => {
    const ydoc = makeDoc("Hello");
    const pmDoc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);

    const result = relRangeToPmPositions(ydoc, pmDoc as any, {
      fromRel: { bogus: true },
      toRel: 42,
    });
    expect(result).toBeNull();
  });
});
