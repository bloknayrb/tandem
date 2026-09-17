import { render } from "@testing-library/svelte";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions.js";
import { useAnnotationReview } from "../../src/client/panels/useAnnotationReview.svelte.js";
import UseAnnotationReviewHarness from "../../src/client/svelte-harness/UseAnnotationReviewHarness.svelte";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types.js";
import { isReviewTarget } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

/**
 * Inline implementation of the getReviewTargets filter — mirrors
 * useAnnotationReview.svelte.ts so we can test the predicate without
 * a Svelte rune environment.
 */
function getReviewTargets(annotations: Annotation[]): Annotation[] {
  return annotations.filter((a) => a.status === "pending" && isReviewTarget(a));
}

describe("isReviewTarget", () => {
  it("returns true for claude-authored annotations", () => {
    expect(isReviewTarget(makeAnnotation({ author: "claude" }))).toBe(true);
  });

  it("returns true for import-authored annotations (.docx Word comments)", () => {
    expect(isReviewTarget(makeAnnotation({ author: "import" }))).toBe(true);
  });

  it("returns false for user-authored annotations (private notes)", () => {
    expect(isReviewTarget(makeAnnotation({ author: "user" }))).toBe(false);
  });

  // Future-proofing: every value in Annotation["author"] must have a clear result.
  it.each([
    { author: "claude" as const, expected: true },
    { author: "import" as const, expected: true },
    { author: "user" as const, expected: false },
  ])("author=$author -> $expected", ({ author, expected }) => {
    expect(isReviewTarget(makeAnnotation({ author }))).toBe(expected);
  });
});

