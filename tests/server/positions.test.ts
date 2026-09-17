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
  remapRangeAcrossReplacement,
  resolveToElement,
  validateFlatRange,
  validateRange,
} from "../../src/server/positions.js";
import type {
  FlatOffset,
  RangeValidation,
  SerializedRelPos,
} from "../../src/shared/positions/types.js";
import { rangeOverlapsHeadingPrefix } from "../../src/shared/positions/ydoc.js";
import { snapshotContradicts } from "../../src/shared/snapshot.js";
import type { Annotation } from "../../src/shared/types.js";
import { off, range } from "../helpers/positions.js";
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
 * #1766 — Critical Rule 6 was ENDPOINT-only, so a range that stepped straight
 * over a heading prefix passed and `tandem_edit` deleted the heading.
 *
 * The fixture is the issue's own: `"para\n## Head\nnext"`, whose heading block
 * starts at flat offset 5 and whose `"## "` prefix occupies [5, 8).
 *
 * Every spec here passes `rejectHeadingOverlap` too, because the interior term
 * lives inside that block — it is a second term, not a second check, and
 * Critical Rule 4's order is untouched.
 */
describe("validateRange — heading interior scan (#1766)", () => {
  const FIXTURE = "para\n## Head\nnext";

  it("refuses a range whose interior spans the prefix, from either side", () => {
    // The two cases the issue measured. Both endpoints clear the prefix — 4 is
    // the paragraph's last offset, 9 is inside "Head" — so the endpoint arm
    // alone says ok and the heading gets deleted.
    doc = makeDoc(FIXTURE);
    for (const [from, to] of [
      [4, 9],
      [0, 9],
    ] as const) {
      const result = validateRange(doc, off(from), off(to), {
        rejectHeadingOverlap: true,
        rejectHeadingInterior: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("HEADING_OVERLAP");
    }
  });

  it("still accepts those ranges without rejectHeadingInterior", () => {
    // **This is what keeps annotation creation out of the widening.**
    // `YDocStore.anchorRange` and `local-model/tools.ts` pass
    // `rejectHeadingOverlap` alone and must keep the endpoint-only rule: a
    // comment about a whole section spans a heading, and "target the text
    // content only" is not advice its author can follow. An implementation that
    // ORs the scan into the shared flag turns both of these red.
    doc = makeDoc(FIXTURE);
    for (const [from, to] of [
      [4, 9],
      [0, 9],
    ] as const) {
      expect(validateRange(doc, off(from), off(to), { rejectHeadingOverlap: true }).ok).toBe(true);
    }
  });

  it("keeps the exclusive-end asymmetry: to === the prefix's first char is refused", () => {
    // Documented, not removed (#1766's second half). `to` is exclusive, yet
    // `resolveToElement(5)` lands at offset 0 OF THE HEADING and reports
    // `clampedFromPrefix`, so [0, 5) is HEADING_OVERLAP — which is what stops
    // `tandem_edit` swallowing the newline that separates the paragraph from
    // the heading below it.
    //
    // **Without this spec, an implementation that REPLACES the endpoint check
    // with the overlap predicate passes everything else in this file**: the
    // predicate evaluates `5 < 5`, false, and silently accepts.
    doc = makeDoc(FIXTURE);
    const result = validateRange(doc, off(0), off(5), { rejectHeadingOverlap: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("HEADING_OVERLAP");
  });

  it("accepts the ranges that clear every prefix", () => {
    doc = makeDoc(FIXTURE);
    const opts = { rejectHeadingOverlap: true, rejectHeadingInterior: true } as const;
    // Stops one unit short of the heading block.
    expect(validateRange(doc, off(0), off(4), opts).ok).toBe(true);
    // Entirely inside the heading's TEXT, past the prefix ("Head" is [8, 12)).
    expect(validateRange(doc, off(8), off(12), opts).ok).toBe(true);
    // Two ordinary paragraphs with no heading between them.
    doc.destroy();
    doc = makeDoc("alpha\nbravo");
    expect(validateRange(doc, off(0), off(11), opts).ok).toBe(true);
  });

  it("still refuses a range from inside the prefix into the same heading's text", () => {
    // The endpoint arm alone already did this; the assertion pins that ORing
    // the interior term in reordered nothing.
    doc = makeDoc(FIXTURE);
    const result = validateRange(doc, off(6), off(10), {
      rejectHeadingOverlap: true,
      rejectHeadingInterior: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("HEADING_OVERLAP");
  });

  it("does not run ahead of the resolver's null arm", () => {
    // The `unresolvable` fixture from the #1752 reason table (an element-free
    // fragment, `allowEmpty`, `(0, 0)`), replayed with the new option on. The
    // scan sits AFTER the `!startPos || !endPos` return, so the verdict is
    // unchanged — an implementation that evaluates the predicate first would
    // still answer `unresolvable` here only by accident, which is why the
    // structural placement is stated in `positions.ts` as well.
    doc = new Y.Doc();
    doc.getXmlFragment("default");
    const result = validateRange(doc, off(0), off(0), {
      rejectHeadingOverlap: true,
      rejectHeadingInterior: true,
      allowEmpty: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "INVALID_RANGE") {
      expect(result.reason).toBe("unresolvable");
    } else {
      expect.unreachable("expected INVALID_RANGE/unresolvable");
    }
  });
});

/**
 * #1766 — the separator contract, measured against `extractText`'s own offsets.
 *
 * `rangeOverlapsHeadingPrefix` repeats `resolveToElement`'s flat arithmetic, and
 * the one rule an implementer drops is the `continue`: a non-`Y.XmlElement`
 * child consumes NOTHING, because the `\n` is added after the type guard. A
 * walker that counts one for it puts every later block start one unit high.
 */
describe("rangeOverlapsHeadingPrefix — separator contract (#1766)", () => {
  it("consumes no separator for a non-element child", () => {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");

    const heading = (text: string) => {
      const el = new Y.XmlElement("heading");
      fragment.insert(fragment.length, [el]);
      // Attach BEFORE populating — a detached Y.XmlText reverses segment order.
      (el as unknown as { setAttribute: (k: string, v: number) => void }).setAttribute("level", 2);
      el.insert(0, [new Y.XmlText(text)]);
      return el;
    };

    heading("Alpha");
    fragment.insert(fragment.length, [new Y.XmlText("bare")]);
    heading("Bravo");

    // The ORACLE: derive the second heading's block start from `extractText`
    // rather than from arithmetic this test would have to keep in sync.
    const text = extractText(doc);
    const bs2 = text.indexOf("## Bravo");
    expect(bs2).toBeGreaterThan(0);
    const prefixLen = 3;

    // **The one boundary that flips.** A range starting exactly one unit past
    // the end of the second heading's prefix: with a correct walker the
    // predicate evaluates `bs2 + prefixLen > bs2 + prefixLen`, false; with the
    // `continue` dropped, `bs2` is one high and it evaluates
    // `bs2 + 1 + prefixLen > bs2 + prefixLen`, true. A range covering the prefix
    // (true either way) or ending at the block start (false either way) pins
    // nothing.
    expect(
      rangeOverlapsHeadingPrefix(fragment, off(bs2 + prefixLen), off(bs2 + prefixLen + 2)),
    ).toBe(false);

    // The control: the same walker DOES see the prefix it is standing on.
    expect(rangeOverlapsHeadingPrefix(fragment, off(bs2 + 1), off(bs2 + prefixLen + 2))).toBe(true);
  });
});

/**
 * #1622 — a U+00A0 in the document made `textSnapshot` unwinnable.
 *
 * `tandem_getTextContent` returns a no-break space faithfully, but it is
 * indistinguishable from U+0020 to whoever reads that output, so the snapshot
 * comes back with an ordinary space, the exact comparison correctly fails,
 * `indexOf` finds nothing, and the tool answers `RANGE_GONE` for text that is
 * right there.
 *
 * **Every spec here that wants the new behaviour passes `normalizeSpaceClass:
 * true`** — the option is off by default, so a spec that omits it is asserting
 * the UNCHANGED exact behaviour. The last spec deliberately omits it.
 */
describe("validateRange — space-class normalization (#1622)", () => {
  const NBSP = "\u00A0";
  /** The issue's own phrase: an NBSP sits between "emails," and "Teams". */
  const PHRASE = `categorized emails,${NBSP}Teams chats`;
  /** What a caller reading `tandem_getTextContent` transcribes it as. */
  const TRANSCRIBED = PHRASE.replace(NBSP, " ");

  it("accepts a snapshot that differs from the document only in space class", () => {
    // The headline. This also kills a `RANGE_MOVED`-with-a-`whitespaceMismatch`-flag
    // fix, which would not return `ok`.
    doc = makeDoc(`We ${PHRASE}, and meeting transcripts.`);
    const full = extractText(doc);
    const from = off(full.indexOf(PHRASE));
    const to = off(from + PHRASE.length);

    const result = validateRange(doc, from, to, {
      textSnapshot: TRANSCRIBED,
      normalizeSpaceClass: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.range).toEqual({ from, to });
  });

  it("never answers RANGE_MOVED pointing at the offsets it was just given", () => {
    // **The loop guard, and the reason the issue's own proposal was not taken.**
    // Relocating a whitespace-class mismatch leaves the exact slice still
    // different at the CORRECT offsets, so the retry the caller is told to make
    // ("use resolvedFrom/resolvedTo") comes back RANGE_MOVED naming the offsets
    // it just passed, forever. A relocation cannot answer a mismatch that is not
    // a relocation.
    doc = makeDoc(`We ${PHRASE}, and meeting transcripts.`);
    const full = extractText(doc);
    const from = off(full.indexOf(PHRASE));
    const to = off(from + PHRASE.length);

    const result = validateRange(doc, from, to, {
      textSnapshot: TRANSCRIBED,
      normalizeSpaceClass: true,
    });
    const looped =
      !result.ok &&
      result.code === "RANGE_MOVED" &&
      result.resolvedFrom === from &&
      result.resolvedTo === to;
    expect(looped).toBe(false);
  });

  it("relocates to the true offsets when the NBSP-bearing text has moved", () => {
    // Pins that the normalizer is LENGTH-PRESERVING: the offsets come out of a
    // sweep over the normalized copy and are then used to slice the ORIGINAL.
    doc = makeDoc(`Some earlier filler sentence. We ${PHRASE}, and more.`);
    const full = extractText(doc);
    const trueFrom = full.indexOf(PHRASE);

    const result = validateRange(doc, off(0), off(PHRASE.length), {
      textSnapshot: TRANSCRIBED,
      normalizeSpaceClass: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "RANGE_MOVED") {
      expect(result.resolvedFrom).toBe(trueFrom);
      expect(result.resolvedTo).toBe(trueFrom + PHRASE.length);
      expect(full.slice(result.resolvedFrom, result.resolvedTo)).toBe(PHRASE);
    } else {
      expect(result).toMatchObject({ code: "RANGE_MOVED" });
    }
  });

  it("still answers RANGE_GONE for text that is genuinely absent", () => {
    // Without this the fix could turn RANGE_GONE into dead code and nothing
    // would notice.
    doc = makeDoc("An entirely different sentence with no such phrase.");
    const result = validateRange(doc, off(0), off(PHRASE.length), {
      textSnapshot: TRANSCRIBED,
      normalizeSpaceClass: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RANGE_GONE");
  });

  it("prefers an exact occurrence over a normalized-only one", () => {
    // **The fixture deliberately puts the NBSP variant NEARER the queried
    // `from` than the exact occurrence.** The relocation sweep collects every
    // hit and picks the candidate nearest `from`
    // (`candidates.reduce((a, b) => (Math.abs(a - from) <= Math.abs(b - from) ? a : b))`),
    // so an implementation that normalizes `fullText` and the snapshot up front
    // and runs ONE sweep finds both occurrences and returns whichever is nearer.
    // With the NBSP variant nearer, that implementation relocates onto it and
    // fails here; with the exact one nearer it would pass for the wrong reason,
    // and `tandem_edit`'s documented resolvedFrom/resolvedTo retry would then
    // rewrite the wrong span.
    //
    // The queried range is stale under BOTH comparisons, so step 2 cannot fire
    // and the question really is which sweep wins.
    const exact = "Teams chats";
    const variant = `Teams${NBSP}chats`;
    doc = makeDoc(`lead in filler ${variant} and later ${exact} end.`);
    const full = extractText(doc);
    expect(full.indexOf(variant)).toBeLessThan(full.indexOf(exact));

    const result = validateRange(doc, off(0), off(exact.length), {
      textSnapshot: exact,
      normalizeSpaceClass: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "RANGE_MOVED") {
      expect(full.slice(result.resolvedFrom, result.resolvedTo)).toBe(exact);
    } else {
      expect(result).toMatchObject({ code: "RANGE_MOVED" });
    }
  });

  it("does not normalize a block separator — a newline is not a space", () => {
    // Kills a `\s`-class regex. A newline is a block boundary in this coordinate
    // system, so collapsing it would let a range cross one.
    doc = makeDoc("alpha para\n\nbravo para");
    const full = extractText(doc);
    expect(full).toContain("\n");
    // The snapshot the caller would send if newlines WERE in the class: the
    // real slice with every block separator turned into an ordinary space.
    const snapshot = full.replace(/\n/g, " ");
    expect(snapshot).not.toBe(full);

    const result = validateRange(doc, off(0), off(full.length), {
      textSnapshot: snapshot,
      normalizeSpaceClass: true,
    });
    expect(result.ok).toBe(false);
  });

  it("is OFF by default, and the stored-snapshot comparators still agree", () => {
    // **The gate, both directions.** The document's NBSP has been replaced by an
    // ordinary U+0020 — a real external edit. The watcher's shape (a STORED
    // snapshot, no `normalizeSpaceClass`) must NOT read that as `ok`, because
    // `snapshotContradicts` — which gates the editor accept and the `.docx`
    // apply — is still exact and would refuse. A fix that normalizes
    // unconditionally passes every spec above and fails only this one.
    const storedSnapshot = `emails,${NBSP}Teams chats`;
    doc = makeDoc("We categorized emails, Teams chats, and more.");
    const full = extractText(doc);
    const from = off(full.indexOf("emails, Teams chats"));
    const to = off(from + storedSnapshot.length);

    const strict = validateRange(doc, from, to, { textSnapshot: storedSnapshot });
    expect(strict.ok).toBe(false);

    const ann = makeAnnotation({
      range: { from, to },
      textSnapshot: storedSnapshot,
    });
    expect(snapshotContradicts(ann, full.slice(from, to))).toBe(true);

    // ...and the opt-in direction, so this spec cannot be satisfied by a build
    // in which the option does nothing at all.
    const lenient = validateRange(doc, from, to, {
      textSnapshot: storedSnapshot,
      normalizeSpaceClass: true,
    });
    expect(lenient.ok).toBe(true);
  });
});

/**
 * The CALL-SITE half of #1622's safety gate, which nothing pinned.
 *
 * The spec above pins the OPTION in both directions, and the integration suite
 * pins the two opt-INs (`tandem_edit` and `YDocStore.anchorRange`) by driving a
 * tool whose call goes red when the flag is deleted. Nothing pinned the two
 * opt-OUTs — and a review reproduced exactly that: adding `normalizeSpaceClass:
 * true` to BOTH watcher sites left the entire suite green (10913 passed), so a
 * forgotten opt-out is the one direction with no detector.
 *
 * That asymmetry matters because #1622's own argument for default-off is that a
 * forgotten opt-IN merely reproduces today's visible `RANGE_GONE` while a
 * forgotten opt-OUT silently accepts a stale range: normalizing there makes the
 * watcher's probe answer `ok` while `snapshotContradicts` — still exact —
 * refuses the editor accept and the `.docx` apply. That is the #1631 divergence
 * shape, and it presents as "accept stopped working", not as an error.
 *
 * A textual pin rather than an AST one, in the idiom of
 * `document-write-rearm.test.ts`'s "`forbidden` files contain no reference to
 * `rearmWatch` AT ALL": both watcher sites resolve their options through one
 * shared `relocOpts` binding, so an AST walk over the two call expressions would
 * miss a property added to that object — the same undercount Critical Rule 4
 * warns about for the shared `surrogates` binding. The rationale for the opt-out
 * belongs in `RangeValidationOpts.normalizeSpaceClass`'s docblock, which is
 * where a reader looks; this file deliberately owns none of the prose.
 */
describe("#1622 call-site pin — the watcher's STORED snapshots stay byte-exact", () => {
  const WATCHER = "src/server/documents/watcher.ts";

  it(`${WATCHER} does not mention normalizeSpaceClass at all`, async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const text = await readFile(path.join(repoRoot, WATCHER), "utf-8");

    // The control: the file really is the one holding both relocation calls, so
    // a rename or a move fails here instead of passing vacuously.
    expect(text).toContain("watcher/relocation-probe");
    expect(text).toContain("watcher/relocation-anchor");

    expect(
      text.includes("normalizeSpaceClass"),
      `${WATCHER} passes STORED snapshots and must stay byte-exact (#1622) — ` +
        "normalizing there makes the relocation probe answer `ok` while " +
        "`snapshotContradicts` stays exact and then refuses the editor accept and " +
        "the .docx apply (the #1631 divergence shape).",
    ).toBe(false);
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

/**
 * #1765 — the pure arithmetic behind `tandem_edit`'s cross-block re-anchor.
 * `[from, to)` becomes `newLength` units; a range that does not intersect the
 * replacement has an exact destination, and one that does has none.
 */
describe("remapRangeAcrossReplacement (#1765)", () => {
  // Replace [10, 20) — ten units — with the given length.
  const from = off(10);
  const to = off(20);

  it("is the identity for a range entirely BEFORE the replacement", () => {
    expect(remapRangeAcrossReplacement(range(2, 5), from, to, 3)).toEqual({ from: 2, to: 5 });
  });

  it("is the identity for a range touching the replacement's start exactly", () => {
    // `to === from` is outside a half-open [from, to): nothing under it moved.
    expect(remapRangeAcrossReplacement(range(2, 10), from, to, 3)).toEqual({ from: 2, to: 10 });
  });

  it("shifts a range entirely AFTER the replacement, both when it shrinks and grows", () => {
    expect(remapRangeAcrossReplacement(range(25, 30), from, to, 2)).toEqual({ from: 17, to: 22 });
    expect(remapRangeAcrossReplacement(range(25, 30), from, to, 40)).toEqual({ from: 55, to: 60 });
  });

  it("shifts a range touching the replacement's end exactly", () => {
    expect(remapRangeAcrossReplacement(range(20, 24), from, to, 2)).toEqual({ from: 12, to: 16 });
  });

  it("shifts a POINT range after the replacement and keeps it a point", () => {
    expect(remapRangeAcrossReplacement(range(25, 25), from, to, 2)).toEqual({ from: 17, to: 17 });
  });

  it("REFUSES every intersecting range rather than clamping", () => {
    // Head overlap, tail overlap, fully contained, and a range that swallows
    // the replacement whole. A partially overwritten annotation has no correct
    // destination; clamping both ends to `from` would invent one.
    expect(remapRangeAcrossReplacement(range(5, 15), from, to, 3)).toBeNull();
    expect(remapRangeAcrossReplacement(range(15, 25), from, to, 3)).toBeNull();
    expect(remapRangeAcrossReplacement(range(12, 18), from, to, 3)).toBeNull();
    expect(remapRangeAcrossReplacement(range(0, 30), from, to, 3)).toBeNull();
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
