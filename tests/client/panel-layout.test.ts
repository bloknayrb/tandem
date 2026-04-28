import { describe, expect, it } from "vitest";
import {
  getRightWidth,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  type PanelLayout,
} from "../../src/client/panel-layout.js";

describe("getRightWidth", () => {
  it("returns right width for tabbed layout", () => {
    const layout: PanelLayout = { kind: "tabbed", right: 400 };
    expect(getRightWidth(layout)).toBe(400);
  });

  it("returns right width for three-panel layout", () => {
    const layout: PanelLayout = { kind: "three-panel", left: 250, right: 350 };
    expect(getRightWidth(layout)).toBe(350);
  });

  it("returns PANEL_DEFAULT_WIDTH for tabbed-left layout", () => {
    const layout: PanelLayout = { kind: "tabbed-left", left: 250 };
    expect(getRightWidth(layout)).toBe(PANEL_DEFAULT_WIDTH);
  });
});

describe("tabbed-left layout variant", () => {
  it("only carries a left width (no right property)", () => {
    const layout: PanelLayout = { kind: "tabbed-left", left: 320 };
    expect(layout.kind).toBe("tabbed-left");
    expect("left" in layout).toBe(true);
    expect("right" in layout).toBe(false);
  });

  it("PANEL_MIN_WIDTH and PANEL_MAX_WIDTH bound left panel width", () => {
    // These bounds are enforced by loadPanelWidth — verify the constants are
    // sane so the clamping contract is testable without localStorage.
    expect(PANEL_MIN_WIDTH).toBeGreaterThan(0);
    expect(PANEL_MAX_WIDTH).toBeGreaterThan(PANEL_MIN_WIDTH);
    expect(PANEL_DEFAULT_WIDTH).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH);
    expect(PANEL_DEFAULT_WIDTH).toBeLessThanOrEqual(PANEL_MAX_WIDTH);
  });
});
