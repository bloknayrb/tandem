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
    onStartFreshClaude: vi.fn(),
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

  // Every non-null aiChip branch renders exactly one of these — checking all
  // three per case (not just the one expected to be present) is the positive
  // control: it proves an "absent" testid is absent because that branch
  // genuinely didn't render, not because the whole card failed to mount.
  const AI_CTA_TESTIDS = [
    "empty-state-connect-ai",
    "empty-state-setup-claude",
    "empty-state-restart-claude",
  ] as const;

  describe("state A — no document open", () => {
    it.each([
      {
        why: "aiChip null (ready/booting/solo) → state A + product-positioning line, no CTA",
        aiChip: null,
        expectSecondary: true,
        expectedTestId: null,
      },
      {
        why: "aiChip 'connect' → Connect AI CTA, no positioning line",
        aiChip: "connect",
        expectSecondary: false,
        expectedTestId: "empty-state-connect-ai",
      },
      {
        why: "aiChip 'setup' (re-keyed off lastError === circuit-open, #1268) → Set up Claude Code CTA, no positioning line",
        aiChip: "setup",
        expectSecondary: false,
        expectedTestId: "empty-state-setup-claude",
      },
      {
        why: "aiChip 'restart' → Restart Claude Code CTA, no positioning line",
        aiChip: "restart",
        expectSecondary: false,
        expectedTestId: "empty-state-restart-claude",
      },
    ])("$why", ({ aiChip, expectSecondary, expectedTestId }) => {
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

      // Exactly the expected branch's testid is present — every other AI-CTA
      // testid must be absent, distinguishing the three reachable branches
      // from each other (not just "some CTA rendered").
      for (const testid of AI_CTA_TESTIDS) {
        const present = byTestId(container, testid) !== null;
        expect(present).toBe(testid === expectedTestId);
      }
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
      expect(props.onRestartClaude).not.toHaveBeenCalled();
    });

    it("aiChip 'connect' carries an honest data-ai-chip attribute", () => {
      const { container } = render(EmptyState, {
        props: makeProps({ connected: true, aiChip: "connect" }),
      });
      expect(byTestId(container, "empty-state-connect-ai")?.getAttribute("data-ai-chip")).toBe(
        "connect",
      );
    });

    // #1268 defect 2a: the install CTA was keyed on `lastError ===
    // "binary-not-found"`, which never actually fires for an uninstalled
    // Claude CLI (that surfaces as an ordinary reaper exit code, routed to
    // `circuit-open` — see the `AiChip` doc comment in useAiReadiness). The
    // hook now folds that into `aiChip === "setup"`; EmptyState must render
    // the install CTA off that value alone.
    it("Set up Claude Code CTA (aiChip 'setup') fires onConnectAi, not onRestartClaude", async () => {
      const props = makeProps({ connected: true, aiChip: "setup" });
      const { container } = render(EmptyState, { props });

      const btn = byTestId(container, "empty-state-setup-claude");
      expect(btn?.textContent?.trim()).toBe("Set up Claude Code");
      expect(btn?.getAttribute("data-ai-chip")).toBe("setup");

      btn?.click();
      await tick();

      expect(props.onConnectAi).toHaveBeenCalledOnce();
      expect(props.onRestartClaude).not.toHaveBeenCalled();
      expect(props.onStartFreshClaude).not.toHaveBeenCalled();
    });

    describe("aiChip 'restart' — primary Restart + secondary Start Fresh", () => {
      function renderRestart(overrides: Record<string, unknown> = {}) {
        const props = makeProps({ connected: true, aiChip: "restart", ...overrides });
        const result = render(EmptyState, { props });
        return { ...result, props };
      }

      it("both actions render with distinct testids and an honest data-ai-chip", () => {
        const { container } = renderRestart();

        const primary = byTestId(container, "empty-state-restart-claude");
        const secondary = byTestId(container, "empty-state-start-fresh");
        expect(primary).toBeTruthy();
        expect(secondary).toBeTruthy();
        expect(primary).not.toBe(secondary);
        expect(primary?.getAttribute("data-ai-chip")).toBe("restart");
        expect(secondary?.getAttribute("data-ai-chip")).toBe("restart");
      });

      // #1268 defect 2b: this button used to be labelled "Try Again" while
      // invoking the session-destroying start-fresh flow. The primary CTA
      // must now be non-destructive — positive control: it still does the
      // (safe) thing its label promises.
      it("primary Restart Claude Code CTA calls onRestartClaude, never onStartFreshClaude", async () => {
        const { container, props } = renderRestart();

        const btn = byTestId(container, "empty-state-restart-claude");
        expect(btn?.textContent?.trim()).toBe("Restart Claude Code");

        btn?.click();
        await tick();

        expect(props.onRestartClaude).toHaveBeenCalledOnce();
        expect(props.onStartFreshClaude).not.toHaveBeenCalled();
      });

      it("secondary Start Fresh CTA calls onStartFreshClaude, never onRestartClaude", async () => {
        const { container, props } = renderRestart();

        const btn = byTestId(container, "empty-state-start-fresh");
        expect(btn?.textContent?.trim()).toBe("Start a fresh conversation");

        btn?.click();
        await tick();

        expect(props.onStartFreshClaude).toHaveBeenCalledOnce();
        expect(props.onRestartClaude).not.toHaveBeenCalled();
      });

      // #1268 defect 2b: "cancelling that confirm leaves the user with no
      // exit from the empty state." The destructive confirm lives inside the
      // wired `onStartFreshClaude` handler (out of this component's scope —
      // a cancel there is a no-op prop call, same as any click), so the
      // structural guarantee EmptyState owns is that the primary, safe
      // Restart button is never removed or disabled as a side effect of the
      // secondary action being present or clicked. Positive control: the
      // primary button still fires its own handler afterwards.
      it("the primary Restart button stays a working exit after the secondary CTA is clicked", async () => {
        const { container, props } = renderRestart();

        byTestId(container, "empty-state-start-fresh")?.click();
        await tick();
        expect(props.onStartFreshClaude).toHaveBeenCalledOnce();

        const primary = byTestId(container, "empty-state-restart-claude");
        expect(primary).toBeTruthy();
        primary?.click();
        await tick();
        expect(props.onRestartClaude).toHaveBeenCalledOnce();
      });
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
