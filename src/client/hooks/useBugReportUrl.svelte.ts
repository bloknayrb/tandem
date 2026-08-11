import { TANDEM_ISSUES_NEW_URL } from "../../shared/constants";
import { buildBugReportUrl, formatDiagnostics, summarizeUserAgent } from "../utils/diagnostics";
import { fetchDiagnostics } from "../utils/diagnostics-fetch";

/**
 * How long the pointer must rest on the link before the collector runs.
 *
 * `/api/diagnostics` is not an inert read: `runDoctor`'s SSE check opens a real
 * connection to `/api/events`, which registers and immediately drops an
 * `"external"` subscriber — the same count `takeWakeAdvisory` and the Solo
 * forwarding gate read. A mouse merely crossing the sidebar on its way
 * somewhere else should not do that, and should not spawn `npm ls -g` either.
 * Resting on the link is intent; passing over it is not. Keyboard focus skips
 * the delay — tabbing to a link is already unambiguous.
 */
const POINTER_INTENT_MS = 150;

export interface BugReportUrlState {
  /** Always a usable issue URL — bare until the prefetch lands. */
  readonly url: string;
  /** Start the prefetch now. Idempotent. For unambiguous intent (focus). */
  prime(): void;
  /** Arm the prefetch after a short dwell. Idempotent. */
  primeOnDwell(): void;
  /** Cancel a dwell that has not fired yet (pointer left before it elapsed). */
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
 * `prime()` is wired to hover/focus rather than to the modal opening.
 * `/api/diagnostics` runs the full `tandem doctor` collector — an `npm ls -g`
 * subprocess with a 4s timeout, port probes, a directory scan — which
 * `doctor.ts` notes runs "inside the synchronous Copy-Diagnostics path", i.e.
 * only on an explicit click. Paying that on every Settings open, for the large
 * majority of opens that never touch this link, would be an unforced
 * regression. Hover and focus both precede the click by enough to win the race
 * on a warm path; touch-only interaction fires neither and keeps the bare URL.
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

  function prime(): void {
    cancelDwell();
    if (primed) return;
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
          // Unlatch so a later hover can retry. The fetch layer deliberately
          // does not cache failures; latching here would undo that and leave
          // the prefill dead for the rest of the session after one blip.
          primed = false;
          return;
        }
        url = buildBugReportUrl(
          formatDiagnostics(result.payload, {
            browser: summarizeUserAgent(navigator.userAgent),
          }),
        );
      })
      .catch((err: unknown) => {
        if (token === generation) primed = false;
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
    }, POINTER_INTENT_MS);
  }

  return {
    get url() {
      return url;
    },
    prime,
    primeOnDwell,
    cancelDwell,
  };
}
