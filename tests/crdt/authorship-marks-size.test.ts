import { describe, expect, it } from "vitest";
import * as Y from "yjs";

/**
 * Phase A: CRDT Size Impact Assessment for Authorship Marks
 *
 * Measures Y.Doc byte overhead of per-character author attributes on
 * Y.XmlText nodes to determine if inline marks are viable.
 *
 * Thresholds:
 *   GREEN  (<5% overhead)  -- proceed with inline marks
 *   YELLOW (5-15% overhead) -- proceed with optimization notes
 *   RED    (>15% overhead) -- pivot to Y.Map overlay strategy
 *
 * RESULT: RED -- continuous marks add ~31% overhead on 100KB docs.
 * Fragmented marks (realistic editing) add 400%+. Interleaved char-by-char
 * editing adds 4000%+. Decision: use Y.Map overlay strategy.
 *
 * This test documents the measurement and asserts the RED threshold was
 * correctly identified, serving as a regression test if Y.js ever
 * optimizes attribute storage.
 */

/** Generate deterministic text of approximately `targetBytes` in size. */
function generateText(targetBytes: number): string {
  const sentence = "The quick brown fox jumps over the lazy dog. ";
  const repeats = Math.ceil(targetBytes / sentence.length);
  return sentence.repeat(repeats).slice(0, targetBytes);
}

/** Populate a Y.Doc with paragraphs of ~100 chars each. */
function populateDoc(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment("default");
  const chunkSize = 100;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    const el = new Y.XmlElement("paragraph");
    fragment.insert(fragment.length, [el]);
    const textNode = new Y.XmlText();
    el.insert(0, [textNode]);
    textNode.insert(0, chunk);
  }
}

/** Apply continuous author marks -- 50% user, 50% claude in large runs. */
function applyContinuousMarks(doc: Y.Doc): void {
  const fragment = doc.getXmlFragment("default");
  doc.transact(() => {
    for (let i = 0; i < fragment.length; i++) {
      const el = fragment.get(i) as Y.XmlElement;
      const textNode = el.get(0) as Y.XmlText;
      const len = textNode.length;
      const author = i % 2 === 0 ? "user" : "claude";
      textNode.format(0, len, { author });
    }
  });
}

/** Apply fragmented author marks -- alternating user/claude every 10 chars. */
function applyFragmentedMarks(doc: Y.Doc): void {
  const fragment = doc.getXmlFragment("default");
  doc.transact(() => {
    for (let i = 0; i < fragment.length; i++) {
      const el = fragment.get(i) as Y.XmlElement;
      const textNode = el.get(0) as Y.XmlText;
      const len = textNode.length;
      for (let offset = 0; offset < len; offset += 10) {
        const end = Math.min(offset + 10, len);
        const author = Math.floor(offset / 10) % 2 === 0 ? "user" : "claude";
        textNode.format(offset, end - offset, { author });
      }
    }
  });
}

/** Simulate interleaved editing: alternating user/claude inserts char-by-char. */
function simulateInterleavedEditing(doc: Y.Doc, totalChars: number): void {
  const fragment = doc.getXmlFragment("default");
  const el = new Y.XmlElement("paragraph");
  fragment.insert(fragment.length, [el]);
  const textNode = new Y.XmlText();
  el.insert(0, [textNode]);

  for (let i = 0; i < totalChars; i++) {
    const author = i % 2 === 0 ? "user" : "claude";
    textNode.insert(i, "x", { author });
  }
}

function getDocSize(doc: Y.Doc): number {
  return Y.encodeStateAsUpdate(doc).byteLength;
}

function overhead(baseline: number, withMarks: number): number {
  return ((withMarks - baseline) / baseline) * 100;
}

