import { deriveLicenseUi, type LicenseStatusResponse, type LicenseUi } from "../utils/license-ui";
import { fetchLicenseStatus } from "./useLicense";

/**
 * App-global license state (#1116, ADR-040). A module-level SINGLETON (per the
 * Svelte 5 app-global-state rule, #737) so the editor, the trial banner, the
 * restricted wall, and the Settings → License tab all read one source of truth.
 *
 * Polls `GET /api/license/status`. When the gate is dark (the default until
 * v1.0) the first poll returns `gateActive: false` and polling stops — so a
 * dark build does one cheap fetch and then goes quiet, with `ui` fully
 * permissive (no banner, no wall, editor editable). On the transition INTO
 * restricted it fires `onRestricted` so the app can force a provider reconnect
 * (the server re-applies `connection.readOnly` via `onAuthenticate`).
 */

const POLL_INTERVAL_MS = 60_000;

function createLicenseStore() {
  let status = $state<LicenseStatusResponse | null>(null);
  let started = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let onRestricted: (() => void) | null = null;
  let wasRestricted = false;

  function isRestricted(s: LicenseStatusResponse): boolean {
    return s.gateActive && s.status === "restricted";
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Clear `started` so a later start() (App.svelte remount under HMR/tests,
    // or the dark-build self-stop below followed by a fresh mount) can re-arm
    // the interval. Without this the singleton would stay permanently quiet
    // after the first stop, since start() early-returns on `started`.
    started = false;
  }

  async function poll(): Promise<void> {
    try {
      const next = await fetchLicenseStatus();
      status = next;
      const nowRestricted = isRestricted(next);
      if (nowRestricted && !wasRestricted) onRestricted?.();
      wasRestricted = nowRestricted;
      // The build flag never flips at runtime — a dark build polls once, then rests.
      if (!next.gateActive) stop();
    } catch {
      // Server unavailable / transient — keep last-known state, retry next tick.
    }
  }

  return {
    get status(): LicenseStatusResponse | null {
      return status;
    },
    get ui(): LicenseUi {
      return deriveLicenseUi(status);
    },
    /** Begin polling. Idempotent; wires the restricted-transition callback once. */
    start(deps?: { onRestricted?: () => void }): void {
      // Guard BEFORE wiring the callback so a redundant start() (no deps) can't
      // null out a live `onRestricted` while the timer keeps running. First
      // start per lifecycle wins; a stop() resets `started`, so a clean
      // stop→start cycle re-establishes the callback from the new deps.
      if (started) return;
      started = true;
      onRestricted = deps?.onRestricted ?? null;
      void poll();
      timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    },
    stop,
    /** Re-poll now (e.g. after the Settings tab activates a license). */
    refresh(): Promise<void> {
      return poll();
    },
    /** Apply a freshly-activated state immediately (from the activate response). */
    set(next: LicenseStatusResponse): void {
      status = next;
      wasRestricted = isRestricted(next);
    },
  };
}

export const licenseStore = createLicenseStore();
