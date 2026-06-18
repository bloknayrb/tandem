// @vitest-environment happy-dom

/**
 * Lifecycle coverage for the `licenseStore` singleton (#1116, ADR-040).
 *
 * The pure status→UI mapping lives in `license-ui.test.ts`; this file exercises
 * the polling/transition logic and the start/stop composition that was tightened
 * after the Svelte review:
 *   - a dark build (gateActive:false) polls exactly once, then self-stops
 *   - `onRestricted` fires only on the trial→restricted EDGE, never per-poll
 *   - a redundant `start()` cannot null a live `onRestricted` (review #1)
 *   - `stop()` then `start()` re-arms the interval (review #2)
 *
 * `fetchLicenseStatus` is the only I/O the store performs, so it's mocked; fake
 * timers drive the 60s poll interval deterministically. The store is a module
 * singleton, so each test resets it via `stop()` (clears timer + `started`) plus
 * `set()` (baselines `status`/`wasRestricted` to a non-restricted value).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseStatusResponse } from "../../src/client/utils/license-ui";

const fetchLicenseStatus = vi.fn<() => Promise<LicenseStatusResponse>>();
vi.mock("../../src/client/hooks/useLicense", () => ({
  fetchLicenseStatus: () => fetchLicenseStatus(),
  activateLicenseClient: vi.fn(),
}));

const { licenseStore } = await import("../../src/client/hooks/useLicense.svelte");

const DARK: LicenseStatusResponse = {
  gateActive: false,
  status: "trial",
  updateWindowCurrent: false,
};
const TRIAL = (days: number): LicenseStatusResponse => ({
  gateActive: true,
  status: "trial",
  updateWindowCurrent: false,
  trial: { daysRemaining: days },
});
const RESTRICTED: LicenseStatusResponse = {
  gateActive: true,
  status: "restricted",
  updateWindowCurrent: false,
};

/** Flush the microtask queue so an in-flight poll's awaited fetch settles. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("licenseStore (singleton lifecycle)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchLicenseStatus.mockReset();
    // Reset the singleton: stop() clears the timer + `started`; set(DARK) zeroes
    // `wasRestricted` (DARK is non-restricted) so transition tests start clean.
    licenseStore.stop();
    licenseStore.set(DARK);
  });

  afterEach(() => {
    licenseStore.stop();
    vi.useRealTimers();
  });

  it("dark build polls once then self-stops; UI stays permissive", async () => {
    fetchLicenseStatus.mockResolvedValue(DARK);
    licenseStore.start();
    await flush();

    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);
    expect(licenseStore.ui.editable).toBe(true);
    expect(licenseStore.ui.showWall).toBe(false);
    expect(licenseStore.ui.showTrialBanner).toBe(false);

    // Well past the interval — no further polls (the dark path stopped the timer).
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);
  });

  it("trial state surfaces the banner with the day count", async () => {
    fetchLicenseStatus.mockResolvedValue(TRIAL(5));
    licenseStore.start();
    await flush();

    expect(licenseStore.ui.showTrialBanner).toBe(true);
    expect(licenseStore.ui.trialDaysRemaining).toBe(5);
    expect(licenseStore.ui.editable).toBe(true);
  });

  it("fires onRestricted only on the trial→restricted edge", async () => {
    const onRestricted = vi.fn();
    fetchLicenseStatus.mockResolvedValueOnce(TRIAL(1)).mockResolvedValue(RESTRICTED);

    licenseStore.start({ onRestricted });
    await flush(); // poll 1: trial → no fire
    expect(onRestricted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000); // poll 2: restricted → fire once
    await flush();
    expect(onRestricted).toHaveBeenCalledTimes(1);
    expect(licenseStore.ui.showWall).toBe(true);
    expect(licenseStore.ui.editable).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000); // poll 3: still restricted → no re-fire
    await flush();
    expect(onRestricted).toHaveBeenCalledTimes(1);
  });

  it("a redundant start() does not null a live onRestricted (review #1)", async () => {
    const onRestricted = vi.fn();
    fetchLicenseStatus.mockResolvedValue(TRIAL(3));

    licenseStore.start({ onRestricted });
    await flush();
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);

    // Second start with NO deps must be guarded — no extra poll, callback intact.
    licenseStore.start();
    await flush();
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);

    // Drive a restricted transition; the original callback must still fire.
    fetchLicenseStatus.mockResolvedValue(RESTRICTED);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(onRestricted).toHaveBeenCalledTimes(1);
  });

  it("stop() then start() re-arms polling (review #2)", async () => {
    fetchLicenseStatus.mockResolvedValue(TRIAL(2));

    licenseStore.start();
    await flush();
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);

    licenseStore.stop();
    licenseStore.start(); // must NOT early-return — `started` was reset by stop()
    await flush();
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(2);
  });
});
