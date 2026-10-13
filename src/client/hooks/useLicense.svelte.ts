import { deriveLicenseUi, type LicenseStatusResponse, type LicenseUi } from "../utils/license-ui";
import { fetchLicenseStatus } from "./useLicense";

/**
 * App-global license state (#1116, ADR-040, #1521). A module-level SINGLETON (per
 * the Svelte 5 app-global-state rule, #737) so the trial banner, the AI-off
 * notice, the AI controls and the Settings → License tab all read one source of
 * truth.
 *
 * Polls `GET /api/license/status`. When the gate is dark (the default until
 * v1.0) the first poll returns `gateActive: false` and polling stops — so a
 * dark build does one cheap fetch and then goes quiet, with `ui.aiNotice` null.
 *
 * A keyless install refuses the AI, never the editor (#1521, D3), so a licence
 * transition needs no provider rebuild: nothing about the document connection
 * depends on it. The cadence does change with the state — every 8 s while the
 * AI is refused, so a `tandem activate` from the CLI brings the AI back within
 * seconds rather than a minute, and every 60 s otherwise. Ticks are skipped
 * while the tab is hidden, and one poll runs when it becomes visible again, so a
 * background tab does not poll the licence forever.
 *
 * The client's AI-off state is advisory and fails OPEN: while `status` is null
 * (the first poll still in flight, or every poll failing) `ui.aiNotice` is null
 * and the AI controls stay enabled. The server's `aiRefusal()` gates MCP and
 * `/api` and is the authority; these surfaces only explain its refusal early.
 */

const POLL_INTERVAL_MS = 60_000;
/** While restricted: how quickly a CLI activation is noticed. */
const RESTRICTED_POLL_INTERVAL_MS = 8_000;
/** Under the restricted cadence, so a hung read never overlaps two ticks. */
const LICENSE_READ_TIMEOUT_MS = 5_000;

function createLicenseStore() {
  let status = $state<LicenseStatusResponse | null>(null);
  // The last poll failed and this is a stale/absent view (#1789). Surfaced so
  // Settings → License can say so instead of asserting a state it no longer has
  // evidence for.
  //
  // Deliberately NOT an input to `deriveLicenseUi` below: `ui` stays a pure
  // function of `status`, so a transient loopback failure structurally cannot
  // raise the AI-off notice.
  let statusUnavailable = $state(false);
  // One derived `ui` shared by all consumers so `deriveLicenseUi` runs once per
  // status change, not once per consumer per cycle.
  const ui = $derived(deriveLicenseUi(status));
  let started = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  // The period of the interval currently armed. Plain `let`, not `$state`:
  // nothing renders it.
  let armedPeriodMs: number | null = null;
  // Sequences polls against each other and against `set()`: only the most
  // recently issued observation may write. Without it a poll started before an
  // activation could resolve after `set(licensed)` and put the stale
  // `restricted` answer back. Plain `let`: nothing renders it.
  let pollSeq = 0;

  function desiredPeriodMs(): number {
    return status?.gateActive && status.status === "restricted"
      ? RESTRICTED_POLL_INTERVAL_MS
      : POLL_INTERVAL_MS;
  }

  function arm(periodMs: number): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!isHidden()) void poll();
    }, periodMs);
    armedPeriodMs = periodMs;
  }

  // `document` is guarded: this module is imported by code that can run with no
  // DOM, and a non-DOM context is never "hidden".
  function isHidden(): boolean {
    return typeof document !== "undefined" && document.hidden;
  }

  // Catch up at once when the tab comes back, rather than waiting out a period
  // whose ticks were all skipped.
  function onVisibilityChange(): void {
    if (started && !isHidden()) void poll();
  }

  /**
   * Re-arm the interval when the state calls for a different cadence. Called
   * after `status` is written in BOTH `poll()` and `set()`: the activate form
   * calls `set()`, so a poll-only re-arm would leave an activated user polling
   * every 8 s.
   */
  function rearmIfNeeded(): void {
    if (!started) return;
    const want = desiredPeriodMs();
    if (want !== armedPeriodMs) arm(want);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Clear `started` so a later start() (App.svelte remount under HMR/tests,
    // or the dark-build self-stop below followed by a fresh mount) can re-arm
    // the interval. Without resetting it the singleton would stay permanently
    // quiet after the first stop, since start() early-returns on it.
    started = false;
    armedPeriodMs = null;
    statusUnavailable = false;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  }

  async function poll(): Promise<void> {
    const mine = ++pollSeq;
    let next: LicenseStatusResponse;
    // The try wraps the FETCH ONLY. `statusUnavailable` drives copy that names
    // the local server as unreachable, so it must be bound to a fetch/parse
    // failure and nothing else.
    try {
      // Bounded: readiness holds the pill on "booting" while a licence re-read
      // is in flight, so a request that never answers must not hold it forever.
      next = await fetchLicenseStatus(AbortSignal.timeout(LICENSE_READ_TIMEOUT_MS));
    } catch (err) {
      // Superseded: a newer poll or `set()` owns the state, and a stale failure
      // must not paint "couldn't reach the server" beside it.
      if (mine !== pollSeq) return;
      // Server unavailable / transient — keep last-known `status`, retry next
      // tick. What must NOT happen is the silent version: before #1789 this
      // catch was a bare comment, so a first-poll failure left `status === null`
      // and Settings → License then read "Not enforced in this version" — an
      // assertion about the gate made with no evidence at all.
      //
      // Warn on the TRANSITION into failure only. The timer fires forever, so a
      // per-tick warn is a console flood on any sustained outage.
      //
      // The cause is part of the record (review round 1): the on-screen copy
      // asserts Tandem "couldn't reach its local server", which is true of an
      // ECONNREFUSED and false of a 500, a 401 after token rotation, or a parse
      // failure on a truncated body — all of which mean the server answered.
      // Without the bound error those four are indistinguishable in the console.
      if (!statusUnavailable) {
        console.warn(
          `[license] status poll failed — showing last known state, if any: ${String(err)}`,
        );
      }
      statusUnavailable = true;
      return;
    }
    if (mine !== pollSeq) return;
    status = next;
    statusUnavailable = false;
    // The build flag never flips at runtime — a dark build polls once, then rests.
    if (!next.gateActive) {
      stop();
      return;
    }
    rearmIfNeeded();
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
    /** Begin polling. Idempotent. */
    start(): void {
      if (started) return;
      started = true;
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange);
      }
      void poll();
      arm(desiredPeriodMs());
    },
    stop,
    /** Re-poll now (e.g. after the Settings tab activates a license). */
    refresh(): Promise<void> {
      return poll();
    },
    /** Apply a freshly-activated state immediately (from the activate response). */
    set(next: LicenseStatusResponse): void {
      // Supersede any poll in flight, so it cannot overwrite this answer.
      pollSeq++;
      status = next;
      // A successful observation by definition — this is the activate response.
      // Without the clear, a just-activated license renders beside a stale
      // "couldn't reach the server" warning.
      statusUnavailable = false;
      rearmIfNeeded();
    },
  };
}

export const licenseStore = createLicenseStore();
