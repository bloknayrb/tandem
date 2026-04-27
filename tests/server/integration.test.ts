import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  extractText,
  getOrCreateXmlText,
  mergeXmlText,
  resolveOffset,
} from "../../src/server/mcp/document.js";
import { escapeRegex } from "../../src/server/mcp/response.js";
import { makeDoc } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

/** Find text like tandem_resolveRange */
function findText(fullText: string, pattern: string, occurrence = 1) {
  const regex = new RegExp(escapeRegex(pattern), "g");
  let match;
  let count = 0;
  while ((match = regex.exec(fullText)) !== null) {
    count++;
    if (count === occurrence) {
      return { from: match.index, to: match.index + match[0].length };
    }
  }
  return null;
}

/** Apply edit like tandem_edit */
function applyEdit(doc: Y.Doc, from: number, to: number, newText: string): boolean {
  const fragment = doc.getXmlFragment("default");
  const startPos = resolveOffset(fragment, from);
  const endPos = resolveOffset(fragment, to);
  if (!startPos || !endPos) return false;
  if (startPos.clampedFromPrefix || endPos.clampedFromPrefix) return false;

  if (startPos.elementIndex !== endPos.elementIndex) {
    doc.transact(() => {
      const startNode = fragment.get(startPos.elementIndex) as Y.XmlElement;
      const startText = getOrCreateXmlText(startNode);
      const startLen = startText.length;
      if (startPos.textOffset < startLen) {
        startText.delete(startPos.textOffset, startLen - startPos.textOffset);
      }
      const deleteCount = endPos.elementIndex - startPos.elementIndex - 1;
      for (let i = 0; i < deleteCount; i++) {
        fragment.delete(startPos.elementIndex + 1, 1);
      }
      const endNode = fragment.get(startPos.elementIndex + 1) as Y.XmlElement;
      const endText = getOrCreateXmlText(endNode);
      if (endPos.textOffset > 0) {
        endText.delete(0, endPos.textOffset);
      }
      mergeXmlText(startText, endText, startPos.textOffset);
      fragment.delete(startPos.elementIndex + 1, 1);
      startText.insert(startPos.textOffset, newText);
    });
  } else {
    doc.transact(() => {
      const node = fragment.get(startPos.elementIndex) as Y.XmlElement;
      const textNode = getOrCreateXmlText(node);
      const deleteLen = endPos.textOffset - startPos.textOffset;
      if (deleteLen > 0) {
        textNode.delete(startPos.textOffset, deleteLen);
      }
      if (newText.length > 0) {
        textNode.insert(startPos.textOffset, newText);
      }
    });
  }
  return true;
}

describe("resolveRange → edit pipeline", () => {
  it("find text, replace it, verify result", () => {
    doc = makeDoc("The quick brown fox jumps over the lazy dog");
    const text = extractText(doc);
    const range = findText(text, "brown fox");
    expect(range).not.toBeNull();

    const success = applyEdit(doc, range!.from, range!.to, "red cat");
    expect(success).toBe(true);
    expect(extractText(doc)).toBe("The quick red cat jumps over the lazy dog");
  });

  it("find and edit text in document with headings", () => {
    doc = makeDoc("# Title\nThe old paragraph\n## Section\nMore content");
    const text = extractText(doc);
    const range = findText(text, "old paragraph");
    expect(range).not.toBeNull();

    const success = applyEdit(doc, range!.from, range!.to, "new paragraph");
    expect(success).toBe(true);

    const result = extractText(doc);
    expect(result).toBe("# Title\nThe new paragraph\n## Section\nMore content");
    // Heading structure preserved
    expect(result).toContain("# Title");
    expect(result).toContain("## Section");
  });

  it("search → edit → search again at new position", () => {
    doc = makeDoc("Replace OLD with something NEW");
    let text = extractText(doc);

    const range = findText(text, "OLD");
    expect(range).not.toBeNull();
    applyEdit(doc, range!.from, range!.to, "FRESH");

    text = extractText(doc);
    expect(text).toBe("Replace FRESH with something NEW");

    // "FRESH" should be findable at the expected position
    const newRange = findText(text, "FRESH");
    expect(newRange).not.toBeNull();
    expect(newRange!.from).toBe(8); // "Replace " is 8 chars
    expect(newRange!.to).toBe(13); // "FRESH" is 5 chars
  });
});
