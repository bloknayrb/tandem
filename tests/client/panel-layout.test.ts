import { describe, expect, it } from "vitest";
import {
  getRightWidth,
  PANEL_DEFAULT_WIDTH,
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
