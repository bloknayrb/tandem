// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { describe, expect, it, vi } from "vitest";
import PeekStrip from "../../src/client/panels/PeekStrip.svelte";
import type { Annotation } from "../../src/shared/types";

/**
 * #832: the left peek's outline ticks must reflect the real document instead
 * of five hardcoded `h1/h2/h2/h3/h2` literals. `headingLevels` is threaded in
 * from `createHeadings` (App.svelte); this test only exercises PeekStrip's
 * own render logic — clamp, class mapping, empty state.
 */
function baseProps(overrides: Partial<ComponentProps<typeof PeekStrip>> = {}) {
  return {
    side: "left" as const,
    collapsed: true,
    kind: "outline" as const,
    onActivate: vi.fn(),
    ...overrides,
  };
}

function readTickClasses(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>(".peek-tick")].map((el) =>
    el.className
      .split(/\s+/)
      // Drop "peek-tick" itself and Svelte's scoped-CSS hash class
      // (svelte-xxxxxxx), leaving just the level class (h1/h2/h3).
      .filter((c) => c !== "peek-tick" && !c.startsWith("svelte-"))
      .join(" "),
  );
}

describe("PeekStrip outline ticks (#832)", () => {
  it("renders one tick per heading, mapping level to the matching class", () => {
    const { container } = render(PeekStrip, {
      props: baseProps({ headingLevels: [1, 2, 2, 3, 2] }),
    });

    expect(readTickClasses(container)).toEqual(["h1", "h2", "h2", "h3", "h2"]);
  });

  it("clamps levels 3 and deeper to h3 (only three tick widths exist)", () => {
    const { container } = render(PeekStrip, {
      props: baseProps({ headingLevels: [1, 4, 5, 6] }),
    });

    expect(readTickClasses(container)).toEqual(["h1", "h3", "h3", "h3"]);
  });

  it("caps at 12 ticks, taken from the start of the document", () => {
    const levels = Array.from({ length: 30 }, (_, i) => (i % 3) + 1);
    const { container } = render(PeekStrip, {
      props: baseProps({ headingLevels: levels }),
    });

    const rendered = readTickClasses(container);
    expect(rendered).toHaveLength(12);
    expect(rendered).toEqual(
      levels.slice(0, 12).map((l) => (l <= 1 ? "h1" : l === 2 ? "h2" : "h3")),
    );
  });

  it("renders zero ticks for a document with no headings", () => {
    const { container } = render(PeekStrip, {
      props: baseProps({ headingLevels: [] }),
    });

    expect(container.querySelectorAll(".peek-tick")).toHaveLength(0);
  });

  it("defaults to zero ticks when headingLevels is omitted entirely", () => {
    const { container } = render(PeekStrip, { props: baseProps() });

    expect(container.querySelectorAll(".peek-tick")).toHaveLength(0);
  });
});

describe("PeekStrip annotation dots — a promoted import keeps the import dot (#1714)", () => {
  // The sliver previews the rail it is hiding. `promotedAnnotation` rewrites
  // `author: "import" -> "user"`, so before this fix the preview dot said "the
  // user wrote this" while the card it previews said "From: <reviewer>" — the
  // same contradiction as the card, one surface over and far easier to miss.
  const promoted: Annotation = {
    id: "ann-promoted",
    author: "user",
    type: "comment",
    range: { from: 0, to: 5 },
    content: "A colleague's words, promoted",
    status: "pending",
    timestamp: 1_700_000_000_000,
    importSource: { author: "Dana Reviewer", file: "/draft.docx" },
  } as Annotation;

  function dotClasses(container: HTMLElement, id: string): string[] {
    const dot = container.querySelector<HTMLElement>(`[data-testid='peek-dot-${id}']`);
    expect(dot, `expected a dot for ${id}`).not.toBeNull();
    return (dot?.className ?? "")
      .split(/\s+/)
      .filter((c) => c !== "peek-dot" && !c.startsWith("svelte-"));
  }

  it("paints the import dot for a promoted import", () => {
    const { container } = render(PeekStrip, {
      props: baseProps({ side: "right", kind: "annotations", annotations: [promoted] }),
    });
    expect(dotClasses(container, "ann-promoted")).toEqual(["import"]);
  });

  it("still paints the user dot for an ordinary user comment", () => {
    // The negative control: without it, "always return import" passes above.
    const plain = { ...promoted, id: "ann-plain", importSource: undefined } as Annotation;
    const { container } = render(PeekStrip, {
      props: baseProps({ side: "right", kind: "annotations", annotations: [plain] }),
    });
    expect(dotClasses(container, "ann-plain")).toEqual(["user"]);
  });

  it("keeps type outranking author — a promoted import carrying a suggestion reads 'suggest'", () => {
    // `dotClass` checks highlight and suggestion BEFORE author, and threading
    // the display author through must not disturb that order: a suggestion is
    // what the reader acts on, and "import" would bury it.
    const suggesting = {
      ...promoted,
      id: "ann-suggest",
      suggestedText: "replacement",
    } as Annotation;
    const { container } = render(PeekStrip, {
      props: baseProps({ side: "right", kind: "annotations", annotations: [suggesting] }),
    });
    expect(dotClasses(container, "ann-suggest")).toEqual(["suggest"]);
  });
});
