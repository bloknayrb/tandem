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

describe("AnnotationCardHeader type icon (author-tint model)", () => {
  function badge(container: HTMLElement): HTMLElement {
    const el = container.querySelector<HTMLElement>(".annotation-type-badge");
    expect(el).toBeTruthy();
    return el as HTMLElement;
  }

  // Queried by CLASS, not by a data-testid, deliberately: adding a testid would
  // force a testid-set snapshot regeneration and a manifest update under
  // Critical Rule 7, for a purely internal assertion handle.
  it("renders a sized svg glyph, never an unsized one", () => {
    const { container } = renderHeader(makeAnnotation());
    const svg = badge(container).querySelector("svg");
    expect(svg).toBeTruthy();
    // A viewBox alone gives an <svg> no intrinsic size — it resolves to the
    // 300x150 replaced-element default and blows out the header. There is no
    // CSS sizing rule for this icon, so the attributes are load-bearing.
    expect(svg?.getAttribute("width")).toBe("13");
    expect(svg?.getAttribute("height")).toBe("13");
  });

  it("names the type accessibly even though the word is visually hidden", () => {
    const { container } = renderHeader(makeAnnotation({ type: "note", author: "user" }));
    expect(badge(container).getAttribute("aria-label")).toBe("Private note");
  });

  it("paints a highlight's chosen color onto the icon, not the card", () => {
    const { container } = renderHeader(
      makeAnnotation({ type: "highlight", author: "user", color: "green" }),
    );
    const svg = badge(container).querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("var(--tandem-highlight-green)");
  });

  it("leaves non-highlight glyphs unfilled so they read as outlines", () => {
    const { container } = renderHeader(makeAnnotation({ type: "comment" }));
    expect(badge(container).querySelector("svg")?.getAttribute("fill")).toBe("none");
  });

  it("distinguishes a suggestion from a plain comment by glyph", () => {
    const { container: plain } = renderHeader(makeAnnotation({ type: "comment" }));
    const { container: sugg } = renderHeader(
      makeAnnotation({ type: "comment", suggestedText: "replacement" }),
    );
    expect(badge(plain).getAttribute("aria-label")).toBe("Comment");
    expect(badge(sugg).getAttribute("aria-label")).toBe("Suggested replacement");
  });
});
