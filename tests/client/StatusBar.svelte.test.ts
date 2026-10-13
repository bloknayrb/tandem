// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import StatusBar from "../../src/client/status/StatusBar.svelte";
import { TANDEM_PURCHASE_URL } from "../../src/shared/constants.js";

const baseProps = {
  connected: true,
  connectionStatus: "connected" as const,
  reconnectAttempts: 0,
  disconnectedSince: null,
  claudeStatus: null,
  claudeActive: false,
  aiLiveIndicator: null,
  aiLauncherAttached: false,
  aiLauncherRestarting: false,
  aiSessionCount: null as number | null,
  aiOffKind: null,
  onOpenLicenseSettings: () => {},
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

  // #1521: the new action must reach its own handler, never the connect or
  // restart branch a binary ternary would route it to.
  it("the unlicensed chip opens license settings and nothing else", async () => {
    const onConnectAi = vi.fn();
    const onRestartClaude = vi.fn();
    const onOpenLicenseSettings = vi.fn();
    const { getByTestId, queryByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        aiState: "stopped",
        aiChip: "unlicensed",
        aiOffKind: "unlicensed",
        onConnectAi,
        onRestartClaude,
        onOpenLicenseSettings,
      },
    });
    const indicator = getByTestId("status-ai-indicator");
    expect(indicator.getAttribute("data-ai-action")).toBe("unlicensed");
    expect(indicator.textContent).toContain("AI off");
    await fireEvent.click(indicator);
    expect(onOpenLicenseSettings).toHaveBeenCalledOnce();
    expect(onConnectAi).not.toHaveBeenCalled();
    expect(onRestartClaude).not.toHaveBeenCalled();
    expect(queryByTestId("status-tandem-claude-down")).toBeNull();
  });

  it("an unverifiable holder is never told 'unlicensed' or shown the purchase URL", () => {
    const { getByTestId } = render(StatusBar, {
      props: { ...baseProps, aiState: "stopped", aiChip: "unlicensed", aiOffKind: "unverifiable" },
    });
    const indicator = getByTestId("status-ai-indicator");
    for (const text of [
      indicator.getAttribute("title") ?? "",
      indicator.getAttribute("aria-label") ?? "",
    ]) {
      expect(text).not.toMatch(/unlicensed/i);
      expect(text).not.toContain("Activate a license");
      expect(text).not.toContain(TANDEM_PURCHASE_URL);
    }
  });

  it("the unlicensed twin's copy does name the state", () => {
    const { getByTestId } = render(StatusBar, {
      props: { ...baseProps, aiState: "stopped", aiChip: "unlicensed", aiOffKind: "unlicensed" },
    });
    expect(getByTestId("status-ai-indicator").getAttribute("title")).toContain("unlicensed");
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
    expect(indicator.getAttribute("aria-label")).toContain("Something is connected to Tandem");
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
    expect(indicator.textContent).toContain(" · reviewing scratchpad… (not your comments)");
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
    // The separator keeps its leading space: Svelte trims whitespace at the start
    // of an `{#if}` body, which rendered "AI connected· reviewing…".
    expect(indicator.textContent).toContain(" · reviewing scratchpad…");
  });

  it("spaces the activity after the session count too", () => {
    const { getByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        aiLiveIndicator: "connected" as const,
        aiState: "ready" as const,
        aiSessionCount: 2,
        claudeStatus: "reviewing scratchpad…",
        claudeActive: true,
      },
    });

    expect(getByTestId("status-ai-indicator").textContent).toContain(
      "2 sessions · reviewing scratchpad…",
    );
  });
});

/**
 * The chat UI shows status only for the chat's attached session (Bryan,
 * 2026-10-09). Beside "Tandem's Claude", presence activity may be another
 * session's, so only the supervisor's own `busy` renders.
 */
