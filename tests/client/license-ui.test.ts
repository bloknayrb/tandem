import { describe, expect, it } from "vitest";
import { aiOffCopy, deriveLicenseUi } from "../../src/client/utils/license-ui.js";
import { TANDEM_PURCHASE_URL } from "../../src/shared/constants.js";

/**
 * #1521: a keyless install refuses the AI, never the editor. `LicenseUi`
 * carries no editability or wall flag at all, and `aiNotice` is the one
 * discriminant every AI surface keys on — null on every dark build.
 */
describe("deriveLicenseUi", () => {
  it("has no aiNotice when state is null (not loaded)", () => {
    expect(deriveLicenseUi(null)).toMatchObject({ aiNotice: null, showTrialBanner: false });
  });

  it("has no aiNotice when the gate is inactive (dark build), even if restricted", () => {
    const ui = deriveLicenseUi({
      gateActive: false,
      status: "restricted",
      updateWindowCurrent: true,
    });
    expect(ui).toMatchObject({ aiNotice: null, showTrialBanner: false });
    expect(ui.statusLabel).toBe("");
  });

  it("shows the trial banner with day count (nested trial payload)", () => {
    const ui = deriveLicenseUi({
      gateActive: true,
      status: "trial",
      updateWindowCurrent: false,
      trial: { daysRemaining: 9 },
    });
    expect(ui.aiNotice).toBeNull();
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

  it("a trial with an unverifiable licence file still has no aiNotice", () => {
    const ui = deriveLicenseUi({
      gateActive: true,
      status: "trial",
      updateWindowCurrent: false,
      daysRemaining: 3,
      licenseUnverifiable: "BAD_SIGNATURE",
    });
    expect(ui.aiNotice).toBeNull();
  });

  it("restricted refuses the AI as unlicensed, labelled 'Unlicensed' (never 'Trial ended')", () => {
    const ui = deriveLicenseUi({
      gateActive: true,
      status: "restricted",
      updateWindowCurrent: false,
    });
    expect(ui.aiNotice).toBe("unlicensed");
    expect(ui.statusLabel).toBe("Unlicensed");
  });

  it("restricted with an unverifiable licence refuses the AI as unverifiable", () => {
    const ui = deriveLicenseUi({
      gateActive: true,
      status: "restricted",
      updateWindowCurrent: false,
      licenseUnverifiable: "MALFORMED",
    });
    expect(ui.aiNotice).toBe("unverifiable");
    expect(ui.statusLabel).toBe("License not verified");
  });

  // Client AI-off is advisory and fails open: with no status yet (first poll in
  // flight, or every poll failing) the AI controls stay enabled. The server's
  // `aiRefusal()` is the authority.
  it("fails open: no status means the AI controls are not disabled", () => {
    expect(deriveLicenseUi(null).aiOff).toBe(false);
    expect(deriveLicenseUi(null).aiNotice).toBeNull();
  });

  it("carries no editable or showWall key in any state", () => {
    for (const ui of [
      deriveLicenseUi(null),
      deriveLicenseUi({ gateActive: true, status: "restricted", updateWindowCurrent: false }),
      deriveLicenseUi({ gateActive: true, status: "trial", updateWindowCurrent: false }),
      deriveLicenseUi({ gateActive: true, status: "licensed", updateWindowCurrent: true }),
    ]) {
      expect(ui).not.toHaveProperty("editable");
      expect(ui).not.toHaveProperty("showWall");
    }
  });

  it("labels a licensed device with the licensee email when available", () => {
    const ui = deriveLicenseUi({
      gateActive: true,
      status: "licensed",
      updateWindowCurrent: true,
      license: { email: "jane@example.com", type: "grandfathered" },
    });
    expect(ui).toMatchObject({ aiNotice: null, showTrialBanner: false });
    expect(ui.statusLabel).toBe("Licensed to jane@example.com");
  });

  it("falls back to a generic licensed label when the email is scrubbed", () => {
    expect(
      deriveLicenseUi({ gateActive: true, status: "licensed", updateWindowCurrent: true })
        .statusLabel,
    ).toBe("Licensed");
  });
});

describe("deriveLicenseUi — aiOff", () => {
  it("is exactly aiNotice !== null in every state", () => {
    const states = [
      null,
      { gateActive: false, status: "restricted", updateWindowCurrent: true },
      { gateActive: true, status: "trial", updateWindowCurrent: true, daysRemaining: 3 },
      { gateActive: true, status: "licensed", updateWindowCurrent: true },
      { gateActive: true, status: "restricted", updateWindowCurrent: false },
      {
        gateActive: true,
        status: "restricted",
        updateWindowCurrent: false,
        licenseUnverifiable: "MALFORMED",
      },
    ] as const;
    const seen = new Set<boolean>();
    for (const state of states) {
      const ui = deriveLicenseUi(state);
      expect(ui.aiOff).toBe(ui.aiNotice !== null);
      seen.add(ui.aiOff);
    }
    // Both buckets, so the loop cannot pass on all-false.
    expect(seen).toEqual(new Set([true, false]));
  });
});

describe("aiOffCopy", () => {
  it("each sentence ends with its remedy", () => {
    for (const kind of ["unlicensed", "unverifiable"] as const) {
      const c = aiOffCopy(kind);
      expect(c.sentence.endsWith(` ${c.remedy}`)).toBe(true);
    }
  });

  it("unlicensed names the state and the remedy", () => {
    const c = aiOffCopy("unlicensed");
    expect(c.sentence).toContain("unlicensed");
    expect(c.short).toContain("unlicensed");
  });

  it("unverifiable never says 'unlicensed' or 'Activate a license', and carries no URL", () => {
    const c = aiOffCopy("unverifiable");
    for (const text of [c.short, c.sentence, c.remedy]) {
      expect(text).not.toMatch(/unlicensed/i);
      expect(text).not.toContain("Activate a license");
      expect(text).not.toContain(TANDEM_PURCHASE_URL);
    }
  });
});
