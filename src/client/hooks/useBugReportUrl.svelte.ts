import { TANDEM_ISSUES_NEW_URL } from "../../shared/constants";
import { readClientLog } from "../utils/client-log";
import { buildBugReportUrl, formatDiagnostics, summarizeUserAgent } from "../utils/diagnostics";
import { fetchDiagnostics } from "../utils/diagnostics-fetch";

/**
 * How long pointer or focus must rest on the link before the collector runs.
 *
 * `/api/diagnostics` is not an inert read: `runDoctor`'s SSE check opens a real
 * connection to `/api/events`, which registers and immediately drops an
 * `"external"` subscriber — the same count `takeWakeAdvisory` and the Solo
 * forwarding gate read. A pointer merely crossing the sidebar on its way
 * somewhere else should not do that, and should not spawn `npm ls -g` either.
 *
 * Keyboard focus is gated the same way, and for the same reason: this link is
 * the last focusable element in the sidebar, with the content pane next in DOM
 * order inside the modal's focus trap, so *every* keyboard user tabbing from
 * the sidebar into the content passes focus through it. Focus in transit is no
 * more a statement of intent than a pointer in transit.
 */
const INTENT_DWELL_MS = 150;

/**
 * How long to wait before a failed prefetch may be retried.
 *
 * The latch is released on failure so a later hover can try again — but without
 * a cooldown, moving the pointer in and out of the link while the endpoint is
 * failing spawns one full collector run per entry, each with its own `npm ls -g`
 * subprocess and `/api/events` subscriber registration.
 */
const RETRY_COOLDOWN_MS = 10_000;

export interface BugReportUrlState {
  /** Always a usable issue URL — bare until the prefetch lands. */
  readonly url: string;
  /** Arm the prefetch after a short dwell. Idempotent. */
  primeOnDwell(): void;
  /** Cancel a dwell that has not fired yet (pointer or focus left in transit). */
  cancelDwell(): void;
}

/**
 * Backing state for the Settings sidebar's "Report a bug" link.
 *
 * The element stays an `<a>` and its `href` is upgraded in place: it starts as
 * the bare issue URL and is replaced once diagnostics arrive. The click path
 * therefore never awaits anything, which is the point — a button that had to
 * `await` a fetch before `window.open` would lose user activation and get
 * popup-blocked in the browser build. Failure needs no branch either: the
 * fallback IS the initial value.
 *
 * Priming is wired to a pointer/focus dwell rather than to the modal opening.
 * `/api/diagnostics` runs the full `tandem doctor` collector — an `npm ls -g`
 * subprocess with a 4s timeout, port probes, a directory scan — which
 * `doctor.ts` notes runs "inside the synchronous Copy-Diagnostics path", i.e.
 * only on an explicit click. Paying that on every Settings open, for the large
 * majority of opens that never touch this link, would be an unforced
 * regression. A dwell precedes the click by enough to win the race on a warm
 * path. Touch taps do fire `pointerenter`, but the dwell resolves after the
 * navigation has already used the bare URL, so touch effectively keeps it.
 *
 * Takes `getOpen` so the hook owns its own teardown, matching `createAppInfo`
 * and the rest of this directory — priming is the caller's business, forgetting
 * to reset should not be.
 */
export function createBugReportUrl(getOpen: () => boolean): BugReportUrlState {
  let url = $state(TANDEM_ISSUES_NEW_URL);
  let primed = false;
  // Bumped on close so a report still in flight cannot land afterwards.
  let generation = 0;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAllowedAt = 0;

  function cancelDwell(): void {
    if (dwellTimer === null) return;
    clearTimeout(dwellTimer);
    dwellTimer = null;
  }

  $effect(() => {
    if (getOpen()) return;
    // Diagnostics captured during an earlier session of the modal would be
    // stale by the next open, and stale readings in a bug report are worse
    // than none.
    cancelDwell();
    generation++;
    primed = false;
    url = TANDEM_ISSUES_NEW_URL;
  });

  // Unmount teardown, separate from the close-transition effect above: that one
  // returns early while the modal is open, so a dwell armed during an open
  // session would outlive a destroy that never passes through `open === false`.
  $effect(() => cancelDwell);

  function unlatchAfterFailure(): void {
    // Released so a later dwell can retry, but not instantly — see
    // RETRY_COOLDOWN_MS.
    primed = false;
    retryAllowedAt = Date.now() + RETRY_COOLDOWN_MS;
  }

  function prime(): void {
    cancelDwell();
    if (primed || Date.now() < retryAllowedAt) return;
    primed = true;
    const token = generation;

    // No timeout and no abort: the request is shared (see `diagnostics-fetch`),
    // so cancelling it could kill a Copy-Diagnostics click's fetch. A late
    // result is harmless — the link works throughout, and `token` is what stops
    // a stale one from being applied.
    void fetchDiagnostics()
      .then((result) => {
        if (token !== generation) return;
        if (!result.ok) {
          // The fetch layer deliberately does not cache failures; latching here
          // permanently would undo that and leave the prefill dead for the rest
          // of the session after one blip.
          unlatchAfterFailure();
          return;
        }
        url = buildBugReportUrl(
          formatDiagnostics(result.payload, {
            browser: summarizeUserAgent(navigator.userAgent),
            // Client-side warnings the server cannot see (#1439). The section is
            // rendered above the check list and budgeted, because this URL is
            // the surface that truncates.
            clientLog: readClientLog(),
          }),
        );
      })
      .catch((err: unknown) => {
        if (token === generation) unlatchAfterFailure();
        // No toast: the user asked for an issue form, not a diagnostic report.
        // A banner on every hover of an offline app would be pure noise.
        console.warn("[useBugReportUrl] diagnostics prefetch failed:", err);
      });
  }

  function primeOnDwell(): void {
    if (primed || dwellTimer !== null) return;
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      prime();
    }, INTENT_DWELL_MS);
  }

  return {
    get url() {
      return url;
    },
    primeOnDwell,
    cancelDwell,
  };
}