describe("getReviewTargets (filter applied at review callsite)", () => {
  const claudePending = makeAnnotation({ id: "c1", author: "claude", status: "pending" });
  const importPending = makeAnnotation({ id: "i1", author: "import", status: "pending" });
  const userPending = makeAnnotation({ id: "u1", author: "user", status: "pending" });
  const claudeAccepted = makeAnnotation({ id: "c2", author: "claude", status: "accepted" });

  it("includes claude-authored pending annotations", () => {
    const result = getReviewTargets([claudePending]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c1");
  });

  it("includes import-authored pending annotations (.docx Word comments)", () => {
    const result = getReviewTargets([importPending]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("i1");
  });

  it("excludes user-authored pending annotations (private notes)", () => {
    expect(getReviewTargets([userPending])).toHaveLength(0);
  });

  it("excludes resolved annotations regardless of author", () => {
    expect(getReviewTargets([claudeAccepted])).toHaveLength(0);
  });

  it("returns only claude + import when all three author types are pending", () => {
    const result = getReviewTargets([claudePending, importPending, userPending]);
    expect(result).toHaveLength(2);
    const ids = result.map((a) => a.id);
    expect(ids).toContain("c1");
    expect(ids).toContain("i1");
    expect(ids).not.toContain("u1");
  });
});

/**
 * Mounts the hook via a real Svelte component (onDestroy/$state require
 * component-init context) and hands the returned API back synchronously.
 *
 * Module-scoped because two describes drive the hook now: the B2 toast path
 * and the `resolvedBy` revert at the bottom of this file.
 */
function mountReview(params: Parameters<typeof useAnnotationReview>[0]) {
  let api: ReturnType<typeof useAnnotationReview> | undefined;
  render(UseAnnotationReviewHarness, {
    props: {
      params,
      onReady: (returned: ReturnType<typeof useAnnotationReview>) => {
        api = returned;
      },
    },
  });
  if (!api) throw new Error("useAnnotationReview did not report ready");
  return api;
}

describe("useAnnotationReview — onApplyFailed (B2)", () => {
  it("reverts to pending and calls onApplyFailed when the suggestion range can't resolve", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const ann = makeAnnotation({
      id: "unresolvable",
      author: "claude",
      type: "comment",
      status: "pending",
      suggestedText: "replacement text",
      // No `range` and no `relRange` — annotationToPmRange() has nothing to
      // resolve against, so applySuggestion() returns false.
      range: undefined,
    });
    map.set(ann.id, ann);

    // annotationToPmRange() returns null before it ever touches
    // `editor.state.doc` when the annotation has neither `range` nor
    // `relRange`, so an inert stub doc is sufficient here.
    const editor = {
      state: { doc: {} },
      chain: vi.fn(),
    } as unknown as TiptapEditor;

    const onApplyFailed = vi.fn();

    const review = mountReview({
      getYdoc: () => ydoc,
      getEditor: () => editor,
      getAnnotations: () => [map.get(ann.id) as Annotation],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto",
      onApplyFailed,
    });

    review.resolveAnnotation(ann.id, "accepted");

    expect(onApplyFailed).toHaveBeenCalledTimes(1);
    // The `"range"` half of the round-3 discriminant: an editor IS present here
    // and `applySuggestion` genuinely failed, so "the text has changed" is the
    // correct message. Its sibling row asserts `"no-editor"` on the same
    // callback — together they stop the two declines collapsing back into one.
    expect(onApplyFailed).toHaveBeenCalledWith(expect.objectContaining({ id: ann.id }), "range");
    // ADR-027: the callback receives the annotation object for the caller to
    // build its own generic message from — but resolveAnnotation itself must
    // not have leaked content anywhere else. Reverted to pending:
    expect((map.get(ann.id) as Annotation).status).toBe("pending");
  });

  it("reverts to pending and calls onApplyFailed when the TEXT DRIFTED (#1629)", () => {
    // The sibling case above drives the unresolvable-range path. This one
    // drives the drift path, which is the one #1629 added and the one the
    // toast's wording ("the text has changed") actually describes.
    //
    // They share the `if (!applied)` branch, so this is not re-testing that
    // branch — it is pinning that a drift decline REACHES it. Mutation check:
    // delete `onApplyFailed?.(ann)` and the whole drift-guard suite still
    // passes, because that file calls `applySuggestion` directly. This is the
    // only test that fails.
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const ann = makeAnnotation({
      id: "drifted",
      author: "claude",
      type: "comment",
      status: "pending",
      suggestedText: "replacement text",
      range: { from: toFlatOffset(0), to: toFlatOffset(11) },
      // The document says something else entirely at those offsets.
      textSnapshot: "hello world",
    });
    map.set(ann.id, ann);

    // A REAL editor: the drift guard reads the document, so a stub doc cannot
    // reach the branch under test.
    const editor = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p>totally other</p>",
    });

    const onApplyFailed = vi.fn();

    const review = mountReview({
      getYdoc: () => ydoc,
      getEditor: () => editor,
      getAnnotations: () => [map.get(ann.id) as Annotation],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto",
      onApplyFailed,
    });

    review.resolveAnnotation(ann.id, "accepted");

    expect(onApplyFailed).toHaveBeenCalledTimes(1);
    expect((map.get(ann.id) as Annotation).status).toBe("pending");
    // And the document was not touched on the way to that decline.
    expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", "\n")).toBe(
      "totally other",
    );
    editor.destroy();
  });

  it("does not call onApplyFailed when the suggestion applies successfully", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const ann = makeAnnotation({
      id: "no-suggestion",
      author: "claude",
      type: "comment",
      status: "pending",
    });
    map.set(ann.id, ann);

    const onApplyFailed = vi.fn();

    const review = mountReview({
      getYdoc: () => ydoc,
      getEditor: () => null,
      getAnnotations: () => [map.get(ann.id) as Annotation],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto",
      onApplyFailed,
    });

    // No `suggestedText` on this annotation, so the accept path never enters
    // the applySuggestion branch at all — dismissal-equivalent happy path.
    review.resolveAnnotation(ann.id, "accepted");

    expect(onApplyFailed).not.toHaveBeenCalled();
    expect((map.get(ann.id) as Annotation).status).toBe("accepted");
  });
});

