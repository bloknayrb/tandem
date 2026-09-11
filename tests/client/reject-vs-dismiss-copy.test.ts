// @vitest-environment happy-dom

/**
 * #1824 item D — visible button text said "Reject" while every internal
 * identifier (testids, CSS classes) and the native right-click menu already
 * said "Dismiss". Align the visible copy to "Dismiss"/"Dismiss All"; the
 * internal identifiers are deliberately untouched (they were already
 * correct).
 *
 * `@testing-library/svelte`'s auto-cleanup never registers in this repo (the
 * `client` vitest project sets no `globals`/`setupFiles` — see
 * TabItem.svelte.test.ts's own note on this), so every render here is
 * explicitly unmounted and every query is scoped to `within(container)`
 * rather than the global `screen`.
 */

import { within } from "@testing-library/dom";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import AnnotationCardActions from "../../src/client/panels/AnnotationCardActions.svelte";
import BulkActions from "../../src/client/panels/BulkActions.svelte";

describe("BulkActions dismiss copy (#1824 item D)", () => {
  it("says Dismiss All on the request row, never Reject", () => {
    const { container, unmount } = render(BulkActions, {
      props: {
        bulkConfirm: null,
        pendingCount: 3,
        allPendingCount: 5,
        onConfirmAccept: vi.fn(),
        onConfirmDismiss: vi.fn(),
        onCancel: vi.fn(),
        onRequestAccept: vi.fn(),
        onRequestDismiss: vi.fn(),
      },
    });
    const scoped = within(container);
    expect(scoped.getByText("Dismiss All")).toBeTruthy();
    expect(scoped.queryByText(/^Reject/)).toBeNull();
    unmount();
  });

  it("says Dismiss (not Reject) on the confirm row", () => {
    const { container, unmount } = render(BulkActions, {
      props: {
        bulkConfirm: "dismiss",
        pendingCount: 3,
        allPendingCount: 5,
        onConfirmAccept: vi.fn(),
        onConfirmDismiss: vi.fn(),
        onCancel: vi.fn(),
        onRequestAccept: vi.fn(),
        onRequestDismiss: vi.fn(),
      },
    });
    const scoped = within(container);
    expect(scoped.getByText(/^Dismiss/)).toBeTruthy();
    expect(scoped.queryByText(/^Reject/)).toBeNull();
    unmount();
  });
});

describe("AnnotationCardActions dismiss copy (#1824 item D)", () => {
  it("says Dismiss on the per-card action button, never Reject", () => {
    const { container, unmount } = render(AnnotationCardActions, {
      props: {
        annotationId: "ann-1",
        isPending: true,
        isEditing: false,
        onAccept: vi.fn(),
        onDismiss: vi.fn(),
      },
    });
    const scoped = within(container);
    expect(scoped.getByText("Dismiss")).toBeTruthy();
    expect(scoped.queryByText(/^Reject/)).toBeNull();
    unmount();
  });
});
