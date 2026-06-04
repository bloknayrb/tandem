// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionBannerHarness from "../../src/client/svelte-harness/ConnectionBannerHarness.svelte";
import { PROLONGED_DISCONNECT_MS } from "../../src/shared/constants.js";

describe("createConnectionBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows after a prolonged disconnect and dismisses cleanly", async () => {
    const disconnectedSince = Date.now();
    const { container } = render(ConnectionBannerHarness, {
      props: { disconnectedSince },
    });

    expect(container.querySelector("[data-testid='connection-banner']")).toBeNull();

    await vi.advanceTimersByTimeAsync(PROLONGED_DISCONNECT_MS);
    await tick();

    const banner = container.querySelector("[data-testid='connection-banner']");
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain("We've lost the connection to the Tandem server");

    (banner?.querySelector("button") as HTMLButtonElement).click();
    await tick();

    expect(container.querySelector("[data-testid='connection-banner']")).toBeNull();
  });
});
