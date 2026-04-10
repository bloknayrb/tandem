import { describe, expect, it } from "vitest";
import {
  docIdFromPath,
  extractText,
  getCurrentDoc,
  populateYDoc,
} from "../../src/server/mcp/document.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";

describe("docIdFromPath", () => {
  it("generates stable IDs from the same path", () => {
    const id1 = docIdFromPath("C:\\Users\\test\\report.md");
    const id2 = docIdFromPath("C:\\Users\\test\\report.md");
    expect(id1).toBe(id2);
  });

  it("generates different IDs for different paths", () => {
    const id1 = docIdFromPath("C:\\Users\\test\\report.md");
    const id2 = docIdFromPath("C:\\Users\\test\\invoice.md");
    expect(id1).not.toBe(id2);
  });

  it("normalizes path separators", () => {
    const id1 = docIdFromPath("C:\\Users\\test\\report.md");
    const id2 = docIdFromPath("C:/Users/test/report.md");
    expect(id1).toBe(id2);
  });

  it("produces readable IDs with filename prefix", () => {
    const id = docIdFromPath("C:\\Users\\test\\my-report.md");
    expect(id).toMatch(/^my-report-[a-z0-9]+$/);
  });

  it("truncates long filenames", () => {
    const id = docIdFromPath(
      "C:\\Users\\test\\this-is-a-very-long-filename-that-should-be-truncated.md",
    );
    // The name part should be at most 16 chars
    const namePart = id.split("-").slice(0, -1).join("-");
    expect(namePart.length).toBeLessThanOrEqual(16);
  });
});

describe("getCurrentDoc with documentId", () => {
  it("returns null when no docs are open", () => {
    expect(getCurrentDoc()).toBeNull();
    expect(getCurrentDoc("nonexistent")).toBeNull();
  });
});

describe("multi-document Y.Doc isolation", () => {
  it("maintains separate Y.Docs for different room names", () => {
    const doc1 = getOrCreateDocument("room-a");
    const doc2 = getOrCreateDocument("room-b");

    populateYDoc(doc1, "Content A");
    populateYDoc(doc2, "Content B");

    expect(extractText(doc1)).toBe("Content A");
    expect(extractText(doc2)).toBe("Content B");
  });

  it("returns the same Y.Doc for the same room name", () => {
    const doc1 = getOrCreateDocument("room-same");
    const doc2 = getOrCreateDocument("room-same");
    expect(doc1).toBe(doc2);
  });

  it("maintains separate annotation maps per document", () => {
    const doc1 = getOrCreateDocument("ann-room-1");
    const doc2 = getOrCreateDocument("ann-room-2");

    const map1 = doc1.getMap(Y_MAP_ANNOTATIONS);
    const map2 = doc2.getMap(Y_MAP_ANNOTATIONS);

    map1.set("ann1", { id: "ann1", type: "comment", content: "Note on doc 1" });
    map2.set("ann2", { id: "ann2", type: "highlight", content: "Note on doc 2" });

    expect(map1.has("ann1")).toBe(true);
    expect(map1.has("ann2")).toBe(false);
    expect(map2.has("ann2")).toBe(true);
    expect(map2.has("ann1")).toBe(false);
  });
});
