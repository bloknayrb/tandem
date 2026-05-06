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
    }

    expect(container.querySelector(RECOVER_SELECTOR)).toBeNull();
    expect(container.querySelector(RELOAD_SELECTOR)).toBeTruthy();
    expect(container.textContent).toContain("Recovery attempts exhausted");
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
