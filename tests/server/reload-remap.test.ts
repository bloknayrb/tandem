/**
 * The reload remap's own arithmetic and decisions (#2269), against a real
 * Y.Doc but without the open/reload plumbing — the integration paths are in
 * `reload-reanchor-2269.test.ts`.
 *
 * Every assertion about a record checks the TEXT its range resolves to (and,
 * where it matters, `refreshRange`'s verdict), never just a size: a range can
 * have the right length over the wrong text.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyRemap,
  captureRemapInput,
  type Hunk,
  lineHunks,
  mapRange,
  type ReloadRemap,
  remapEnvelopeWins,
} from "../../src/server/documents/reload-remap.js";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { anchoredRange, refreshRange } from "../../src/server/positions.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withMcp, withReload } from "../../src/shared/origins.js";
import { type DocumentRange, toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types.js";
import { makeAnnotation, makeMarkdownDoc } from "../helpers/ydoc-factory.js";

const FILE = "/virtual/remap.md";

/** Rebuild `newText` from `oldText` and the hunks — the invariant every hunk list must satisfy. */
function applyHunks(oldText: string, newText: string, hunks: Hunk[]): string {
  let out = "";
  let at = 0;
  for (const h of hunks) {
    out += oldText.slice(at, h.oldFrom) + newText.slice(h.newFrom, h.newTo);
    at = h.oldTo;
  }
  return out + oldText.slice(at);
}

const r = (from: number, to: number): DocumentRange => ({
  from: toFlatOffset(from),
  to: toFlatOffset(to),
});

describe("lineHunks", () => {
  it("returns nothing for identical text", () => {
    expect(lineHunks("a\nb", "a\nb")).toEqual([]);
  });

  const PAIRS: Array<[string, string, string]> = [
    ["paragraph inserted above", "alpha\nbravo", "new\nalpha\nbravo"],
    ["paragraph appended (no trailing newline)", "alpha\nbravo", "alpha\nbravo\ncharlie"],
    ["last paragraph deleted", "alpha\nbravo\ncharlie", "alpha\nbravo"],
    ["first paragraph deleted", "alpha\nbravo", "bravo"],
    ["one word changed", "the quick brown fox", "the quick red fox"],
    ["two scattered edits", "a1\nb\nc\nd\ne1", "a2\nb\nc\nd\ne2"],
    ["everything replaced", "old text", "something else"],
    ["to empty", "gone\nall", ""],
    ["from empty", "", "born\nnew"],
    ["heading prefix added", "Title\nbody", "## Title\nbody"],
  ];
  for (const [name, oldText, newText] of PAIRS) {
    it(`reconstructs the new text: ${name}`, () => {
      const hunks = lineHunks(oldText, newText);
      expect(applyHunks(oldText, newText, hunks)).toBe(newText);
      for (let i = 1; i < hunks.length; i++) {
        expect(hunks[i].oldFrom, "ascending and disjoint").toBeGreaterThanOrEqual(
          hunks[i - 1].oldTo,
        );
      }
    });
  }

  it("narrows a changed line to the units that differ", () => {
    expect(lineHunks("the quick brown fox", "the quick red fox")).toEqual([
      { oldFrom: 10, oldTo: 15, newFrom: 10, newTo: 13 },
    ]);
  });

  it("does not treat the last line as changed when text is appended after it", () => {
    // Without the sentinel, "bravo" vs "bravo\n" is a changed line.
    expect(lineHunks("alpha\nbravo", "alpha\nbravo\ncharlie")).toEqual([
      { oldFrom: 11, oldTo: 11, newFrom: 11, newTo: 19 },
    ]);
  });

  it("never cuts a hunk between the halves of a surrogate pair", () => {
    // 😀 = D83D DE00, 😃 = D83D DE03: they share a high surrogate, so naive
    // narrowing would start the hunk at the low half.
    const hunks = lineHunks("a\u{1F600}b", "a\u{1F603}b");
    expect(hunks).toEqual([{ oldFrom: 1, oldTo: 3, newFrom: 1, newTo: 3 }]);
  });

  it("falls back to one narrowed hunk when the edit budget is exceeded", () => {
    const oldText = Array.from({ length: 2500 }, (_, i) => `old line ${i}`).join("\n");
    const newText = Array.from({ length: 2500 }, (_, i) => `new line ${i}`).join("\n");
    const hunks = lineHunks(`keep\n${oldText}\nkeep`, `keep\n${newText}\nkeep`);
    expect(hunks).toHaveLength(1);
    expect(applyHunks(`keep\n${oldText}\nkeep`, `keep\n${newText}\nkeep`, hunks)).toBe(
      `keep\n${newText}\nkeep`,
    );
    expect(hunks[0].oldFrom, "the common prefix stays outside").toBe(5);
  });
});

