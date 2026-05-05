import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Y_MAP_AUTHORSHIP } from "../../src/shared/constants";
import type { AuthorshipRange } from "../../src/shared/types";

/**
 * Tests for buildAuthorshipDecorations — verifies that decorations emit
 * data-tandem-author attributes (not class-based variants) per ADR-026.
 */

// --- ProseMirror mocks ---

type CapturedInline = { from: number; to: number; attrs: Record<string, string> };
let capturedInlines: CapturedInline[] = [];

type CapturedNode = { from: number; to: number; attrs: Record<string, string> };
let capturedNodes: CapturedNode[] = [];

vi.mock("@tiptap/pm/view", () => {
  const empty = Symbol("DecorationSet.empty");
  return {
    DecorationSet: {
      empty,
      create(_doc: unknown, decorations: unknown[]) {
        return { decorations, _tag: "created" };
      },
    },
    Decoration: {
      inline(from: number, to: number, attrs: Record<string, string>) {
        const d = { from, to, attrs, _type: "inline" };
        capturedInlines.push(d);
        return d;
      },
      node(from: number, to: number, attrs: Record<string, string>) {
        const d = { from, to, attrs, _type: "node" };
        capturedNodes.push(d);
        return d;
      },
    },
  };
});

vi.mock("@tiptap/pm/state", () => ({
  Plugin: class {},
  PluginKey: class {
    constructor(public name: string) {}
  },
}));

vi.mock("@tiptap/core", () => ({
  Extension: { create: () => ({}) },
}));

// Mock positions so ranges resolve to simple flat values
vi.mock("../../src/client/positions", () => ({
  relRangeToPmPositions: () => null,
  flatOffsetToPmPos: (_doc: unknown, offset: { value: number } | number) =>
    typeof offset === "object" ? offset.value : offset,
}));

// Import AFTER mocks
const { buildAuthorshipDecorations } = await import(
  "../../src/client/editor/extensions/authorship"
);

// --- Minimal doc mock ---

function makeMockDoc(
  blocks: Array<{
    typeName: string;
    size: number;
    offset: number;
  }> = [{ typeName: "paragraph", size: 10, offset: 1 }],
  totalSize = 100,
) {
  return {
    content: { size: totalSize },
    forEach(cb: (node: unknown, offset: number, index: number) => void) {
      blocks.forEach(({ typeName, size, offset }, i) => {
        cb(
          {
            type: { name: typeName },
            nodeSize: size + 2,
            content: { size },
          },
          offset,
          i,
        );
      });
    },
  } as unknown as import("@tiptap/pm/model").Node;
}

function addEntry(map: Y.Map<unknown>, author: string, id = "auth-1", from = 1, to = 5) {
  const entry: Partial<AuthorshipRange> & { author: string } = {
    id,
    author,
    range: { from, to },
    timestamp: Date.now(),
  };
  map.set(id, entry);
}

