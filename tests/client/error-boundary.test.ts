// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_BOUNDARY_RECOVER_BTN_TESTID,
  ERROR_BOUNDARY_RELOAD_BTN_TESTID,
  MAX_RECOVERY_ATTEMPTS,
} from "../../src/client/components/errorBoundaryConstants";
import ErrorBoundaryHarness from "../../src/client/svelte-harness/ErrorBoundaryHarness.svelte";

const RECOVER_SELECTOR = `[data-testid='${ERROR_BOUNDARY_RECOVER_BTN_TESTID}']`;
const RELOAD_SELECTOR = `[data-testid='${ERROR_BOUNDARY_RELOAD_BTN_TESTID}']`;

describe("ErrorBoundary", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Svelte logs caught boundary errors to console.error; silence in tests.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("recovers when child stops throwing after a Try-to-recover click", async () => {
    const { container, rerender } = render(ErrorBoundaryHarness, {
      props: { shouldThrow: true },
    });
    await tick();

    expect(container.querySelector("[role='alert']")).toBeTruthy();
    const recoverBtn = container.querySelector<HTMLButtonElement>(RECOVER_SELECTOR);
    expect(recoverBtn).toBeTruthy();
    expect(container.querySelector(RELOAD_SELECTOR)).toBeTruthy();

    await rerender({ shouldThrow: false });
    recoverBtn!.click();
    await tick();

    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(container.querySelector("[data-testid='throw-on-render-ok']")).toBeTruthy();
  });

  it("hides Try-to-recover after MAX_RECOVERY_ATTEMPTS failures", async () => {
    const { container } = render(ErrorBoundaryHarness, {
      props: { shouldThrow: true },
    });
    await tick();

    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
      const btn = container.querySelector<HTMLButtonElement>(RECOVER_SELECTOR);
      expect(btn, `recover button missing at attempt ${i + 1}`).toBeTruthy();
      btn!.click();
      await tick();
      // Boundary must stay in failed state across the loop — the recover button
      // wouldn't be queryable in the next iteration if the alert disappeared.
      expect(
        container.querySelector("[role='alert']"),
        `alert missing after attempt ${i + 1}`,
      ).toBeTruthy();
    }

    expect(container.querySelector(RECOVER_SELECTOR)).toBeNull();
    expect(container.querySelector(RELOAD_SELECTOR)).toBeTruthy();
    expect(container.textContent).toContain("weren't able to recover");
  });

  it("resets the attempts counter after a successful recovery", async () => {
    const { container, rerender } = render(ErrorBoundaryHarness, {
      props: { shouldThrow: true },
    });
    await tick();

    // Burn one attempt against the still-throwing child so the counter is non-zero.
    container.querySelector<HTMLButtonElement>(RECOVER_SELECTOR)!.click();
    await tick();
    expect(container.querySelector("[role='alert']")).toBeTruthy();

    // Stop throwing, recover successfully — SuccessHook should reset attempts to 0.
    await rerender({ shouldThrow: false });
    await tick();
    container.querySelector<HTMLButtonElement>(RECOVER_SELECTOR)!.click();
    await tick();
    expect(container.querySelector("[role='alert']")).toBeNull();

    // Re-trigger failure: a fresh budget should be available.
    await rerender({ shouldThrow: true });
    await tick();
    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
      const btn = container.querySelector<HTMLButtonElement>(RECOVER_SELECTOR);
      expect(btn, `recover button missing at attempt ${i + 1} after counter reset`).toBeTruthy();
      btn!.click();
      await tick();
    }
    // Cap should be reachable again — proves the budget started fresh from 0.
    expect(container.querySelector(RECOVER_SELECTOR)).toBeNull();
    expect(container.textContent).toContain("weren't able to recover");
  });

  it("Reload button calls window.location.reload()", async () => {
    // happy-dom's window.location is non-configurable; replace via
    // Object.defineProperty so the reload spy is observable.
    const originalLocation = window.location;
    const reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload: reloadSpy },
    });

    try {
      const { container } = render(ErrorBoundaryHarness, {
        props: { shouldThrow: true },
      });
      await tick();

      const reloadBtn = container.querySelector<HTMLButtonElement>(RELOAD_SELECTOR);
      expect(reloadBtn).toBeTruthy();
      reloadBtn!.click();
      await tick();

      expect(reloadSpy).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