describe("mapRange", () => {
  // "0123456789": replace [4,6) with 4 units (delta +2).
  const REPLACE: Hunk[] = [{ oldFrom: 4, oldTo: 6, newFrom: 4, newTo: 8 }];
  // insert 3 units at 4.
  const INSERT: Hunk[] = [{ oldFrom: 4, oldTo: 4, newFrom: 4, newTo: 7 }];
  // delete [4,6).
  const DELETE: Hunk[] = [{ oldFrom: 4, oldTo: 6, newFrom: 4, newTo: 4 }];

  it("leaves a range before the hunk alone, ending exactly at it included", () => {
    expect(mapRange(r(0, 4), REPLACE)).toEqual(r(0, 4));
  });
  it("shifts a range after the hunk, starting exactly at its end included", () => {
    expect(mapRange(r(6, 9), REPLACE)).toEqual(r(8, 11));
  });
  it("refuses a range whose endpoint is inside a replaced region", () => {
    expect(mapRange(r(5, 9), REPLACE)).toBeNull();
    expect(mapRange(r(0, 5), REPLACE)).toBeNull();
    expect(mapRange(r(4, 9), REPLACE), "start on the first replaced unit").toBeNull();
    expect(mapRange(r(0, 6), REPLACE), "end on the last replaced unit").toBeNull();
  });
  it("maps the endpoints of a range that CONTAINS the hunk", () => {
    expect(mapRange(r(2, 8), REPLACE)).toEqual(r(2, 10));
  });
  it("keeps text inserted at either endpoint outside the range", () => {
    expect(mapRange(r(4, 8), INSERT), "inserted at the start").toEqual(r(7, 11));
    expect(mapRange(r(1, 4), INSERT), "inserted at the end").toEqual(r(1, 4));
    expect(mapRange(r(2, 6), INSERT), "inserted inside").toEqual(r(2, 9));
  });
  it("maps an endpoint inside a pure deletion to the deletion point", () => {
    expect(mapRange(r(2, 5), DELETE)).toEqual(r(2, 4));
    expect(mapRange(r(5, 9), DELETE)).toEqual(r(4, 7));
    expect(mapRange(r(4, 6), DELETE), "wholly deleted: both meet").toEqual(r(4, 4));
  });
  it("carries a point with the text after it, at both boundaries", () => {
    expect(mapRange(r(4, 4), INSERT), "an insertion at the point lands before it").toEqual(r(7, 7));
    expect(mapRange(r(4, 4), REPLACE), "at a replaced region's start").toEqual(r(4, 4));
    expect(mapRange(r(6, 6), REPLACE), "at a replaced region's end").toEqual(r(8, 8));
    expect(mapRange(r(5, 5), REPLACE), "strictly inside").toBeNull();
  });
});

// ---------------------------------------------------------------------------
// With a Y.Doc
// ---------------------------------------------------------------------------

/** Replace `doc`'s content with `markdown` the way a reload does: one transaction, remap inside. */
function reload(doc: Y.Doc, markdown: string): ReloadRemap {
  let remap: ReloadRemap | undefined;
  withReload(doc, () => {
    const input = captureRemapInput(doc, FILE);
    loadMarkdown(doc, markdown);
    remap = applyRemap(doc, input);
  });
  if (!remap) throw new Error("remap did not run");
  return remap;
}

function annotationsOf(doc: Y.Doc): Y.Map<Annotation> {
  return doc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
}