beforeEach(() => {
  capturedInlines = [];
  capturedNodes = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAuthorshipDecorations", () => {
  it("returns empty DecorationSet when visible=false", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "user");

    const result = buildAuthorshipDecorations(makeMockDoc(), authorshipMap, ydoc, false);
    // DecorationSet.empty is a symbol
    expect(typeof result).toBe("symbol");
    expect(capturedInlines).toHaveLength(0);
  });

  it("emits data-tandem-author attribute for user", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "user");

    buildAuthorshipDecorations(makeMockDoc(), authorshipMap, ydoc, true);

    expect(capturedInlines).toHaveLength(1);
    expect(capturedInlines[0].attrs["data-tandem-author"]).toBe("user");
  });

  it("emits data-tandem-author attribute for claude", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "claude", "auth-claude");

    buildAuthorshipDecorations(makeMockDoc(), authorshipMap, ydoc, true);

    expect(capturedInlines).toHaveLength(1);
    expect(capturedInlines[0].attrs["data-tandem-author"]).toBe("claude");
  });

  it("does NOT emit any CSS class (data-tandem-author replaces class variants)", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "user");

    buildAuthorshipDecorations(makeMockDoc(), authorshipMap, ydoc, true);

    expect(capturedInlines).toHaveLength(1);
    // Decoration carries only data-tandem-author; no class prop at all
    expect(capturedInlines[0].attrs.class).toBeUndefined();
    expect(capturedInlines[0].attrs["data-tandem-author"]).toBe("user");
  });

  it("skips entries with author='import' (import belongs to annotations, not authorship)", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    // "import" is a valid annotation author but is not a valid AuthorshipRange author;
    // no code path writes author="import" to Y_MAP_AUTHORSHIP.
    addEntry(authorshipMap, "import" as any, "auth-import");

    buildAuthorshipDecorations(makeMockDoc(), authorshipMap, ydoc, true);

    expect(capturedInlines).toHaveLength(0);
  });

  it("skips entries with unknown author values", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    // Inject an entry with an unexpected author value via Y.Map (untyped at runtime)
    addEntry(authorshipMap, "unknown-bot" as any, "auth-bad");

    buildAuthorshipDecorations(makeMockDoc(), authorshipMap, ydoc, true);

    expect(capturedInlines).toHaveLength(0);
  });

  it("skips unknown author but renders valid ones in the same map", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "unknown-bot" as any, "auth-bad", 1, 5);
    addEntry(authorshipMap, "claude", "auth-claude", 6, 10);

    buildAuthorshipDecorations(makeMockDoc(), authorshipMap, ydoc, true);

    expect(capturedInlines).toHaveLength(1);
    expect(capturedInlines[0].attrs["data-tandem-author"]).toBe("claude");
  });

  // --- Node decoration (gutter) tests ---

  it("emits data-tandem-author-block for a single-author paragraph (claude)", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "claude", "auth-1", 1, 5);

    const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
    buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

    expect(capturedNodes).toHaveLength(1);
    expect(capturedNodes[0].attrs["data-tandem-author-block"]).toBe("claude");
  });

  it("emits data-tandem-author-block='user' when user has more chars (majority wins)", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    // claude: 3 chars (1..4), user: 5 chars (4..9)
    addEntry(authorshipMap, "claude", "auth-claude", 1, 4);
    addEntry(authorshipMap, "user", "auth-user", 4, 9);

    const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
    buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

    expect(capturedNodes).toHaveLength(1);
    expect(capturedNodes[0].attrs["data-tandem-author-block"]).toBe("user");
  });

  it("tie-breaks to user when claude and user have equal coverage", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "claude", "auth-claude", 1, 4); // 3 chars
    addEntry(authorshipMap, "user", "auth-user", 4, 7); // 3 chars

    const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
    buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

    expect(capturedNodes).toHaveLength(1);
    expect(capturedNodes[0].attrs["data-tandem-author-block"]).toBe("user");
  });

  it("authorship range spanning two paragraphs gives each its own node decoration", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    // Range spans both blocks: para1 offset 1..11, para2 offset 13..23
    addEntry(authorshipMap, "user", "auth-1", 1, 23);

    const doc = makeMockDoc(
      [
        { typeName: "paragraph", size: 10, offset: 1 },
        { typeName: "paragraph", size: 10, offset: 13 },
      ],
      30,
    );
    buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

    expect(capturedNodes).toHaveLength(2);
    expect(capturedNodes[0].attrs["data-tandem-author-block"]).toBe("user");
    expect(capturedNodes[1].attrs["data-tandem-author-block"]).toBe("user");
  });

  it("import author entries are excluded from node decorations", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "import" as any, "auth-import", 1, 8);

    const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
    buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

    expect(capturedNodes).toHaveLength(0);
  });

  it("heading node receives a gutter decoration", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "user", "auth-1", 1, 5);

    const doc = makeMockDoc([{ typeName: "heading", size: 10, offset: 1 }]);
    buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

    expect(capturedNodes).toHaveLength(1);
    expect(capturedNodes[0].attrs["data-tandem-author-block"]).toBe("user");
  });

  it("bullet_list node does NOT receive a gutter decoration", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "claude", "auth-1", 1, 8);

    const doc = makeMockDoc([{ typeName: "bullet_list", size: 10, offset: 1 }]);
    buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

    expect(capturedNodes).toHaveLength(0);
  });

  it("block with no authorship coverage gets no node decoration", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    // No entries in map

    const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
    buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

    expect(capturedNodes).toHaveLength(0);
  });

  it("visible=false skips both inline and node decoration passes", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "user", "auth-1", 1, 5);

    const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
    buildAuthorshipDecorations(doc, authorshipMap, ydoc, false);

    expect(capturedInlines).toHaveLength(0);
    expect(capturedNodes).toHaveLength(0);
  });
});
