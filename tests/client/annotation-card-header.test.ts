// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import AnnotationCardHeader from "../../src/client/panels/AnnotationCardHeader.svelte";
import { ANNOTATION_TYPE_GLYPHS } from "../../src/client/panels/annotation-type-icon";
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

function headerProps(annotation: Annotation) {
  return {
    annotation,
    isPending: true,
    isEditing: false,
    canEdit: false,
    onEnterEdit: () => {},
  };
}

function renderHeader(annotation: Annotation) {
  return render(AnnotationCardHeader, { props: headerProps(annotation) });
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

describe("annotation type glyphs are distinguishable", () => {
  // The render tests below prove an <svg> appears and carries a name. They do
  // NOT prove the four types look or sound different from each other: blanking
  // every `paths` array, or swapping two types' path data, or giving two types
  // the same `label`, all left the suite green. A type badge that renders the
  // same mark for a private note and an outbound comment is worse than none.
  const glyphs = Object.values(ANNOTATION_TYPE_GLYPHS);

  it("gives every type a non-empty path set", () => {
    for (const [type, glyph] of Object.entries(ANNOTATION_TYPE_GLYPHS)) {
      expect(glyph.paths.length, `${type} has no path data`).toBeGreaterThan(0);
      expect(
        glyph.paths.every((d) => d.trim() !== ""),
        `${type} has an empty path`,
      ).toBe(true);
    }
  });

  it("draws a DIFFERENT shape for every type", () => {
    expect(new Set(glyphs.map((g) => g.paths.join("|"))).size).toBe(glyphs.length);
  });

  it("names every type DIFFERENTLY", () => {
    // The label is the accessible name, so two types sharing one is a
    // screen-reader collision, not just a cosmetic one. `highlight` was the
    // unpinned member: no aria-label test rendered it.
    expect(new Set(glyphs.map((g) => g.label)).size).toBe(glyphs.length);
  });

  it("fills the highlight glyph and only the highlight glyph", () => {
    const filled = Object.entries(ANNOTATION_TYPE_GLYPHS)
      .filter(([, g]) => g.filled)
      .map(([type]) => type);
    expect(filled).toEqual(["highlight"]);
  });
});

describe("AnnotationCardHeader stays reactive to the annotation it is given", () => {
  // The source comment says a plain `const` here would freeze at mount "with no
  // type error and no failing test" — which was still true after the icon
  // landed, because nothing re-rendered with changed props. Both paths below
  // are reachable from real UI: the highlight colour picker, and
  // `tandem_editAnnotation` adding suggestedText to a pending comment.
  it("repaints the swatch when a highlight is recoloured", async () => {
    const green = makeAnnotation({ type: "highlight", author: "user", color: "green" });
    const { container, rerender } = render(AnnotationCardHeader, {
      props: headerProps(green),
    });
    expect(container.querySelector(".annotation-type-badge svg")?.getAttribute("fill")).toBe(
      "var(--tandem-highlight-green)",
    );

    await rerender(
      headerProps(makeAnnotation({ type: "highlight", author: "user", color: "yellow" })),
    );
    expect(container.querySelector(".annotation-type-badge svg")?.getAttribute("fill")).toBe(
      "var(--tandem-highlight-yellow)",
    );
  });

  it("switches the glyph when a comment gains suggestedText", async () => {
    const comment = makeAnnotation({ type: "comment" });
    const { container, rerender } = render(AnnotationCardHeader, {
      props: headerProps(comment),
    });
    expect(container.querySelector(".annotation-type-badge")?.getAttribute("aria-label")).toBe(
      ANNOTATION_TYPE_GLYPHS.comment.label,
    );

    await rerender(headerProps(makeAnnotation({ type: "comment", suggestedText: "replacement" })));
    expect(container.querySelector(".annotation-type-badge")?.getAttribute("aria-label")).toBe(
      ANNOTATION_TYPE_GLYPHS.replacement.label,
    );
  });
});

describe("AnnotationCardHeader author dot presence", () => {
  it("omits the dot entirely for an import", () => {
    // An imported Word comment has no user/Claude author, and `dotColor`'s else
    // branch is the USER token — so dropping this guard paints an import as
    // though the user wrote it, which is the collision the tint model exists to
    // prevent. Nothing rendered an `import` author before this.
    const { container } = renderHeader(makeAnnotation({ author: "import" }));
    expect(container.querySelector("[data-testid^='annotation-author-dot-']")).toBeNull();
  });

  it("renders the dot for user and claude", () => {
    for (const author of ["user", "claude"] as const) {
      const { container } = renderHeader(makeAnnotation({ author }));
      expect(
        container.querySelector("[data-testid^='annotation-author-dot-']"),
        `${author} must keep its dot`,
      ).not.toBeNull();
    }
  });
});
