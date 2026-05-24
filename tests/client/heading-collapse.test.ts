// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the heading-collapse plugin (issue #650 + #815 review).
 *
 * Coverage:
 *  - walkHeadings: top-level heading discovery + duplicate-ordinal hashing.
 *  - normalizeHeadingText: trim / lowercase / whitespace collapse.
 *  - load/save localStorage round-trip, empty-set cleanup, upload:// skip.
 *  - reconcileOnEdit: the HIGH fix — editing a collapsed heading's text must
 *    NOT erase persistence (count-stable → migrate; count-decreased → prune).
 *  - init(empty doc) → rehydrate(content arrives) → apply transition: directly
 *    guards the original empty-doc-wipe fix.
 *
 * We mock the ProseMirror primitives (same approach as
 * annotation-decoration.test.ts) so the plugin spec can be constructed and its
 * init/apply arms driven without a full editor + jsdom stack. `walkHeadings`
 * and `buildHideDecorations` only read a lightweight node shape, so we feed them
 * fake docs.
 */

const EMPTY_SENTINEL = Symbol("DecorationSet.empty");

vi.mock("@tiptap/pm/view", () => ({
  DecorationSet: {
    empty: EMPTY_SENTINEL,
    create(_doc: unknown, decorations: unknown[]) {
      if (decorations.length === 0) return EMPTY_SENTINEL;
      return { decorations, _tag: "created" };
    },
  },
  Decoration: {
    widget(pos: number, _render: unknown, spec: Record<string, unknown>) {
      return { pos, spec, _type: "widget" };
    },
    node(from: number, to: number, attrs: Record<string, string>) {
      return { from, to, attrs, _type: "node" };
    },
  },
}));

vi.mock("@tiptap/pm/state", () => ({
  Plugin: class {
    // biome-ignore lint/suspicious/noExplicitAny: test mock mirrors PM's Plugin spec shape
    constructor(public spec: any) {}
  },
  PluginKey: class {
    key: string;
    constructor(public name: string) {
      this.key = `${name}$`;
    }
    getState() {
      return null;
    }
  },
}));

vi.mock("@tiptap/core", () => ({
  Extension: {
    create<T>(config: T) {
      return config;
    },
  },
}));

const {
  walkHeadings,
  normalizeHeadingText,
  loadCollapsed,
  saveCollapsed,
  reconcileOnEdit,
  HeadingCollapseExtension,
} = await import("../../src/client/editor/extensions/heading-collapse");

// --- Fake ProseMirror doc -------------------------------------------------

interface FakeNode {
  type: { name: string };
  attrs: Record<string, unknown>;
  textContent: string;
  nodeSize: number;
}

/**
 * Build a fake doc whose top-level children are the given nodes. Supports the
 * two traversal APIs the plugin uses: `descendants` (walkHeadings) and
 * `forEach` (buildHideDecorations), plus `content.size`.
 */
function fakeDoc(children: FakeNode[]) {
  const doc: any = {
    type: { name: "doc" },
    content: { size: children.reduce((acc, c) => acc + c.nodeSize, 0) + 2 },
    descendants(fn: (node: FakeNode, pos: number, parent: unknown) => boolean | void) {
      let pos = 1; // doc open token at 0; first child starts at 1
      for (const child of children) {
        fn(child, pos, doc);
        pos += child.nodeSize;
      }
    },
    forEach(fn: (child: FakeNode, offset: number, index: number) => void) {
      let offset = 1;
      children.forEach((child, index) => {
        fn(child, offset, index);
        offset += child.nodeSize;
      });
    },
  };
  return doc;
}

function heading(level: number, text: string): FakeNode {
  return {
    type: { name: "heading" },
    attrs: { level },
    textContent: text,
    nodeSize: text.length + 2,
  };
}

function para(text: string): FakeNode {
  return {
    type: { name: "paragraph" },
    attrs: {},
    textContent: text,
    nodeSize: text.length + 2,
  };
}

// --- normalizeHeadingText -------------------------------------------------

