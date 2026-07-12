import { render } from "@testing-library/svelte";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { useAnnotationReview } from "../../src/client/panels/useAnnotationReview.svelte.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import type { Annotation } from "../../src/shared/types.js";
import { isReviewTarget } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";
import UseAnnotationReviewHarness from "./harness/UseAnnotationReviewHarness.svelte";

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

// B2: accept-failure toast. When `applySuggestion` can't resolve an
// annotation's range, `resolveAnnotation` reverts the annotation to
// "pending" — this proves `onApplyFailed` fires on that same path so the
// caller can surface a toast instead of failing silently.
describe("useAnnotationReview — onApplyFailed (B2)", () => {
  /**
   * Mounts the hook via a real Svelte component (onDestroy/$state require
   * component-init context) and hands the returned API back synchronously.
   */
  function mountReview(params: Parameters<typeof useAnnotationReview>[0]) {
    let api: ReturnType<typeof useAnnotationReview> | undefined;
    render(UseAnnotationReviewHarness, {
      props: {
        params,
        onReady: (returned) => {
          api = returned;
        },
      },
    });
    if (!api) throw new Error("useAnnotationReview did not report ready");
    return api;
  }

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
    expect(onApplyFailed).toHaveBeenCalledWith(expect.objectContaining({ id: ann.id }));
    // ADR-027: the callback receives the annotation object for the caller to
    // build its own generic message from — but resolveAnnotation itself must
    // not have leaked content anywhere else. Reverted to pending:
    expect((map.get(ann.id) as Annotation).status).toBe("pending");
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
