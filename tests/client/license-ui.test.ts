import { describe, expect, it } from "vitest";
import { deriveLicenseUi } from "../../src/client/utils/license-ui.js";

describe("deriveLicenseUi", () => {
  it("is fully permissive when state is null (not loaded)", () => {
    expect(deriveLicenseUi(null)).toMatchObject({
      editable: true,
      showWall: false,
      showTrialBanner: false,
    });
  });

  it("is fully permissive when the gate is inactive (dark build)", () => {
    const ui = deriveLicenseUi({
      gateActive: false,
      status: "licensed",
      updateWindowCurrent: true,
    });
    expect(ui).toMatchObject({ editable: true, showWall: false, showTrialBanner: false });
    expect(ui.statusLabel).toBe("");
  });

  it("shows the trial banner with day count (nested trial payload)", () => {
    const ui = deriveLicenseUi({
      gateActive: true,
      status: "trial",
      updateWindowCurrent: false,
      trial: { daysRemaining: 9 },
    });
    expect(ui.editable).toBe(true);
    expect(ui.showTrialBanner).toBe(true);
    expect(ui.trialDaysRemaining).toBe(9);
    expect(ui.statusLabel).toBe("Trial — 9 days left");
  });

  it("reads daysRemaining from the scrubbed (LAN) payload too, and singularizes", () => {
    const ui = deriveLicenseUi({
      gateActive: true,
      status: "trial",
      updateWindowCurrent: false,
      daysRemaining: 1,
    });
    expect(ui.trialDaysRemaining).toBe(1);
    expect(ui.statusLabel).toBe("Trial — 1 day left");
  });

  it("locks the editor and shows the wall when restricted", () => {
    const ui = deriveLicenseUi({
      gateActive: true,
      status: "restricted",
      updateWindowCurrent: false,
    });
    expect(ui.editable).toBe(false);
    expect(ui.showWall).toBe(true);
    expect(ui.statusLabel).toBe("Trial ended");
  });

  it("labels a licensed device with the licensee name when available", () => {
    const ui = deriveLicenseUi({
      gateActive: true,
      status: "licensed",
      updateWindowCurrent: true,
      license: { name: "Jane Doe", type: "grandfathered" },
    });
    expect(ui).toMatchObject({ editable: true, showWall: false, showTrialBanner: false });
    expect(ui.statusLabel).toBe("Licensed to Jane Doe");
  });

  it("falls back to a generic licensed label when the name is scrubbed", () => {
    expect(
      deriveLicenseUi({ gateActive: true, status: "licensed", updateWindowCurrent: true })
        .statusLabel,
    ).toBe("Licensed");
  });
});
