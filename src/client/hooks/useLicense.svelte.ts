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
 * permissive (no banner, no wall, editor editable).
 *
 * On any restricted↔unrestricted transition it fires `onTransition` so the app
 * can force a provider rebuild (`yjsSync.rebuildForLicenseChange`). That re-runs
 * the server's `onAuthenticate` gate (Surface A): clamping document rooms to
 * read-only on trial→restricted and releasing them on restricted→licensed. A
 * bare `provider.connect()` is NOT enough — in @hocuspocus/provider 3.x it
 * early-returns on a live socket, so the gate would never re-evaluate. The
 * callback deliberately does NOT fire on the FIRST poll: at boot the providers
 * already authenticated against the current license state, so a cold start in
 * restricted mode needs no rebuild.
 */

const POLL_INTERVAL_MS = 60_000;

function createLicenseStore() {
  let status = $state<LicenseStatusResponse | null>(null);
  // The last poll failed and this is a stale/absent view (#1789). Surfaced so
  // Settings → License can say so instead of asserting a state it no longer has
  // evidence for.
  //
  // Deliberately NOT an input to `deriveLicenseUi` below: `ui` stays a pure
  // function of `status`, so a transient loopback failure structurally cannot
  // raise the restricted wall or flip editability.
  let statusUnavailable = $state(false);
  // One derived `ui` shared by all consumers (banner, wall, tab, editor) so
  // `deriveLicenseUi` runs once per status change, not once per consumer per cycle.
  const ui = $derived(deriveLicenseUi(status));
  let started = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let onTransition: (() => void) | null = null;
  // null = no baseline yet (don't fire on the first observation); boolean = the
  // last observed restricted-ness, used to detect edges in either direction.
  let wasRestricted: boolean | null = null;

  function isRestricted(s: LicenseStatusResponse): boolean {
    return s.gateActive && s.status === "restricted";
  }

  /** Update the baseline and fire `onTransition` only on a genuine edge. */
  function reconcileTransition(nowRestricted: boolean): void {
    if (wasRestricted !== null && nowRestricted !== wasRestricted) onTransition?.();
    wasRestricted = nowRestricted;
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Clear `started` so a later start() (App.svelte remount under HMR/tests,
    // or the dark-build self-stop below followed by a fresh mount) can re-arm
    // the interval. Drop the callback + baseline too; the next start()/poll
    // re-establishes them, and this keeps a stale callback from firing during a
    // beforeEach reset. Without resetting `started` the singleton would stay
    // permanently quiet after the first stop, since start() early-returns on it.
    started = false;
    onTransition = null;
    wasRestricted = null;
    statusUnavailable = false;
  }

  async function poll(): Promise<void> {
    try {
      const next = await fetchLicenseStatus();
      status = next;
      statusUnavailable = false;
      reconcileTransition(isRestricted(next));
      // The build flag never flips at runtime — a dark build polls once, then rests.
      if (!next.gateActive) stop();
    } catch {
      // Server unavailable / transient — keep last-known `status`, retry next
      // tick. What must NOT happen is the silent version: before #1789 this
      // catch was a bare comment, so a first-poll failure left `status === null`
      // and Settings → License then read "Not enforced in this version" — an
      // assertion about the gate made with no evidence at all.
      //
      // Warn on the TRANSITION into failure only. The timer fires forever, so a
      // per-tick warn is a console flood on any sustained outage.
      if (!statusUnavailable) {
        console.warn("[license] status poll failed — showing last known state, if any");
      }
      statusUnavailable = true;
    }
  }

  return {
    get status(): LicenseStatusResponse | null {
      return status;
    },
    /** True when the last poll failed, so `status` is stale or has never been
     *  observed. A getter, not a plain property: this object is built once, so
     *  a snapshot would freeze at its initial value. */
    get statusUnavailable(): boolean {
      return statusUnavailable;
    },
    get ui(): LicenseUi {
      return ui;
    },
    /** Begin polling. Idempotent; wires the transition callback once per cycle. */
    start(deps?: { onTransition?: () => void }): void {
      // Guard BEFORE wiring the callback so a redundant start() (no deps) can't
      // null out a live `onTransition` while the timer keeps running. First
      // start per lifecycle wins; a stop() resets `started`, so a clean
      // stop→start cycle re-establishes the callback from the new deps.
      if (started) return;
      started = true;
      onTransition = deps?.onTransition ?? null;
      void poll();
      timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    },
    stop,
    /** Re-poll now (e.g. after the Settings tab activates a license). */
    refresh(): Promise<void> {
      return poll();
    },
    /** Apply a freshly-activated state immediately (from the activate response).
     *  Fires `onTransition` on an edge so a restricted→licensed activation
     *  triggers the same provider rebuild the poll path would. */
    set(next: LicenseStatusResponse): void {
      status = next;
      // A successful observation by definition — this is the activate response.
      // Without the clear, a just-activated license renders beside a stale
      // "couldn't reach the server" warning.
      statusUnavailable = false;
      reconcileTransition(isRestricted(next));
    },
  };
}

export const licenseStore = createLicenseStore();
