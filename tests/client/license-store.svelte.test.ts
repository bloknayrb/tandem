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
const LICENSED: LicenseStatusResponse = {
  gateActive: true,
  status: "licensed",
  updateWindowCurrent: true,
  license: { name: "Beta Tester", type: "grandfathered" },
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

  it("fires onTransition only on the trial→restricted edge", async () => {
    const onTransition = vi.fn();
    fetchLicenseStatus.mockResolvedValueOnce(TRIAL(1)).mockResolvedValue(RESTRICTED);

    licenseStore.start({ onTransition });
    await flush(); // poll 1: trial → no edge from the false baseline
    expect(onTransition).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000); // poll 2: restricted → fire once
    await flush();
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(licenseStore.ui.showWall).toBe(true);
    expect(licenseStore.ui.editable).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000); // poll 3: still restricted → no re-fire
    await flush();
    expect(onTransition).toHaveBeenCalledTimes(1);
  });

  it("fires onTransition on the restricted→licensed edge via set() (activation)", async () => {
    const onTransition = vi.fn();
    fetchLicenseStatus.mockResolvedValue(RESTRICTED);

    licenseStore.start({ onTransition });
    await flush(); // poll establishes restricted (edge from false baseline)
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(licenseStore.ui.showWall).toBe(true);

    // Activation applies the licensed state immediately — the release edge must
    // also fire so the provider rebuild lifts Surface A's read-only.
    licenseStore.set(LICENSED);
    expect(onTransition).toHaveBeenCalledTimes(2);
    expect(licenseStore.ui.showWall).toBe(false);
    expect(licenseStore.ui.editable).toBe(true);
  });

  it("a redundant start() does not null a live onTransition (review #1)", async () => {
    const onTransition = vi.fn();
    fetchLicenseStatus.mockResolvedValue(TRIAL(3));

    licenseStore.start({ onTransition });
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
    expect(onTransition).toHaveBeenCalledTimes(1);
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

/**
 * A failed poll must be VISIBLE and must change nothing else (#1789). Before
 * this the catch was a bare comment, so a first-poll failure left `status`
 * null and Settings → License asserted "Not enforced in this version" from a
 * fetch that never answered.
 */
describe("licenseStore — statusUnavailable (#1789)", () => {
  let warn: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchLicenseStatus.mockReset();
    licenseStore.stop();
    warn = vi.fn();
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => warn(...args));
  });

  afterEach(() => {
    licenseStore.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("a failed poll sets the flag and leaves status and ui at their last values", async () => {
    fetchLicenseStatus.mockResolvedValueOnce(TRIAL(5));
    licenseStore.start();
    await flush();
    expect(licenseStore.statusUnavailable).toBe(false);

    fetchLicenseStatus.mockRejectedValue(new Error("ECONNREFUSED"));
    await licenseStore.refresh();
    await flush();

    expect(licenseStore.statusUnavailable).toBe(true);
    // The `ui`-unchanged half is a real guard only because `deriveLicenseUi`
    // must NOT take `statusUnavailable` — `ui` stays a pure function of
    // `status`, so a transient loopback failure structurally cannot raise the
    // wall or flip editability. A later widening breaks these two lines.
    expect(licenseStore.status).toEqual(TRIAL(5));
    expect(licenseStore.ui.showTrialBanner).toBe(true);
    expect(licenseStore.ui.editable).toBe(true);
  });

  it("two consecutive failures warn exactly once", async () => {
    fetchLicenseStatus.mockRejectedValue(new Error("down"));
    licenseStore.start();
    await flush();
    await licenseStore.refresh();
    await flush();

    expect(licenseStore.statusUnavailable).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("[license]"))).toHaveLength(1);
  });

  /**
   * Review round 1. The once-per-transition warn recorded THAT the poll failed
   * and not WHY. The on-screen copy asserts Tandem "couldn't reach its local
   * server" — true of an ECONNREFUSED, false of a 500 from
   * `/api/license/status`, a 401 after token rotation, or a JSON parse failure
   * on a truncated body, all of which mean the server answered. Without the
   * cause in the line those four are indistinguishable in a bug report.
   */
  it("the warn names the cause, not just the failure", async () => {
    fetchLicenseStatus.mockRejectedValue(new Error("HTTP 401"));
    licenseStore.start();
    await flush();

    const line = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(line).toContain("[license]");
    expect(line).toContain("HTTP 401");
  });

  it("a later success clears it", async () => {
    fetchLicenseStatus.mockRejectedValueOnce(new Error("down"));
    licenseStore.start();
    await flush();
    expect(licenseStore.statusUnavailable).toBe(true);

    fetchLicenseStatus.mockResolvedValue(TRIAL(3));
    await licenseStore.refresh();
    await flush();
    expect(licenseStore.statusUnavailable).toBe(false);
  });

  it("set() clears it — an activate response is a successful observation", async () => {
    fetchLicenseStatus.mockRejectedValue(new Error("down"));
    licenseStore.start();
    await flush();
    expect(licenseStore.statusUnavailable).toBe(true);

    licenseStore.set(LICENSED);
    expect(licenseStore.statusUnavailable).toBe(false);
  });

  /**
   * Review round 2. The try used to span `reconcileTransition`, whose
   * `onTransition` is `yjsSync.rebuildForLicenseChange()` — `teardownAllTabs()`
   * + `startBootstrap()`, real Y.js/provider work. A throw there landed in this
   * catch and Settings → License then said Tandem "couldn't reach its local
   * server", about a status it had just fetched successfully. The console line
   * misdiagnosed it the same way, defeating the round-1 reason for binding the
   * error at all.
   */
  it("a throwing onTransition is not reported as an unreachable server", async () => {
    const onTransition = vi.fn(() => {
      throw new Error("provider rebuild failed");
    });
    fetchLicenseStatus.mockResolvedValueOnce(TRIAL(5));
    licenseStore.start({ onTransition });
    await flush(); // baseline: no edge from the null baseline
    expect(licenseStore.statusUnavailable).toBe(false);

    fetchLicenseStatus.mockResolvedValue(RESTRICTED);
    // The client-side defect stays visible as a rejection rather than being
    // relabelled an outage.
    await expect(licenseStore.refresh()).rejects.toThrow("provider rebuild failed");
    expect(onTransition).toHaveBeenCalledTimes(1);

    // The fetch SUCCEEDED, so the fresh status is stored and nothing on screen
    // may claim the local server is unreachable.
    expect(licenseStore.status).toEqual(RESTRICTED);
    expect(licenseStore.statusUnavailable).toBe(false);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("[license]"))).toHaveLength(0);
  });

  it("stop() resets it with the rest of the baseline", async () => {
    fetchLicenseStatus.mockRejectedValue(new Error("down"));
    licenseStore.start();
    await flush();
    expect(licenseStore.statusUnavailable).toBe(true);

    licenseStore.stop();
    expect(licenseStore.statusUnavailable).toBe(false);
  });
});
// The `status === null` row is deliberately NOT here: `stop()` never clears
// `status` and `set()` always assigns a non-null one, so within this file the
// singleton has held a status since the first describe's `beforeEach`. That row
// needs a fresh module instance and lives in `settings-license-tab.test.ts`.
