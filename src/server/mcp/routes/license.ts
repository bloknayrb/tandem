import type { Request, Response } from "express";
import { isLoopback } from "../../auth/middleware.js";
import { GATE_ENABLED } from "../../license/gate-flag.js";
import { resolveLicenseState } from "../../license/license-state.js";
import type { LicenseState } from "../../license/license-types.js";
import { resolveAppDataDir } from "../../platform.js";

/**
 * PII-scrubbed status for non-loopback (LAN / deprecated-browser) callers — drops
 * the licensee name/email/licenseId so they never reach the wire, while keeping
 * enough for the client's wall/banner + read-only derivation.
 */
export function scrubForNonLoopback(s: LicenseState): {
  gateActive: boolean;
  status: LicenseState["status"];
  daysRemaining: number | undefined;
  updateWindowCurrent: boolean;
} {
  return {
    gateActive: s.gateActive,
    status: s.status,
    daysRemaining: s.trial?.daysRemaining,
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
  const state = resolveLicenseState({
    appDataDir: resolveAppDataDir(),
    now: () => Date.now(),
    gateEnabled: GATE_ENABLED,
  });
  if (isLoopback(req.socket.remoteAddress)) {
    res.json(state);
    return;
  }
  res.json(scrubForNonLoopback(state));
}
