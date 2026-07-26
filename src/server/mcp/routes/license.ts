import type { Request, Response } from "express";
import { API_LICENSE_ACTIVATE } from "../../../shared/api-paths.js";
import {
  activationErrorMessage,
  type LicenseUnverifiableCode,
} from "../../../shared/license-copy.js";
import { isLoopback } from "../../auth/middleware.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { LicenseActivationError } from "../../license/activation.js";
import {
  activateLicense,
  resolveLicenseState,
  resolveLiveLicenseState,
} from "../../license/license-state.js";
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
export function toLicenseStatusWire(
  state: LicenseState,
  /**
   * Dark-build only: is a verifiable license already installed, and for whom?
   * Resolved separately (see `darkInstallInfo`) because the dark arm returns
   * before touching disk.
   */
  darkInstall?: { installed: boolean; licenseeName?: string },
): Record<string, unknown> {
  if (!state.gateActive) {
    return {
      gateActive: false,
      status: "licensed",
      updateWindowCurrent: true,
      // Additive, and NOT a gate signal — `gateActive` stays false so nothing
      // gate-only renders. Without it a dark build has no way to tell a user
      // their activation worked: the pill reads "Not enforced in this version"
      // and the hint keeps saying "activate it now" whether or not they just
      // did. The README sends every beta user down exactly that path.
      licenseInstalled: darkInstall?.installed ?? false,
      ...(darkInstall?.licenseeName ? { licenseeName: darkInstall.licenseeName } : {}),
    };
  }
  return state;
}

/**
 * Does this device hold a license that WOULD verify once the gate is on?
 *
 * Re-resolves with `gateEnabled: true` — the same thing `tandem license` does
 * so a beta tester can confirm an installed license before the flip. Only
 * called on the dark path, where the client polls once and then rests, so the
 * extra file read + Ed25519 verify is not on any hot path.
 */
export function darkInstallInfo(): { installed: boolean; licenseeName?: string } {
  const full = resolveLicenseState({
    appDataDir: resolveAppDataDir(),
    now: () => Date.now(),
    gateEnabled: true,
  });
  if (full.gateActive && full.status === "licensed") {
    return { installed: true, licenseeName: full.license.name };
  }
  return { installed: false };
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
  licenseUnverifiable?: LicenseUnverifiableCode;
  licenseInstalled?: boolean;
} {
  if (!s.gateActive) {
    return {
      gateActive: false,
      status: "licensed",
      daysRemaining: undefined,
      updateWindowCurrent: true,
      // Boolean only — the licensee NAME stays on the loopback path.
      licenseInstalled: darkInstallInfo().installed,
    };
  }
  return {
    gateActive: true,
    status: s.status,
    daysRemaining: s.status === "trial" ? s.trial.daysRemaining : undefined,
    updateWindowCurrent: s.updateWindowCurrent,
    // Not PII — a closed enum describing this device's own license file, with no
    // license content, name, id or email in it. The client needs it to avoid
    // telling a license holder that their trial ended.
    licenseUnverifiable: s.status === "licensed" ? undefined : s.licenseUnverifiable,
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
    res.json(toLicenseStatusWire(state, state.gateActive ? undefined : darkInstallInfo()));
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
  // Same gates as before (origin allowlist THEN loopback), but with copy a
  // buyer can act on. The default messages talk about "integration routes" and
  // TANDEM_ALLOW_UNAUTHENTICATED_LAN — internal vocabulary that reaches the
  // activation form verbatim, since the client passes `json.message` straight
  // through.
  const LOCAL_ONLY =
    "A license can only be activated on the computer running Tandem. Open Tandem on that " +
    "computer and paste the key there, or run `tandem activate` on it.";
  if (assertOriginAllowlisted(req, res, API_LICENSE_ACTIVATE, LOCAL_ONLY)) return;
  if (assertLoopbackForMutation(req, res, LOCAL_ONLY)) return;

  const { license: rawLicense } = (req.body ?? {}) as Record<string, unknown>;
  if (!rawLicense || typeof rawLicense !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "license is required" });
    return;
  }

  try {
    // No normalization here — `activateLicense` does it, so the persisted bytes
    // are clean and no caller can forget.
    await activateLicense(resolveAppDataDir(), rawLicense);

    // Re-resolve through the LIVE gate flag rather than returning
    // `activateLicense`'s result directly. That function forces
    // `gateEnabled: true` on purpose (so `tandem license` can confirm an
    // installed license while enforcement still ships dark) — but handing that
    // shape to the client poisons its store on a dark build: it would then
    // believe `gateActive` is true and render gate-only chrome, such as the
    // "your update window has ended" warning, on a build that gates nothing.
    // Same shaping as GET /api/license/status, so the two can't disagree.
    const live = resolveLiveLicenseState();
    res.json(toLicenseStatusWire(live, live.gateActive ? undefined : darkInstallInfo()));
  } catch (err) {
    const code = err instanceof LicenseActivationError ? err.code : "UNKNOWN";
    // A write failure is OUR fault, not the caller's — 500, not 400. The
    // status code is the difference between "fix your input" and "retry".
    const status = code === "WRITE_FAILED" ? 500 : 400;
    res.status(status).json({
      error: code === "WRITE_FAILED" ? "LICENSE_WRITE_FAILED" : "INVALID_LICENSE",
      // Static per-code copy; the underlying error message never reaches the wire.
      message: activationErrorMessage(code),
    });
  }
}
