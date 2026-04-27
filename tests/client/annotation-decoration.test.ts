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
