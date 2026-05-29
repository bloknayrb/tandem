// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmptyState from "../../src/client/components/EmptyState.svelte";
import { DISCONNECT_DEBOUNCE_MS } from "../../src/shared/constants.js";

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    claudeActive: false,
    onOpenFile: vi.fn(),
    onRetry: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

// Bound queries from @testing-library/svelte default to document.body, which
// accumulates across renders without auto-cleanup; scope to the render's
// container instead (mirrors connection-banner.test.ts).
const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);

describe("EmptyState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("state A — no document open", () => {
    it.each([
      {
        why: "connected + claudeActive → state A, no Claude/MCP secondary line",
        claudeActive: true,
        expectSecondary: false,
      },
      {
        why: "connected + !claudeActive → state A + Claude/MCP secondary line",
        claudeActive: false,
        expectSecondary: true,
      },
    ])("$why", ({ claudeActive, expectSecondary }) => {
      const { container } = render(EmptyState, {
        props: makeProps({ connected: true, claudeActive }),
      });

      // State A is the default (connected, not yet disconnected).
      expect(byTestId(container, "empty-state-open-file")).toBeTruthy();
      expect(byTestId(container, "empty-state-retry")).toBeNull();
      expect(container.textContent).toContain("Nothing open yet");

      // The preserved product-positioning line only when Claude is idle.
      const hasSecondary =
        container.textContent?.includes("Tandem works alongside Claude") ?? false;
      expect(hasSecondary).toBe(expectSecondary);
    });

    it("Open file… fires onOpenFile", async () => {
      const props = makeProps({ connected: true });
      const { container } = render(EmptyState, { props });

      byTestId(container, "empty-state-open-file")?.click();
      await tick();

      expect(props.onOpenFile).toHaveBeenCalledOnce();
      expect(props.onRetry).not.toHaveBeenCalled();
    });
  });

  describe("state C — server unavailable (after disconnect debounce)", () => {
    async function renderDisconnected() {
      const props = makeProps({ connected: false });
      const result = render(EmptyState, { props });
      // The debounce delays state C so a brief blip doesn't flash it.
      await vi.advanceTimersByTimeAsync(DISCONNECT_DEBOUNCE_MS);
      await tick();
      return { ...result, props };
    }

    it("renders state C with both actions after the debounce", async () => {
      const { container } = await renderDisconnected();

      expect(byTestId(container, "empty-state-retry")).toBeTruthy();
      expect(byTestId(container, "empty-state-open-settings")).toBeTruthy();
      expect(byTestId(container, "empty-state-open-file")).toBeNull();
      expect(container.textContent).toContain("Server unavailable");
    });

    it("Retry fires onRetry; Open settings fires onOpenSettings", async () => {
      const { container, props } = await renderDisconnected();

      byTestId(container, "empty-state-retry")?.click();
      byTestId(container, "empty-state-open-settings")?.click();
      await tick();

      expect(props.onRetry).toHaveBeenCalledOnce();
      expect(props.onOpenSettings).toHaveBeenCalledOnce();
      expect(props.onOpenFile).not.toHaveBeenCalled();
    });

    it("does not flash state C before the debounce elapses", () => {
      const { container } = render(EmptyState, { props: makeProps({ connected: false }) });

      // Before the debounce window, state A still shows (no retry button yet).
      expect(byTestId(container, "empty-state-retry")).toBeNull();
      expect(byTestId(container, "empty-state-open-file")).toBeTruthy();
    });
  });

  it("decorative illustrations are aria-hidden", () => {
    const { container } = render(EmptyState, { props: makeProps() });
    const illus = container.querySelector(".empty-illus");
    expect(illus?.getAttribute("aria-hidden")).toBe("true");
  });
});
