// @vitest-environment happy-dom

import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import AnnotationCard from "../../src/client/panels/AnnotationCard.svelte";
import type { Annotation } from "../../src/shared/types";

// `cardEnter`/`cardExit` (cardMotion.ts) short-circuit to `{duration: 0}`
// whenever `lifecycleMotion` is false (the default we use throughout this
// file), so no WAAPI/`element.animate` stub is needed here — unlike
// ReplyThread's `discloseUnfold`, these never actually run.

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "annotation-1",
    type: "comment",
    author: "claude",
    status: "pending",
    content: "Body",
    range: { from: 0, to: 1 },
    timestamp: 0,
    ...overrides,
  } as Annotation;
}

describe("AnnotationCard — keyboard activation (C2)", () => {
  it("is tabbable (tabindex=0) when onClick is provided", () => {
    const onClick = vi.fn();
    const { container } = render(AnnotationCard, {
      props: { annotation: makeAnnotation(), onClick },
    });
    const card = container.querySelector("[data-testid='annotation-card-annotation-1']");
    expect(card?.getAttribute("tabindex")).toBe("0");
  });

  it("is NOT tabbable when onClick is absent", () => {
    const { container } = render(AnnotationCard, {
      props: { annotation: makeAnnotation() },
    });
    const card = container.querySelector("[data-testid='annotation-card-annotation-1']");
    expect(card?.hasAttribute("tabindex")).toBe(false);
  });

  it("fires onClick exactly once on Enter", async () => {
    const onClick = vi.fn();
    const { container } = render(AnnotationCard, {
      props: { annotation: makeAnnotation(), onClick },
    });
    const card = container.querySelector("[data-testid='annotation-card-annotation-1']") as Element;
    await fireEvent.keyDown(card, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("fires onClick exactly once on Space", async () => {
    const onClick = vi.fn();
    const { container } = render(AnnotationCard, {
      props: { annotation: makeAnnotation(), onClick },
    });
    const card = container.querySelector("[data-testid='annotation-card-annotation-1']") as Element;
    await fireEvent.keyDown(card, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onClick when Enter is pressed inside the reply composer", async () => {
    const onClick = vi.fn();
    const onReply = vi.fn(async () => true);
    const { container } = render(AnnotationCard, {
      props: {
        annotation: makeAnnotation(),
        onClick,
        onReply,
      },
    });

    // Open the reply composer.
    const replyBtn = container.querySelector("[data-testid='reply-btn-annotation-1']") as Element;
    expect(replyBtn).toBeTruthy();
    await fireEvent.click(replyBtn);

    const textarea = container.querySelector("[data-testid='reply-input-annotation-1']") as Element;
    expect(textarea).toBeTruthy();
    await fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onClick).not.toHaveBeenCalled();
  });
});
