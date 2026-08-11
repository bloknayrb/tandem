/**
 * Shared `GET /api/diagnostics` fetch for the two consumers that need it: the
 * About tab's "Copy Diagnostics" button and the Report-a-bug link's prefill.
 *
 * Kept separate from `diagnostics.ts` deliberately — that module is pure and
 * imported by a node-env vitest file; this one touches `fetch`.
 */

import { API_DIAGNOSTICS } from "../../shared/api-paths";
import type { DiagnosticsPayload } from "./diagnostics";
import { API_BASE } from "./fileUpload";

/**
 * `reason` mirrors the two distinct messages the About tab has always shown.
 * "unreachable" means the request never landed, so "is the server running?" is
 * the right prompt; "server" means it landed and failed, where that prompt
 * would misdirect.
 */
export type DiagnosticsFetchResult =
  | { ok: true; payload: DiagnosticsPayload }
  | { ok: false; reason: "unreachable" | "server" };

/**
 * How long a successful report may be reused.
 *
 * Without this, the ordinary sequence — hover the Report-a-bug link (primes,
 * settles), then click Copy Diagnostics a few seconds later — runs the whole
 * collector twice, where before the prefetch existed it ran once. In-flight
 * sharing alone does not help, because those two requests do not overlap. The
 * staleness is not a real cost: the hook already serves the user a prefetched
 * report of exactly this age when they click through to the issue form.
 */
const CACHE_TTL_MS = 15_000;

/**
 * Deliberately NO AbortSignal parameter.
 *
 * An earlier version took one, and because the promise is shared, whichever
 * caller *started* the request owned its lifetime: the hover prefetch would
 * start it, a Copy-Diagnostics click would join it, and then the prefetch's
 * timeout — or the modal closing — aborted the fetch the click was still
 * awaiting. `run()` maps AbortError to "unreachable", so the user saw
 * "Couldn't reach the server — is it running?" for a perfectly healthy server,
 * and a nearly-complete collector run was thrown away.
 *
 * A caller that wants to stop *waiting* can ignore a late result; nobody gets
 * to cancel work another caller is depending on.
 */
/** The single run currently in progress, with when its probes began. */
let inFlight: { promise: Promise<DiagnosticsFetchResult>; startedAt: number } | null = null;
let cached: { at: number; result: DiagnosticsFetchResult } | null = null;

async function run(): Promise<DiagnosticsFetchResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${API_DIAGNOSTICS}`);
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!res.ok) return { ok: false, reason: "server" };
  try {
    return { ok: true, payload: (await res.json()) as DiagnosticsPayload };
  } catch {
    return { ok: false, reason: "server" };
  }
}

/** Start a run now and register it as the in-flight one. */
function startRun(): Promise<DiagnosticsFetchResult> {
  const entry = {
    startedAt: Date.now(),
    promise: run()
      .then((result) => {
        // Only successes are cached. Pinning a transient failure for the TTL
        // would make a retry look broken.
        if (result.ok) cached = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        if (inFlight === entry) inFlight = null;
      }),
  };
  inFlight = entry;
  return entry.promise;
}

/**
 * Fetch diagnostics, reusing a recent success or joining a request already in
 * flight. The route runs the full `tandem doctor` collector — an `npm ls -g`
 * subprocess, port probes, a directory scan — so duplicate runs are the thing
 * worth avoiding here. (The server single-flights *overlapping* requests too;
 * this layer additionally covers sequential ones and saves the round-trip.)
 *
 * `maxAgeMs: 0` opts out of reuse entirely. The Copy Diagnostics button uses
 * it: that click is an explicit "tell me the state now", and a user who fixes a
 * reported problem and clicks again must not be handed the pre-fix report.
 *
 * Note that opting out has to reject a stale *in-flight* run as well as a stale
 * cache entry. A hover starts a run at t=0; the user fixes the problem at
 * t=0.5s and clicks at t=1s. Joining the running one would hand them probes
 * that predate the fix — the very thing being ruled out. When the running one
 * is too old for the caller, a fresh run is chained behind it rather than
 * started alongside it, so two collectors never compete.
 */
export function fetchDiagnostics(
  opts: { maxAgeMs?: number } = {},
): Promise<DiagnosticsFetchResult> {
  const maxAge = opts.maxAgeMs ?? CACHE_TTL_MS;
  const now = Date.now();

  if (cached && now - cached.at < maxAge) return Promise.resolve(cached.result);
  if (inFlight && now - inFlight.startedAt <= maxAge) return inFlight.promise;
  if (inFlight) return inFlight.promise.then(() => fetchDiagnostics(opts));
  return startRun();
}

/** Test seam — drops the cached report and any shared in-flight promise. */
export function _resetDiagnosticsCache(): void {
  inFlight = null;
  cached = null;
}
