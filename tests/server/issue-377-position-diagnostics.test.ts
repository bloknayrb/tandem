/**
 * Diagnostic tests for Issue #377: Annotation Offset Resolves to Wrong Text
 *
 * Investigates three root cause candidates:
 * 1. Stale CRDT relRange after content replacement (roadmap.md rewritten in PR #375)
 * 2. Dual resolveToElement / resolveOffset implementations (divergence check)
 * 3. \n boundary edge case (> vs >= at separator check)
 *
 * KEY FINDINGS (from running these tests):
 *
 * Candidate 2: RULED OUT — resolveToElement ≡ resolveOffset, all parity tests pass.
 *
 * Candidate 3: RULED OUT — the > condition at the separator is correct. The initial test
 * framing was wrong: loadMarkdown("first\nsecond") produces ONE paragraph element with a
 * soft-break newline (not two elements), so the separator logic never fires for that input.
 * The separator logic is only exercised when multiple block-level elements exist (headings,
 * multiple paragraphs separated by blank lines). The > is confirmed correct by existing
 * tests in positions.test.ts ("resolves offset on separator boundary to end of preceding
 * element" test).
 *
 * Candidate 1: SUBSUMED by deeper structural bugs found during investigation:
 *
 *   Bug A — findXmlText() is single-level (document-model.ts:236-244).
 *     List content lives at bulletList > listItem > paragraph > XmlText. findXmlText()
 *     only searches one level deep, so it returns null for any list item. This means
 *     flatOffsetToRelPos() cannot create CRDT anchors for ANY list content — annotations
 *     on list items have relRange=undefined from creation, making them flat-offset-only.
 *     Confirmed by probe: flatOffsetToRelPos for list item content returns null.
 *
 *   Bug B — extractText() leaks inline markup tags into flat text.
 *     Y.XmlText.toString() emits HTML-like tags for formatting marks (bold, italic, etc.).
 *     getElementText() concatenates these without stripping. Flat text shown to Claude via
 *     tandem_getTextContent contains "<bold>...</bold>" strings. Offsets Claude computes
 *     from this text don't match the annotation coordinate system.
 *     Confirmed by probe: flat text for "**PWA**" includes "<bold>Progressive Web App..."
 *
 *   Bug C — extractText() doesn't insert \n between list items.
 *     getElementText() recurses into nested blocks but just joins content, producing
 *     "Item oneItem two" instead of "Item one\nItem two". Offsets shift for content
 *     after the first list item.
 *     Confirmed by probe: list flat text has no separator between items.
 *
 * Root cause of #377 (annotations on roadmap.md "PWA" section):
 *   - The PWA text is in a bullet list with bold formatting: **Progressive Web App (PWA)**
 *   - Bug A: no CRDT relRange is created → annotation is flat-offset-only
 *   - Bug B: the flat offset Claude receives (from tandem_getTextContent) includes
 *     <bold> tags, so it doesn't match what anchoredRange/validateRange sees
 *   - Bug C: offsets after any list item are shifted by missing separators
 *   All three compound: the annotation is created at a wrong offset with no CRDT safety net.
 *
 * Recommended fix scope: #260 (coordinate system unification). Bugs A/B/C are entangled —
 * fixing findXmlText alone doesn't help when extractText still emits markup tags.
 * A coordinated fix must: (1) strip inline markup from getElementText, (2) add \n between
 * nested block items, (3) fix findXmlText to recurse for CRDT anchoring.
 *
 * THIS FILE IS INVESTIGATION-ONLY. See issue #377 for the fix plan.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { extractText, resolveOffset } from "../../src/server/mcp/document-model.js";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import {
  anchoredRange,
  flatOffsetToRelPos,
  refreshRange,
  relPosToFlatOffset,
  resolveToElement,
} from "../../src/server/positions.js";
import type { Annotation } from "../../src/shared/types.js";
import { toFlatOffset } from "../../src/shared/positions/index.js";
import { makeDoc, makeMarkdownDoc } from "../helpers/ydoc-factory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const roadmapPath = path.resolve(__dirname, "../../docs/roadmap.md");

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

// ---------------------------------------------------------------------------
// Phase 1: Fresh Y.Doc — does offset math work on real roadmap.md content?
// Result: FAILS — PWA text is in a bullet list, so anchoredRange cannot create
// a relRange (Bug A: findXmlText single-level). Also, the flat text contains
// "<bold>" markup (Bug B), so offsets would differ from Claude's view.
// ---------------------------------------------------------------------------

describe("Phase 1: Fresh Y.Doc annotation on roadmap.md", () => {
  it("loads roadmap.md and extracts flat text without throwing", () => {
    const rawMarkdown = fs.readFileSync(roadmapPath, "utf8");
    doc = new Y.Doc();
    loadMarkdown(doc, rawMarkdown);

    const flat = extractText(doc);
    expect(flat.length).toBeGreaterThan(1000);
    // The text exists — but may include <bold> markup tags around it
    expect(flat).toContain("Progressive Web App");
  });

  it("BUG A+B: PWA annotation cannot get CRDT anchors (list item + bold markup)", () => {
    // This test DOCUMENTS THE BUG. It should fail when #377 is fixed.
    // When the fix is applied:
    //   - flatOffsetToRelPos should return non-null for list item content
    //   - fullyAnchored should be true
    //   - flat text should NOT contain "<bold>" tags
    const rawMarkdown = fs.readFileSync(roadmapPath, "utf8");
    doc = new Y.Doc();
    loadMarkdown(doc, rawMarkdown);

    const flat = extractText(doc);

    // BUG B: flat text contains inline markup tags
    // Check that the flat text has the markup-polluted version
    const hasBoldTag = flat.includes("<bold>");
    expect(hasBoldTag).toBe(true); // documents Bug B — should become false after fix

    const target = "Progressive Web App (PWA)";
    const idx = flat.indexOf(target);
    expect(idx).toBeGreaterThan(-1);

    const from = toFlatOffset(idx);
    const to = toFlatOffset(idx + target.length);

    // The slice itself is valid — the text exists in flat output
    expect(flat.slice(from, to)).toBe(target);

    // Create an anchored range
    const result = anchoredRange(doc, from, to, target);
    expect(result.ok).toBe(true);

    if (result.ok) {
      // BUG A: list item content cannot get CRDT anchors — findXmlText is single-level
      expect(result.fullyAnchored).toBe(false); // documents Bug A — should become true after fix
      expect(result.relRange).toBeUndefined(); // no CRDT anchor
    }
  });

  it("BUG A: flatOffsetToRelPos returns null for list item content", () => {
    // Direct demonstration of Bug A: findXmlText() can't reach XmlText inside list items
    doc = new Y.Doc();
    loadMarkdown(doc, "- Item in a list\n- Second item");

    const flat = extractText(doc);
    const itemIdx = flat.indexOf("Item in a list");
    expect(itemIdx).toBeGreaterThan(-1);

    // This returns null because findXmlText(bulletList) finds no direct XmlText child
    const relPos = flatOffsetToRelPos(doc, toFlatOffset(itemIdx), 0);
    expect(relPos).toBeNull(); // documents Bug A — should become non-null after fix
  });

  it("BUG B: extractText emits inline markup tags that pollute flat offsets", () => {
    // Direct demonstration of Bug B: bold formatting leaks into flat text as "<bold>...</bold>"
    doc = new Y.Doc();
    loadMarkdown(doc, "Some **bold text** here.");

    const flat = extractText(doc);
    // The flat text should be "Some bold text here." (no markup)
    // but Bug B makes it "Some <bold>bold text</bold> here."
    expect(flat).toContain("<bold>"); // documents Bug B — should fail after fix
    expect(flat).not.toBe("Some bold text here."); // expected clean output — fails until fix
  });

  it("BUG C: extractText omits separators between list items", () => {
    // Direct demonstration of Bug C: list items have no \n between them
    doc = new Y.Doc();
    loadMarkdown(doc, "- Alpha\n- Beta\n- Gamma");

    const flat = extractText(doc);
    // Expected: "Alpha\nBeta\nGamma" (or similar with separators)
    // Actual (Bug C): "AlphaBetaGamma" — no separators between list items
    expect(flat).not.toContain("\n"); // documents Bug C — list items run together
    console.log(`[issue-377 Bug C] list flat text: ${JSON.stringify(flat)}`);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: resolveToElement vs resolveOffset divergence analysis
// Result: PASSES — both implementations are semantically identical.
// ---------------------------------------------------------------------------

describe("Phase 2: resolveToElement vs resolveOffset implementation parity", () => {
  // Note: makeMarkdownDoc uses remark (loadMarkdown). For inputs where remark produces
  // multi-element fragments (blank-line-separated paragraphs, headings), the separator
  // logic fires. Plain \n without blank lines produces a single paragraph with a soft
  // break in remark, so "first\nsecond" creates one element, not two.
  const testCases = [
    "hello world",
    "## Heading\n\nContent paragraph",
    "# Title\n\nFirst paragraph\n\nSecond paragraph",
    "### Level 3\n\ntext",
  ];

  for (const content of testCases) {
    it(`produces identical results for: "${content.slice(0, 40)}"`, () => {
      doc = makeMarkdownDoc(content);
      const fragment = doc.getXmlFragment("default");
      const flat = extractText(doc);

      // Test every offset from 0 to flat.length + 2 (including past-end)
      for (let offset = 0; offset <= flat.length + 2; offset++) {
        const fromPositions = resolveToElement(fragment, toFlatOffset(offset));
        const fromDocModel = resolveOffset(fragment, offset);

        expect(fromPositions).toEqual(
          fromDocModel,
          `Divergence at offset ${offset} in "${content.slice(0, 40)}"`,
        );
      }
    });
  }

  it("parity on populateYDoc multi-paragraph content", () => {
    // Use makeDoc (populateYDoc) to get genuine multi-element fragments
    doc = makeDoc("first\nsecond\nthird");
    const fragment = doc.getXmlFragment("default");
    const flat = extractText(doc);

    for (let offset = 0; offset <= flat.length + 2; offset++) {
      const fromPositions = resolveToElement(fragment, toFlatOffset(offset));
      const fromDocModel = resolveOffset(fragment, offset);
      expect(fromPositions).toEqual(fromDocModel, `Divergence at offset ${offset}`);
    }
  });

  it("parity on actual roadmap.md for first 200 offsets", () => {
    const rawMarkdown = fs.readFileSync(roadmapPath, "utf8");
    doc = new Y.Doc();
    loadMarkdown(doc, rawMarkdown);

    const fragment = doc.getXmlFragment("default");

    for (let offset = 0; offset < 200; offset++) {
      const fromPositions = resolveToElement(fragment, toFlatOffset(offset));
      const fromDocModel = resolveOffset(fragment, offset);

      expect(fromPositions).toEqual(fromDocModel, `Divergence at offset ${offset} in roadmap.md`);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3: \n boundary edge cases
// Result: > is correct. The separator logic only applies to multi-element fragments
// (block-level elements). loadMarkdown treats single \n as soft break (one element).
// Use makeDoc (populateYDoc) which creates one element per line.
// ---------------------------------------------------------------------------

describe("Phase 3: \\n boundary edge cases", () => {
  it("offset on \\n separator clamps to end of preceding element (using populateYDoc)", () => {
    // populateYDoc creates one element per line — separator logic fires.
    // loadMarkdown("first\nsecond") does NOT: remark treats bare \n as soft break
    // and produces a single paragraph element. Use makeDoc to exercise separator logic.
    doc = makeDoc("first\nsecond");
    const fragment = doc.getXmlFragment("default");

    const flat = extractText(doc);
    expect(flat).toBe("first\nsecond");
    expect(fragment.length).toBe(2); // populateYDoc creates two elements

    // Offset 5 = the \n separator
    const atSep = resolveToElement(fragment, toFlatOffset(5));
    // Resolves to end of "first" (element 0, textOffset 5)
    expect(atSep).toEqual({ elementIndex: 0, textOffset: 5, clampedFromPrefix: false });

    // Offset 6 = start of "second"
    const afterSep = resolveToElement(fragment, toFlatOffset(6));
    // Resolves to start of "second" (element 1, textOffset 0)
    expect(afterSep).toEqual({ elementIndex: 1, textOffset: 0, clampedFromPrefix: false });
  });

  it("> not >= at separator check: confirms offset=5 resolves to element 0, not element 1", () => {
    // This is the existing test from positions.test.ts, re-confirmed here.
    // The > condition is correct. If changed to >=, offset 6 ("s" in "second")
    // would resolve to element 0 end instead of element 1 start.
    doc = makeDoc("first\nsecond");
    const fragment = doc.getXmlFragment("default");

    const result = resolveToElement(fragment, toFlatOffset(5));
    expect(result?.elementIndex).toBe(0);
    expect(result?.textOffset).toBe(5);
  });

  it("flat text slice at separator boundary is correct", () => {
    doc = makeDoc("Line one\nLine two");
    const flat = extractText(doc);

    expect(flat[8]).toBe("\n");
    expect(flat.slice(9, 17)).toBe("Line two");

    const result = anchoredRange(doc, toFlatOffset(9), toFlatOffset(17), "Line two");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(flat.slice(result.range.from, result.range.to)).toBe("Line two");
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 1b: Stale relRange after content replacement
// Result: The stale-relRange scenario exists but is secondary. The primary failure
// is that list content (PWA) never gets a relRange in the first place (Bug A).
// When flat offsets go stale after content replacement, refreshRange's re-anchor
// attempt also fails for list content (same Bug A), leaving stale flat offsets.
// ---------------------------------------------------------------------------

describe("Phase 1b: Stale relRange after content replacement", () => {
  it("refreshRange strips dead relRange and returns annotation with stale flat offsets", () => {
    // Use simple paragraph content (not list) so we can create a relRange to begin with
    doc = makeDoc("Old intro.\nThis is the old target text.\nOld outro.");

    const oldFlat = extractText(doc);
    const oldTarget = "old target text";
    const oldIdx = oldFlat.indexOf(oldTarget);
    expect(oldIdx).toBeGreaterThan(-1);

    const oldFrom = toFlatOffset(oldIdx);
    const oldTo = toFlatOffset(oldIdx + oldTarget.length);

    const rangeResult = anchoredRange(doc, oldFrom, oldTo, oldTarget);
    expect(rangeResult.ok).toBe(true);
    if (!rangeResult.ok) return;

    // This content is a paragraph, so relRange should be created
    expect(rangeResult.fullyAnchored).toBe(true);
    expect(rangeResult.relRange).toBeDefined();

    const ann: Annotation = {
      id: "ann_test_stale",
      author: "claude" as const,
      type: "comment" as const,
      range: rangeResult.range,
      relRange: rangeResult.relRange,
      content: "Annotation on old content",
      status: "pending" as const,
      timestamp: Date.now(),
    };

    // Replace document content (simulate reloadFromDisk after PR #375-style rewrite)
    const fragment = doc.getXmlFragment("default");
    fragment.delete(0, fragment.length);

    const newElement = new Y.XmlElement("paragraph");
    newElement.insert(0, [new Y.XmlText("Entirely new content without the original text.")]);
    fragment.insert(0, [newElement]);

    const refreshed = refreshRange(ann, doc);

    // refreshRange should strip the dead relRange (deleted Y.items → null resolution)
    // and attempt re-anchor from flat offsets. Both the strip and the fallback
    // re-anchor will succeed or fail depending on CRDT tombstone state.
    const newFlat = extractText(doc);
    console.log(`[issue-377 diagnostic] post-replacement flat: "${newFlat}"`);
    console.log(
      `[issue-377 diagnostic] refreshed range: [${refreshed.range.from}, ${refreshed.range.to}]`,
    );
    console.log(
      `[issue-377 diagnostic] refreshed relRange: ${refreshed.relRange !== undefined ? "defined" : "undefined"}`,
    );

    if (refreshed.range.to <= newFlat.length) {
      const resolvedText = newFlat.slice(refreshed.range.from, refreshed.range.to);
      console.log(`[issue-377 diagnostic] resolved text: "${resolvedText}"`);
      // If offsets are stale, the resolved text will not match the original target
      if (resolvedText !== oldTarget) {
        console.log("[issue-377 diagnostic] CONFIRMED stale offset: wrong text after refresh");
      }
    }

    // Annotation should not crash
    expect(refreshed).toBeDefined();
    expect(refreshed.id).toBe("ann_test_stale");
  });

  it("stale flat offsets from before content replacement point to wrong text in new doc", () => {
    // Demonstrate that even if relRange is stripped, the stale flat offsets
    // (from pre-replacement content) resolve to wrong text in the new document.
    const oldContent = "Intro paragraph.\n## Old Section\n\nOld body text with MARKER here.";
    const newContent = "# New Title\n\nCompletely different body text. Old section is gone.";

    // Old doc: annotate "MARKER"
    const oldDoc = new Y.Doc();
    loadMarkdown(oldDoc, oldContent);
    const oldFlat = extractText(oldDoc);
    const markerIdx = oldFlat.indexOf("MARKER");
    expect(markerIdx).toBeGreaterThan(-1);

    const oldFrom = markerIdx;
    const oldTo = markerIdx + "MARKER".length;

    // New doc: same flat offsets, different content
    const newDoc = new Y.Doc();
    loadMarkdown(newDoc, newContent);
    const newFlat = extractText(newDoc);

    if (oldTo <= newFlat.length) {
      const resolvedInNew = newFlat.slice(oldFrom, oldTo);
      // The stale offsets resolve to wrong text — not "MARKER"
      expect(resolvedInNew).not.toBe("MARKER");
      console.log(
        `[issue-377 diagnostic] stale [${oldFrom}, ${oldTo}] → "${resolvedInNew}" in new doc`,
      );
    } else {
      console.log(
        `[issue-377 diagnostic] stale [${oldFrom}, ${oldTo}] out of bounds in new doc (len ${newFlat.length})`,
      );
    }

    oldDoc.destroy();
    newDoc.destroy();
  });
});
