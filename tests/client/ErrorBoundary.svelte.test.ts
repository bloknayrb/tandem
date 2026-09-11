// @vitest-environment happy-dom

/**
 * #1824 item L — the `failed` snippet showed a raw `error.message` with no
 * saved/unsaved reassurance. This mounts the real component (via a fixture
 * child that throws inside `$effect`, matching the component's own docblock
 * framing of what `<svelte:boundary>` catches here) rather than asserting on
 * the source text, since the fix is genuinely mountable — unlike #1713/#1824
 * item I, which need App.svelte itself.
 */

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import ErrorBoundaryHarness from "./fixtures/ErrorBoundaryHarness.svelte";

describe("ErrorBoundary failed snippet — saved-work reassurance (#1824 item L)", () => {
  it("shows the reassurance paragraph between the message and the error detail", () => {
    const { container, unmount } = render(ErrorBoundaryHarness);

    const boundary = container.querySelector(".error-boundary");
    expect(boundary, "the failed snippet must have rendered").toBeTruthy();
    if (!boundary) throw new Error("boundary not found");

    const message = boundary.querySelector(".message");
    const reassurance = boundary.querySelector(".reassurance");
    const detail = boundary.querySelector(".detail");
    expect(message).toBeTruthy();
    expect(reassurance).toBeTruthy();
    expect(detail).toBeTruthy();

    expect(reassurance?.textContent).toContain(
      "Your document is synced to the server, so this doesn't affect your saved work.",
    );

    // Between the two, in DOM order — not just "present somewhere".
    const children = Array.from(boundary.children);
    const messageIdx = children.indexOf(message as Element);
    const reassuranceIdx = children.indexOf(reassurance as Element);
    const detailIdx = children.indexOf(detail as Element);
    expect(messageIdx).toBeGreaterThanOrEqual(0);
    expect(reassuranceIdx).toBeGreaterThan(messageIdx);
    expect(detailIdx).toBeGreaterThan(reassuranceIdx);

    unmount();
  });
});
