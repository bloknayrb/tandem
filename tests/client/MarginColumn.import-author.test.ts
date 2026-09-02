// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import MarginColumn from "../../src/client/panels/MarginColumn.svelte";
import type { Annotation } from "../../src/shared/types";
import { range } from "../helpers/positions";

// Closes the gap from the V2 plan §4.1b — `leaderColorForAuthor` is unit-tested
// in marginLeaderGeometry.test.ts, but pure-function correctness can't prove
// that an import-authored annotation reaches the SVG with author intact (a
// sanitizer between the prop and the render call could silently re-bucket
// imports as Claude). This test mounts MarginColumn with a synthetic
// import-authored annotation and asserts `data-tandem-author="import"` lands
// on the rendered path + circle.

function importComment(id: string): Annotation {
  return {
    id,
    author: "import",
    type: "comment",
    range: range(0, 5),
    content: "Word comment text",
    status: "pending",
    timestamp: 1_700_000_000_000,
    importSource: { author: "Alice", file: "/test.docx" },
  };
}

describe("MarginColumn — import-author render path", () => {
  it('renders <path> and <circle> with data-tandem-author="import" for an import-authored annotation', () => {
    const ann = importComment("ann-1");
    const positions = new Map<string, number>([["ann-1", 100]]);
    const { container } = render(MarginColumn, {
      annotations: [ann],
      positions,
      side: "right",
      width: 240,
      edgeInset: 8,
      gap: 24,
      activeAnnotationId: null,
      repliesById: new Map(),
      onClick: () => {},
    });

    const path = container.querySelector<SVGPathElement>('path[data-annotation-id="ann-1"]');
    const circle = container.querySelector<SVGCircleElement>('circle[data-annotation-id="ann-1"]');

    expect(path, "leader <path> must render for the import-authored annotation").not.toBeNull();
    expect(circle, "anchor <circle> must render alongside the leader").not.toBeNull();

    expect(path?.getAttribute("data-tandem-author")).toBe("import");
    expect(circle?.getAttribute("data-tandem-author")).toBe("import");

    // The exact stroke string flows through `leaderColorForAuthor` — guard the
    // integration, not the CSS variable's resolved value (happy-dom doesn't
    // resolve custom properties; that's an E2E concern).
    expect(path?.getAttribute("stroke")).toBe("var(--tandem-fg-subtle)");
    expect(circle?.getAttribute("fill")).toBe("var(--tandem-fg-subtle)");
  });
});

describe("MarginColumn — a PROMOTED import keeps the import leader (#1714)", () => {
  // The leader line points AT a card that reads "From: <reviewer>". Keyed on the
  // raw `author` it would stroke in the USER colour and carry
  // `data-tandem-author="user"`, so the line and the bubble it lands on would
  // disagree about whose comment it is.
  function promotedImport(id: string): Annotation {
    return {
      id,
      author: "user",
      type: "comment",
      range: range(0, 5),
      content: "Word comment text, promoted",
      status: "pending",
      timestamp: 1_700_000_000_000,
      importSource: { author: "Alice", file: "/test.docx" },
    };
  }

  function renderOne(ann: Annotation) {
    return render(MarginColumn, {
      annotations: [ann],
      positions: new Map<string, number>([[ann.id, 100]]),
      side: "right",
      width: 240,
      edgeInset: 8,
      gap: 24,
      activeAnnotationId: null,
      repliesById: new Map(),
      onClick: () => {},
    });
  }

  it("strokes and labels a promoted import as an import", () => {
    const { container } = renderOne(promotedImport("ann-promoted"));
    const path = container.querySelector<SVGPathElement>('path[data-annotation-id="ann-promoted"]');
    const circle = container.querySelector<SVGCircleElement>(
      'circle[data-annotation-id="ann-promoted"]',
    );

    expect(path?.getAttribute("data-tandem-author")).toBe("import");
    expect(circle?.getAttribute("data-tandem-author")).toBe("import");
    expect(path?.getAttribute("stroke")).toBe("var(--tandem-fg-subtle)");
    expect(circle?.getAttribute("fill")).toBe("var(--tandem-fg-subtle)");
  });

  it("leaves an ordinary user comment on the user leader", () => {
    // The negative control. The attribute and the stroke are asserted together
    // on purpose: they are set from two separate expressions in the template,
    // and the bug being fixed is precisely two expressions disagreeing.
    const plain = { ...promotedImport("ann-plain"), importSource: undefined };
    const { container } = renderOne(plain);
    const path = container.querySelector<SVGPathElement>('path[data-annotation-id="ann-plain"]');

    expect(path?.getAttribute("data-tandem-author")).toBe("user");
    expect(path?.getAttribute("stroke")).toBe("var(--tandem-author-user)");
  });
});
