// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import AnnotationCardHeader from "../../src/client/panels/AnnotationCardHeader.svelte";
import type { Annotation } from "../../src/shared/types";

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

function renderHeader(annotation: Annotation) {
  return render(AnnotationCardHeader, {
    props: {
      annotation,
      isPending: true,
      isEditing: false,
      canEdit: false,
      badgeBg: "transparent",
      badgeFg: "inherit",
      onEnterEdit: () => {},
    },
  });
}

function dotStyle(container: HTMLElement): string {
  const dot = container.querySelector("[data-testid='annotation-author-dot-annotation-1']");
  expect(dot).toBeTruthy();
  return dot?.getAttribute("style") ?? "";
}

describe("AnnotationCardHeader author dot color (#1123 M4)", () => {
  it("a claude annotation with NO agentIdentity uses the exact claude token (dark == today)", () => {
    const { container } = renderHeader(makeAnnotation());
    expect(dotStyle(container)).toContain("background: var(--tandem-author-claude);");
  });

  it("a claude annotation WITH agentIdentity uses the per-agent token, not the claude token", () => {
    const { container } = renderHeader(
      makeAnnotation({ agentIdentity: { provider: "local-ollama", displayName: "Qwen 2.5" } }),
    );
    const style = dotStyle(container);
    expect(style).toContain("background: var(--tandem-agent-local-ollama);");
    expect(style).not.toContain("var(--tandem-author-claude)");
  });

  it("a user annotation is unaffected by identity wiring", () => {
    const { container } = renderHeader(makeAnnotation({ author: "user" }));
    expect(dotStyle(container)).toContain("background: var(--tandem-author-user);");
  });
});