describe("StatusBar — Tandem's Claude activity", () => {
  const foreignActivity = {
    claudeStatus: "reviewing scratchpad…",
    claudeActive: true,
    claudeWorkingTool: "tandem_edit",
  };

  it("suppresses another session's activity while Tandem's Claude runs", () => {
    const { getByTestId, queryByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        ...foreignActivity,
        aiState: "ready" as const,
        aiLiveIndicator: "connected" as const,
        aiLauncherRunning: true,
      },
    });
    const indicator = getByTestId("status-ai-indicator");
    expect(indicator.textContent).toContain("Tandem's Claude");
    expect(indicator.textContent).not.toContain("reviewing scratchpad…");
    expect(queryByTestId("claude-working-indicator")).toBeNull();
    // `claudeActive` would pulse the dot without the `pulse` override.
    const dot = indicator.querySelector(".claude-dot") as HTMLElement;
    expect(dot.getAttribute("style")).toContain("animation: none");
  });

  it("positive control: the same activity renders when the launcher is not running", () => {
    const { getByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        ...foreignActivity,
        aiState: "ready" as const,
        aiLiveIndicator: "connected" as const,
      },
    });
    const indicator = getByTestId("status-ai-indicator");
    expect(indicator.textContent).toContain("reviewing scratchpad…");
    expect(getByTestId("claude-working-indicator").textContent).toContain("is editing");
    const dot = indicator.querySelector(".claude-dot") as HTMLElement;
    expect(dot.getAttribute("style")).toContain("tandem-status-pulse");
  });

  it("re-sources the working pill to the launcher's busy flag", () => {
    const { getByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        ...foreignActivity,
        aiState: "ready" as const,
        aiLiveIndicator: "connected" as const,
        aiLauncherRunning: true,
        aiLauncherBusy: true,
      },
    });
    const pill = getByTestId("claude-working-indicator");
    expect(pill.textContent).toContain("Tandem's Claude is working…");
    expect(pill.getAttribute("role")).toBe("status");
    // The dot pulses from `busy` through the `pulse` override, not from presence.
    const dot = getByTestId("status-ai-indicator").querySelector(".claude-dot") as HTMLElement;
    expect(dot.getAttribute("style")).toContain("tandem-status-pulse");
  });
});

describe("StatusBar — Tandem's Claude isn't running", () => {
  const attached = {
    aiState: "ready" as const,
    aiLiveIndicator: "connected" as const,
  };

  it("renders nothing when there is no failure", () => {
    const { queryByTestId } = render(StatusBar, { props: { ...baseProps, ...attached } });
    expect(queryByTestId("status-tandem-claude-down")).toBeNull();
  });

  it("restart: says the user's own Claude is unaffected and calls restart", async () => {
    const onRestartClaude = vi.fn();
    const onConnectAi = vi.fn();
    const { getByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        ...attached,
        aiLauncherFailure: "restart" as const,
        onRestartClaude,
        onConnectAi,
      },
    });
    const btn = getByTestId("status-tandem-claude-down");
    expect(btn.textContent).toContain("Tandem's Claude isn't running");
    expect(btn.getAttribute("aria-label")).toContain(
      "any Claude you started yourself is unaffected",
    );
    await fireEvent.click(btn);
    expect(onRestartClaude).toHaveBeenCalledOnce();
    expect(onConnectAi).not.toHaveBeenCalled();
  });

  it("setup: opens the wizard, not a restart (the #1268 handler pairing)", async () => {
    const onRestartClaude = vi.fn();
    const onConnectAi = vi.fn();
    const { getByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        ...attached,
        aiLauncherFailure: "setup" as const,
        onRestartClaude,
        onConnectAi,
      },
    });
    const btn = getByTestId("status-tandem-claude-down");
    expect(btn.textContent).toContain("Tandem's Claude can't start");
    await fireEvent.click(btn);
    expect(onConnectAi).toHaveBeenCalledOnce();
    expect(onRestartClaude).not.toHaveBeenCalled();
  });

  it("sign-in: names the sign-in and checks again via restart", async () => {
    const onRestartClaude = vi.fn();
    const { getByTestId } = render(StatusBar, {
      props: { ...baseProps, ...attached, aiLauncherFailure: "sign-in" as const, onRestartClaude },
    });
    const btn = getByTestId("status-tandem-claude-down");
    expect(btn.textContent).toContain("Tandem's Claude: sign in");
    await fireEvent.click(btn);
    expect(onRestartClaude).toHaveBeenCalledOnce();
  });

  it("dismiss calls the caller's handler", async () => {
    const onDismissLauncherFailure = vi.fn();
    const { getByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        ...attached,
        aiLauncherFailure: "restart" as const,
        onDismissLauncherFailure,
      },
    });
    await fireEvent.click(getByTestId("status-tandem-claude-down-dismiss"));
    expect(onDismissLauncherFailure).toHaveBeenCalledOnce();
  });

  it("sits beside the attached pill rather than replacing it", () => {
    const { getByTestId } = render(StatusBar, {
      props: { ...baseProps, ...attached, aiLauncherFailure: "restart" as const },
    });
    expect(getByTestId("status-tandem-claude-down")).toBeTruthy();
    expect(getByTestId("status-ai-indicator").textContent).toContain("AI attached");
  });

  it("a dismissal hides the button and leaves the pill as it was", () => {
    const { getByTestId, queryByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        ...attached,
        aiLauncherFailure: "restart" as const,
        aiLauncherFailureDismissed: true,
      },
    });
    expect(queryByTestId("status-tandem-claude-down")).toBeNull();
    expect(getByTestId("status-ai-indicator").textContent).toContain("AI attached");
  });
});

