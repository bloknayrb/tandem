import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const { AnnotationExtension, renderedDecorationType } = await import(
  "../../src/client/editor/extensions/annotation"
);
const { sanitizeAnnotation } = await import("../../src/shared/sanitize");

// --- Helpers ---

function getPlugin(ydoc: Y.Doc) {
  const ext = AnnotationExtension as any;
  const plugins = ext.addProseMirrorPlugins.call({ options: { ydoc } });
  return plugins[0];
}

function makeTr(opts: { docChanged: boolean; meta?: boolean | object }) {
  return {
    docChanged: opts.docChanged,
    getMeta: () => {
      if (opts.meta === undefined) return undefined;
      return opts.meta;
    },
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

  it("short-circuits to empty when no visible annotations exist (no rebuild)", () => {
    const ydoc = new Y.Doc();
    // If the plugin reached the recovery branch it would build "non-empty";
    // the empty result proves the hasVisibleAnnotations short-circuit fired
    // before any O(n) rebuild.
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const mockDecorationSet = { map: () => "mapped-forward" };
    const result = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      mockDecorationSet,
      fakeState,
      fakeState,
    );

    // No annotations → nothing visible → returns empty without rebuilding.
    expect(result).toBe(EMPTY_SENTINEL);
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

// --- #596 → 1.13: per-type decoration visibility ---

const DECORATION_KEY = "tandem:decorationVisibility";
const ALL_ON = { comment: true, highlight: true, note: true };
const ALL_OFF = { comment: false, highlight: false, note: false };

function clearVisibility() {
  try {
    localStorage.removeItem(DECORATION_KEY);
  } catch {
    // localStorage may not exist in this environment — fine.
  }
}

function setVisibility(v: { comment: boolean; highlight: boolean; note: boolean }) {
  localStorage.setItem(DECORATION_KEY, JSON.stringify(v));
}

function addTypedAnnotation(ydoc: Y.Doc, type: string, id = `ann-${type}`) {
  ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
    id,
    type,
    status: "pending",
    content: "test",
    author: type === "comment" ? "claude" : "user",
    createdAt: Date.now(),
    range: { from: 1, to: 5 },
  });
}

describe("annotation plugin decoration-visibility toggle (#596 → 1.13)", () => {
  beforeEach(clearVisibility);
  // Avoid leaking an all-off blob into AR2 tests further down the file —
  // those build plugins via init() and would otherwise see EMPTY_SENTINEL.
  afterEach(clearVisibility);

  it("plugin init returns empty DecorationSet when all types stored false", () => {
    setVisibility(ALL_OFF);
    const ydoc = new Y.Doc();
    addAnnotation(ydoc);
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const initial = plugin.spec.state.init(null, fakeState);

    expect(initial).toBe(EMPTY_SENTINEL);
  });

  it("plugin init returns built decorations when types stored true", () => {
    setVisibility(ALL_ON);
    const ydoc = new Y.Doc();
    addAnnotation(ydoc);
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const initial = plugin.spec.state.init(null, fakeState);

    expect(initial).not.toBe(EMPTY_SENTINEL);
  });

  it("apply() clears decorations on toggle-decorations meta with all types false", () => {
    const ydoc = new Y.Doc();
    addAnnotation(ydoc);
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const result = plugin.spec.state.apply(
      makeTr({
        docChanged: false,
        meta: { type: "toggle-decorations", visible: ALL_OFF },
      }),
      { _stub: "previous-set" },
      fakeState,
      fakeState,
    );

    expect(result).toBe(EMPTY_SENTINEL);
  });

  it("apply() rebuilds decorations on toggle-decorations meta with types true", () => {
    setVisibility(ALL_OFF);
    const ydoc = new Y.Doc();
    addAnnotation(ydoc);
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const result = plugin.spec.state.apply(
      makeTr({
        docChanged: false,
        meta: { type: "toggle-decorations", visible: ALL_ON },
      }),
      EMPTY_SENTINEL,
      fakeState,
      fakeState,
    );

    expect(result).not.toBe(EMPTY_SENTINEL);
  });

  it("apply() suppresses docChanged rebuild path when all types false", () => {
    setVisibility(ALL_OFF);
    const ydoc = new Y.Doc();
    addAnnotation(ydoc);
    // If the plugin ignored the toggle it would call buildDecorations on the
    // recovery branch (empty + docChanged + hasVisibleAnnotations).
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const result = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      EMPTY_SENTINEL,
      fakeState,
      fakeState,
    );

    expect(result).toBe(EMPTY_SENTINEL);
  });

  // Recovery-guard interaction (plan-review HIGH). A doc holding only
  // hidden-type annotations is a PERMANENT "annotations present but nothing
  // visible" state. If the guard tracked mere presence (hasAnnotations) the
  // recovery branch would re-run buildDecorations O(n) on every keystroke
  // forever. Tracking hasVisibleAnnotations short-circuits before recovery.
  it("does NOT rebuild on docChanged when all annotations are a hidden type", () => {
    setVisibility({ comment: true, highlight: true, note: false });
    const ydoc = new Y.Doc();
    addTypedAnnotation(ydoc, "note");
    // Would build "non-empty" if the recovery branch were reached — proving a
    // (forbidden) per-keystroke rebuild. The empty result proves it short-circuits.
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const first = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      EMPTY_SENTINEL,
      fakeState,
      fakeState,
    );
    expect(first).toBe(EMPTY_SENTINEL);
    // Second keystroke: still no rebuild.
    const second = plugin.spec.state.apply(
      makeTr({ docChanged: true }),
      EMPTY_SENTINEL,
      fakeState,
      fakeState,
    );
    expect(second).toBe(EMPTY_SENTINEL);
  });

  it("builds only the visible type (comments off, highlights on)", () => {
    setVisibility({ comment: false, highlight: true, note: true });
    const ydoc = new Y.Doc();
    addTypedAnnotation(ydoc, "highlight");
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const initial = plugin.spec.state.init(null, fakeState);
    // Highlight is visible → builds.
    expect(initial).not.toBe(EMPTY_SENTINEL);
  });

  // Privacy invariant (plan-review LOW → regression guard). Hiding notes is
  // DISPLAY-ONLY: the note is suppressed from the decoration set but stays in
  // the Y.Map untouched, so the channel-observer / MCP layer (ADR-027) is
  // unaffected — Claude never reads notes regardless of this toggle.
  it("showNotes:false hides the note mark but leaves the note in the Y.Map", () => {
    setVisibility({ comment: true, highlight: true, note: false });
    const ydoc = new Y.Doc();
    addTypedAnnotation(ydoc, "note", "note-1");
    buildDecorationsResult = "non-empty";

    const plugin = getPlugin(ydoc);
    const initial = plugin.spec.state.init(null, fakeState);
    // No visible annotations → no decorations rendered.
    expect(initial).toBe(EMPTY_SENTINEL);
    // The note is still present in the CRDT map — display filter never mutates it.
    expect(ydoc.getMap(Y_MAP_ANNOTATIONS).has("note-1")).toBe(true);
  });
});

