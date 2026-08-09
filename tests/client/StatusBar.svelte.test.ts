// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import StatusBar from "../../src/client/status/StatusBar.svelte";

const baseProps = {
  connected: true,
  connectionStatus: "connected" as const,
  reconnectAttempts: 0,
  disconnectedSince: null,
  claudeStatus: null,
  claudeActive: false,
  aiLiveIndicator: null,
  aiState: "unconfigured" as const,
  soloMode: false,
};

afterEach(() => cleanup());

describe("StatusBar AI action indicator", () => {
  it("renders the disconnected indicator as a named Connect button when actionable", async () => {
    const onConnectAi = vi.fn();
    const { getByTestId } = render(StatusBar, {
      props: { ...baseProps, aiChip: "connect", onConnectAi },
    });

    const indicator = getByTestId("status-ai-indicator");
    expect(indicator.tagName).toBe("BUTTON");
    expect(indicator.getAttribute("aria-label")).toBe("AI isn't set up. Connect Claude Code.");
    expect(indicator.getAttribute("data-ai-action")).toBe("connect");
    await fireEvent.click(indicator);
    expect(onConnectAi).toHaveBeenCalledOnce();
  });

  it("renders Restart with a state-specific accessible name", async () => {
    const onRestartClaude = vi.fn();
    const { getByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        aiState: "stopped",
        aiChip: "restart",
        onRestartClaude,
      },
    });

    const indicator = getByTestId("status-ai-indicator");
    expect(indicator.getAttribute("aria-label")).toBe(
      "Claude Code has stopped. Restart Claude Code.",
    );
    await fireEvent.click(indicator);
    expect(onRestartClaude).toHaveBeenCalledOnce();
  });

  // #1268 defect 1: the "setup" chip (keyed off `lastError === "cli-unusable"`
  // in the hook — see useAiReadiness's `AiChip` doc comment)
  // used to announce "Set up Claude Code" via title/aria-label while the
  // separate onclick ternary had silently lost that branch and fell through
  // to onRestartClaude. Assert the announced label AND the invoked handler
  // agree, with a positive control proving onRestartClaude is reachable at
  // all (so a bug that made onclick always resolve to undefined wouldn't
  // pass by both assertions vacuously succeeding).
  it("renders Setup with a state-specific accessible name whose handler matches", async () => {
    const onConnectAi = vi.fn();
    const onRestartClaude = vi.fn();
    const { getByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        aiState: "stopped",
        aiChip: "setup",
        onConnectAi,
        onRestartClaude,
      },
    });

    const indicator = getByTestId("status-ai-indicator");
    expect(indicator.getAttribute("aria-label")).toBe(
      "Claude Code needs to be installed. Set up Claude Code.",
    );
    expect(indicator.getAttribute("data-ai-action")).toBe("setup");
    await fireEvent.click(indicator);
    expect(onConnectAi).toHaveBeenCalledOnce();
    expect(onRestartClaude).not.toHaveBeenCalled();
  });

  it("keeps a connected, non-actionable status as a labelled image", () => {
    const { getByTestId } = render(StatusBar, {
      props: { ...baseProps, aiLiveIndicator: "connected", aiState: "ready" },
    });

    const indicator = getByTestId("status-ai-indicator");
    expect(indicator.tagName).toBe("DIV");
    expect(indicator.getAttribute("role")).toBe("img");
    expect(indicator.getAttribute("aria-label")).toContain("Claude is connected");
  });
  // #1287: the Solo qualifier is only meaningful when it renders from the real
  // component. An earlier draft asserted it via `page.setContent()` in an E2E
  // spec -- writing the HTML and then reading it back, which passes with the
  // feature deleted. These render StatusBar itself.
  it("qualifies Claude's activity text in Solo so it doesn't read as disproving the hold", () => {
    const { getByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        soloMode: true,
        aiLiveIndicator: "solo-paused" as const,
        aiState: "ready" as const,
        claudeStatus: "reviewing scratchpad…",
        claudeActive: true,
      },
    });

    const indicator = getByTestId("status-ai-indicator");
    expect(indicator.textContent).toContain("Solo · comments held");
    expect(indicator.textContent).toContain("reviewing scratchpad…");
    expect(indicator.textContent).toContain("(not your comments)");
    // The label already says "held"; the qualifier must add the missing fact,
    // not restate it on a status strip whose scarcest resource is width.
    expect(indicator.textContent).not.toContain("comments still held");
  });

  it("leaves the connected copy unqualified -- it makes no forwarding promise", () => {
    const { getByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        aiLiveIndicator: "connected" as const,
        aiState: "ready" as const,
        claudeStatus: "reviewing scratchpad…",
        claudeActive: true,
      },
    });

    const indicator = getByTestId("status-ai-indicator");
    // Positive control: the activity text IS rendering here, so the negative
    // assertion below is about the gate and not about an empty pill.
    expect(indicator.textContent).toContain("reviewing scratchpad…");
    expect(indicator.textContent).not.toContain("not your comments");
  });
});
