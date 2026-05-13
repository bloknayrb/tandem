import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants";

/**
 * Tests for the annotation decoration plugin's apply() recovery branch.
 *
 * The plugin has a one-shot recovery path: when Y.Map observer fires before
 * y-prosemirror populates the doc, decorationSet is empty despite annotations
 * existing. On the next docChanged transaction the plugin rebuilds. A
 * `recoveryAttempted` gate prevents O(n) rebuilds on every keystroke when
 * all annotations legitimately fail range validation.
 */

// --- ProseMirror mocks ---

const EMPTY_SENTINEL = Symbol("DecorationSet.empty");
let buildDecorationsResult: unknown = EMPTY_SENTINEL;

vi.mock("@tiptap/pm/view", () => ({
  DecorationSet: {
    empty: EMPTY_SENTINEL,
    create(_doc: unknown, decorations: unknown[]) {
      if (decorations.length === 0) return EMPTY_SENTINEL;
      return { decorations, _tag: "created" };
    },
  },
  Decoration: {
    inline(from: number, to: number, attrs: Record<string, string>) {
      return { from, to, attrs, _type: "inline" };
    },
  },
}));

vi.mock("@tiptap/pm/state", () => ({
  Plugin: class {
    constructor(public spec: any) {}
  },
  PluginKey: class {
    key: string;
    constructor(public name: string) {
      this.key = `tandemAnnotations$`;
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

vi.mock("../../src/client/positions", () => ({
  annotationToPmRange(_ann: unknown, _doc: unknown, _ydoc: unknown) {
    return buildDecorationsResult === EMPTY_SENTINEL
      ? null
      : { from: 1, to: 5, method: "flat" as const };
  },
}));

const { AnnotationExtension } = await import("../../src/client/editor/extensions/annotation");

// --- Helpers ---

function getPlugin(ydoc: Y.Doc) {
  const ext = AnnotationExtension as any;
  const plugins = ext.addProseMirrorPlugins.call({ options: { ydoc } });
  return plugins[0];
}

function makeTr(opts: { docChanged: boolean; meta?: boolean }) {
  return {
    docChanged: opts.docChanged,
    getMeta: () => (opts.meta ? true : undefined),
    setMeta: () => makeTr({ docChanged: false, meta: true }),
    mapping: {
      map: (pos: number) => pos,
    },
    doc: { content: { size: 100 } },
  };
}

const fakeState = { doc: { content: { size: 100 } } };

function addAnnotation(ydoc: Y.Doc, id = "ann-1") {
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  map.set(id, {
    id,
    type: "comment",
    status: "pending",
    content: "test",
    author: "claude",
    createdAt: Date.now(),
    range: { from: 1, to: 5 },
  });
}

// --- Tests ---

beforeEach(() => {
  buildDecorationsResult = EMPTY_SENTINEL;
});

describe("annotation plugin apply() recovery branch", () => {
  it("rebuilds when docChanged + empty decorations + annotations exist", () => {
    const ydoc = new Y.Doc();
    addAnnotation(ydoc);
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const result = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      EMPTY_SENTINEL,
      fakeState,
      fakeState,
    );

    expect(result).not.toBe(EMPTY_SENTINEL);
  });

  it("does not rebuild when no annotations exist", () => {
    const ydoc = new Y.Doc();
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const mockDecorationSet = { map: () => "mapped-forward" };
    const result = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      mockDecorationSet,
      fakeState,
      fakeState,
    );

    // No annotations → maps forward, no rebuild
    expect(result).toBe("mapped-forward");
  });

  it("gates recovery after successful rebuild", () => {
    const ydoc = new Y.Doc();
    addAnnotation(ydoc);
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    // First call: recovery fires
    const first = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      EMPTY_SENTINEL,
      fakeState,
      fakeState,
    );
    expect(first).not.toBe(EMPTY_SENTINEL);

    // Second call: gate is closed, maps forward instead of rebuilding
    buildDecorationsResult = "should-not-reach";
    const mockDecorationSet = {
      map: () => "mapped-forward",
    };
    const second = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      mockDecorationSet,
      fakeState,
      fakeState,
    );
    expect(second).toBe("mapped-forward");
  });

  it("retries recovery when first rebuild returns empty (transient partial-doc)", () => {
    const ydoc = new Y.Doc();
    addAnnotation(ydoc);

    const plugin = getPlugin(ydoc);

    // First attempt: buildDecorations returns empty (doc not ready yet)
    buildDecorationsResult = EMPTY_SENTINEL;
    const first = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      EMPTY_SENTINEL,
      fakeState,
      fakeState,
    );
    // Returns empty, but gate stays open because rebuild was unsuccessful
    expect(first).toBe(EMPTY_SENTINEL);

    // Second attempt: doc is now populated, ranges resolve
    buildDecorationsResult = "non-empty";
    const second = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      EMPTY_SENTINEL,
      fakeState,
      fakeState,
    );
    expect(second).not.toBe(EMPTY_SENTINEL);
  });

  it("observer resets recovery gate for new annotation changes", () => {
    const ydoc = new Y.Doc();
    addAnnotation(ydoc);
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);

    // Recovery fires and gate closes
    plugin.spec.state.apply(makeTr({ docChanged: true }), EMPTY_SENTINEL, fakeState, fakeState);

    // Simulate observer firing by adding another annotation
    // (the view() observer resets recoveryAttempted via the closure)
    const mockEditorView = {
      state: {
        tr: {
          setMeta: () => ({
            docChanged: false,
            getMeta: () => true,
          }),
        },
      },
      dispatch: () => {},
    };
    const viewReturn = plugin.spec.view(mockEditorView);

    // Trigger observer by mutating the Y.Map
    addAnnotation(ydoc, "ann-2");

    // Now the gate should be reset — recovery should fire again
    const result = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      EMPTY_SENTINEL,
      fakeState,
      fakeState,
    );
    expect(result).not.toBe(EMPTY_SENTINEL);

    viewReturn.destroy();
  });

  it("always rebuilds on annotationPluginKey meta (observer dispatch)", () => {
    const ydoc = new Y.Doc();
    addAnnotation(ydoc);
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const result = plugin.spec.state.apply(
      makeTr({ docChanged: false, meta: true }),
      EMPTY_SENTINEL,
      fakeState,
      fakeState,
    );

    expect(result).not.toBe(EMPTY_SENTINEL);
  });
});

