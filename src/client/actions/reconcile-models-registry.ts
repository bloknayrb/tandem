/**
 * One-shot localStorage→server reconcile of the Models registry (#1123 M2).
 *
 * Replaces the M1a seeder (`migrate-models-registry.ts`). M1a relocated only the
 * *resolver* to the server, so under an M1a build the client kept editing the
 * registry in localStorage — which is therefore the *newer* authority at the M2
 * transition. This pushes localStorage → server once, then records a flag so it
 * never re-runs. Un-gated by `BYO_MODELS_ENABLED` on purpose (R2-A): it runs
 * while dark exactly like the seeder did, completing before any CRUD is
 * structurally possible (the Models UI is unmounted while dark), so
 * "localStorage ≥ server" holds by construction. It does NOT touch the client
 * store's `$state`; the store's own `loadFromServer` (BYO-gated) is the reader.
 *
 * Constraints (from the plan review):
 *  - `_readOnly`-gated: a downgraded client must never clobber a newer client's
 *    data — the same guard `updateSettings` enforces locally.
 *  - New flag `tandem:models-reconciled-to-server-v2` — the M1a `-migrated-` flag
 *    meant "seeded once", NOT "server current", so it is the wrong signal.
 *  - Overwrite semantics: at the transition localStorage is the newer authority,
 *    so we push it up unconditionally (not "skip if server non-empty"). ETag-
 *    guarded, so a racing two-window reconcile 409s (→ adopt) rather than clobbers.
 *  - Retry-safe: the localStorage source is never dropped; a failed POST leaves
 *    the flag unset → retries next boot.
 *  - Returns a `ReconcileOutcome` — the store's `initializeStore` maps it to
 *    settle-or-leave-pending in ONE place: `skipped`/`reconciled` settle the CRUD
 *    gate, a real `failed` leaves it pending so an M4 CRUD write cannot precede a
 *    successful reconcile (R2-B). This action never reaches back into the store
 *    (no import cycle, no scattered settle obligation).
 *  - Drops `_legacyApiKey` via `projectModelsFile` (server schema is `.strict()`).
 */
import {
  API_MODELS,
  type ModelsGetResponse,
  type ModelsPostBody,
} from "../../shared/models/contract.js";
import { loadSettings } from "../hooks/useTandemSettings.js";
import { projectModelsFile } from "../models/project.js";
import { API_BASE } from "../utils/fileUpload.js";

/** localStorage flag — separate key so it never touches the settings schema. */
export const MODELS_RECONCILED_FLAG_KEY = "tandem:models-reconciled-to-server-v2";

/**
 * `skipped` — nothing to do (flag set / read-only / no models): CRUD gate may open.
 * `reconciled` — localStorage pushed to the server (200), or a concurrent writer
 *   won (409) and we adopted: gate may open. `failed` — a real POST/network error:
 *   flag left unset (retries next boot), gate must stay closed (R2-B).
 */
export type ReconcileOutcome = "skipped" | "reconciled" | "failed";

let hasRun = false;
let lastOutcome: ReconcileOutcome = "skipped";

export async function reconcileModelsToServerOnce(): Promise<ReconcileOutcome> {
  if (hasRun) return lastOutcome;
  hasRun = true;
  try {
    if (localStorage.getItem(MODELS_RECONCILED_FLAG_KEY) === "1") return (lastOutcome = "skipped");
    const settings = loadSettings();
    if (settings._readOnly) return (lastOutcome = "skipped"); // downgraded client must not clobber
    const models = settings.models ?? [];
    if (models.length === 0) return (lastOutcome = "skipped"); // nothing to reconcile

    // GET first to obtain the current server ETag (the POST precondition).
    const getRes = await fetch(`${API_BASE}${API_MODELS}`, { method: "GET" });
    if (!getRes.ok) throw new Error(`GET ${API_MODELS} → ${getRes.status}`);
    const { etag } = (await getRes.json()) as ModelsGetResponse;

    const body: ModelsPostBody = {
      file: projectModelsFile(models, settings.defaultModelId ?? null),
      ifMatch: etag,
    };
    const postRes = await fetch(`${API_BASE}${API_MODELS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (postRes.ok || postRes.status === 409) {
      // 200 → localStorage is now the server state.
      // 409 → a concurrent window/origin already wrote; adopt (converge), don't
      //       re-clobber. The store's `loadFromServer` reads the winning state.
      // Either way: set the flag (no re-reconcile) and report reconciled.
      localStorage.setItem(MODELS_RECONCILED_FLAG_KEY, "1");
      return (lastOutcome = "reconciled");
    }
    // Non-2xx/409 (server schema rejecting a legacy blob, or a 5xx) → leave the
    // flag unset (retries next boot) and report failed so the gate stays closed
    // (R2-B). Warn so a stuck "my models won't sync" is debuggable.
    const code = await postRes
      .json()
      .then((b: { code?: string }) => b?.code)
      .catch(() => undefined);
    console.warn(
      `[tandem] model-registry reconcile POST failed (status ${postRes.status}${
        code ? `, ${code}` : ""
      }); will retry next boot.`,
    );
    return (lastOutcome = "failed");
  } catch (err) {
    // A failed reconcile leaves the flag unset (retried next boot) and reports
    // failed (gate stays closed). localStorage unavailable (incognito) also lands
    // here — harmless, but warn so a real failure isn't wholly silent.
    console.warn("[tandem] model-registry reconcile errored; will retry next boot.", err);
    return (lastOutcome = "failed");
  }
}

/** Test seam — reset the once-per-session guard. */
export function _resetModelsReconcileGuardForTests(): void {
  hasRun = false;
  lastOutcome = "skipped";
}