/** Bryan, 2026-10-11: "i do want the colors to be honest. the status pill
 * should indicate how many sessions are connected as well". */
describe("StatusBar — honest colour and session count", () => {
  const launcher = {
    aiState: "ready" as const,
    aiLiveIndicator: "connected" as const,
    aiLauncherRunning: true,
  };

  it("keeps the dot neutral beside Tandem's Claude when the connection isn't matched to it", () => {
    const { getByTestId } = render(StatusBar, { props: { ...baseProps, ...launcher } });
    const dot = getByTestId("status-ai-indicator").querySelector(".claude-dot") as HTMLElement;
    expect(dot.classList.contains("pending-ring")).toBe(true);
  });

  it("turns it green only when the server matched the connection to Tandem's Claude", () => {
    const { getByTestId } = render(StatusBar, {
      props: { ...baseProps, ...launcher, aiLauncherAttached: true },
    });
    const dot = getByTestId("status-ai-indicator").querySelector(".claude-dot") as HTMLElement;
    expect(dot.classList.contains("pending-ring")).toBe(false);
  });

  it("shows the session count beside the label and in the tooltip", () => {
    const { getByTestId } = render(StatusBar, {
      props: { ...baseProps, ...launcher, aiSessionCount: 2 },
    });
    expect(getByTestId("status-ai-session-count").textContent).toBe(" · 2 sessions");
    const pill = getByTestId("status-ai-indicator");
    expect(pill.textContent).toContain("Tandem's Claude · 2 sessions");
    expect(pill.getAttribute("title")).toContain("2 sessions are connected to Tandem");
    expect(pill.getAttribute("aria-label")).toContain("2 sessions are connected to Tandem");
  });

  it("shows no count when it is unknown", () => {
    const { queryByTestId } = render(StatusBar, { props: { ...baseProps, ...launcher } });
    expect(queryByTestId("status-ai-session-count")).toBeNull();
  });
});

describe("StatusBar — a leftover session", () => {
  it("shows 'AI attached' hollow, without a count, when no session is live", () => {
    const { getByTestId, queryByTestId } = render(StatusBar, {
      props: {
        ...baseProps,
        aiState: "ready" as const,
        aiLiveIndicator: "connected" as const,
        aiSessionCount: 0,
      },
    });
    const pill = getByTestId("status-ai-indicator");
    expect(pill.getAttribute("data-ai-state")).toBe("connected-stale");
    expect(pill.textContent).toContain("AI attached");
    const dot = pill.querySelector(".claude-dot") as HTMLElement;
    expect(dot.classList.contains("pending-ring")).toBe(true);
    expect(queryByTestId("status-ai-session-count")).toBeNull();
  });
});
