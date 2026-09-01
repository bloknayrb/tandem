import { Editor } from "@tiptap/core";
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions.js";
import type { RailTab } from "../../src/client/layout/model.svelte.js";
import {
  createRailContentModel,
  type RailContentModel,
  type RailContentOptions,
} from "../../src/client/layout/rail-content.svelte.js";
import { SNAPSHOT_CAP } from "../../src/shared/snapshot.js";
import type { Annotation } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

/**
 * Harness rules for this file, inherited from `layout-model.svelte.test.ts`
 * because breaking rule 1 there cost three review rounds:
 *
 * 1. **Every injected source must be `$state`-backed.** A plain object literal
 *    or plain array handed in as a thunk is inert: the mutant that hoists a read
 *    out of a reaction survives, because nothing in the test ever changes the
 *    value. `railStubs` below exists for exactly that reason.
 * 2. **A getter is not pinned by reading it back.** A frozen value returns the
 *    right answer at every direct read while template reactivity is dead. The
 *    only instrument is an `$effect` that subscribes to the member and records
 *    what it SEES — and the run COUNT alone is not enough either, because a
 *    getter that still performs a tracked read while returning a stale value
 *    re-runs on schedule and fails only on the recorded values. Every count
 *    assertion here is paired with a `seen` assertion.
 */

let disposeRoot: (() => void) | null = null;

afterEach(() => {
  disposeRoot?.();
  disposeRoot = null;
});

/** `$state`-backed stand-ins for everything the model reads through a thunk. */
function railStubs(overrides: Partial<RailContentOptions> = {}) {
  let activeRailTab = $state<RailTab>("annotations");
  let rightVisible = $state(false);
  let findBarOpen = $state(false);
  let activeTabId = $state<string | null>("doc-1");
  let annotations = $state<Annotation[]>([]);
  let firstTarget = $state<Annotation | undefined>(undefined);

  const opts: RailContentOptions = {
    getActiveRailTab: () => activeRailTab,
    getEffectiveRightVisible: () => rightVisible,
    getFindBarOpen: () => findBarOpen,
    getEditor: () => null,
    getActiveTabId: () => activeTabId,
    getVisibleAnnotations: () => annotations,
    getFirstReviewTarget: () => firstTarget,
    ...overrides,
  };

  return {
    opts,
    setRailTab(next: RailTab) {
      activeRailTab = next;
      flushSync();
    },
    setRightVisible(next: boolean) {
      rightVisible = next;
      flushSync();
    },
    setFindBarOpen(next: boolean) {
      findBarOpen = next;
      flushSync();
    },
    setActiveTabId(next: string | null) {
      activeTabId = next;
      flushSync();
    },
    setAnnotations(next: Annotation[]) {
      annotations = next;
      flushSync();
    },
    setFirstTarget(next: Annotation | undefined) {
      firstTarget = next;
      flushSync();
    },
  };
}

/** Build the model inside a real effect root so its three `$effect`s run. */
function mount(overrides: Partial<RailContentOptions> = {}) {
  const stubs = railStubs(overrides);
  let model!: RailContentModel;
  disposeRoot = $effect.root(() => {
    model = createRailContentModel(stubs.opts);
  });
  flushSync();
  return { model, ...stubs };
}