describe("normalizeHeadingText", () => {
  it("trims, lowercases, and collapses internal whitespace", () => {
    expect(normalizeHeadingText("  Hello   World  ")).toBe("hello world");
    expect(normalizeHeadingText("Section\t\tOne")).toBe("section one");
    expect(normalizeHeadingText("ALREADY")).toBe("already");
  });
});

// --- walkHeadings + hash recipe -------------------------------------------

describe("walkHeadings", () => {
  it("collects top-level headings in order with level + text-derived hash", () => {
    const doc = fakeDoc([
      heading(1, "Title"),
      para("intro"),
      heading(2, "First Section"),
      para("body"),
      heading(2, "Second Section"),
    ]);
    const headings = walkHeadings(doc);
    expect(headings.map((h) => h.hash)).toEqual([
      "1::title::0",
      "2::first section::0",
      "2::second section::0",
    ]);
    expect(headings.map((h) => h.level)).toEqual([1, 2, 2]);
    // Positions are ascending.
    expect(headings[0].pos).toBeLessThan(headings[1].pos);
  });

  it("distinguishes duplicate headings by positional ordinal", () => {
    const doc = fakeDoc([heading(2, "Notes"), heading(2, "Notes"), heading(2, "Notes")]);
    expect(walkHeadings(doc).map((h) => h.hash)).toEqual([
      "2::notes::0",
      "2::notes::1",
      "2::notes::2",
    ]);
  });

  it("ignores non-heading nodes", () => {
    const doc = fakeDoc([para("a"), para("b")]);
    expect(walkHeadings(doc)).toEqual([]);
  });
});

// --- localStorage load/save ----------------------------------------------

describe("loadCollapsed / saveCollapsed", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a collapsed set", () => {
    saveCollapsed("/tmp/doc.md", new Set(["2::a::0", "2::b::0"]));
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::a::0", "2::b::0"]));
  });

  it("removes the key when saving an empty set", () => {
    saveCollapsed("/tmp/doc.md", new Set(["x"]));
    expect(window.localStorage.getItem("tandem:headingCollapse:/tmp/doc.md")).not.toBeNull();
    saveCollapsed("/tmp/doc.md", new Set());
    expect(window.localStorage.getItem("tandem:headingCollapse:/tmp/doc.md")).toBeNull();
  });

  it("returns an empty set for null path or missing key", () => {
    expect(loadCollapsed(null)).toEqual(new Set());
    expect(loadCollapsed("/tmp/never-saved.md")).toEqual(new Set());
  });

  it("skips persistence for ephemeral upload:// paths", () => {
    saveCollapsed("upload://abc-123", new Set(["2::x::0"]));
    // Nothing written under any key.
    expect(window.localStorage.length).toBe(0);
    expect(loadCollapsed("upload://abc-123")).toEqual(new Set());
  });

  it("ignores corrupt JSON / non-array payloads", () => {
    window.localStorage.setItem("tandem:headingCollapse:/tmp/x.md", "{not json");
    expect(loadCollapsed("/tmp/x.md")).toEqual(new Set());
    window.localStorage.setItem("tandem:headingCollapse:/tmp/y.md", JSON.stringify({ a: 1 }));
    expect(loadCollapsed("/tmp/y.md")).toEqual(new Set());
  });
});

// --- reconcileOnEdit: the HIGH fix ----------------------------------------

