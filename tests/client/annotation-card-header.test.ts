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

/**
 * The author LABEL alone.
 *
 * `.ach-author` also wraps the optional "(edited)" marker, the authorship dot
 * and the relative timestamp, so its `textContent` is `"Imported 12/31/1969"`
 * in this fixture — an assertion on the whole span is an assertion about the
 * clock. Removing the timestamp child leaves the label and nothing else.
 */
function authorLabelText(container: HTMLElement): string {
  const span = container.querySelector(".ach-author")?.cloneNode(true) as HTMLElement | undefined;
  span?.querySelector(".ach-time")?.remove();
  return span?.textContent?.trim() ?? "";
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

describe("AnnotationCardHeader — a PROMOTED import is still a colleague's comment (#1714)", () => {
  // `promotedAnnotation` rewrites `author: "import" -> "user"` so the user can
  // edit and reply, and carries `importSource` through untouched. This header is
  // where that showed: it painted the "You" dot and said "You" over a third
  // party's unedited words.
  //
  // The header is asserted rather than the card, deliberately — it is SHARED by
  // `ImportedCard` and the ordinary comment card, so a fix that only re-keyed
  // the card dispatch would route the record back into `ImportedCard` and still
  // render the dot and the label inside it. That was the first draft.
  const promoted = () =>
    makeAnnotation({
      author: "user",
      importSource: { author: "Dana Reviewer", file: "draft.docx", commentId: "c1" },
    });

  it("omits the You dot for a promoted import", () => {
    const { container } = renderHeader(promoted());
    expect(container.querySelector("[data-testid^='annotation-author-dot-']")).toBeNull();
  });

  it("labels a promoted import 'Imported', not 'You'", () => {
    const { container } = renderHeader(promoted());
    expect(authorLabelText(container)).toBe("Imported");
  });

  it("still says You for a user annotation that has no import provenance", () => {
    // The negative control, and the reason the predicate is keyed on a populated
    // `importSource.author` rather than on the field's mere presence: without
    // this, "route everything through the import branch" passes both specs
    // above.
    const { container } = renderHeader(makeAnnotation({ author: "user" }));
    expect(authorLabelText(container)).toBe("You");
    expect(container.querySelector("[data-testid^='annotation-author-dot-']")).not.toBeNull();
  });

  it("still says You when importSource carries a BLANK author", () => {
    // A record with provenance that names nobody has no byline to show, so it
    // must not be dragged out of the ordinary user treatment. Whitespace-only
    // counts as blank — `.trim()` is what makes that true, and dropping it
    // leaves this the only spec that notices.
    const { container } = renderHeader(
      makeAnnotation({ author: "user", importSource: { author: "   ", file: "draft.docx" } }),
    );
    expect(authorLabelText(container)).toBe("You");
    expect(container.querySelector("[data-testid^='annotation-author-dot-']")).not.toBeNull();
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
