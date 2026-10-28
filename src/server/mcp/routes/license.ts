import type { Request, Response } from "express";
import { API_LICENSE_ACTIVATE } from "../../../shared/api-paths.js";
import {
  activationErrorMessage,
  LICENSE_SAVED_STATE_UNREADABLE,
  LICENSE_SAVED_STATE_UNREADABLE_MESSAGE,
  type LicenseUnverifiableCode,
} from "../../../shared/license-copy.js";
import { isLoopback } from "../../auth/middleware.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlistedIfPresent,
} from "../../integrations/api-routes.js";
import type { Supervisor } from "../../launcher/supervisor.js";
import { LicenseActivationError } from "../../license/activation.js";
import {
  activateLicense,
  resolveLicenseState,
  resolveLiveLicenseState,
} from "../../license/license-state.js";
import type { GraceInfo, LicenseState, LicenseStatus } from "../../license/license-types.js";
import { npmCliSharesAppDataRoot, resolveAppDataDir } from "../../platform.js";

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
  darkInstall?: { installed: boolean; licenseeEmail?: string },
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
      ...(darkInstall?.licenseeEmail ? { licenseeEmail: darkInstall.licenseeEmail } : {}),
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
export function darkInstallInfo(): { installed: boolean; licenseeEmail?: string } {
  const full = resolveLicenseState({
    appDataDir: resolveAppDataDir(),
    now: () => Date.now(),
    gateEnabled: true,
  });
  if (full.gateActive && full.status === "licensed") {
    return { installed: true, licenseeEmail: full.license.email };
  }
  return { installed: false };
}

/**
 * PII-scrubbed status for non-loopback (LAN / deprecated-browser) callers — drops
 * the licensee email and licenseId so they never reach the wire, while keeping
 * enough for the client's licence surfaces and `tandem doctor`'s licence row.
 */
