import { describe, expect, it } from "vitest";
import {
  aiOffCopy,
  deriveLicenseUi,
  LICENSE_GRACE_DEDUP_KEY,
  type LicenseStatusResponse,
  planLicenseGraceNotice,
} from "../../src/client/utils/license-ui.js";
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

// ── #2231: the grace period ─────────────────────────────────────────────────

const GRACE_STATUS: LicenseStatusResponse = {
  gateActive: true,
  status: "grace",
  updateWindowCurrent: false,
  licenseUnverifiable: "BAD_SIGNATURE",
  grace: {
    firstFailedAt: new Date(2026, 9, 29, 12).toISOString(),
    endsAt: new Date(2026, 10, 12, 12).toISOString(),
    daysRemaining: 1,
  },
};

describe("deriveLicenseUi — grace (#2231)", () => {
  it("keeps the AI on, shows no trial banner, and never says 'Licensed'", () => {
    const ui = deriveLicenseUi(GRACE_STATUS);
    expect(ui).toEqual({
      aiNotice: null,
      aiOff: false,
      showTrialBanner: false,
      trialDaysRemaining: null,
      statusLabel: "License not verified — AI on for 1 more day",
    });
  });

  it("degrades to a dateless label when the payload carries no grace object", () => {
    const { grace: _drop, ...noGrace } = GRACE_STATUS;
    expect(deriveLicenseUi(noGrace).statusLabel).toBe("License not verified");
  });
});

describe("planLicenseGraceNotice (#2231)", () => {
  const NOW = 1_800_000_000_000;
  const row = { id: "license-grace-1", dedupKey: LICENSE_GRACE_DEDUP_KEY };

  it("pushes one persistent warning on entering grace, with the date and no purchase URL", () => {
    const plan = planLicenseGraceNotice({
      status: GRACE_STATUS,
      activity: [],
      handledThisLoad: false,
      now: NOW,
    });
    expect(plan.handledThisLoad).toBe(true);
    expect(plan.dismissIds).toEqual([]);
    expect(plan.push).toMatchObject({
      type: "license",
      severity: "warning",
      dedupKey: LICENSE_GRACE_DEDUP_KEY,
      timestamp: NOW,
    });
    expect(plan.push?.message).toContain("until 2026-11-12");
    expect(plan.push?.message).toContain("support@tandem.ink");
    expect(plan.push?.message).not.toContain(TANDEM_PURCHASE_URL);
  });

  it("does not push again on a later poll of the same page load", () => {
    expect(
      planLicenseGraceNotice({
        status: GRACE_STATUS,
        activity: [],
        handledThisLoad: true,
        now: NOW,
      }).push,
    ).toBeNull();
  });

  it("does not push when the rehydrated tray already holds a grace row", () => {
    const plan = planLicenseGraceNotice({
      status: GRACE_STATUS,
      activity: [row],
      handledThisLoad: false,
      now: NOW,
    });
    expect(plan.push).toBeNull();
    expect(plan.handledThisLoad).toBe(true);
  });

  it("keys on the dedupKey, not a date: a moving firstFailedAt never re-toasts", () => {
    const first = planLicenseGraceNotice({
      status: GRACE_STATUS,
      activity: [],
      handledThisLoad: false,
      now: NOW,
    });
    const moved: LicenseStatusResponse = {
      ...GRACE_STATUS,
      grace: { firstFailedAt: new Date(NOW).toISOString(), endsAt: "z", daysRemaining: 14 },
    };
    expect(
      planLicenseGraceNotice({
        status: moved,
        activity: [],
        handledThisLoad: first.handledThisLoad,
        now: NOW + 60_000,
      }).push,
    ).toBeNull();
  });

  it.each([
    ["licensed", { gateActive: true, status: "licensed", updateWindowCurrent: true }],
    ["restricted", { gateActive: true, status: "restricted", updateWindowCurrent: false }],
    ["a dark build", { gateActive: false, status: "licensed", updateWindowCurrent: true }],
  ] as const)("leaving grace (%s) dismisses every grace row and resets the flag", (_l, status) => {
    const plan = planLicenseGraceNotice({
      status: status as LicenseStatusResponse,
      activity: [row, { id: "other", dedupKey: "settings-readonly" }],
      handledThisLoad: true,
      now: NOW,
    });
    expect(plan).toEqual({ push: null, dismissIds: ["license-grace-1"], handledThisLoad: false });
  });

  it("no status (a failed poll) is not evidence the grace ended: nothing happens", () => {
    expect(
      planLicenseGraceNotice({ status: null, activity: [row], handledThisLoad: true, now: NOW }),
    ).toEqual({ push: null, dismissIds: [], handledThisLoad: true });
  });
});
