// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { describe, expect, it } from "vitest";
import OutlinePanel from "../../src/client/components/OutlinePanel.svelte";
import type { HeadingEntry } from "../../src/client/utils/headings";

/**
 * #832: `headings` is now a prop (computed once upstream by `createHeadings`
 * in App.svelte) instead of something OutlinePanel walks itself. These tests
 * cover the render side of that change and the local-state clamp effect that
 * had to survive the extraction — see the `untrack()` comment in the
 * component for why dropping it reproduces effect_update_depth_exceeded.
 */
function heading(level: number, text: string, pos: number): HeadingEntry {
  return { level, text, pos };
}

function baseProps(overrides: Partial<ComponentProps<typeof OutlinePanel>> = {}) {
  return {
    editor: null,
    headings: [] as HeadingEntry[],
    ...overrides,
  };
}

describe("OutlinePanel headings prop (#832)", () => {
  it("shows the empty state when there are no headings", () => {
    const { getByText, queryAllByRole } = render(OutlinePanel, { props: baseProps() });

    expect(getByText("No headings")).toBeTruthy();
    expect(queryAllByRole("button")).toHaveLength(0);
  });

  it("renders one button per heading, tagged with its level", () => {
    const headings = [heading(1, "Intro", 0), heading(2, "Details", 10), heading(3, "Notes", 20)];
    const { container } = render(OutlinePanel, { props: baseProps({ headings }) });

    expect(container.querySelector('[data-testid="outline-heading-1-0"]')?.textContent).toContain(
      "Intro",
    );
    expect(container.querySelector('[data-testid="outline-heading-2-1"]')?.textContent).toContain(
      "Details",
    );
    expect(container.querySelector('[data-testid="outline-heading-3-2"]')?.textContent).toContain(
      "Notes",
    );
  });

  it("survives the heading count shrinking across a rerender (untrack clamp)", async () => {
    const headings = [heading(1, "A", 0), heading(1, "B", 10), heading(1, "C", 20)];
    const { rerender, container } = render(OutlinePanel, { props: baseProps({ headings }) });

    // Would throw effect_update_depth_exceeded if the itemEls/focusedIndex
    // clamp effect ever tracked its own write-back instead of using untrack().
    await expect(rerender(baseProps({ headings: [heading(1, "A", 0)] }))).resolves.not.toThrow();

    expect(container.querySelectorAll('[data-testid^="outline-heading-"]')).toHaveLength(1);
  });
});