describe("reconcileOnEdit (HIGH: editing a collapsed heading must not wipe state)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("migrates the collapsed entry to the new hash when a heading's text is edited (count unchanged)", () => {
    const prev = walkHeadings(fakeDoc([heading(2, "First Section"), heading(2, "Second")]));
    // User types into "First Section" → "First Sectionx".
    const next = walkHeadings(fakeDoc([heading(2, "First Sectionx"), heading(2, "Second")]));
    const collapsed = new Set(["2::first section::0"]);

    const result = reconcileOnEdit(prev, next, collapsed, "/tmp/doc.md");

    // Old hash gone, new hash present → section stays collapsed across the edit.
    expect(result.has("2::first section::0")).toBe(false);
    expect(result.has("2::first sectionx::0")).toBe(true);
    // Persistence updated, NOT erased.
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::first sectionx::0"]));
  });

  it("returns the same set instance when no collapsed heading changed (count unchanged)", () => {
    const prev = walkHeadings(fakeDoc([heading(2, "A"), heading(2, "B")]));
    const next = walkHeadings(fakeDoc([heading(2, "A"), heading(2, "Bx")]));
    const collapsed = new Set(["2::a::0"]); // collapsed heading "A" untouched
    const result = reconcileOnEdit(prev, next, collapsed, "/tmp/doc.md");
    expect(result).toBe(collapsed);
  });

  it("prunes a vanished hash when a heading is genuinely deleted (count decreased)", () => {
    const prev = walkHeadings(fakeDoc([heading(2, "A"), heading(2, "B")]));
    const next = walkHeadings(fakeDoc([heading(2, "B")])); // "A" deleted
    const collapsed = new Set(["2::a::0", "2::b::0"]);
    const result = reconcileOnEdit(prev, next, collapsed, "/tmp/doc.md");
    expect(result).toEqual(new Set(["2::b::0"]));
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::b::0"]));
  });

  it("retains everything when a heading is added (count increased)", () => {
    const prev = walkHeadings(fakeDoc([heading(2, "A")]));
    const next = walkHeadings(fakeDoc([heading(2, "A"), heading(2, "New")]));
    const collapsed = new Set(["2::a::0"]);
    const result = reconcileOnEdit(prev, next, collapsed, "/tmp/doc.md");
    expect(result).toBe(collapsed);
  });

  it("no-ops on an empty collapsed set", () => {
    const prev = walkHeadings(fakeDoc([heading(2, "A")]));
    const next = walkHeadings(fakeDoc([heading(2, "Ax")]));
    const collapsed = new Set<string>();
    expect(reconcileOnEdit(prev, next, collapsed, "/tmp/doc.md")).toBe(collapsed);
  });

  // --- Finding 2 (#815 re-review): multi-index change → retain, no mis-migrate
  it("does NOT mis-migrate a collapsed entry on a same-count reorder of distinct headings", () => {
    // "A" and "B" swap positions (count unchanged, two indices differ).
    const prev = walkHeadings(fakeDoc([heading(2, "A"), heading(2, "B")]));
    const next = walkHeadings(fakeDoc([heading(2, "B"), heading(2, "A")]));
    const collapsed = new Set(["2::a::0"]);

    const result = reconcileOnEdit(prev, next, collapsed, "/tmp/doc.md");

    // Multiple index mismatches → retain unchanged (same instance), no blind
    // index-pairing that would migrate "a::0" onto the unrelated "b::0" slot.
    expect(result).toBe(collapsed);
    expect(result).toEqual(new Set(["2::a::0"]));
    // Nothing persisted (no spurious save on the ambiguous case).
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set());
  });

  it("does NOT mis-migrate on a net-zero add+delete (two indices differ, count stable)", () => {
    // "Old" replaced by "New" at index 0 AND a new tail heading swaps in at
    // index 1 — two simultaneous mismatches with identical count.
    const prev = walkHeadings(fakeDoc([heading(2, "Old"), heading(2, "Keep")]));
    const next = walkHeadings(fakeDoc([heading(2, "New"), heading(2, "Other")]));
    const collapsed = new Set(["2::old::0"]);

    const result = reconcileOnEdit(prev, next, collapsed, "/tmp/doc.md");

    // Retain unchanged rather than pairing index 0 → "new::0".
    expect(result).toBe(collapsed);
    expect(result.has("2::new::0")).toBe(false);
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set());
  });

  // --- Finding 1 (#815 re-review): force-reload empty transaction must not erase
  it("does NOT erase localStorage when a force-reload drops the doc to zero headings then restores it", () => {
    // Simulate the y-prosemirror split-swap: clear (full → empty) then
    // populate (empty → full). The intermediate empty transaction must NOT
    // garbage-collect the collapsed set, since the editor is not remounted and
    // rehydrate will not re-run to recover it.
    saveCollapsed("/tmp/doc.md", new Set(["2::a::0", "2::b::0"]));
    const content = walkHeadings(fakeDoc([heading(2, "A"), heading(2, "B")]));
    const empty = walkHeadings(fakeDoc([]));
    const collapsed = new Set(["2::a::0", "2::b::0"]);

    // Step 1: full → empty (clear transaction during force-reload). hasSeenContent
    // is true at this point (the caller only invokes reconcileOnEdit after the
    // initial sync). Count drops to 0.
    const afterClear = reconcileOnEdit(content, empty, collapsed, "/tmp/doc.md");
    // Suppressed: collapsed set survives untouched, localStorage NOT erased.
    expect(afterClear).toBe(collapsed);
    expect(afterClear).toEqual(new Set(["2::a::0", "2::b::0"]));
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::a::0", "2::b::0"]));

    // Step 2: empty → full (repopulate transaction). Count increases → retain.
    const afterRepopulate = reconcileOnEdit(empty, content, afterClear, "/tmp/doc.md");
    expect(afterRepopulate).toEqual(new Set(["2::a::0", "2::b::0"]));
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::a::0", "2::b::0"]));
  });

  it("still prunes a genuine single-heading deletion (count drops to non-zero)", () => {
    // Regression guard: the empty-doc suppression must not over-broaden to all
    // count-decreased cases. Deleting one of two headings still GCs the vanished
    // hash because the post-edit count is > 0.
    const prev = walkHeadings(fakeDoc([heading(2, "A"), heading(2, "B")]));
    const next = walkHeadings(fakeDoc([heading(2, "B")]));
    const collapsed = new Set(["2::a::0", "2::b::0"]);
    const result = reconcileOnEdit(prev, next, collapsed, "/tmp/doc.md");
    expect(result).toEqual(new Set(["2::b::0"]));
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::b::0"]));
  });
});