/** Seed a record over the first occurrence of `text` (anchored, with a snapshot). */
function seedOn(doc: Y.Doc, id: string, text: string, nth = 0, extra: Partial<Annotation> = {}) {
  const flat = extractText(doc);
  let idx = -1;
  for (let i = 0; i <= nth; i++) idx = flat.indexOf(text, idx + 1);
  if (idx < 0) throw new Error(`"${text}" not found`);
  const result = anchoredRange(doc, toFlatOffset(idx), toFlatOffset(idx + text.length), text);
  if (!result.ok) throw new Error("anchoredRange failed");
  const ann = makeAnnotation({
    id,
    range: result.range,
    ...(result.fullyAnchored ? { relRange: result.relRange } : {}),
    textSnapshot: text,
    ...extra,
  });
  withMcp(doc, () => annotationsOf(doc).set(id, ann));
  return ann;
}

/** The text an annotation's stored range covers right now. */
function textOf(doc: Y.Doc, id: string): string {
  const ann = annotationsOf(doc).get(id);
  if (!ann) throw new Error(`${id} vanished`);
  return extractText(doc).slice(ann.range.from, ann.range.to);
}

function kindOf(doc: Y.Doc, id: string): string {
  const ann = annotationsOf(doc).get(id);
  if (!ann) throw new Error(`${id} vanished`);
  return refreshRange(ann, doc).kind;
}

describe("applyRemap — records outside every changed region", () => {
  it("carries a record across an unrelated edit and re-anchors it", () => {
    const doc = makeMarkdownDoc("First paragraph.\n\nThe target text.\n");
    seedOn(doc, "a", "target");
    reload(doc, "First paragraph, edited at length.\n\nThe target text.\n");
    expect(textOf(doc, "a")).toBe("target");
    expect(kindOf(doc, "a")).toBe("ok");
  });

  it("moves a record up when a paragraph above it is deleted", () => {
    const doc = makeMarkdownDoc("Delete me.\n\nKeep me.\n\nThe target text.\n");
    seedOn(doc, "a", "target");
    reload(doc, "Keep me.\n\nThe target text.\n");
    expect(textOf(doc, "a")).toBe("target");
    expect(kindOf(doc, "a")).toBe("ok");
  });

  it("follows a heading prefix added in front of its text", () => {
    const doc = makeMarkdownDoc("Title\n\nbody\n");
    seedOn(doc, "a", "Title");
    reload(doc, "## Title\n\nbody\n");
    expect(textOf(doc, "a")).toBe("Title");
    expect(kindOf(doc, "a")).toBe("ok");
  });

  it("keeps a record ending at a heading boundary when the heading level changes", () => {
    const doc = makeMarkdownDoc("intro\n\n## Title\n\nbody\n");
    seedOn(doc, "a", "intro");
    seedOn(doc, "b", "body");
    reload(doc, "intro\n\n### Title\n\nbody\n");
    expect(textOf(doc, "a")).toBe("intro");
    expect(textOf(doc, "b")).toBe("body");
  });

  it("maps the endpoints of a record whose interior was edited, as the editor would", () => {
    const doc = makeMarkdownDoc("The quick brown fox jumps.\n");
    seedOn(doc, "a", "quick brown fox");
    reload(doc, "The quick red fox jumps.\n");
    expect(textOf(doc, "a")).toBe("quick red fox");
    expect(kindOf(doc, "a")).toBe("ok");
  });

  it("shrinks a record whose tail was deleted, and collapses one wholly deleted", () => {
    const doc = makeMarkdownDoc("Keep this and drop that.\n\nAfter.\n");
    seedOn(doc, "tail", "this and drop");
    seedOn(doc, "gone", "drop that");
    reload(doc, "Keep this.\n\nAfter.\n");
    expect(textOf(doc, "tail")).toBe("this");
    // "drop that" lost its whole text: a point, detached.
    const gone = annotationsOf(doc).get("gone");
    expect(gone?.range.from).toBe(gone?.range.to);
    expect(kindOf(doc, "gone")).toBe("degraded");
  });

  it("carries a record over a surrogate pair at a hunk boundary", () => {
    const doc = makeMarkdownDoc("x \u{1F600} y z\n");
    seedOn(doc, "a", "\u{1F600}");
    reload(doc, "x \u{1F600} y Z\n");
    expect(textOf(doc, "a")).toBe("\u{1F600}");
  });

  it("detaches a record whose emoji was replaced, at the pair's start, never mid-pair", () => {
    const doc = makeMarkdownDoc("x \u{1F600} y\n");
    seedOn(doc, "a", "\u{1F600}");
    reload(doc, "x \u{1F603} y\n");
    const ann = annotationsOf(doc).get("a");
    expect(ann?.range).toEqual(r(2, 2));
    expect(kindOf(doc, "a")).toBe("degraded");
  });
});

