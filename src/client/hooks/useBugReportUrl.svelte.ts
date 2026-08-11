import { TANDEM_ISSUES_NEW_URL } from "../../shared/constants";
import { buildBugReportUrl, formatDiagnostics, summarizeUserAgent } from "../utils/diagnostics";
import { fetchDiagnostics } from "../utils/diagnostics-fetch";

/** `runDoctor` does port probes and HTTP self-probes; 3s (useAppInfo's budget) is too tight. */
const PREFETCH_TIMEOUT_MS = 8000;

export interface BugReportUrlState {
  /** Always a usable issue URL — bare until the prefetch lands. */
  readonly url: string;
  /** Start the prefetch. Idempotent; safe to call on every hover/focus. */
  prime(): void;
  /** Abort, and drop any captured diagnostics. */
  reset(): void;
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
 */
export function createBugReportUrl(): BugReportUrlState {
  let url = $state(TANDEM_ISSUES_NEW_URL);
  let primed = false;
  let controller: AbortController | null = null;

  function prime(): void {
    if (primed) return;
    primed = true;

    const ctrl = new AbortController();
    controller = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), PREFETCH_TIMEOUT_MS);

    fetchDiagnostics(ctrl.signal)
      .then((result) => {
        if (ctrl.signal.aborted || !result.ok) return;
        url = buildBugReportUrl(
          formatDiagnostics(result.payload, {
            browser: summarizeUserAgent(navigator.userAgent),
          }),
        );
      })
      .catch((err: unknown) => {
        // No toast: the user asked for an issue form, not a diagnostic report.
        // A banner on every hover of an offline app would be pure noise.
        console.warn("[useBugReportUrl] diagnostics prefetch failed:", err);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (controller === ctrl) controller = null;
      });
  }

  function reset(): void {
    controller?.abort();
    controller = null;
    primed = false;
    // Diagnostics captured during an earlier session of the modal would be
    // stale by the next open, and stale readings in a bug report are worse
    // than none.
    url = TANDEM_ISSUES_NEW_URL;
  }

  return {
    get url() {
      return url;
    },
    prime,
    reset,
  };
}
