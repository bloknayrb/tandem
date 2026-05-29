// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import MarginColumn from "../../src/client/panels/MarginColumn.svelte";
import type { Annotation } from "../../src/shared/types";

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
    range: { from: 0, to: 5 },
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
