// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundaryHarness from "../../src/client/svelte-harness/ErrorBoundaryHarness.svelte";

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

    const alert = container.querySelector("[role='alert']");
    expect(alert).toBeTruthy();
    const recoverBtn = container.querySelector<HTMLButtonElement>(
      "[data-testid='error-boundary-recover-btn']",
    );
    const reloadBtn = container.querySelector<HTMLButtonElement>(
      "[data-testid='error-boundary-reload-btn']",
    );
    expect(recoverBtn).toBeTruthy();
    expect(reloadBtn).toBeTruthy();

    // Flip the harness prop so the next render of the child does not throw.
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

    // Three failed recovery attempts; child keeps throwing each reset.
    for (let i = 0; i < 3; i++) {
      const btn = container.querySelector<HTMLButtonElement>(
        "[data-testid='error-boundary-recover-btn']",
      );
      expect(btn).toBeTruthy();
      btn!.click();
      await tick();
    }

    expect(container.querySelector("[data-testid='error-boundary-recover-btn']")).toBeNull();
    expect(container.querySelector("[data-testid='error-boundary-reload-btn']")).toBeTruthy();
    expect(container.textContent).toContain("Recovery attempts exhausted");
  });

  it("Reload button calls window.location.reload()", async () => {
    // happy-dom's window.location is non-configurable; replace it via
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

      const reloadBtn = container.querySelector<HTMLButtonElement>(
        "[data-testid='error-boundary-reload-btn']",
      );
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
