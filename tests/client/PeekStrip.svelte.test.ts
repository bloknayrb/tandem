// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { describe, expect, it, vi } from "vitest";
import PeekStrip from "../../src/client/panels/PeekStrip.svelte";

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