describe("createRailContentModel — reveal lifecycle", () => {
  it("opens over a collapsed rail and no-ops over a pinned one", () => {
    const h = mount();
    h.model.openReveal();
    flushSync();
    expect(h.model.revealOpen).toBe(true);

    h.model.closeReveal();
    h.setRightVisible(true);
    h.model.openReveal();
    flushSync();
    // The pinned-rail guard. Without it a command reveal would float Chat over
    // a rail that is already showing it.
    expect(h.model.revealOpen).toBe(false);
  });

  it("closeReveal is idempotent", () => {
    const h = mount();
    h.model.openReveal();
    flushSync();
    h.model.closeReveal();
    h.model.closeReveal();
    expect(h.model.revealOpen).toBe(false);
  });

  it("closes when the document changes, and not when it does not", () => {
    const h = mount();
    h.model.openReveal();
    flushSync();

    // Same document: the effect re-runs (activeTabId is a tracked dep) and must
    // NOT close. Asserting only the switch case would leave an unconditional
    // close green.
    h.setActiveTabId("doc-1");
    expect(h.model.revealOpen).toBe(true);

    h.setActiveTabId("doc-2");
    expect(h.model.revealOpen).toBe(false);
  });

  it("a reveal opened over a new document survives a switch BACK to the old one", () => {
    // Pins that the document id is captured at open time rather than read as a
    // constant. A model that stored the FIRST document forever would pass the
    // test above and fail here.
    const h = mount();
    h.setActiveTabId("doc-2");
    h.model.openReveal();
    flushSync();
    expect(h.model.revealOpen).toBe(true);

    h.setActiveTabId("doc-1");
    expect(h.model.revealOpen).toBe(false);
  });

  it("registers capture-phase listeners only while open, and removes them on close", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const h = mount();

    const before = add.mock.calls.filter((c) => c[2] === true).length;
    h.model.openReveal();
    flushSync();
    const armed = add.mock.calls.filter((c) => c[2] === true);
    expect(armed.length - before).toBe(2);
    // Capture phase is the contract, not an implementation detail: Escape has
    // to beat the chat composer's own textarea handler.
    expect(
      armed
        .slice(before)
        .map((c) => c[0])
        .sort(),
    ).toEqual(["keydown", "pointerdown"]);

    h.model.closeReveal();
    flushSync();
    expect(remove.mock.calls.filter((c) => c[2] === true).length).toBe(2);

    add.mockRestore();
    remove.mockRestore();
  });

  it("Escape closes the reveal and an outside pointerdown closes it", () => {
    const h = mount();
    h.model.openReveal();
    flushSync();

    window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    expect(h.model.revealOpen).toBe(false);

    h.model.openReveal();
    flushSync();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(h.model.revealOpen).toBe(false);
  });

  it("a pointerdown inside .rail-shell-right does NOT close the reveal", () => {
    const rail = document.createElement("div");
    rail.className = "rail-shell-right";
    const inner = document.createElement("button");
    rail.appendChild(inner);
    document.body.appendChild(rail);

    const h = mount();
    h.model.openReveal();
    flushSync();
    inner.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    expect(h.model.revealOpen).toBe(true);

    rail.remove();
  });

  it("an already-prevented Escape does not close the reveal", () => {
    const h = mount();
    h.model.openReveal();
    flushSync();
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    e.preventDefault();
    window.dispatchEvent(e);
    flushSync();
    // A modal that handled Escape already consumed this keystroke.
    expect(h.model.revealOpen).toBe(true);
  });

  it("Escape hands focus back to the editor after closing the reveal", () => {
    // Declared NO-INSTRUMENT in the battery on the grounds that the unit specs
    // inject a null editor. That was the classification being wrong, not the
    // call being uncoverable -- the handler only needs `view.focus` to exist, so
    // a spy stands in for a real editor. Review pushed back and was right.
    const focus = vi.fn();
    const h = mount({ getEditor: () => ({ view: { focus } }) as unknown as Editor });
    h.model.openReveal();
    flushSync();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();

    // The half the reveal assertion cannot see: Escape closes the float AND
    // returns the caret, so the user can keep typing where they left off.
    expect(h.model.revealOpen).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("revealOpen is reactive, not a frozen value", () => {
    const h = mount();
    const seen: boolean[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        seen.push(h.model.revealOpen);
      });
    });
    flushSync();
    h.model.openReveal();
    flushSync();
    // The VALUES, not the run count: a getter performing a tracked read while
    // returning a stale value re-runs on schedule and passes a count check.
    expect(seen).toEqual([false, true]);
    stop();
  });
});

