import type { Request, Response } from "express";
import { API_LICENSE_ACTIVATE } from "../../../shared/api-paths.js";
import { isLoopback } from "../../auth/middleware.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { activateLicense, resolveLiveLicenseState } from "../../license/license-state.js";
import type { LicenseState, LicenseStatus } from "../../license/license-types.js";
import { resolveAppDataDir } from "../../platform.js";

/**
 * Loopback (full) status wire. `LicenseState` is a discriminated union whose
 * dark arm is `{ gateActive: false }` with NO status; the wire keeps emitting the
 * back-compat sentinel (`status:"licensed", updateWindowCurrent:true`) so the
 * Tauri updater + client (which redeclare a flat shape and ignore `status` when
 * `!gateActive`) stay byte-identical to the pre-union build. The active arms
 * serialize exactly as before (full license + licenseId on the licensed arm).
 */
export function toLicenseStatusWire(state: LicenseState): Record<string, unknown> {
  if (!state.gateActive) {
    return { gateActive: false, status: "licensed", updateWindowCurrent: true };
  }
  return state;
}

/**
 * PII-scrubbed status for non-loopback (LAN / deprecated-browser) callers — drops
 * the licensee name/email/licenseId so they never reach the wire, while keeping
 * enough for the client's wall/banner + read-only derivation.
 */
export function scrubForNonLoopback(s: LicenseState): {
  gateActive: boolean;
  status: LicenseStatus;
  daysRemaining: number | undefined;
  updateWindowCurrent: boolean;
} {
  if (!s.gateActive) {
    return {
      gateActive: false,
      status: "licensed",
      daysRemaining: undefined,
      updateWindowCurrent: true,
    };
  }
  return {
    gateActive: true,
    status: s.status,
    daysRemaining: s.status === "trial" ? s.trial.daysRemaining : undefined,
    updateWindowCurrent: s.updateWindowCurrent,
  };
}

/**
 * GET /api/license/status — current on-device license state, recomputed fresh.
 * Loopback callers get the full state (incl. licensee name + licenseId for the
 * updater); non-loopback callers get the scrubbed subset (raw `isLoopback` check,
 * not the mutation helper — review §12 M1).
 */
export function handleGetLicenseStatus(req: Request, res: Response): void {
  const state = resolveLiveLicenseState();
  if (isLoopback(req.socket.remoteAddress)) {
    res.json(toLicenseStatusWire(state));
    return;
  }
  res.json(scrubForNonLoopback(state));
}

/**
 * POST /api/license/activate — persist a signed license blob and return the
 * freshly-resolved (full) state. Body: `{ license: string }` (the signed blob).
 *
 * Gated on origin allowlist THEN loopback (same order as handleRename, #1121):
 * a license is a credential, so only a local caller may install one. Works
 * regardless of GATE_ENABLED — a beta tester can activate a grandfathered
 * license before the v1.0 flag-flip. `activateLicense` verifies the signature
 * and rejects unknown schema versions; a bad blob yields 400 with a generic
 * message (no signature/parse detail reaches the wire).
 */
export async function handleActivateLicense(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_LICENSE_ACTIVATE)) return;
  if (assertLoopbackForMutation(req, res)) return;

  const { license: rawLicense } = (req.body ?? {}) as Record<string, unknown>;
  if (!rawLicense || typeof rawLicense !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "license is required" });
    return;
  }

  try {
    const state = await activateLicense(resolveAppDataDir(), rawLicense.trim());
    res.json(state);
  } catch {
    // Generic message by design: the verify/parse error can embed blob bytes.
    res.status(400).json({
      error: "INVALID_LICENSE",
      message: "License could not be verified. Check that you pasted the full license.",
    });
  }
}
