// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmptyState from "../../src/client/components/EmptyState.svelte";
import { DISCONNECT_DEBOUNCE_MS } from "../../src/shared/constants.js";

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    aiChip: null,
    onOpenFile: vi.fn(),
    onRetry: vi.fn(),
    onOpenSettings: vi.fn(),
    onConnectAi: vi.fn(),
    onRestartClaude: vi.fn(),
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
        why: "aiChip null (ready/booting/solo) → state A + product-positioning line, no CTA",
        aiChip: null,
        expectSecondary: true,
        expectCta: false,
      },
      {
        why: "aiChip 'connect' → Connect AI CTA, no positioning line",
        aiChip: "connect",
        expectSecondary: false,
        expectCta: true,
      },
      {
        why: "aiChip 'restart' → Restart CTA, no positioning line",
        aiChip: "restart",
        expectSecondary: false,
        expectCta: true,
      },
    ])("$why", ({ aiChip, expectSecondary, expectCta }) => {
      const { container } = render(EmptyState, {
        props: makeProps({ connected: true, aiChip }),
      });

      // State A is the default (connected, not yet disconnected).
      expect(byTestId(container, "empty-state-open-file")).toBeTruthy();
      expect(byTestId(container, "empty-state-retry")).toBeNull();
      expect(container.textContent).toContain("Nothing open yet");

      // The product-positioning line shows only when there's no AI CTA to make.
      const hasSecondary =
        container.textContent?.includes("Tandem works alongside Claude") ?? false;
      expect(hasSecondary).toBe(expectSecondary);
      expect(byTestId(container, "empty-state-connect-ai") !== null).toBe(expectCta);
    });

    it("Open file… fires onOpenFile", async () => {
      const props = makeProps({ connected: true });
      const { container } = render(EmptyState, { props });

      byTestId(container, "empty-state-open-file")?.click();
      await tick();

      expect(props.onOpenFile).toHaveBeenCalledOnce();
      expect(props.onRetry).not.toHaveBeenCalled();
    });

    it("Connect AI CTA fires onConnectAi", async () => {
      const props = makeProps({ connected: true, aiChip: "connect" });
      const { container } = render(EmptyState, { props });

      byTestId(container, "empty-state-connect-ai")?.click();
      await tick();

      expect(props.onConnectAi).toHaveBeenCalledOnce();
    });

    it("Restart CTA fires onRestartClaude", async () => {
      const props = makeProps({ connected: true, aiChip: "restart" });
      const { container } = render(EmptyState, { props });

      byTestId(container, "empty-state-connect-ai")?.click();
      await tick();

      expect(props.onRestartClaude).toHaveBeenCalledOnce();
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

    it("reconnect clears state C and returns to state A", async () => {
      const { container, rerender } = render(EmptyState, {
        props: makeProps({ connected: false }),
      });
      await vi.advanceTimersByTimeAsync(DISCONNECT_DEBOUNCE_MS);
      await tick();
      expect(byTestId(container, "empty-state-retry")).toBeTruthy();

      // Server returns: the $effect's connected branch must reset showDisconnected.
      // This is the only path that dismisses "Server unavailable" — guard against a
      // future "tidy" dropping the reset and stranding the user on state C.
      await rerender(makeProps({ connected: true }));
      await tick();
      expect(byTestId(container, "empty-state-retry")).toBeNull();
      expect(byTestId(container, "empty-state-open-file")).toBeTruthy();
    });

    it("reconnect within the debounce window cancels the pending flip to state C", async () => {
      const { container, rerender } = render(EmptyState, {
        props: makeProps({ connected: false }),
      });
      // Reconnect before the deadline; the effect cleanup must clearTimeout the
      // pending flip so the stale timer never fires state C after recovery.
      await vi.advanceTimersByTimeAsync(DISCONNECT_DEBOUNCE_MS / 2);
      await rerender(makeProps({ connected: true }));
      await vi.advanceTimersByTimeAsync(DISCONNECT_DEBOUNCE_MS);
      await tick();

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
