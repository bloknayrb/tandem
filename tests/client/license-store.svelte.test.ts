// @vitest-environment happy-dom

/**
 * Lifecycle coverage for the `licenseStore` singleton (#1116, ADR-040).
 *
 * The pure status→UI mapping lives in `license-ui.test.ts`; this file exercises
 * the polling cadence and the start/stop composition:
 *   - a dark build (gateActive:false) polls exactly once, then self-stops
 *   - restricted polls every 8 s, so a CLI `tandem activate` is noticed fast;
 *     trial and licensed poll every 60 s, and both `poll()` and `set()` re-arm
 *   - `stop()` then `start()` re-arms the interval (review #2)
 *
 * `fetchLicenseStatus` is the only I/O the store performs, so it's mocked; fake
 * timers drive the poll interval deterministically. The store is a module
 * singleton, so each test resets it via `stop()` (clears timer + `started`) plus
 * `set()` (baselines `status` to a non-restricted value).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseStatusResponse } from "../../src/client/utils/license-ui";

const fetchLicenseStatus = vi.fn<(signal?: AbortSignal) => Promise<LicenseStatusResponse>>();
vi.mock(import("../../src/client/hooks/useLicense"), () => ({
  fetchLicenseStatus: (signal?: AbortSignal) => fetchLicenseStatus(signal),
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
  license: { email: "beta@example.com", type: "grandfathered" },
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
    // Reset the singleton: stop() clears the timer + `started`; set(DARK)
    // baselines `status` to a non-restricted value so cadence tests start clean.
    licenseStore.stop();
    licenseStore.set(DARK);
  });

  afterEach(() => {
    licenseStore.stop();
    vi.useRealTimers();
  });

  it("dark build polls once then self-stops; no AI notice", async () => {
    fetchLicenseStatus.mockResolvedValue(DARK);
    licenseStore.start();
    await flush();

    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);
    expect(licenseStore.ui.aiNotice).toBeNull();
    expect(licenseStore.ui.showTrialBanner).toBe(false);

    // Well past the interval — no further polls (the dark path stopped the timer).
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);
  });

  // Readiness holds the pill on "booting" while a licence re-read is in
  // flight; an unanswered read must therefore end, as a failure.
  it("bounds every read: a status request that never answers aborts and is a failure", async () => {
    // `AbortSignal.timeout` runs on the platform's own clock, not vitest's
    // fake timers, so the test owns the signal and fires it itself.
    const ctrl = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(ctrl.signal);
    try {
      fetchLicenseStatus.mockImplementation(
        (signal) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      );
      const settled = vi.fn();
      void licenseStore.refresh().then(settled);
      await flush();
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(fetchLicenseStatus).toHaveBeenCalledWith(ctrl.signal);
      expect(settled).not.toHaveBeenCalled();

      ctrl.abort();
      await flush();
      expect(settled).toHaveBeenCalledTimes(1);
      expect(licenseStore.statusUnavailable).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("trial state surfaces the banner with the day count", async () => {
    fetchLicenseStatus.mockResolvedValue(TRIAL(5));
    licenseStore.start();
    await flush();

    expect(licenseStore.ui.showTrialBanner).toBe(true);
    expect(licenseStore.ui.trialDaysRemaining).toBe(5);
    expect(licenseStore.ui.aiNotice).toBeNull();
  });

  it("restricted surfaces the AI notice and polls every 8 s", async () => {
    fetchLicenseStatus.mockResolvedValue(RESTRICTED);
    licenseStore.start();
    await flush();
    expect(licenseStore.ui.aiNotice).toBe("unlicensed");
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(3);
  });

  it("trial and licensed poll every 60 s, not 8 s", async () => {
    for (const state of [TRIAL(4), LICENSED]) {
      licenseStore.stop();
      licenseStore.set(state);
      fetchLicenseStatus.mockReset();
      fetchLicenseStatus.mockResolvedValue(state);
      licenseStore.start();
      await flush();
      expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(59_000);
      expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchLicenseStatus).toHaveBeenCalledTimes(2);
    }
  });

  it("a restricted→licensed poll re-arms the interval at 60 s", async () => {
    fetchLicenseStatus.mockResolvedValue(RESTRICTED);
    licenseStore.start();
    await flush();

    fetchLicenseStatus.mockResolvedValue(LICENSED);
    await vi.advanceTimersByTimeAsync(8_000); // the 8 s poll that sees licensed
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(2);
    expect(licenseStore.ui.aiNotice).toBeNull();

    await vi.advanceTimersByTimeAsync(52_000); // past every further 8 s tick
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000); // 60 s after the re-arm
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(3);
  });

  it("restricted then set(licensed) — the activate-form path — re-arms at 60 s", async () => {
    fetchLicenseStatus.mockResolvedValue(RESTRICTED);
    licenseStore.start();
    await flush();
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);

    fetchLicenseStatus.mockResolvedValue(LICENSED);
    licenseStore.set(LICENSED);
    expect(licenseStore.ui.aiNotice).toBeNull();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1); // no 8 s fetches
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(2);
  });

  it("a dark build still stops after one poll even when it was restricted before", async () => {
    licenseStore.set(RESTRICTED);
    fetchLicenseStatus.mockResolvedValue(DARK);
    licenseStore.start();
    await flush();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);
  });

  it("a redundant start() does not double-poll", async () => {
    fetchLicenseStatus.mockResolvedValue(TRIAL(3));
    licenseStore.start();
    await flush();
    licenseStore.start();
    await flush();
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);
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
/**
 * A hidden tab skips its ticks, so a backgrounded window does not poll the
 * licence every 8 s forever, and polls once on becoming visible. `hidden` is
 * redefined on the instance, which works whatever happy-dom's own definition
 * is; the afterEach removes the override.
 */