describe("applyRemap — records inside a changed region", () => {
  it("collapses a record whose own text was rewritten, with a snapshot, as degraded", () => {
    const doc = makeMarkdownDoc("Before.\n\nThe doomed sentence.\n\nAfter.\n");
    // Browser shape: no snapshot, no relRange.
    const flat = extractText(doc);
    const from = flat.indexOf("doomed");
    withMcp(doc, () =>
      annotationsOf(doc).set(
        "b",
        makeAnnotation({ id: "b", author: "user", range: r(from, from + 6) }),
      ),
    );
    reload(doc, "Before.\n\nSomething else entirely.\n\nAfter.\n");
    const ann = annotationsOf(doc).get("b");
    expect(ann?.range.from).toBe(ann?.range.to);
    expect(ann?.relRange).toBeUndefined();
    expect(ann?.textSnapshot, "the OLD text, captured on collapse").toBe("doomed");
    expect(kindOf(doc, "b")).toBe("degraded");
  });

  it("collapses rather than jumping to another copy of its text outside the change", () => {
    const doc = makeMarkdownDoc("foo bar here.\n\nfoo bar there.\n");
    seedOn(doc, "a", "foo bar", 1);
    reload(doc, "foo bar here.\n\nnothing there.\n");
    const ann = annotationsOf(doc).get("a");
    expect(ann?.range.from).toBe(ann?.range.to);
    expect(kindOf(doc, "a")).toBe("degraded");
  });

  it("finds a short repeated probe between two scattered edits on its own copy", () => {
    const doc = makeMarkdownDoc("the cat. AAA the dog. BBB the end.\n");
    seedOn(doc, "a", "the", 1);
    const before = annotationsOf(doc).get("a")?.range.from;
    reload(doc, "the cat. aaa the dog. bbb the end.\n");
    expect(annotationsOf(doc).get("a")?.range.from).toBe(before);
    expect(textOf(doc, "a")).toBe("the");
    expect(kindOf(doc, "a")).toBe("ok");
  });

  it("relocates a LIVE record by its current text, not its creation-time snapshot", () => {
    // Claude commented on "the big cat"; the user then changed "big" to "fat"
    // in the editor, inside the live anchor. A reload that rewrites the same
    // paragraph must find "the fat cat" — the snapshot "the big cat" is
    // nowhere in the document any more.
    const doc = makeMarkdownDoc("Above line.\n\nthe big cat sat\n");
    seedOn(doc, "a", "the big cat");
    const para = doc.getXmlFragment("default").get(1) as Y.XmlElement;
    const text = para.get(0) as Y.XmlText;
    withMcp(doc, () => {
      text.delete(4, 3);
      text.insert(4, "fat");
    });
    expect(kindOf(doc, "a")).toBe("ok");

    reload(doc, "Above line!\n\nthe fat cat sits\n");
    expect(textOf(doc, "a")).toBe("the fat cat");
    expect(annotationsOf(doc).get("a")?.textSnapshot, "snapshot untouched").toBe("the big cat");
  });

  it("keeps a found range without a relRange when an endpoint cannot be anchored", () => {
    // Offset 5 is the separator AFTER an empty list item, which no Y.XmlText
    // backs, so a `to` there cannot be minted (#2001's refusal set).
    const doc = makeMarkdownDoc("- Xone\n-\n- three\n");
    expect(extractText(doc)).toBe("Xone\n\nthree");
    withMcp(doc, () =>
      annotationsOf(doc).set(
        "a",
        makeAnnotation({ id: "a", range: r(1, 5), textSnapshot: "one\n" }),
      ),
    );
    reload(doc, "- Yone\n-\n- thrEE\n");
    const ann = annotationsOf(doc).get("a");
    expect(ann?.range, "found, not collapsed").toEqual(r(1, 5));
    expect(ann?.relRange).toBeUndefined();
  });
});

