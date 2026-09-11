// @vitest-environment happy-dom

/**
 * #1824 item G — two independent gaps on the filter bar:
 *  1. `filter-bar-toggle` had no `aria-expanded`, so the filter row's
 *     collapsed/expanded state was announced to nobody.
 *  2. Filters silently persisted across a document switch — SidePanel is
 *     mounted once (display toggle, no `{#key documentId}`), so switching
 *     tabs while "Comments only" was active hid every annotation in the
 *     newly-active document with no visible reason.
 *
 * The fix for (2) is a SECOND, independent effect from the existing
 * reset-bulk-confirm effect (#1772) — folding it into that one would read the
 * filters as a dependency AND write them, making it self-dependent and the
 * filter bar permanently unsettable.
 *
 * Cases 2/3 below mount through `SidePanelHarness.svelte` rather than calling
 * `@testing-library/svelte`'s `rerender()` directly on SidePanel: that helper
 * packs every prop into one `$state.raw` container and replaces it wholesale
 * on each call, so ANY prop write (even to an unchanged value) invalidates
 * every prop-reading effect — including one that reads only `documentId`.
 * That is a coarse-graining artifact of the test harness, not production
 * behaviour (real Svelte markup binds each prop independently), so it cannot
 * discriminate "an unrelated re-render happened" from "documentId actually
 * changed". The fixture reproduces genuine per-prop reactivity instead.
 */

import { fireEvent } from "@testing-library/dom";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import SidePanel from "../../src/client/panels/SidePanel.svelte";
import type { UseAnnotationReviewReturn } from "../../src/client/panels/useAnnotationReview.svelte";
import SidePanelHarness from "./fixtures/SidePanelHarness.svelte";

function makeReview(): UseAnnotationReviewReturn {
  return {
    resolveAnnotation: vi.fn(),
    undoResolveAnnotation: vi.fn(() => false),
    handleAccept: vi.fn(),
    handleDismiss: vi.fn(),
    scrollToAnnotation: vi.fn(),
    getRecentlyResolved: () => new Set<string>(),
    getReviewIndex: () => 0,
    getReviewTargets: () => [],
  };
}

async function openAndSelectCommentFilter(container: HTMLElement) {
  const toggle = container.querySelector<HTMLButtonElement>("[data-testid='filter-bar-toggle']")!;
  await fireEvent.click(toggle);
  await tick();
  const commentChip = container.querySelector<HTMLElement>("[data-testid='filter-type-comment']")!;
  await fireEvent.click(commentChip);
  await tick();
  return commentChip;
}

describe("SidePanel filter bar (#1824 item G)", () => {
  it("filter-bar-toggle carries aria-expanded tracking filterBarOpen", async () => {
    const { container, unmount } = render(SidePanel, {
      props: {
        annotations: [],
        editor: null,
        ydoc: new Y.Doc(),
        documentId: "doc-a",
        activeAnnotationId: null,
        onActiveAnnotationChange: vi.fn(),
        review: makeReview(),
      },
    });
    const toggle = container.querySelector<HTMLButtonElement>("[data-testid='filter-bar-toggle']");
    expect(toggle).toBeTruthy();
    if (!toggle) throw new Error("toggle not found");

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(toggle);
    await tick();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await fireEvent.click(toggle);
    await tick();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    unmount();
  });

  it("a set filter survives an unrelated re-render (documentId untouched)", async () => {
    const { container, component, unmount } = render(SidePanelHarness, {
      props: { ydoc: new Y.Doc(), review: makeReview(), initialDocumentId: "doc-a" },
    });
    const commentChip = await openAndSelectCommentFilter(container);
    expect(commentChip.getAttribute("aria-checked"), "sanity: click must select it first").toBe(
      "true",
    );

    // Forces SidePanel's `annotations` prop to a fresh array reference —
    // mirrors App.svelte recomputing it on every store change — while
    // documentId's own value is never written.
    (component as unknown as { bumpUnrelated: () => void }).bumpUnrelated();
    await tick();

    expect(
      commentChip.getAttribute("aria-checked"),
      "an unrelated prop change must not reset the filter",
    ).toBe("true");
    unmount();
  });

  it("filters reset to all when documentId actually changes", async () => {
    const { container, component, unmount } = render(SidePanelHarness, {
      props: { ydoc: new Y.Doc(), review: makeReview(), initialDocumentId: "doc-a" },
    });
    await openAndSelectCommentFilter(container);
    expect(container.querySelector("[data-testid='clear-filters-btn']")).toBeTruthy();

    (component as unknown as { setDocumentId: (id: string) => void }).setDocumentId("doc-b");
    await tick();

    expect(
      container.querySelector("[data-testid='clear-filters-btn']"),
      "switching documents must clear the active filter",
    ).toBeNull();
    unmount();
  });
});