// --- #610: rAF coalescing on Y.Map observer bursts ---

describe("annotation plugin observer coalescing (#610)", () => {
  let savedRAF: typeof globalThis.requestAnimationFrame;
  let savedCancelRAF: typeof globalThis.cancelAnimationFrame;
  // Map id → callback so `cancelAnimationFrame` only removes the matching
  // entry (matches real browser semantics; a sloppy "clear-all" cancel mock
  // would mask a bug where production canceled an unrelated frame).
  let rafQueue: Map<number, FrameRequestCallback>;
  let rafCount: number;

  beforeEach(() => {
    rafQueue = new Map();
    rafCount = 0;
    savedRAF = globalThis.requestAnimationFrame;
    savedCancelRAF = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = ++rafCount;
      rafQueue.set(id, cb);
      return id;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      rafQueue.delete(id);
    }) as typeof globalThis.cancelAnimationFrame;
  });

  function restoreRAF() {
    globalThis.requestAnimationFrame = savedRAF;
    globalThis.cancelAnimationFrame = savedCancelRAF;
  }

  function flushRAF() {
    const callbacks = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of callbacks) cb(0);
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
    expect(rafQueue.size).toBe(1);
    expect(dispatchCount()).toBe(0);

    flushRAF();
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
    expect(rafQueue.size).toBe(1);

    // Destroy before the frame fires; the queued rebuild must not dispatch.
    viewReturn.destroy();
    expect(rafQueue.size).toBe(0);
    flushRAF();
    expect(dispatchCount()).toBe(0);

    restoreRAF();
  });
});

// --- renderedDecorationType must mirror sanitize's type bucketing ---

describe("renderedDecorationType mirrors sanitizeAnnotation", () => {
  // The cheap visible-annotations walk reads RAW Y.Map types and maps them via
  // renderedDecorationType; buildDecorations filters the SANITIZED type. If the
  // two ever disagree, the gate hides a renderable annotation (or vice versa).
  // This pins the mirror so a future change to sanitize's bucketing breaks here.
  it.each([
    { raw: "highlight", why: "highlight keeps its own bucket" },
    { raw: "note", why: "note keeps its own bucket" },
    { raw: "flag", why: "legacy flag → note" },
    { raw: "comment", why: "comment is a comment" },
    { raw: "suggestion", why: "legacy suggestion → comment" },
    { raw: "question", why: "legacy question → comment" },
    { raw: "totally-unknown", why: "unknown type → comment" },
  ])("$raw → same bucket as sanitize ($why)", ({ raw }) => {
    const sanitized = sanitizeAnnotation(
      {
        id: "t",
        type: raw,
        author: "claude",
        status: "pending",
        content: "x",
        range: { from: 1, to: 2 },
        timestamp: Date.now(),
      } as never,
      () => {},
    );
    expect(renderedDecorationType(raw)).toBe(sanitized.type);
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