describe("applyRemap — moved text", () => {
  // A line diff records a move as a deletion in one hunk and an insertion in
  // another, so the moved copy is never in the record's own window.
  it("follows a paragraph moved down", () => {
    const doc = makeMarkdownDoc("alpha one\n\nbravo two\n\ncharlie\n");
    seedOn(doc, "a", "alpha one");
    reload(doc, "bravo two\n\nalpha one\n\ncharlie\n");
    expect(textOf(doc, "a")).toBe("alpha one");
    expect(annotationsOf(doc).get("a")?.range.from).toBe(extractText(doc).indexOf("alpha one"));
    expect(kindOf(doc, "a")).toBe("ok");
  });

  it("follows a paragraph moved up past an edited one", () => {
    const doc = makeMarkdownDoc("first\n\nmiddle\n\nlast words here\n");
    seedOn(doc, "a", "words");
    reload(doc, "last words here\n\nfirst, edited\n\nmiddle\n");
    expect(textOf(doc, "a")).toBe("words");
    expect(kindOf(doc, "a")).toBe("ok");
  });

  it("detaches moved text that also occurs anywhere else, rather than guess", () => {
    const doc = makeMarkdownDoc("alpha one\n\nbravo two\n\ncharlie one\n");
    seedOn(doc, "a", "one");
    reload(doc, "bravo two\n\nalpha one\n\ncharlie one\n");
    const ann = annotationsOf(doc).get("a");
    expect(ann?.range.from).toBe(ann?.range.to);
    expect(kindOf(doc, "a")).toBe("degraded");
  });

  it("relocates an untrusted record by its snapshot only, never minting from shifted offsets", () => {
    const doc = makeMarkdownDoc("alpha one\n\nbravo two\n\ncharlie\n");
    const flat = extractText(doc);
    const at = flat.indexOf("alpha");
    // Stored range over "alpha", snapshot claims "one": contradicts.
    withMcp(doc, () =>
      annotationsOf(doc).set(
        "u",
        makeAnnotation({ id: "u", range: r(at, at + 5), textSnapshot: "one" }),
      ),
    );
    expect(kindOf(doc, "u")).toBe("degraded");
    reload(doc, "bravo two\n\nalpha one\n\ncharlie\n");
    expect(textOf(doc, "u"), "the snapshot's text, not the stored span").toBe("one");
  });
});

describe("applyRemap — records refreshRange does not trust", () => {
  it("never mints an anchor for a contradicting snapshot outside every change", () => {
    const doc = makeMarkdownDoc("Edited here.\n\nalpha bravo charlie\n");
    const flat = extractText(doc);
    const at = flat.indexOf("bravo");
    // Stored range over "bravo", snapshot claims "charlie": no relRange to say
    // where the record really is.
    withMcp(doc, () =>
      annotationsOf(doc).set(
        "u",
        makeAnnotation({ id: "u", range: r(at, at + 5), textSnapshot: "charlie" }),
      ),
    );
    expect(kindOf(doc, "u")).toBe("degraded");

    reload(doc, "Edited here, more.\n\nalpha bravo charlie\n");
    const ann = annotationsOf(doc).get("u");
    expect(ann?.relRange, "no anchor over unverified offsets (#1764)").toBeUndefined();
    expect(extractText(doc).slice(ann?.range.from, ann?.range.to), "span carried").toBe("bravo");
    expect(kindOf(doc, "u")).toBe("degraded");
  });

  it("keeps a spurious-collapse record's span — the text is still there", () => {
    // Live anchors resolving to one point over a non-empty stored range that
    // still holds its snapshot: `refreshRange` answers `degraded` and writes
    // nothing, so the span survives. The remap must not turn the collapsed
    // anchors into a confident point.
    const doc = makeMarkdownDoc("Edited here.\n\nalpha bravo charlie\n");
    const flat = extractText(doc);
    const at = flat.indexOf("bravo");
    const point = anchoredRange(doc, toFlatOffset(at), toFlatOffset(at), undefined, {
      allowEmpty: true,
    });
    if (!point.ok || !point.fullyAnchored) throw new Error("point anchor failed");
    withMcp(doc, () =>
      annotationsOf(doc).set(
        "c",
        makeAnnotation({
          id: "c",
          range: r(at, at + 5),
          relRange: point.relRange,
          textSnapshot: "bravo",
        }),
      ),
    );
    expect(kindOf(doc, "c")).toBe("degraded");

    reload(doc, "Edited here, more.\n\nalpha bravo charlie\n");
    expect(textOf(doc, "c"), "the span, not a point").toBe("bravo");
  });
});