describe("createRailContentModel — captured anchor", () => {
  it("captures the editor selection as a flat range with a snapshot", () => {
    const editor = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p>hello world</p>",
    });
    const h = mount({ getEditor: () => editor });
    editor.commands.setTextSelection({ from: 1, to: 6 });

    h.model.captureSelectionForChat();
    expect(h.model.capturedAnchor?.textSnapshot).toBe("hello");
    editor.destroy();
  });

  it("truncates a selection longer than SNAPSHOT_CAP, ellipsis included in the cap", () => {
    // The cap is what keeps a whole-document selection out of every chat
    // message and out of the tandem_checkInbox payload. Length is asserted as
    // exactly SNAPSHOT_CAP, not merely bounded: the ellipsis is spent from
    // INSIDE the budget (`slice(0, CAP - 3)`), so a version that appended it
    // afterwards would sit at CAP + 3 and pass a `toBeLessThanOrEqual`.
    const long = "x".repeat(SNAPSHOT_CAP * 2);
    const editor = new Editor({
      extensions: buildSchemaExtensions(),
      content: `<p>${long}</p>`,
    });
    const h = mount({ getEditor: () => editor });
    editor.commands.setTextSelection({ from: 1, to: long.length + 1 });

    h.model.captureSelectionForChat();
    const snapshot = h.model.capturedAnchor?.textSnapshot ?? "";
    expect(snapshot).toHaveLength(SNAPSHOT_CAP);
    expect(snapshot.endsWith("...")).toBe(true);
    editor.destroy();
  });

  it("leaves a selection of exactly SNAPSHOT_CAP characters untruncated", () => {
    // The boundary, and the ONLY length at which `>` and `>=` disagree. The spec
    // above uses SNAPSHOT_CAP * 2, where both operators truncate identically --
    // so on its own it leaves the comparison unpinned, and a `>=` would shorten
    // a legitimately full-length snapshot by three characters and append an
    // ellipsis it did not earn.
    const exact = "y".repeat(SNAPSHOT_CAP);
    const editor = new Editor({
      extensions: buildSchemaExtensions(),
      content: `<p>${exact}</p>`,
    });
    const h = mount({ getEditor: () => editor });
    editor.commands.setTextSelection({ from: 1, to: exact.length + 1 });

    h.model.captureSelectionForChat();
    expect(h.model.capturedAnchor?.textSnapshot).toBe(exact);
    editor.destroy();
  });

  it("refuses to capture while the Chat tab is already selected", () => {
    const editor = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p>hello world</p>",
    });
    const h = mount({ getEditor: () => editor });
    editor.commands.setTextSelection({ from: 1, to: 6 });
    h.setRailTab("chat");

    // The whole point of the anchor is to carry context the user was looking at
    // when they LEFT the document. Already being in Chat means there is none.
    h.model.captureSelectionForChat();
    expect(h.model.capturedAnchor).toBeNull();
    editor.destroy();
  });

  it("refuses to capture an empty selection or with no editor", () => {
    const editor = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p>hello world</p>",
    });
    const withEditor = mount({ getEditor: () => editor });
    editor.commands.setTextSelection({ from: 3, to: 3 });
    withEditor.model.captureSelectionForChat();
    expect(withEditor.model.capturedAnchor).toBeNull();
    disposeRoot?.();
    disposeRoot = null;

    const noEditor = mount();
    noEditor.model.captureSelectionForChat();
    expect(noEditor.model.capturedAnchor).toBeNull();
    editor.destroy();
  });

  it("capturedAnchor is reactive, not a frozen value", () => {
    const h = mount();
    const seen: (string | null)[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        seen.push(h.model.capturedAnchor?.textSnapshot ?? null);
      });
    });
    flushSync();
    h.model.setCapturedAnchor({ start: 0, end: 2, textSnapshot: "hi" } as never);
    flushSync();
    expect(seen).toEqual([null, "hi"]);
    stop();
  });
});

