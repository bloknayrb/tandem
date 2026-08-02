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

  it("keeps a connected, non-actionable status as a labelled image", () => {
    const { getByTestId } = render(StatusBar, {
      props: { ...baseProps, aiLiveIndicator: "connected", aiState: "ready" },
    });

    const indicator = getByTestId("status-ai-indicator");
    expect(indicator.tagName).toBe("DIV");
    expect(indicator.getAttribute("role")).toBe("img");
    expect(indicator.getAttribute("aria-label")).toContain("Claude is connected");
  });
});
