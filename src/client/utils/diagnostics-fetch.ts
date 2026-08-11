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
 * Single shared in-flight request. `runDoctor` behind this route spawns
 * `npm ls -g`, probes ports, and stats the annotation store, so a hover-prefetch
 * racing a Copy-Diagnostics click should cost one run, not two. Cleared on
 * settle rather than cached with a TTL: a later click deserves fresh readings.
 */
let inFlight: Promise<DiagnosticsFetchResult> | null = null;

async function run(signal?: AbortSignal): Promise<DiagnosticsFetchResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${API_DIAGNOSTICS}`, { signal });
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
 * Fetch diagnostics, joining any request already in flight.
 *
 * Note that `signal` only applies to a request this call actually starts — a
 * joined caller cannot abort someone else's fetch. That is the intended
 * behavior: the hook's timeout should stop *waiting*, not cancel the click-path
 * request it happened to piggyback on.
 */
export function fetchDiagnostics(signal?: AbortSignal): Promise<DiagnosticsFetchResult> {
  inFlight ??= run(signal).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Test seam — drops any shared in-flight promise. */
export function _resetDiagnosticsInFlight(): void {
  inFlight = null;
}
