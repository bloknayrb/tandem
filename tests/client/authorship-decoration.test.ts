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

function makeMockDoc(size = 100) {
  return {
    content: { size },
    childCount: 1,
    child: () => ({
      type: { name: "paragraph" },
      isTextblock: true,
      textContent: "x".repeat(size),
      nodeSize: size + 2,
      childCount: 0,
      content: { size },
    }),
    forEach: () => {},
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

  it("still emits base class tandem-authorship", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "user");

    buildAuthorshipDecorations(makeMockDoc(), authorshipMap, ydoc, true);

    expect(capturedInlines).toHaveLength(1);
    expect(capturedInlines[0].attrs.class).toBe("tandem-authorship");
  });

  it("does NOT emit variant class (tandem-authorship--user)", () => {
    const ydoc = new Y.Doc();
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    addEntry(authorshipMap, "user");

    buildAuthorshipDecorations(makeMockDoc(), authorshipMap, ydoc, true);

    expect(capturedInlines).toHaveLength(1);
    expect(capturedInlines[0].attrs.class).not.toContain("tandem-authorship--");
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
});