describe("applyRemap — what it leaves alone", () => {
  it("skips a record the content swap itself rewrote (the .docx adapter's in-place update)", () => {
    const doc = makeMarkdownDoc("alpha\n\nbravo\n");
    seedOn(doc, "a", "bravo");
    const rewritten = makeAnnotation({ id: "a", range: r(0, 5), content: "adapter wrote this" });
    withReload(doc, () => {
      const input = captureRemapInput(doc, FILE);
      loadMarkdown(doc, "new\n\nalpha\n\nbravo\n");
      annotationsOf(doc).set("a", rewritten);
      applyRemap(doc, input);
    });
    expect(annotationsOf(doc).get("a")).toEqual(rewritten);
  });

  it("keeps everything but range and relRange, and the replies map", () => {
    const doc = makeMarkdownDoc("alpha\n\nbravo\n");
    const seeded = seedOn(doc, "a", "bravo", 0, {
      heldInSolo: true,
      editedAt: 5,
      rev: 3,
      audience: "outbound",
    });
    reload(doc, "new\n\nalpha\n\nbravo\n");
    const { range: _r, relRange: _rr, ...rest } = annotationsOf(doc).get("a") as Annotation;
    const { range: _r0, relRange: _rr0, ...seededRest } = seeded;
    expect(rest).toEqual(seededRest);
  });
});

describe("remapEnvelopeWins", () => {
  it("remaps an envelope copy's pre-reload coordinates onto the new content", () => {
    const doc = makeMarkdownDoc("alpha\n\nbravo\n");
    seedOn(doc, "a", "bravo");
    const preReload = annotationsOf(doc).get("a") as Annotation;
    const remap = reload(doc, "new paragraph\n\nalpha\n\nbravo\n");
    expect(textOf(doc, "a")).toBe("bravo");

    // The merge puts the envelope's copy back: pre-reload range, dead relRange,
    // and a newer rev so it wins.
    const envelopeCopy = { ...preReload, rev: 9, content: "edited elsewhere" } as Annotation;
    withMcp(doc, () => annotationsOf(doc).set("a", envelopeCopy));
    expect(textOf(doc, "a")).not.toBe("bravo");

    expect(remapEnvelopeWins(doc, remap, new Set(["a"]))).toBe(true);
    expect(textOf(doc, "a")).toBe("bravo");
    expect(annotationsOf(doc).get("a")?.content).toBe("edited elsewhere");
    expect(kindOf(doc, "a")).toBe("ok");
  });

  it("re-diffs when the document changed between the reload and the merge", () => {
    const doc = makeMarkdownDoc("alpha\n\nbravo\n");
    seedOn(doc, "a", "bravo");
    const preReload = annotationsOf(doc).get("a") as Annotation;
    const remap = reload(doc, "new\n\nalpha\n\nbravo\n");
    // An edit lands in the await window before the merge.
    withMcp(doc, () => loadMarkdown(doc, "newer and longer\n\nalpha\n\nbravo\n"));

    withMcp(doc, () => annotationsOf(doc).set("a", { ...preReload, rev: 9 } as Annotation));
    remapEnvelopeWins(doc, remap, new Set(["a"]));
    expect(textOf(doc, "a")).toBe("bravo");
  });

  it("does nothing without a remap or ids", () => {
    const doc = new Y.Doc();
    expect(remapEnvelopeWins(doc, undefined, new Set(["a"]))).toBe(false);
  });
});