describe("createRailContentModel — review selection", () => {
  const claude = makeAnnotation({ id: "c1", author: "claude", status: "pending" });
  const userHighlight = makeAnnotation({ id: "u1", author: "user", status: "pending" });

  it("activeOrFirstPending returns the ACTIVE annotation even when it is a user highlight", () => {
    // #768: the active branch returns whatever is selected, which can be a user
    // highlight overlapping a Claude comment. The `author !== "user"` guard
    // lives at the CALL SITES; folding it in here would also filter the
    // fallback branch and change behaviour.
    const h = mount();
    h.setAnnotations([claude, userHighlight]);
    h.setFirstTarget(claude);
    h.model.setActiveAnnotationId("u1");

    expect(h.model.activeOrFirstPending()?.id).toBe("u1");
  });

  it("activeOrFirstPending falls back to the first review target when nothing is active", () => {
    const h = mount();
    h.setAnnotations([claude, userHighlight]);
    h.setFirstTarget(claude);
    expect(h.model.activeOrFirstPending()?.id).toBe("c1");
  });

  it("Escape deselects from an editing surface", () => {
    const h = mount();
    h.model.setActiveAnnotationId("c1");
    flushSync();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(h.model.activeAnnotationId).toBeNull();
  });

  it("Escape does NOT deselect while the find bar is open", () => {
    const h = mount();
    h.model.setActiveAnnotationId("c1");
    h.setFindBarOpen(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    // The find bar closes on Escape WITHOUT preventDefault, so this guard is
    // the only thing between an open find bar and a stray deselect.
    expect(h.model.activeAnnotationId).toBe("c1");
  });

  it("Escape does NOT deselect when focus is in a text field INSIDE an editing surface", () => {
    // The nesting is the whole test. A bare input attached to `document.body`
    // is already refused by the `inEditingSurface` check one line further down,
    // so a fixture like that passes with the text-field guard DELETED --
    // measured: the first version of this spec did exactly that and the mutant
    // survived. A reply textarea inside the annotation list is the real case,
    // and there the field guard is the only thing standing between typing
    // Escape in a reply box and losing the selection behind it.
    const container = document.createElement("div");
    container.setAttribute("data-testid", "annotation-list-scroll-container");
    const field = document.createElement("textarea");
    container.appendChild(field);
    document.body.appendChild(container);
    field.focus();

    const h = mount();
    h.model.setActiveAnnotationId("c1");
    flushSync();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(h.model.activeAnnotationId).toBe("c1");

    container.remove();
  });

  it("Escape DOES deselect from a non-field element inside an editing surface", () => {
    // The positive control for the spec above: same container, focus on
    // something that is not a text field. Without this, narrowing
    // `inEditingSurface` to nothing at all would leave that spec green.
    const container = document.createElement("div");
    container.setAttribute("data-testid", "annotation-list-scroll-container");
    const button = document.createElement("button");
    container.appendChild(button);
    document.body.appendChild(container);
    button.focus();

    const h = mount();
    h.model.setActiveAnnotationId("c1");
    flushSync();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(h.model.activeAnnotationId).toBeNull();

    container.remove();
  });

  it("Escape does NOT deselect when focus is OUTSIDE every editing surface", () => {
    // The `inEditingSurface` guard itself. Deleting it leaves both specs above
    // green -- measured -- because in each of them focus is already inside a
    // recognised surface. Escape pressed with a toolbar button focused belongs
    // to that button, not to the annotation selection behind it.
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    const h = mount();
    h.model.setActiveAnnotationId("c1");
    flushSync();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(h.model.activeAnnotationId).toBe("c1");

    button.remove();
  });

  it("an already-prevented Escape does not deselect", () => {
    const h = mount();
    h.model.setActiveAnnotationId("c1");
    flushSync();
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    e.preventDefault();
    window.dispatchEvent(e);
    flushSync();
    expect(h.model.activeAnnotationId).toBe("c1");
  });

  it("the deselect listener is NOT capture-phase", () => {
    // Deliberate asymmetry with the reveal's Escape handler, and the reason is
    // the `defaultPrevented` guard above: this one has to LOSE to anything that
    // handles Escape first. Capture phase would make it win.
    const add = vi.spyOn(window, "addEventListener");
    mount();
    flushSync();
    const keydowns = add.mock.calls.filter((c) => c[0] === "keydown");
    expect(keydowns.length).toBe(1);
    expect(keydowns[0][2]).toBeUndefined();
    add.mockRestore();
  });

  it("activeAnnotationId is reactive, not a frozen value", () => {
    const h = mount();
    const seen: (string | null)[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        seen.push(h.model.activeAnnotationId);
      });
    });
    flushSync();
    h.model.setActiveAnnotationId("c1");
    flushSync();
    expect(seen).toEqual([null, "c1"]);
    stop();
  });
});
