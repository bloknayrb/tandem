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
let inFlight: Promise<DiagnosticsFetchResult> | null = null;
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

/**
 * Fetch diagnostics, reusing a recent success or joining a request already in
 * flight. The route runs the full `tandem doctor` collector — an `npm ls -g`
 * subprocess, port probes, a directory scan — so duplicate runs are the thing
 * worth avoiding here. (The server single-flights *overlapping* requests too;
 * this layer additionally covers sequential ones and saves the round-trip.)
 */
export function fetchDiagnostics(
  opts: { maxAgeMs?: number } = {},
): Promise<DiagnosticsFetchResult> {
  // `maxAgeMs: 0` opts out of the cache. The Copy Diagnostics button uses it:
  // that click is an explicit "tell me the state now", and a user who fixes a
  // reported problem and clicks again must not be handed the pre-fix report.
  // In-flight sharing still applies, so opting out costs a run only when there
  // isn't one already going.
  const maxAge = opts.maxAgeMs ?? CACHE_TTL_MS;
  if (cached && Date.now() - cached.at < maxAge) {
    return Promise.resolve(cached.result);
  }
  inFlight ??= run()
    .then((result) => {
      // Only successes are cached. Pinning a transient failure for 15s would
      // make a retry look broken.
      if (result.ok) cached = { at: Date.now(), result };
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Test seam — drops the cached report and any shared in-flight promise. */
export function _resetDiagnosticsCache(): void {
  inFlight = null;
  cached = null;
}