// --- #610: rAF coalescing on Y.Map observer bursts ---

describe("annotation plugin observer coalescing (#610)", () => {
  let savedRAF: typeof globalThis.requestAnimationFrame;
  let savedCancelRAF: typeof globalThis.cancelAnimationFrame;
  let rafCallbacks: FrameRequestCallback[];
  let rafCount: number;

  beforeEach(() => {
    rafCallbacks = [];
    rafCount = 0;
    savedRAF = globalThis.requestAnimationFrame;
    savedCancelRAF = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return ++rafCount;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((_id: number) => {
      rafCallbacks = [];
    }) as typeof globalThis.cancelAnimationFrame;
  });

  function restoreRAF() {
    globalThis.requestAnimationFrame = savedRAF;
    globalThis.cancelAnimationFrame = savedCancelRAF;
  }

  function makeMockEditorView(): { view: any; dispatchCount: () => number } {
    let dispatchCount = 0;
    const view = {
      state: {
        tr: {
          setMeta: () => ({ docChanged: false, getMeta: () => true }),
        },
      },
      dispatch: () => {
        dispatchCount++;
      },
    };
    return { view, dispatchCount: () => dispatchCount };
  }

  it("coalesces a burst of N observer fires into one rebuild per frame", () => {
    const ydoc = new Y.Doc();
    const plugin = getPlugin(ydoc);
    const { view, dispatchCount } = makeMockEditorView();
    const viewReturn = plugin.spec.view(view);

    // Simulate a burst of Y.Map mutations within one tick.
    for (let i = 0; i < 100; i++) addAnnotation(ydoc, `ann-${i}`);

    // One rAF scheduled regardless of N; no dispatches yet (frame hasn't fired).
    expect(rafCallbacks.length).toBe(1);
    expect(dispatchCount()).toBe(0);

    // Flush the frame
    for (const cb of rafCallbacks) cb(0);
    rafCallbacks = [];
    expect(dispatchCount()).toBe(1);

    viewReturn.destroy();
    restoreRAF();
  });

  it("destroy() cancels a pending rAF rebuild", () => {
    const ydoc = new Y.Doc();
    const plugin = getPlugin(ydoc);
    const { view, dispatchCount } = makeMockEditorView();
    const viewReturn = plugin.spec.view(view);

    addAnnotation(ydoc, "ann-pending");
    expect(rafCallbacks.length).toBe(1);

    // Destroy before the frame fires; the queued rebuild must not dispatch.
    viewReturn.destroy();
    for (const cb of rafCallbacks) cb(0);
    expect(dispatchCount()).toBe(0);

    restoreRAF();
  });
});

