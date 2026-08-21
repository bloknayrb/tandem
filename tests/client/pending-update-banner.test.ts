// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import PendingUpdateBannerHarness from "./fixtures/PendingUpdateBannerHarness.svelte";

/**
 * #1118. These three exist because a mis-wired button ships GREEN through every
 * other gate: the util tests pin the command names, the testid snapshot pins
 * that the selectors exist, and neither ties a selector to a handler. Swap the
 * two buttons and nothing else in the suite notices.
 */
describe("PendingUpdateBanner", () => {
  it("routes the dismiss button to onDismiss and not onCheck", async () => {
    const onCheck = vi.fn();
    const onDismiss = vi.fn();
    const { container } = render(PendingUpdateBannerHarness, {
      props: { visible: true, onCheck, onDismiss },
    });

    const btn = container.querySelector<HTMLButtonElement>(
      "[data-testid='pending-update-banner-dismiss']",
    );
    expect(btn).toBeTruthy();
    btn?.click();
    await tick();

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("routes the CTA to onCheck and not onDismiss", async () => {
    const onCheck = vi.fn();
    const onDismiss = vi.fn();
    const { container } = render(PendingUpdateBannerHarness, {
      props: { visible: true, onCheck, onDismiss },
    });

    const btn = container.querySelector<HTMLButtonElement>(
      "[data-testid='pending-update-banner-check']",
    );
    expect(btn).toBeTruthy();
    btn?.click();
    await tick();

    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps the live-region host mounted while the banner content is absent", async () => {
    // #1431's invariant, pinned here so a later "simplify" cannot fold the host
    // inside the {#if}: a live region created in the same commit as its content
    // is commonly never announced at all. The host must PRE-EXIST the message.
    const { container, rerender } = render(PendingUpdateBannerHarness, {
      props: { visible: false, onCheck: vi.fn(), onDismiss: vi.fn() },
    });

    const host = container.querySelector("[data-testid='pending-update-banner-live']");
    expect(host, "live-region host must exist before the banner does").toBeTruthy();
    expect(host?.getAttribute("role")).toBe("status");
    expect(host?.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector("[data-testid='pending-update-banner']")).toBeNull();

    await rerender({ visible: true, onCheck: vi.fn(), onDismiss: vi.fn() });
    await tick();

    // Same host node, now populated — not a replacement created with the text.
    const hostAfter = container.querySelector("[data-testid='pending-update-banner-live']");
    expect(hostAfter).toBe(host);
    expect(container.querySelector("[data-testid='pending-update-banner']")).toBeTruthy();
  });
});
