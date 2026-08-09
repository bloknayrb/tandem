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

const PILL = {
  label: "Claude in notes",
  title: "Claude is running in ~/notes, not ~/projects/alpha.",
  ariaLabel:
    "Working folder mismatch. Claude is running in ~/notes, not ~/projects/alpha. " +
    "It can't see that folder's CLAUDE.md.",
  explanation:
    "Claude is running in ~/notes, not ~/projects/alpha. It can't see that folder's CLAUDE.md.",
  actionLabel: "Restart Claude in alpha…",
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
  return render(StatusBar, { props: { ...baseProps, cwdDriftView: PILL, ...over } });
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

  it("renders nothing when the caller passes no pill", () => {
    // The stale-CTA gate now lives in `cwdDriftPill` and is composed by App, so
    // that suppression is pinned in `status-ai-view.test.ts`. What StatusBar owes
    // is only that it renders exactly what it is handed.
    const { queryByTestId } = mount({ cwdDriftView: null });
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

  it("hands focus to the status bar for the rows that unmount it", async () => {
    // `DecorationsMenu`, whose close-guard this copies, has a trigger that
    // survives every action. Dismiss and opt-out unmount this component AND its
    // trigger, so restoring focus there drops a keyboard user on <body>.
    for (const testid of ["cwd-drift-dismiss", "cwd-drift-opt-out"] as const) {
      const { getByTestId, container } = mount();
      await fireEvent.click(getByTestId("cwd-drift-pill"));
      await fireEvent.click(getByTestId(testid));
      const statusRoot = container.querySelector("[data-status-focus-root]");
      expect(statusRoot, testid).not.toBeNull();
      expect(document.activeElement, `${testid} stranded focus`).toBe(statusRoot);
      cleanup();
    }
  });

  it("keeps focus on the trigger for the row that leaves it mounted", async () => {
    const { getByTestId } = mount();
    await fireEvent.click(getByTestId("cwd-drift-pill"));
    await fireEvent.click(getByTestId("cwd-drift-relaunch"));
    expect(document.activeElement).toBe(getByTestId("cwd-drift-pill"));
  });

  it("closes on an outside click", async () => {
    // `clickOutside` fires on mousedown — the case Escape cannot reach, and the
    // reason `closeMenu`'s focus guard is conditional at all.
    const { getByTestId, queryByTestId } = mount();
    await fireEvent.click(getByTestId("cwd-drift-pill"));
    expect(queryByTestId("cwd-drift-dismiss")).not.toBeNull();
    await fireEvent.mouseDown(document.body);
    expect(queryByTestId("cwd-drift-dismiss")).toBeNull();
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