// --- AR2: five visual languages ---

describe("AR2: annotation decoration attrs — five visual languages", () => {
  function addAnnotationEntry(
    ydoc: Y.Doc,
    fields: {
      id?: string;
      type: string;
      author: string;
      suggestedText?: string;
      color?: string;
    },
  ) {
    const id = fields.id ?? "ann-1";
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    map.set(id, {
      id,
      type: fields.type,
      status: "pending",
      content: "test",
      author: fields.author,
      audience: fields.author === "claude" ? "outbound" : "private",
      range: { from: 1, to: 5 },
      ...(fields.suggestedText !== undefined ? { suggestedText: fields.suggestedText } : {}),
      ...(fields.color !== undefined ? { color: fields.color } : {}),
    });
  }

  function getDecorations(
    ydoc: Y.Doc,
  ): Array<{ from: number; to: number; attrs: Record<string, string> }> {
    buildDecorationsResult = "non-empty";
    const plugin = getPlugin(ydoc);
    const result = plugin.spec.state.init(undefined, fakeState) as any;
    if (result === EMPTY_SENTINEL) return [];
    return result.decorations;
  }

  it("user comment → tandem-comment, dashed underline, data-annotation-author=user", () => {
    const ydoc = new Y.Doc();
    addAnnotationEntry(ydoc, { type: "comment", author: "user" });
    const [dec] = getDecorations(ydoc);
    expect(dec.attrs.class).toBe("tandem-comment");
    expect(dec.attrs.style).toContain("dashed");
    expect(dec.attrs["data-annotation-author"]).toBe("user");
  });

  it("claude comment → tandem-comment--claude, solid underline, data-annotation-author=claude", () => {
    const ydoc = new Y.Doc();
    addAnnotationEntry(ydoc, { type: "comment", author: "claude" });
    const [dec] = getDecorations(ydoc);
    expect(dec.attrs.class).toBe("tandem-comment tandem-comment--claude");
    expect(dec.attrs.style).toContain("solid");
    expect(dec.attrs["data-annotation-author"]).toBe("claude");
  });

  it("import comment → tandem-comment (not --claude), data-annotation-author=import", () => {
    const ydoc = new Y.Doc();
    addAnnotationEntry(ydoc, { type: "comment", author: "import" });
    const [dec] = getDecorations(ydoc);
    expect(dec.attrs.class).toBe("tandem-comment");
    expect(dec.attrs.style).toContain("dashed");
    expect(dec.attrs["data-annotation-author"]).toBe("import");
  });

  it("suggestion (comment with suggestedText) → tandem-suggestion, data-annotation-author set", () => {
    const ydoc = new Y.Doc();
    addAnnotationEntry(ydoc, { type: "comment", author: "claude", suggestedText: "replacement" });
    const [dec] = getDecorations(ydoc);
    expect(dec.attrs.class).toBe("tandem-suggestion");
    expect(dec.attrs["data-annotation-author"]).toBe("claude");
  });

  it("note → tandem-note, dotted underline, data-annotation-author set", () => {
    const ydoc = new Y.Doc();
    addAnnotationEntry(ydoc, { type: "note", author: "user" });
    const [dec] = getDecorations(ydoc);
    expect(dec.attrs.class).toBe("tandem-note");
    expect(dec.attrs.style).toContain("dotted");
    expect(dec.attrs["data-annotation-author"]).toBe("user");
  });

  it("highlight → tandem-highlight, data-annotation-author set", () => {
    const ydoc = new Y.Doc();
    addAnnotationEntry(ydoc, { type: "highlight", author: "user", color: "yellow" });
    const [dec] = getDecorations(ydoc);
    expect(dec.attrs.class).toContain("tandem-highlight");
    expect(dec.attrs["data-annotation-author"]).toBe("user");
  });
});