describe("licenseStore — hidden tabs", () => {
  let hidden = false;
  const fire = () => document.dispatchEvent(new Event("visibilitychange"));

  beforeEach(() => {
    vi.useFakeTimers();
    fetchLicenseStatus.mockReset();
    licenseStore.stop();
    licenseStore.set(DARK);
    hidden = false;
    Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
  });

  afterEach(() => {
    licenseStore.stop();
    vi.useRealTimers();
    delete (document as unknown as { hidden?: boolean }).hidden;
  });

  it("skips restricted ticks while hidden and polls once on becoming visible", async () => {
    fetchLicenseStatus.mockResolvedValue(RESTRICTED);
    licenseStore.start();
    await flush();
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);

    hidden = true;
    fire();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);

    hidden = false;
    fire();
    await flush();
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(2);

    // Visible again: the 8 s cadence resumes.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(3);
  });

  it("a visibilitychange after stop() polls nothing", async () => {
    fetchLicenseStatus.mockResolvedValue(RESTRICTED);
    licenseStore.start();
    await flush();
    licenseStore.stop();
    fire();
    await flush();
    expect(fetchLicenseStatus).toHaveBeenCalledTimes(1);
  });
});

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
    // AI-off notice. A later widening breaks these two lines.
    expect(licenseStore.status).toEqual(TRIAL(5));
    expect(licenseStore.ui.showTrialBanner).toBe(true);
    expect(licenseStore.ui.aiNotice).toBeNull();
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

  it("stop() resets it with the rest of the baseline", async () => {
    fetchLicenseStatus.mockRejectedValue(new Error("down"));
    licenseStore.start();
    await flush();
    expect(licenseStore.statusUnavailable).toBe(true);

    licenseStore.stop();
    expect(licenseStore.statusUnavailable).toBe(false);
  });
});
/**
 * A poll issued before `set()` must not land after it. With the 8 s restricted
 * cadence a poll is often in flight when the activate form answers, and without
 * sequencing its stale `restricted` would overwrite the licensed status.
 */
describe("licenseStore — a poll superseded by set()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchLicenseStatus.mockReset();
    licenseStore.stop();
    licenseStore.set(DARK);
  });

  afterEach(() => {
    licenseStore.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("an in-flight restricted poll resolving after set(licensed) leaves licensed", async () => {
    fetchLicenseStatus.mockResolvedValueOnce(RESTRICTED);
    licenseStore.start();
    await flush();
    expect(licenseStore.ui.aiOff).toBe(true);

    const slow = deferred<LicenseStatusResponse>();
    fetchLicenseStatus.mockReturnValueOnce(slow.promise);
    const inFlight = licenseStore.refresh();
    licenseStore.set(LICENSED);
    slow.resolve(RESTRICTED);
    await inFlight;
    await flush();

    expect(licenseStore.status).toEqual(LICENSED);
    expect(licenseStore.ui.aiOff).toBe(false);
  });

  it("an in-flight poll failing after set(licensed) raises no 'unavailable' flag", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchLicenseStatus.mockResolvedValueOnce(RESTRICTED);
    licenseStore.start();
    await flush();

    const slow = deferred<LicenseStatusResponse>();
    fetchLicenseStatus.mockReturnValueOnce(slow.promise);
    const inFlight = licenseStore.refresh();
    licenseStore.set(LICENSED);
    slow.reject(new Error("ECONNREFUSED"));
    await inFlight;
    await flush();

    expect(licenseStore.statusUnavailable).toBe(false);
    expect(licenseStore.status).toEqual(LICENSED);
  });

  it("the twin: a poll with nothing newer still writes its answer", async () => {
    fetchLicenseStatus.mockResolvedValueOnce(LICENSED);
    licenseStore.start();
    await flush();

    const slow = deferred<LicenseStatusResponse>();
    fetchLicenseStatus.mockReturnValueOnce(slow.promise);
    const inFlight = licenseStore.refresh();
    slow.resolve(RESTRICTED);
    await inFlight;
    await flush();

    expect(licenseStore.status).toEqual(RESTRICTED);
  });
});

// The `status === null` row is deliberately NOT here: `stop()` never clears
// `status` and `set()` always assigns a non-null one, so within this file the
// singleton has held a status since the first describe's `beforeEach`. That row
// needs a fresh module instance and lives in `settings-license-tab.test.ts`.

/**
 * #1521: the Surface-A provider rebuild is retired. A keyless install refuses
 * the AI, never the editor, so nothing re-authenticates on a licence change.
 * App is never mounted in tests, so these pin the source.
 */
describe("the licence-change provider rebuild is gone (#1521)", () => {
  it("yjsSync has no rebuildForLicenseChange and App starts the store with no argument", async () => {
    const { readFileSync } = await import("node:fs");
    const yjs = readFileSync("src/client/hooks/yjsSync.svelte.ts", "utf-8");
    const app = readFileSync("src/client/App.svelte", "utf-8");
    expect(yjs).not.toContain("rebuildForLicenseChange");
    expect(app).toContain("licenseStore.start();");
    expect(app).not.toMatch(/licenseStore\.start\(\s*[^)\s]/);
  });
});