// --- Plugin spec: init(empty) → rehydrate(content) → apply ----------------

function getPluginSpec(filePath: string | null) {
  const ext = HeadingCollapseExtension as any;
  const plugins = ext.addProseMirrorPlugins.call({ options: { filePath } });
  return plugins[0].spec;
}

describe("plugin lifecycle: empty-init → content-arrival rehydrate → on-edit", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("does not prune persisted state at init against an empty doc", () => {
    saveCollapsed("/tmp/doc.md", new Set(["2::first section::0"]));
    const spec = getPluginSpec("/tmp/doc.md");
    const emptyDoc = fakeDoc([]);

    const state = spec.state.init({}, { doc: emptyDoc });
    // Persisted set survives the empty init; not yet "seen content".
    expect(state.collapsed).toEqual(new Set(["2::first section::0"]));
    expect(state.hasSeenContent).toBe(false);
    // localStorage untouched.
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::first section::0"]));
  });

  it("rehydrate prunes against the now-populated doc and flips hasSeenContent", () => {
    // localStorage has one valid hash and one stale hash.
    saveCollapsed("/tmp/doc.md", new Set(["2::first section::0", "2::ghost::0"]));
    const spec = getPluginSpec("/tmp/doc.md");

    const prev = spec.state.init({}, { doc: fakeDoc([]) });
    const populated = fakeDoc([heading(2, "First Section"), para("body")]);
    const rehydrateTr = {
      docChanged: true,
      getMeta: (k: unknown) => (k ? { type: "rehydrate" } : undefined),
      mapping: { map: (p: number) => p },
    };
    const next = spec.state.apply(rehydrateTr, prev, {}, { doc: populated });

    expect(next.hasSeenContent).toBe(true);
    expect(next.collapsed).toEqual(new Set(["2::first section::0"]));
    // Stale hash garbage-collected from localStorage.
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::first section::0"]));
  });

  it("after rehydrate, editing the collapsed heading's text keeps it collapsed (full transition)", () => {
    saveCollapsed("/tmp/doc.md", new Set(["2::first section::0"]));
    const spec = getPluginSpec("/tmp/doc.md");

    // init on empty doc
    const s0 = spec.state.init({}, { doc: fakeDoc([]) });

    // content arrives → rehydrate
    const populated = fakeDoc([heading(2, "First Section"), para("body")]);
    const s1 = spec.state.apply(
      {
        docChanged: true,
        getMeta: (k: unknown) => (k ? { type: "rehydrate" } : undefined),
        mapping: { map: (p: number) => p },
      },
      s0,
      {},
      { doc: populated },
    );
    expect(s1.collapsed.has("2::first section::0")).toBe(true);

    // user types into the heading → text edit, same heading count
    const edited = fakeDoc([heading(2, "First Sectionz"), para("body")]);
    const s2 = spec.state.apply(
      {
        docChanged: true,
        getMeta: () => undefined,
        mapping: { map: (p: number) => p },
      },
      s1,
      {},
      { doc: edited },
    );

    // Collapse migrated to the new hash — NOT erased, NOT re-expanded.
    expect(s2.collapsed.has("2::first section::0")).toBe(false);
    expect(s2.collapsed.has("2::first sectionz::0")).toBe(true);
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::first sectionz::0"]));
  });

  it("force-reload through apply(): clear-to-empty then restore preserves collapse + localStorage", () => {
    // Finding 1, exercised end-to-end through the plugin's apply() arm.
    saveCollapsed("/tmp/doc.md", new Set(["2::first section::0"]));
    const spec = getPluginSpec("/tmp/doc.md");

    // init populated → hasSeenContent true from the start (force-reload does NOT
    // remount the editor, so we model the pre-reload populated state).
    const populated = fakeDoc([heading(2, "First Section"), para("body")]);
    const s0 = spec.state.init({}, { doc: populated });
    expect(s0.hasSeenContent).toBe(true);
    expect(s0.collapsed).toEqual(new Set(["2::first section::0"]));

    // Force-reload clear: doc → empty (count drops to 0). The empty-doc
    // suppression must keep the collapsed set + localStorage intact.
    const s1 = spec.state.apply(
      {
        docChanged: true,
        getMeta: () => undefined,
        mapping: { map: (p: number) => p },
      },
      s0,
      {},
      { doc: fakeDoc([]) },
    );
    expect(s1.collapsed).toEqual(new Set(["2::first section::0"]));
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::first section::0"]));

    // Force-reload repopulate: empty → full content returns. Collapse survives.
    const s2 = spec.state.apply(
      {
        docChanged: true,
        getMeta: () => undefined,
        mapping: { map: (p: number) => p },
      },
      s1,
      {},
      { doc: fakeDoc([heading(2, "First Section"), para("body")]) },
    );
    expect(s2.collapsed).toEqual(new Set(["2::first section::0"]));
    expect(loadCollapsed("/tmp/doc.md")).toEqual(new Set(["2::first section::0"]));
  });

  it("populated-at-init still reconciles edits (hasSeenContent true from the start)", () => {
    saveCollapsed("/tmp/doc.md", new Set(["2::a::0"]));
    const spec = getPluginSpec("/tmp/doc.md");
    const populated = fakeDoc([heading(2, "A"), heading(2, "B")]);

    const s0 = spec.state.init({}, { doc: populated });
    expect(s0.hasSeenContent).toBe(true);

    // Delete heading "B" → count decreased; "A" stays collapsed.
    const s1 = spec.state.apply(
      {
        docChanged: true,
        getMeta: () => undefined,
        mapping: { map: (p: number) => p },
      },
      s0,
      {},
      { doc: fakeDoc([heading(2, "A")]) },
    );
    expect(s1.collapsed).toEqual(new Set(["2::a::0"]));
  });
});

afterEach(() => {
  window.localStorage.clear();
});
