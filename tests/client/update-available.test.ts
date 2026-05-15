// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Captured by the test so it can emit a synthetic update-available event.
let emit: ((payload: { version: string }) => void) | null = null;
const unlistenSpy = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: { version: string } }) => void) => {
    emit = (payload) => cb({ payload });
    return unlistenSpy;
  }),
}));

import UpdateAvailableHarness from "../../src/client/svelte-harness/UpdateAvailableHarness.svelte";

const DISMISS_KEY_PREFIX = "tandem:updater-dismissed-v";

describe("createUpdateAvailable", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Pretend we're in Tauri so the hook attaches its listener.
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    emit = null;
    unlistenSpy.mockClear();
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("renders the dot after an update-available event and clears it on acknowledge", async () => {
    const { container } = render(UpdateAvailableHarness);
    // Wait for the async dynamic import + listen() to resolve.
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    expect(container.querySelector("[data-testid='titlebar-update-available-dot']")).toBeNull();
    expect(emit).toBeTruthy();

    emit?.({ version: "0.12.0" });
    await tick();
    expect(container.querySelector("[data-testid='titlebar-update-available-dot']")).toBeTruthy();

    (container.querySelector("[data-testid='harness-acknowledge']") as HTMLButtonElement).click();
    await tick();
    expect(container.querySelector("[data-testid='titlebar-update-available-dot']")).toBeNull();
    expect(window.localStorage.getItem(`${DISMISS_KEY_PREFIX}0.12.0`)).toBe("1");
  });

  it("does not flicker on cold start when the same version was previously acknowledged", async () => {
    window.localStorage.setItem(`${DISMISS_KEY_PREFIX}0.12.0`, "1");

    const { container } = render(UpdateAvailableHarness);
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    emit?.({ version: "0.12.0" });
    await tick();
    // Persisted dismissal must short-circuit the getter — the dot never appears.
    expect(container.querySelector("[data-testid='titlebar-update-available-dot']")).toBeNull();
  });

  it("re-shows the dot when a newer version arrives after a prior acknowledge", async () => {
    window.localStorage.setItem(`${DISMISS_KEY_PREFIX}0.12.0`, "1");

    const { container } = render(UpdateAvailableHarness);
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    emit?.({ version: "0.12.0" });
    await tick();
    expect(container.querySelector("[data-testid='titlebar-update-available-dot']")).toBeNull();

    emit?.({ version: "0.13.0" });
    await tick();
    expect(container.querySelector("[data-testid='titlebar-update-available-dot']")).toBeTruthy();
  });
});