/**
 * #1770 review round 1 — `resolvedBy` must not outlive the resolution it names.
 *
 * `sanitizeAnnotation` carries a stored `resolvedBy` through, so both client
 * revert writes used to spread it back onto a record they were putting BACK to
 * `pending`. `awareness.ts`'s `userResponses` bucket excludes
 * `resolvedBy === "claude"` — so a user who then accepts that record has their
 * decision permanently misattributed to Claude and reported to nobody.
 *
 * Reachable through a concurrent user Accept vs a Claude
 * `tandem_resolveAnnotation` dismiss on one pending record: the client passes
 * its own pending gate before Claude's write lands, Claude's write wins the
 * Y.Map tie, and the id is in `recentlyResolved`, so Undo is offered on a
 * record already stamped `claude`.
 */
describe("useAnnotationReview — the revert clears resolvedBy (#1770)", () => {
  it("strips a claude stamp when a dismissal is undone", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    // Claude's own dismiss, as `transitionPending` writes it.
    const ann = {
      ...makeAnnotation({
        id: "claude-dismissed",
        author: "claude",
        type: "comment",
        status: "dismissed",
      }),
      resolvedBy: "claude" as const,
    };
    map.set(ann.id, ann);

    const review = mountReview({
      getYdoc: () => ydoc,
      // No suggestedText, so the text-restore branch is never entered and the
      // status write is the only thing under test.
      getEditor: () => null,
      getAnnotations: () => [map.get(ann.id) as Annotation],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto",
    });

    expect(review.undoResolveAnnotation(ann.id)).toBe(true);

    const after = map.get(ann.id) as Annotation;
    expect(after.status).toBe("pending");
    expect(after.resolvedBy, "a pending record has not been resolved by anyone").toBeUndefined();
  });

  it("strips it on the apply-failure revert too, which is the other write", () => {
    // Both revert sites spread the sanitized record, so a fix applied to only
    // one of them leaves this green — hence a row per site.
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const ann = {
      ...makeAnnotation({
        id: "unresolvable-stamped",
        author: "claude",
        type: "comment",
        status: "pending",
        suggestedText: "replacement text",
        range: undefined,
      }),
      resolvedBy: "claude" as const,
    };
    map.set(ann.id, ann);

    const editor = { state: { doc: {} }, chain: vi.fn() } as unknown as TiptapEditor;

    const review = mountReview({
      getYdoc: () => ydoc,
      getEditor: () => editor,
      getAnnotations: () => [map.get(ann.id) as Annotation],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto",
      onApplyFailed: () => {},
    });

    review.resolveAnnotation(ann.id, "accepted");

    const after = map.get(ann.id) as Annotation;
    expect(after.status).toBe("pending");
    expect(after.resolvedBy).toBeUndefined();
  });
});

/**
 * #1826 item 1 — push and pull must not disagree after a failed Accept.
 *
 * `resolveAnnotation` used to write `status: "accepted"` FIRST and revert to
 * `pending` only after `applySuggestion` returned false. The server's annotation
 * observer emits `annotation:accepted` on that first write and has NO arm for a
 * revert to `pending`, so Claude was pushed `annotation:accepted` while every
 * `tandem_checkInbox` read `pending`.
 *
 * The discriminator is the SEQUENCE of statuses written, not the final one: the
 * two specs above already assert the final `pending` and stay green under the
 * bug. The failure branch still writes — a bare `return` would turn the #1770
 * stripper pin red — so "zero writes" is the wrong assertion too.
 */
