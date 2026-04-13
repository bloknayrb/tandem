import { describe, expect, it, vi } from "vitest";
import type { ClaudeAwareness } from "../../src/shared/types";

/**
 * Tests for buildAwarenessDecorations — the pure function that maps
 * Claude's awareness state to ProseMirror decorations.
 *
 * We mock the ProseMirror Decoration/DecorationSet APIs and use the
 * same makeMockDoc helper from coordinate-conversion.test.ts.
 */

// --- ProseMirror mocks ---

// Capture decoration calls for assertions
type CapturedNode = { from: number; to: number; attrs: Record<string, string> };
type CapturedWidget = { pos: number; toDOM: () => HTMLElement };

let capturedNodes: CapturedNode[] = [];
let capturedWidgets: CapturedWidget[] = [];

vi.mock("@tiptap/pm/view", () => {
  const empty = Symbol("empty");
  return {
    DecorationSet: {
      empty,
      create(_doc: unknown, decorations: unknown[]) {
        return { decorations, _tag: "created" };
      },
    },
    Decoration: {
      node(from: number, to: number, attrs: Record<string, string>) {
        const d = { from, to, attrs, _type: "node" };
        capturedNodes.push(d);
        return d;
      },
      widget(pos: number, toDOM: () => HTMLElement) {
        const d = { pos, toDOM, _type: "widget" };
        capturedWidgets.push(d);
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

// Must import AFTER mocks are registered
const { buildAwarenessDecorations } = await import("../../src/client/editor/extensions/awareness");

// --- Mock doc helper (same shape as coordinate-conversion.test.ts) ---

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
    forEach(cb: (node: MockBlock, offset: number) => void) {
      let offset = 0;
      for (const child of children) {
        cb(child, offset);
        offset += child.nodeSize;
      }
    },
  };
}

function makeAwareness(overrides: Partial<ClaudeAwareness> = {}): ClaudeAwareness {
  return {
    status: "working",
    timestamp: Date.now(),
    active: true,
    focusParagraph: null,
    focusOffset: null,
    ...overrides,
  };
}

// Reset captured decorations before each test
import { beforeEach } from "vitest";

beforeEach(() => {
  capturedNodes = [];
  capturedWidgets = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAwarenessDecorations", () => {
  it("returns empty for null awareness", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    const result = buildAwarenessDecorations(doc as any, null);
    // DecorationSet.empty is a symbol — the function returns it directly
    expect(typeof result).toBe("symbol");
  });

  it("returns empty when focusParagraph and focusOffset are both null", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    const result = buildAwarenessDecorations(
      doc as any,
      makeAwareness({ focusParagraph: null, focusOffset: null }),
    );
    expect(typeof result).toBe("symbol"); // DecorationSet.empty
  });

  it("creates paragraph gutter decoration for focusParagraph=0", () => {
    const doc = makeMockDoc([
      { type: "paragraph", text: "Hello" },
      { type: "paragraph", text: "World" },
    ]);
    const result = buildAwarenessDecorations(doc as any, makeAwareness({ focusParagraph: 0 }));
    expect(capturedNodes).toHaveLength(1);
    expect(capturedNodes[0].from).toBe(0); // first block offset
    expect(capturedNodes[0].to).toBe(7); // 0 + nodeSize(2+5)
    expect(capturedNodes[0].attrs.class).toBe("tandem-claude-focus");
    // Result should be a created DecorationSet, not empty
    expect((result as any)._tag).toBe("created");
  });

  it("creates cursor widget at offset 0 (start of document)", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    const result = buildAwarenessDecorations(doc as any, makeAwareness({ focusOffset: 0 }));
    expect(capturedWidgets).toHaveLength(1);
    // Flat offset 0 in "Hello" paragraph -> PM pos 1
    expect(capturedWidgets[0].pos).toBe(1);
    expect((result as any)._tag).toBe("created");
  });

  it("creates cursor widget at mid-document offset", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    buildAwarenessDecorations(doc as any, makeAwareness({ focusOffset: 2 }));
    expect(capturedWidgets).toHaveLength(1);
    // Flat offset 2 -> PM pos 3
    expect(capturedWidgets[0].pos).toBe(3);
  });

  it("clamps cursor beyond doc size to end (no crash)", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hi" }]);
    // Flat text is "Hi" (length 2), doc.content.size = 4, offset 999 exceeds both
    buildAwarenessDecorations(doc as any, makeAwareness({ focusOffset: 999 }));
    expect(capturedWidgets).toHaveLength(1);
    // flatOffsetToPmPos falls through to doc.content.size = 4
    expect(capturedWidgets[0].pos).toBe(doc.content.size);
  });

  it("adds idle class when active is false", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    buildAwarenessDecorations(doc as any, makeAwareness({ focusOffset: 0, active: false }));
    expect(capturedWidgets).toHaveLength(1);
    // Invoke the toDOM factory with a minimal DOM mock to inspect the element
    const mockEl = { className: "", setAttribute: vi.fn(), appendChild: vi.fn() };
    const mockLabel = { className: "", textContent: "" };
    const origDocument = globalThis.document;
    globalThis.document = {
      createElement: vi.fn().mockReturnValueOnce(mockEl).mockReturnValueOnce(mockLabel),
    } as any;
    try {
      capturedWidgets[0].toDOM();
      expect(mockEl.className).toContain("tandem-claude-cursor-idle");
    } finally {
      globalThis.document = origDocument;
    }
  });

  it("does not add idle class when active is true", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    buildAwarenessDecorations(doc as any, makeAwareness({ focusOffset: 0, active: true }));
    expect(capturedWidgets).toHaveLength(1);
    const mockEl = { className: "", setAttribute: vi.fn(), appendChild: vi.fn() };
    const mockLabel = { className: "", textContent: "" };
    const origDocument = globalThis.document;
    globalThis.document = {
      createElement: vi.fn().mockReturnValueOnce(mockEl).mockReturnValueOnce(mockLabel),
    } as any;
    try {
      capturedWidgets[0].toDOM();
      expect(mockEl.className).not.toContain("idle");
    } finally {
      globalThis.document = origDocument;
    }
  });

  it("creates gutter only when focusParagraph set and focusOffset is null", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    buildAwarenessDecorations(doc as any, makeAwareness({ focusParagraph: 0, focusOffset: null }));
    expect(capturedNodes).toHaveLength(1);
    expect(capturedWidgets).toHaveLength(0);
  });

  it("falls back to gutter-only when cursor creation throws", () => {
    const doc = makeMockDoc([{ type: "paragraph", text: "Hello" }]);
    // Temporarily make flatOffsetToPmPos throw by passing a doc that throws on child()
    const badDoc = {
      ...doc,
      childCount: 1,
      child() {
        throw new Error("simulated PM error");
      },
      content: doc.content,
      forEach: doc.forEach.bind(doc),
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = buildAwarenessDecorations(
      badDoc as any,
      makeAwareness({ focusParagraph: 0, focusOffset: 2 }),
    );

    // Gutter decoration still created (uses forEach which works)
    expect(capturedNodes).toHaveLength(1);
    // Widget failed — caught by try/catch
    expect(capturedWidgets).toHaveLength(0);
    // Warning logged with error object
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("cursor decoration failed"),
      expect.any(Error),
    );
    // Still returns a valid DecorationSet (not empty, since gutter exists)
    expect((result as any)._tag).toBe("created");

    warnSpy.mockRestore();
  });
});
