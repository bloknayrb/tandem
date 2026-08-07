// @vitest-environment happy-dom

/**
 * Rendering + interaction coverage for the drift nudge (#1282), driven through
 * `StatusBar` rather than the pill in isolation — the placement decisions are
 * half the design, and the one that matters most (the pill must render in the
 * state where the AI indicator renders nothing) is only observable from here.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import StatusBar from "../../../src/client/status/StatusBar.svelte";

const DRIFT = {
  suggestedCwd: "~/projects/alpha",
  claudeCwd: "~/notes",
  label: "alpha",
  claudeLabel: "notes",
};

const baseProps = {
  connected: true,
  connectionStatus: "connected" as const,
  reconnectAttempts: 0,
  disconnectedSince: null,
  claudeStatus: null,
  claudeActive: false,
  aiLiveIndicator: null,
  aiState: "ready" as const,
  soloMode: false,
};

afterEach(() => cleanup());

function mount(over: Record<string, unknown> = {}) {
  return render(StatusBar, { props: { ...baseProps, cwdDrift: DRIFT, ...over } });
}

describe("drift pill placement", () => {
  it("renders in the launcher-running-but-no-session state", () => {
    // `aiState: "ready"` with `aiLiveIndicator: null` is the auto-launched
    // desktop startup window, where `aiIndicatorView` returns null. If the pill
    // were nested inside `{#if aiView}` this query would fail.
    const { getByTestId, queryByTestId } = mount();
    expect(queryByTestId("status-ai-indicator")).toBeNull();
    expect(getByTestId("cwd-drift-pill")).toBeTruthy();
  });

  it("renders beside a connected AI indicator", () => {
    const { getByTestId } = mount({ aiLiveIndicator: "connected" as const });
    expect(getByTestId("status-ai-indicator")).toBeTruthy();
    expect(getByTestId("cwd-drift-pill")).toBeTruthy();
  });

  it("stays hidden while an AI CTA is showing", () => {
    const { queryByTestId } = mount({ aiState: "stopped" as const, aiChip: "restart" as const });
    expect(queryByTestId("cwd-drift-pill")).toBeNull();
  });

  it("renders nothing when the caller passes no drift", () => {
    const { queryByTestId } = mount({ cwdDrift: null });
    expect(queryByTestId("cwd-drift-pill")).toBeNull();
  });
});

describe("drift pill affordances", () => {
  it("names both folders in its accessible name, not just its tooltip", () => {
    const { getByTestId } = mount();
    const pill = getByTestId("cwd-drift-pill");
    const label = pill.getAttribute("aria-label") ?? "";
    expect(label).toContain("~/notes");
    expect(label).toContain("~/projects/alpha");
  });

  it("is a menu trigger, not a one-click action", () => {
    // The dismiss affordance has to clear WCAG 2.2 SC 2.5.8 (24×24). A bare
    // inline × lands around 10px; three full-size menu rows do not.
    const { getByTestId, queryByTestId } = mount();
    const pill = getByTestId("cwd-drift-pill");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("aria-haspopup")).toBe("menu");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(queryByTestId("cwd-drift-relaunch")).toBeNull();
  });

  it("opens three rows and explains itself", async () => {
    const { getByTestId } = mount();
    await fireEvent.click(getByTestId("cwd-drift-pill"));
    expect(getByTestId("cwd-drift-pill").getAttribute("aria-expanded")).toBe("true");
    expect(getByTestId("cwd-drift-relaunch").textContent).toContain("alpha");
    expect(getByTestId("cwd-drift-dismiss")).toBeTruthy();
    expect(getByTestId("cwd-drift-opt-out")).toBeTruthy();
    // The chip cannot teach the concept; the menu can.
    expect(getByTestId("cwd-drift").textContent).toContain("CLAUDE.md");
  });

  it("runs each row's handler exactly once and closes the menu", async () => {
    for (const [testid, prop] of [
      ["cwd-drift-relaunch", "onRelaunchInFolder"],
      ["cwd-drift-dismiss", "onDismissDrift"],
      ["cwd-drift-opt-out", "onOptOutDrift"],
    ] as const) {
      const spy = vi.fn();
      const { getByTestId, queryByTestId } = mount({ [prop]: spy });
      await fireEvent.click(getByTestId("cwd-drift-pill"));
      await fireEvent.click(getByTestId(testid));
      expect(spy, testid).toHaveBeenCalledOnce();
      expect(queryByTestId(testid), `${testid} left the menu open`).toBeNull();
      cleanup();
    }
  });

  it("closes on Escape without running anything", async () => {
    const spy = vi.fn();
    const { getByTestId, queryByTestId } = mount({ onDismissDrift: spy });
    await fireEvent.click(getByTestId("cwd-drift-pill"));
    await fireEvent.keyDown(getByTestId("cwd-drift"), { key: "Escape" });
    expect(queryByTestId("cwd-drift-dismiss")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
