// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import StatusBar from "../../src/client/status/StatusBar.svelte";

// Minimal required props
const baseProps = {
  connected: true,
  connectionStatus: "connected" as const,
  reconnectAttempts: 0,
  disconnectedSince: null,
  claudeStatus: null,
  claudeActive: false,
};

describe("StatusBar held badge", () => {
  it("renders sb-held button when heldCount > 0 and mode === solo", () => {
    const { container } = render(StatusBar, {
      props: { ...baseProps, heldCount: 3, mode: "solo" },
    });
    expect(container.querySelector("[data-testid='sb-held']")).toBeTruthy();
    expect(container.querySelector("[data-testid='sb-held']")?.textContent).toContain("3");
  });

  it("does not render sb-held when heldCount > 0 and mode === tandem", () => {
    const { container } = render(StatusBar, {
      props: { ...baseProps, heldCount: 3, mode: "tandem" },
    });
    expect(container.querySelector("[data-testid='sb-held']")).toBeNull();
  });

  it("does not render sb-held when heldCount === 0 and mode === solo", () => {
    const { container } = render(StatusBar, {
      props: { ...baseProps, heldCount: 0, mode: "solo" },
    });
    expect(container.querySelector("[data-testid='sb-held']")).toBeNull();
  });

  it("calls onShowHeld when sb-held button is clicked", async () => {
    let called = false;
    const { container } = render(StatusBar, {
      props: {
        ...baseProps,
        heldCount: 2,
        mode: "solo",
        onShowHeld: () => {
          called = true;
        },
      },
    });
    const btn = container.querySelector("[data-testid='sb-held']") as HTMLButtonElement;
    btn.click();
    expect(called).toBe(true);
  });
});