describe("Authorship Marks -- CRDT Size Impact (Phase A)", () => {
  describe("continuous marks (100-char runs)", () => {
    const sizes = [
      { label: "1KB", bytes: 1_000 },
      { label: "10KB", bytes: 10_000 },
      { label: "100KB", bytes: 100_000 },
    ];

    for (const { label, bytes } of sizes) {
      it(`${label} document -- overhead exceeds GREEN threshold`, () => {
        const text = generateText(bytes);

        const baseline = new Y.Doc();
        populateDoc(baseline, text);
        const baselineSize = getDocSize(baseline);

        const marked = new Y.Doc();
        populateDoc(marked, text);
        applyContinuousMarks(marked);
        const markedSize = getDocSize(marked);

        const pct = overhead(baselineSize, markedSize);
        console.log(
          `[continuous] ${label}: baseline=${baselineSize}B, marked=${markedSize}B, overhead=${pct.toFixed(2)}%`,
        );

        // Document the RED result: even best-case continuous marks exceed 15%
        expect(pct).toBeGreaterThan(15);
      });
    }
  });

  describe("fragmented marks (alternating every 10 chars)", () => {
    const sizes = [
      { label: "1KB", bytes: 1_000 },
      { label: "10KB", bytes: 10_000 },
      { label: "100KB", bytes: 100_000 },
    ];

    for (const { label, bytes } of sizes) {
      it(`${label} document -- overhead is extreme`, () => {
        const text = generateText(bytes);

        const baseline = new Y.Doc();
        populateDoc(baseline, text);
        const baselineSize = getDocSize(baseline);

        const marked = new Y.Doc();
        populateDoc(marked, text);
        applyFragmentedMarks(marked);
        const markedSize = getDocSize(marked);

        const pct = overhead(baselineSize, markedSize);
        console.log(
          `[fragmented] ${label}: baseline=${baselineSize}B, marked=${markedSize}B, overhead=${pct.toFixed(2)}%`,
        );

        // Fragmented marks are far worse than continuous
        expect(pct).toBeGreaterThan(100);
      });
    }
  });

  describe("interleaved editing simulation", () => {
    // Only test 1KB -- char-by-char insertion is O(n^2) and 10KB+ times out
    it("1KB document -- char-by-char interleaved is catastrophic", () => {
      const baseline = new Y.Doc();
      const baseFragment = baseline.getXmlFragment("default");
      const baseEl = new Y.XmlElement("paragraph");
      baseFragment.insert(0, [baseEl]);
      const baseText = new Y.XmlText();
      baseEl.insert(0, [baseText]);
      baseText.insert(0, "x".repeat(1_000));
      const baselineSize = getDocSize(baseline);

      const interleaved = new Y.Doc();
      simulateInterleavedEditing(interleaved, 1_000);
      const interleavedSize = getDocSize(interleaved);

      const pct = overhead(baselineSize, interleavedSize);
      console.log(
        `[interleaved] 1KB: baseline=${baselineSize}B, interleaved=${interleavedSize}B, overhead=${pct.toFixed(2)}%`,
      );

      // Worst-case: each char is its own segment with an author attribute
      expect(pct).toBeGreaterThan(1000);
    });
  });

  describe("incremental sync size", () => {
    it("measures sync delta when adding marks to existing content", () => {
      const text = generateText(100_000);
      const doc = new Y.Doc();
      populateDoc(doc, text);

      const stateBeforeMarks = Y.encodeStateVector(doc);

      applyContinuousMarks(doc);

      const incrementalUpdate = Y.encodeStateAsUpdate(doc, stateBeforeMarks);
      const fullSize = getDocSize(doc);

      console.log(
        `[incremental sync] 100KB doc: full=${fullSize}B, markDelta=${incrementalUpdate.byteLength}B, deltaRatio=${((incrementalUpdate.byteLength / fullSize) * 100).toFixed(2)}%`,
      );

      expect(incrementalUpdate.byteLength).toBeGreaterThan(0);
      expect(incrementalUpdate.byteLength).toBeLessThan(fullSize);
    });
  });
});
