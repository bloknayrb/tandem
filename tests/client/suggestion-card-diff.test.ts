// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import SuggestionCard from "../../src/client/panels/SuggestionCard.svelte";
import type { Annotation } from "../../src/shared/types";

// B1: suggestion cards used to strike the whole `textSnapshot` and insert the
// whole `suggestedText`, which is unreadable for a one-word change in a long
// sentence. `SuggestionCard.svelte` now renders a word-level diff (via
// `diffWords`) inside the existing `suggestion-diff-{id}` container, falling
// back to the legacy whole-text rendering when there's no snapshot or the
// input is too large to diff.

type SuggestionAnnotation = Annotation & { type: "comment"; suggestedText: string };

// happy-dom's CSSStyleDeclaration doesn't reliably resolve individual
// longhand properties (e.g. `.style.textDecoration`) out of an inline style
// string containing `var(...)` values, so match against the raw `style`
// attribute text instead — robust regardless of CSSOM parsing quirks.
function hasStyle(span: Element, needle: string): boolean {
  return (span.getAttribute("style") ?? "").includes(needle);
}

function makeAnnotation(overrides: Partial<SuggestionAnnotation> = {}): SuggestionAnnotation {
  return {
    id: "sugg-1",
    type: "comment",
    author: "claude",
    status: "pending",
    content: "",
    range: { from: 0, to: 10 },
    timestamp: 1_700_000_000_000,
    suggestedText: "",
    ...overrides,
  } as SuggestionAnnotation;
}

describe("SuggestionCard — word-level diff (B1)", () => {
  it("strikes only the changed word, leaving unchanged words un-struck", () => {
    const annotation = makeAnnotation({
      textSnapshot: "The quick brown fox jumps",
      suggestedText: "The quick red fox jumps",
    });

    const { container } = render(SuggestionCard, {
      props: {
        annotation,
        isPending: true,
        isEditing: false,
        canEdit: true,
        onEnterEdit: () => {},
      },
    });

    const diffEl = container.querySelector(`[data-testid="suggestion-diff-${annotation.id}"]`);
    expect(diffEl).toBeTruthy();

    // Struck spans (line-through) must contain only the changed word.
    const struckSpans = Array.from(diffEl?.querySelectorAll("span") ?? []).filter((span) =>
      hasStyle(span, "line-through"),
    );
    expect(struckSpans).toHaveLength(1);
    expect(struckSpans[0].textContent?.trim()).toBe("brown");

    // Unchanged words render in the container but NOT inside a struck span.
    expect(diffEl?.textContent).toContain("The");
    expect(diffEl?.textContent).toContain("quick");
    expect(diffEl?.textContent).toContain("fox");
    expect(diffEl?.textContent).toContain("jumps");
    expect(diffEl?.textContent).toContain("red");

    // The legacy " → " separator must NOT appear — that's only in the
    // whole-text fallback rendering.
    expect(diffEl?.textContent).not.toContain(" → ");
  });

  it("falls back to the legacy strike+arrow+insert rendering when the diff exceeds the size cap", () => {
    const big = "word ".repeat(2000); // > 6_000 combined chars -> diffWords returns null
    const annotation = makeAnnotation({
      textSnapshot: big,
      suggestedText: "short replacement",
    });

    const { container } = render(SuggestionCard, {
      props: {
        annotation,
        isPending: true,
        isEditing: false,
        canEdit: true,
        onEnterEdit: () => {},
      },
    });

    const diffEl = container.querySelector(`[data-testid="suggestion-diff-${annotation.id}"]`);
    expect(diffEl).toBeTruthy();

    // Legacy rendering: whole snapshot struck through, " → ", whole suggestion inserted.
    expect(diffEl?.textContent).toContain(" → ");
    const struckSpans = Array.from(diffEl?.querySelectorAll("span") ?? []).filter((span) =>
      hasStyle(span, "line-through"),
    );
    expect(struckSpans).toHaveLength(1);
    expect(struckSpans[0].textContent?.trim()).toBe(big.trim());
  });

  it("keeps the insert-only rendering when there is no textSnapshot", () => {
    const annotation = makeAnnotation({
      textSnapshot: undefined,
      suggestedText: "Brand new suggested text",
    });

    const { container } = render(SuggestionCard, {
      props: {
        annotation,
        isPending: true,
        isEditing: false,
        canEdit: true,
        onEnterEdit: () => {},
      },
    });

    const diffEl = container.querySelector(`[data-testid="suggestion-diff-${annotation.id}"]`);
    expect(diffEl).toBeTruthy();

    // No struck span at all — nothing to diff against.
    const struckSpans = Array.from(diffEl?.querySelectorAll("span") ?? []).filter((span) =>
      hasStyle(span, "line-through"),
    );
    expect(struckSpans).toHaveLength(0);
    expect(diffEl?.textContent).not.toContain(" → ");
    expect(diffEl?.textContent?.trim()).toBe("Brand new suggested text");
  });

  it("renders equal segments as plain (non-highlighted) spans for a mostly-unchanged sentence", () => {
    const annotation = makeAnnotation({
      textSnapshot: "This sentence has one typo in it.",
      suggestedText: "This sentence has one fix in it.",
    });

    const { container } = render(SuggestionCard, {
      props: {
        annotation,
        isPending: true,
        isEditing: false,
        canEdit: true,
        onEnterEdit: () => {},
      },
    });

    const diffEl = container.querySelector(`[data-testid="suggestion-diff-${annotation.id}"]`);
    const insSpans = Array.from(diffEl?.querySelectorAll("span") ?? []).filter((span) =>
      hasStyle(span, "tandem-success-bg"),
    );
    const delSpans = Array.from(diffEl?.querySelectorAll("span") ?? []).filter((span) =>
      hasStyle(span, "line-through"),
    );
    expect(delSpans).toHaveLength(1);
    expect(delSpans[0].textContent?.trim()).toBe("typo");
    expect(insSpans).toHaveLength(1);
    expect(insSpans[0].textContent?.trim()).toBe("fix");
  });
});