export function scrubForNonLoopback(s: LicenseState): {
  gateActive: boolean;
  status: LicenseStatus;
  daysRemaining: number | undefined;
  updateWindowCurrent: boolean;
  licenseUnverifiable?: LicenseUnverifiableCode;
  licenseInstalled?: boolean;
  grace?: GraceInfo;
} {
  if (!s.gateActive) {
    return {
      gateActive: false,
      status: "licensed",
      daysRemaining: undefined,
      updateWindowCurrent: true,
      // Boolean only — the licensee EMAIL stays on the loopback path.
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
    // Not PII either (#2231): two dates and a day count about this device's own
    // licence file. The client's grace notice and doctor's row need it.
    ...(s.status === "grace" ? { grace: s.grace } : {}),
  };
}

/**
 * The loopback payload plus `cliActivateEffective` (#1789, review round 1).
 *
 * Deliberately NOT inside `toLicenseStatusWire`, which stays a pure function of
 * the state it is handed; this reads the environment, so it belongs on the
 * request path. Deliberately NOT on `scrubForNonLoopback` either: a LAN caller
 * runs `tandem activate` on THEIR machine, which can never reach this server's
 * app-data root, and the client reads a missing field as `false` — so absence
 * is already the right answer there, and adding an always-`false` key would only
 * widen the scrubbed wire.
 *
 * Both loopback callers go through here so the GET and the activate response
 * cannot disagree — the client's `set()` replaces `status` wholesale with the
 * activate payload, and a missing flag there would blank the hint on the very
 * screen the user just used.
 */
function loopbackLicenseWire(state: LicenseState): Record<string, unknown> {
  return {
    ...toLicenseStatusWire(state, state.gateActive ? undefined : darkInstallInfo()),
    cliActivateEffective: npmCliSharesAppDataRoot(),
  };
}

/**
 * GET /api/license/status — current on-device license state, recomputed fresh.
 * Loopback callers get the full state (incl. licensee email + licenseId for the
 * updater); non-loopback callers get the scrubbed subset. This is a read-only
 * route, so it checks `isLoopback` directly rather than going through the
 * mutation-gating helper (`assertLoopbackForMutation`), which is for handlers
 * that write state.
 */
export function handleGetLicenseStatus(req: Request, res: Response): void {
  const state = resolveLiveLicenseState();
  if (isLoopback(req.socket.remoteAddress)) {
    res.json(loopbackLicenseWire(state));
    return;
  }
  res.json(scrubForNonLoopback(state));
}

export interface ActivateLicenseDeps {
  /**
   * The launcher supervisor, late-bound like every launcher route's. Optional:
   * a server without the launcher (tests, stdio) skips the resume and answers
   * exactly as before.
   */
  getSupervisor?: () => Pick<Supervisor, "resumeAfterLicence"> | null;
}

/**
 * POST /api/license/activate — persist a signed license blob and return the
 * freshly-resolved (full) state. Body: `{ license: string }` (the signed blob).
 *
 * Gated on the origin allowlist when an Origin is present (the CLI sends none,
 * #2205), THEN loopback (same order as handleRename, #1121): a license is a
 * credential, so only a local caller may install one. Works
 * regardless of GATE_ENABLED — a beta tester can activate a grandfathered
 * license before the v1.0 flag-flip. `activateLicense` verifies the signature
 * and rejects unknown schema versions; a bad blob yields 400 with a generic
 * message (no signature/parse detail reaches the wire).
 *
 * A factory so the success path can resume a launcher the licence refused
 * (#1521) — the one caller of `Supervisor.resumeAfterLicence`.
 */
export function makeActivateLicenseHandler(
  deps: ActivateLicenseDeps = {},
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    // Origin allowlist when an Origin is present (the CLI sends none, #2205),
    // then loopback — with copy a buyer can act on. The default messages talk about "integration routes" and
    // TANDEM_ALLOW_UNAUTHENTICATED_LAN — internal vocabulary that reaches the
    // activation form verbatim, since the client passes `json.message` straight
    // through.
    //
    // The `tandem activate` clause is conditional on the SAME discriminant the
    // Settings hint uses (review round 2). On a desktop install the sidecar reads
    // the Tauri app-data dir while an npm-installed CLI writes `license.json`
    // under its own env-paths root, so the command prints "✓ License activated"
    // and changes nothing the app can see — the exact wrong-root no-op #1789
    // removed from the hint two functions away. `npmCliSharesAppDataRoot()` is the
    // server saying the two roots coincide; anything else, and we only say "paste
    // the key there".
    const LOCAL_ONLY =
      "A license can only be activated on the computer running Tandem. Open Tandem on that " +
      "computer and paste the key there" +
      (npmCliSharesAppDataRoot() ? ", or run `tandem activate` on it." : ".");
    if (assertOriginAllowlistedIfPresent(req, res, API_LICENSE_ACTIVATE, LOCAL_ONLY)) return;
    if (assertLoopbackForMutation(req, res, LOCAL_ONLY)) return;

    // This check is now the route's preflight proof for an Origin-less caller,
    // as in rotate-token.ts. A simple-request POST (text/plain, form-urlencoded,
    // multipart, no Content-Type) leaves `req.body` undefined — every parser on
    // this path is `express.json` — so it gets this 400 before `activateLicense`
    // writes anything or the launcher is resumed. Keep it ahead of both.
    const { license: rawLicense } = (req.body ?? {}) as Record<string, unknown>;
    if (!rawLicense || typeof rawLicense !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "license is required" });
      return;
    }

    try {
      // No normalization here — `activateLicense` does it, so the persisted bytes
      // are clean and no caller can forget.
      await activateLicense(resolveAppDataDir(), rawLicense);
    } catch (err) {
      sendActivationError(res, err);
      return;
    }

    // Resume a launcher the licence refused (#1521) — success path only, and
    // AWAITED before answering, so the spawn has cleared `lastError` before the
    // client hears "activated" (otherwise a stale "restart" chip could appear
    // whose click would relaunch over the fresh child). Deliberately OUTSIDE the
    // try above: that one maps any throw to 400 `INVALID_LICENSE`, and
    // `license.json` is already written here — `startInternal` can still throw
    // from `buildPlan` on a bad `integrations.json`, which is not the key's fault.
    try {
      await deps.getSupervisor?.()?.resumeAfterLicence();
    } catch (err) {
      console.error("[License] Activated, but resuming the launcher failed:", err);
    }

    // Re-resolve through the LIVE gate flag rather than returning
    // `activateLicense`'s result directly. That function forces
    // `gateEnabled: true` on purpose (so `tandem license` can confirm an
    // installed license while enforcement still ships dark) — but handing that
    // shape to the client poisons its store on a dark build: it would then
    // believe `gateActive` is true and render gate-only chrome, such as the
    // "your update window has ended" warning, on a build that gates nothing.
    // Same shaping as GET /api/license/status, so the two can't disagree.
    //
    // Inside a try of its own: a throw here must still reach the buyer as a
    // coded answer, never as an unhandled rejection (which Express would turn
    // into an HTML 500). Not mapped like the activation's, because license.json
    // is already written: `INVALID_LICENSE` would make the Settings form and
    // `tandem activate` report a failure for a key that was installed. Its own
    // code says "saved, restart", and the CLI reads it as installed.
    try {
      const live = resolveLiveLicenseState();
      res.json(loopbackLicenseWire(live));
    } catch (err) {
      console.error("[License] Activated, but re-reading the license state failed:", err);
      res.status(500).json({
        error: LICENSE_SAVED_STATE_UNREADABLE,
        message: LICENSE_SAVED_STATE_UNREADABLE_MESSAGE,
      });
    }
  };
}

/** The activate route's coded failure answer. Static per-code copy; the
 * underlying error message never reaches the wire. */
function sendActivationError(res: Response, err: unknown): void {
  const code = err instanceof LicenseActivationError ? err.code : "UNKNOWN";
  // A write failure is OUR fault, not the caller's — 500, not 400. The
  // status code is the difference between "fix your input" and "retry".
  const status = code === "WRITE_FAILED" ? 500 : 400;
  res.status(status).json({
    error: code === "WRITE_FAILED" ? "LICENSE_WRITE_FAILED" : "INVALID_LICENSE",
    message: activationErrorMessage(code),
  });
}
