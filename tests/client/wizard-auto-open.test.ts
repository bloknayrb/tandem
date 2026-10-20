/**
 * When the setup wizard opens by itself (#2198). The v1.0 walkthrough must come
 * back on every launch until Keep or a successful Apply — so the per-version
 * localStorage dismissal that ends the first-run prompt must not end it — but
 * not again in a session where the user closed it.
 */
import { describe, expect, it } from "vitest";

import {
  resolveWizardAutoOpen,
  type WizardAutoOpenInput,
} from "../../src/client/utils/wizard-auto-open";

const base: WizardAutoOpenInput = {
  needed: true,
  walkthrough: false,
  serverVersion: "1.0.0",
  dismissedForVersion: null,
  closedThisSession: false,
};

describe("resolveWizardAutoOpen", () => {
  it("first run: opens until dismissed for this version", () => {
    expect(resolveWizardAutoOpen(base)).toBe(true);
    expect(resolveWizardAutoOpen({ ...base, dismissedForVersion: "1.0.0" })).toBe(false);
    expect(resolveWizardAutoOpen({ ...base, dismissedForVersion: "0.28.0" })).toBe(true);
  });

  it("the walkthrough ignores the per-version dismissal: it comes back next launch", () => {
    expect(
      resolveWizardAutoOpen({ ...base, walkthrough: true, dismissedForVersion: "1.0.0" }),
    ).toBe(true);
  });

  it("closed this session: not again until the next launch, for either", () => {
    expect(resolveWizardAutoOpen({ ...base, walkthrough: true, closedThisSession: true })).toBe(
      false,
    );
    // Storage-disabled browser: the in-memory flag stops an immediate reopen.
    expect(resolveWizardAutoOpen({ ...base, closedThisSession: true })).toBe(false);
  });

  it("the server is the hard gate", () => {
    expect(resolveWizardAutoOpen({ ...base, needed: false, walkthrough: true })).toBe(false);
    expect(resolveWizardAutoOpen({ ...base, needed: null })).toBe(false);
    expect(resolveWizardAutoOpen({ ...base, serverVersion: null, walkthrough: true })).toBe(false);
  });
});
