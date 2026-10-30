// @vitest-environment happy-dom

/**
 * #1632: Accept is not offered as live on an annotation whose target is gone.
 *
 * #1629 made the CLICK safe: `applySuggestion` reads the target and refuses a
 * contradicted one. The card still rendered an ordinary live Accept, so the user
 * found out from a toast after the click, and the card then looked exactly as
 * before. These pin the other half: the render-time verdict
 * (`useAnnotationReview`'s `isTargetLost`) is the SAME check the click runs
 * (`checkSuggestionTarget`), and the card and the native menu both act on it
 * through `isAcceptBlocked`.
 *
 * Live Tiptap editor throughout, for the reason `suggestion-accept-drift-guard`
 * gives: a mocked editor cannot observe the document the verdict reads.
 *
 * `@testing-library/svelte`'s auto-cleanup never registers in this repo (see
 * `reject-vs-dismiss-copy.test.ts`), so every render is unmounted by hand.
 */

import { within } from "@testing-library/dom";
import { render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import AnnotationCard from "../../src/client/panels/AnnotationCard.svelte";
import {
  buildAnnotationMenuContext,
  isAcceptBlocked,
} from "../../src/client/panels/annotation-context-menu";
import CommentThread from "../../src/client/panels/CommentThread.svelte";
import {
  applySuggestion,
  checkSuggestionTarget,
  type UseAnnotationReviewReturn,
  useAnnotationReview,
} from "../../src/client/panels/useAnnotationReview.svelte";
import UseAnnotationReviewHarness from "../../src/client/svelte-harness/UseAnnotationReviewHarness.svelte";
import { Y_MAP_ANNOTATION_REPLIES } from "../../src/shared/constants";
import type { Annotation, AnnotationReply } from "../../src/shared/types";
import { range } from "../helpers/positions";

/** Loose on purpose: some cases build records the type forbids (no `range`). */
type Extras = Record<string, unknown>;

function comment(extras: Extras = {}): Annotation {
  return {
    id: "a1",
    type: "comment",
    author: "claude",
    status: "pending",
    content: "why",
    timestamp: 0,
    range: range(0, 5),
    textSnapshot: "hello",
    ...extras,
  } as Annotation;
}

const suggestion = (extras: Extras = {}) => comment({ suggestedText: "howdy", ...extras });

/** Replace the first word, the way a user edit under the annotation would. */
function editTarget(editor: Editor) {
  editor.commands.insertContentAt({ from: 1, to: 6 }, "bye");
}

let ydoc: Y.Doc;
let editor: Editor;
beforeEach(() => {
  ydoc = new Y.Doc();
  editor = new Editor({ extensions: buildSchemaExtensions(), content: "<p>hello world</p>" });
});
afterEach(() => {
  editor.destroy();
  ydoc.destroy();
});

describe("checkSuggestionTarget — the one verdict behind both the click and the card", () => {
  it.each([
    ["intact target", suggestion(), "ok"],
    // The #2328 reload remap collapses a record whose text was deleted to a
    // point; its snapshot still claims "hello".
    ["point-collapsed after a reload", suggestion({ range: range(3, 3) }), "contradicted"],
    ["legacy record with no snapshot", suggestion({ textSnapshot: undefined }), "unverified"],
    ["no range at all", suggestion({ range: undefined }), "unresolvable"],
  ])("%s → %s", (_label, ann, kind) => {
    expect(checkSuggestionTarget(ann, editor.state.doc, ydoc).kind).toBe(kind);
  });

  it("reads `contradicted` once the text under the range changes", () => {
    editTarget(editor);
    expect(checkSuggestionTarget(suggestion(), editor.state.doc, ydoc).kind).toBe("contradicted");
  });

  it("does not short-circuit on a missing suggestedText (reply proposals rewrite the parent)", () => {
    editTarget(editor);
    expect(checkSuggestionTarget(comment(), editor.state.doc, ydoc).kind).toBe("contradicted");
  });

  it("refuses because of the target exactly when the verdict says the target is lost", () => {
    // Parity, the reason the check is shared: a disabled button the click
    // would have honoured, or a live one it will refuse, is the bug.
    const cases: Annotation[] = [
      suggestion(),
      suggestion({ range: range(3, 3) }),
      suggestion({ textSnapshot: undefined }),
      suggestion({ range: undefined }),
    ];
    for (const ann of cases) {
      const fresh = new Editor({
        extensions: buildSchemaExtensions(),
        content: "<p>hello world</p>",
      });
      const { kind } = checkSuggestionTarget(ann, fresh.state.doc, ydoc);
      const lost = kind === "unresolvable" || kind === "contradicted";
      expect(applySuggestion(ann, fresh, ydoc)).toBe(!lost);
      fresh.destroy();
    }
  });
});

describe("useAnnotationReview.isTargetLost — reactive on document edits", () => {
  function mount(annotations: Annotation[]) {
    let api: UseAnnotationReviewReturn | undefined;
    const r = render(UseAnnotationReviewHarness, {
      props: {
        params: {
          getYdoc: () => ydoc,
          getEditor: () => editor,
          getAnnotations: () => annotations,
          onActiveAnnotationChange: () => {},
          getScrollBehavior: () => "auto",
        },
        onReady: (returned: ReturnType<typeof useAnnotationReview>) => {
          api = returned;
        },
      },
    });
    if (!api) throw new Error("useAnnotationReview did not report ready");
    return { api, unmount: r.unmount };
  }

  it("flips to lost when the user edits the target, and back when it is restored", async () => {
    const { api, unmount } = mount([suggestion()]);
    expect(api.isTargetLost("a1")).toBe(false);

    editTarget(editor);
    await Promise.resolve(); // the coalesced tick
    await tick();
    expect(api.isTargetLost("a1")).toBe(true);

    editor.commands.insertContentAt({ from: 1, to: 4 }, "hello");
    await Promise.resolve();
    await tick();
    expect(api.isTargetLost("a1")).toBe(false);
    unmount();
  });

  it("grades a plain comment only when a reply proposes a replacement over it", async () => {
    // The parent carries no `suggestedText`, so its own Accept is a status
    // change; only the reply's "Accept replacement" rewrites its range.
    const { api, unmount } = mount([comment({ id: "plain" }), comment({ id: "proposed" })]);
    ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("r1", {
      id: "r1",
      annotationId: "proposed",
      author: "claude",
      text: "try this",
      suggestedText: "howdy",
      timestamp: 0,
    });
    editTarget(editor);
    await Promise.resolve();
    await tick();
    expect(api.isTargetLost("proposed")).toBe(true);
    expect(api.isTargetLost("plain")).toBe(false);
    unmount();
  });

  it("never grades a user-authored record (Accept is not offered on one)", async () => {
    const { api, unmount } = mount([suggestion({ author: "user", type: "note" })]);
    editTarget(editor);
    await Promise.resolve();
    await tick();
    expect(api.isTargetLost("a1")).toBe(false);
    unmount();
  });
});

describe("isAcceptBlocked — shared by the card and the native menu", () => {
  it("blocks a suggestion whose target is lost", () => {
    expect(isAcceptBlocked(suggestion(), true)).toBe(true);
    expect(buildAnnotationMenuContext(suggestion(), false, true).canAccept).toBe(false);
  });

  it("keeps a plain comment's Accept live: it is a status change and writes no text", () => {
    expect(isAcceptBlocked(comment(), true)).toBe(false);
    expect(buildAnnotationMenuContext(comment(), false, true).canAccept).toBe(true);
  });

  it("does not block when the target is intact", () => {
    expect(isAcceptBlocked(suggestion(), false)).toBe(false);
    expect(buildAnnotationMenuContext(suggestion(), false, false).canAccept).toBe(true);
  });
});

describe("the card renders a lost target as a disabled Accept with the reason", () => {
  function renderCard(ann: Annotation, targetLost: boolean, onAccept = vi.fn()) {
    const r = render(AnnotationCard, {
      props: {
        annotation: ann,
        isReviewTarget: false,
        onAccept,
        onDismiss: vi.fn(),
        targetLost,
        aiDisabled: false,
      },
    });
    return { ...r, onAccept, scoped: within(r.container) };
  }

  it("disables Accept, explains why, and keeps Dismiss live", () => {
    const { scoped, onAccept, unmount } = renderCard(suggestion(), true);
    const accept = scoped.getByTestId("accept-btn-a1") as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(accept.getAttribute("aria-describedby")).toBe("accept-blocked-a1");
    expect(scoped.getByTestId("accept-blocked-a1").textContent).toMatch(/has changed/);
    accept.click();
    expect(onAccept).not.toHaveBeenCalled();
    expect((scoped.getByTestId("dismiss-btn-a1") as HTMLButtonElement).disabled).toBe(false);
    unmount();
  });

  it("leaves Accept live on an intact target", () => {
    const { scoped, onAccept, unmount } = renderCard(suggestion(), false);
    const accept = scoped.getByTestId("accept-btn-a1") as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    expect(scoped.queryByTestId("accept-blocked-a1")).toBeNull();
    accept.click();
    expect(onAccept).toHaveBeenCalledWith("a1");
    unmount();
  });

  it("leaves a plain comment's Accept live even when its target is lost", () => {
    const { scoped, unmount } = renderCard(comment(), true);
    expect((scoped.getByTestId("accept-btn-a1") as HTMLButtonElement).disabled).toBe(false);
    expect(scoped.queryByTestId("accept-blocked-a1")).toBeNull();
    unmount();
  });

  it("disables a reply's Accept replacement when the parent's target is lost", () => {
    const reply = {
      id: "r1",
      annotationId: "a1",
      author: "claude",
      text: "try this",
      suggestedText: "howdy",
      timestamp: 0,
    } as AnnotationReply;
    const onAcceptReplySuggestion = vi.fn();
    const { container, unmount } = render(CommentThread, {
      props: {
        replies: [reply],
        annotation: comment(),
        isPending: true,
        onAcceptReplySuggestion,
        targetLost: true,
      },
    });
    const btn = within(container).getByTestId("accept-reply-btn-r1") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onAcceptReplySuggestion).not.toHaveBeenCalled();
    unmount();
  });
});