describe("useAnnotationReview — no silent divergence after a failed Accept (#1826)", () => {
  /** Every `status` value written to `id`, in order. */
  function observeStatuses(map: Y.Map<unknown>, id: string): string[] {
    const seen: string[] = [];
    map.observe((event) => {
      if (!event.keysChanged.has(id)) return;
      const rec = map.get(id) as Annotation | undefined;
      if (rec) seen.push(rec.status);
    });
    return seen;
  }

  it("writes only `pending` when the apply fails", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const ann = makeAnnotation({
      id: "unresolvable-seq",
      author: "claude",
      type: "comment",
      status: "pending",
      suggestedText: "replacement text",
      // Neither `range` nor `relRange` — applySuggestion() returns false.
      range: undefined,
    });
    map.set(ann.id, ann);
    const seen = observeStatuses(map, ann.id);

    const editor = { state: { doc: {} }, chain: vi.fn() } as unknown as TiptapEditor;
    const review = mountReview({
      getYdoc: () => ydoc,
      getEditor: () => editor,
      getAnnotations: () => [map.get(ann.id) as Annotation],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto",
      onApplyFailed: () => {},
    });

    review.resolveAnnotation(ann.id, "accepted");

    // Before the fix: ["accepted", "pending"] — and the "accepted" is what the
    // observer turns into a channel event Claude can never reconcile.
    expect(seen).toEqual(["pending"]);
  });

  it("declines the accept when there is no editor to apply into", () => {
    // **Review round 1.** `if (editor && !applySuggestion(...))` short-circuits
    // on a null editor and fell through to the status write, so the record went
    // out `accepted` with the suggested text never inserted and no toast:
    // exactly the divergence this describe exists to close, by the one route
    // the rewritten condition made read as deliberate. `getEditor()` returns
    // null while the Tiptap instance is absent — a tab swap or a document
    // reload, with `SidePanel` mounted throughout by design.
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const ann = makeAnnotation({
      id: "no-editor",
      author: "claude",
      type: "comment",
      status: "pending",
      suggestedText: "replacement text",
      // A range that WOULD apply cleanly, so the only reason to decline is the
      // missing editor.
      range: { from: toFlatOffset(0), to: toFlatOffset(11) },
      textSnapshot: "hello world",
    });
    map.set(ann.id, ann);
    const seen = observeStatuses(map, ann.id);
    const applyFailed: string[] = [];
    const reasons: string[] = [];

    const review = mountReview({
      getYdoc: () => ydoc,
      getEditor: () => null,
      getAnnotations: () => [map.get(ann.id) as Annotation],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto",
      onApplyFailed: (failed, reason) => {
        applyFailed.push(failed.id);
        reasons.push(reason);
      },
    });

    review.resolveAnnotation(ann.id, "accepted");

    // Before the fix: ["accepted"], with the document untouched and
    // `applyFailed` empty.
    expect(seen).toEqual(["pending"]);
    expect(applyFailed).toEqual(["no-editor"]);
    // **Review round 3.** The reason, not just the fact. Both declines shared
    // one callback and `App.svelte` renders one message from it — "the text has
    // changed" — which is a false diagnosis here: the range above resolves
    // cleanly and the document is untouched. Source view is the reachable
    // route (`{#if !inSourceView}` unmounts Tiptap while this rail stays
    // mounted), so the user is told to hunt for an edit nobody made instead of
    // to leave the view they are in.
    expect(reasons).toEqual(["no-editor"]);
  });

  it("writes exactly one `accepted` when the apply succeeds (positive control)", () => {
    // Kills a fix that stops writing the status at all, and a double-write.
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const ann = makeAnnotation({
      id: "applies-cleanly",
      author: "claude",
      type: "comment",
      status: "pending",
      suggestedText: "goodbye world",
      range: { from: toFlatOffset(0), to: toFlatOffset(11) },
      textSnapshot: "hello world",
    });
    map.set(ann.id, ann);
    const seen = observeStatuses(map, ann.id);

    const editor = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p>hello world</p>",
    });
    const review = mountReview({
      getYdoc: () => ydoc,
      getEditor: () => editor,
      getAnnotations: () => [map.get(ann.id) as Annotation],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto",
      onApplyFailed: () => {},
    });

    review.resolveAnnotation(ann.id, "accepted");
    editor.destroy();

    expect(seen).toEqual(["accepted"]);
  });
});
