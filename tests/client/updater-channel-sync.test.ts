// @vitest-environment happy-dom

/**
 * Cross-surface sync test for the shared updater channel primitive
 * (useUpdaterChannel.svelte.ts). Both the titlebar dot
 * (`createUpdateAvailable`) and the in-app updater banner
 * (`createUpdaterBanner`) consume the same module-singleton listener +
 * acknowledgement state. This test proves:
 *
 *   1. A single Tauri event fires both surfaces simultaneously.
 *   2. Dismissing the banner clears the dot live (no remount needed).
 *   3. Acknowledging the dot clears the banner live (no remount needed).
 *
 * Pre-extraction these surfaces had two independent listeners and two
 * unrelated in-memory ack stores, so cross-surface clear required a remount.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let emit: ((payload: { version: string }) => void) | null = null;
const unlistenSpy = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: { version: string } }) => void) => {
    emit = (payload) => cb({ payload });
    return unlistenSpy;
  }),
}));

import { __resetUpdaterChannelForTests } from "../../src/client/hooks/useUpdaterChannel.svelte";
import UpdateAvailableHarness from "../../src/client/svelte-harness/UpdateAvailableHarness.svelte";
import UpdaterBannerHarness from "../../src/client/svelte-harness/UpdaterBannerHarness.svelte";

describe("useUpdaterChannel cross-surface sync", () => {
  beforeEach(() => {
    window.localStorage.clear();
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    emit = null;
    unlistenSpy.mockClear();
    __resetUpdaterChannelForTests();
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("a single event reveals both surfaces; dismissing the banner clears the dot live", async () => {
    const dot = render(UpdateAvailableHarness);
    const banner = render(UpdaterBannerHarness);
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    expect(dot.container.querySelector("[data-testid='titlebar-update-available-dot']")).toBeNull();
    expect(banner.container.querySelector("[data-testid='updater-banner-visible']")).toBeNull();

    emit?.({ version: "1.0.0" });
    await tick();

    expect(
      dot.container.querySelector("[data-testid='titlebar-update-available-dot']"),
    ).toBeTruthy();
    expect(banner.container.querySelector("[data-testid='updater-banner-visible']")).toBeTruthy();

    (
      banner.container.querySelector("[data-testid='harness-banner-dismiss']") as HTMLButtonElement
    ).click();
    await tick();

    expect(dot.container.querySelector("[data-testid='titlebar-update-available-dot']")).toBeNull();
    expect(banner.container.querySelector("[data-testid='updater-banner-visible']")).toBeNull();
  });

  it("acknowledging the dot clears the banner live", async () => {
    const dot = render(UpdateAvailableHarness);
    const banner = render(UpdaterBannerHarness);
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    emit?.({ version: "1.0.0" });
    await tick();

    expect(banner.container.querySelector("[data-testid='updater-banner-visible']")).toBeTruthy();

    (
      dot.container.querySelector("[data-testid='harness-acknowledge']") as HTMLButtonElement
    ).click();
    await tick();

    expect(banner.container.querySelector("[data-testid='updater-banner-visible']")).toBeNull();
    expect(dot.container.querySelector("[data-testid='titlebar-update-available-dot']")).toBeNull();
  });

  it("attaches exactly one Tauri listener regardless of how many consumers mount", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const listenMock = listen as unknown as ReturnType<typeof vi.fn>;
    listenMock.mockClear();

    render(UpdateAvailableHarness);
    render(UpdaterBannerHarness);
    render(UpdateAvailableHarness);
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    expect(listenMock).toHaveBeenCalledTimes(1);
  });
});
