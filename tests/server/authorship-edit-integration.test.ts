import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyTextEdit, extractText, resolveOffset } from "../../src/server/mcp/document.js";
import { anchoredRange } from "../../src/server/positions.js";
import { Y_MAP_AUTHORSHIP } from "../../src/shared/constants.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { AuthorshipRange } from "../../src/shared/types.js";
import { generateAuthorshipId } from "../../src/shared/utils.js";
import { makeDoc } from "../helpers/ydoc-factory.js";

const MCP_ORIGIN = "mcp";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

/**
 * Replicate the full tandem_edit + authorship recording flow.
 * Returns null on success or an error string.
 */
function applyEditWithAuthorship(
  doc: Y.Doc,
  from: number,
  to: number,
  newText: string,
): string | null {
  const fragment = doc.getXmlFragment("default");
  const startPos = resolveOffset(fragment, from);
  const endPos = resolveOffset(fragment, to);

  if (!startPos || !endPos) return `Cannot resolve offset range [${from}, ${to}].`;
  if (startPos.clampedFromPrefix || endPos.clampedFromPrefix) {
    return "Edit range overlaps with heading markup.";
  }

  applyTextEdit(doc, fragment, startPos, endPos, newText, MCP_ORIGIN);

  // Record authorship — mirrors document.ts logic
  if (newText.length > 0) {
    const newFrom = toFlatOffset(from);
    const newTo = toFlatOffset(from + newText.length);
    const anchored = anchoredRange(doc, newFrom, newTo);
    if (anchored.ok) {
      const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);
      const rangeId = generateAuthorshipId("claude");
      const entry: AuthorshipRange = {
        id: rangeId,
        author: "claude",
        range: anchored.range,
        relRange: anchored.fullyAnchored ? anchored.relRange : undefined,
        timestamp: Date.now(),
      };
      doc.transact(() => {
        authorshipMap.set(rangeId, entry);
      }, MCP_ORIGIN);
    }
  }

  return null;
}

describe("tandem_edit authorship recording (integration)", () => {
  it("records authorship entry after a replacement edit", () => {
    doc = makeDoc("Hello world");
    const err = applyEditWithAuthorship(doc, 6, 11, "there");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("Hello there");

    const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);
    expect(authorshipMap.size).toBe(1);

    const entries: AuthorshipRange[] = [];
    authorshipMap.forEach((v) => entries.push(v as AuthorshipRange));

    const entry = entries[0];
    expect(entry.author).toBe("claude");
    expect(entry.range.from).toBe(6);
    expect(entry.range.to).toBe(11);
    expect(entry.id).toMatch(/^claude_/);
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it("records authorship with CRDT-anchored relRange", () => {
    doc = makeDoc("Hello world");
    const err = applyEditWithAuthorship(doc, 0, 5, "Greetings");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("Greetings world");

    const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);
    const entries: AuthorshipRange[] = [];
    authorshipMap.forEach((v) => entries.push(v as AuthorshipRange));

    const entry = entries[0];
    expect(entry.relRange).toBeDefined();
    expect(entry.relRange!.fromRel).toBeDefined();
    expect(entry.relRange!.toRel).toBeDefined();
  });

  it("does not record authorship for pure deletions", () => {
    doc = makeDoc("Hello world");
    const err = applyEditWithAuthorship(doc, 5, 11, "");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("Hello");

    const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);
    expect(authorshipMap.size).toBe(0);
  });

  it("records authorship for insertion at a point (from === to)", () => {
    doc = makeDoc("Hello world");
    const err = applyEditWithAuthorship(doc, 5, 5, " beautiful");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("Hello beautiful world");

    const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);
    expect(authorshipMap.size).toBe(1);

    const entries: AuthorshipRange[] = [];
    authorshipMap.forEach((v) => entries.push(v as AuthorshipRange));

    const entry = entries[0];
    expect(entry.author).toBe("claude");
    expect(entry.range.from).toBe(5);
    expect(entry.range.to).toBe(15);
  });

  it("records separate entries for multiple edits", () => {
    doc = makeDoc("Hello world");
    applyEditWithAuthorship(doc, 0, 5, "Hi");
    // After first edit: "Hi world"
    applyEditWithAuthorship(doc, 3, 8, "there");
    // After second edit: "Hi there"

    expect(extractText(doc)).toBe("Hi there");

    const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);
    expect(authorshipMap.size).toBe(2);
  });
});
