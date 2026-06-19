import fs from "fs";
import { atomicWrite } from "../file-io/index.js";
import { resolveAppDataDir } from "../platform.js";
import { GATE_ENABLED } from "./gate-flag.js";
import type { LicenseFile, LicenseState, SignatureVerified, TrialFile } from "./license-types.js";
import { licenseFilePath, TRIAL_MS, trialFilePath } from "./paths.js";
import { verifyLicenseSignature } from "./verifier.js";

// Known license schema majors. The signed `version` field becomes load-bearing:
// an unknown major is rejected rather than silently honored (review §12 L3).
const KNOWN_VERSION_MAJORS = new Set(["1"]);
function knownVersion(v: string): boolean {
  return typeof v === "string" && KNOWN_VERSION_MAJORS.has(v.split(".")[0]);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Resolve on-device license state — computed FRESH on every call (no cache).
 * A cache caused the two-writer staleness + mid-session-expiry bugs the spec
 * reviews found, so the gate re-reads `license.json`/`trial.json` per dispatch.
 * Cost is a tiny file read + (at most) one Ed25519 verify.
 *
 * `verify` is injectable for tests; production uses signature-only verification
 * so an expired *update window* never drops a paid user to `restricted`
 * (ADR-040: run forever, updates windowed). The update window is read from
 * `expiresAt` into `updateWindowCurrent`.
 */
export function resolveLicenseState(deps: {
  appDataDir: string;
  now: () => number;
  gateEnabled: boolean;
  // Branded: only a signature-verifying function fits, so the expiry-checking
  // `verifyLicense` can't be wired here (it would lock out paid users past their
  // update window). See SignatureVerified in license-types.ts.
  verify?: (blob: string) => SignatureVerified;
}): LicenseState {
  const { appDataDir, now, gateEnabled, verify = verifyLicenseSignature } = deps;

  if (!gateEnabled) {
    return { gateActive: false };
  }

  // One timestamp for the whole resolution — the licensed update-window check and
  // the trial-clock math must agree on a single "now".
  const nowMs = now();

  // 1. A signature-valid license of a known version ⇒ licensed (runs forever).
  const lf = readJson<LicenseFile>(licenseFilePath(appDataDir));
  if (lf?.blob) {
    try {
      const meta = verify(lf.blob);
      if (knownVersion(meta.version)) {
        const updateWindowCurrent =
          meta.expiresAt === null || new Date(meta.expiresAt).getTime() > nowMs;
        return {
          gateActive: true,
          status: "licensed",
          license: meta,
          licenseId: meta.id,
          updateWindowCurrent,
        };
      }
    } catch {
      // malformed / bad signature / unknown version — fall through to trial/restricted
    }
  }

  // 2. Trial clock (soft by design — ADR-040 §3). Absent file ⇒ day 0.
  const tf = readJson<TrialFile>(trialFilePath(appDataDir));
  const firstRunAt = tf?.firstRunAt ? new Date(tf.firstRunAt).getTime() : nowMs;
  const expiresAt = firstRunAt + TRIAL_MS;
  if (nowMs < expiresAt) {
    const daysRemaining = Math.max(0, Math.ceil((expiresAt - nowMs) / 86_400_000));
    return {
      gateActive: true,
      status: "trial",
      updateWindowCurrent: false,
      trial: {
        firstRunAt: new Date(firstRunAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        daysRemaining,
      },
    };
  }

  // 3. Trial expired, no license ⇒ restricted (read-only escape hatch).
  return { gateActive: true, status: "restricted", updateWindowCurrent: false };
}

/**
 * Production-wired `resolveLicenseState`: the single place the live deps (real
 * app-data dir, wall clock, build-time gate flag) are assembled. Shared by both
 * enforcement surfaces — Hocuspocus `onAuthenticate` (Surface A) and the MCP
 * `gatedTool` / `licenseGateMiddleware` (Surface B) — plus the status route, so
 * a future deps change lands in one spot. Still cache-free: every call re-reads disk.
 */
export function resolveLiveLicenseState(): LicenseState {
  return resolveLicenseState({
    appDataDir: resolveAppDataDir(),
    now: () => Date.now(),
    gateEnabled: GATE_ENABLED,
  });
}

/**
 * Start the trial clock on first boot of a gate-active build. Writes `trial.json`
 * once, with an exclusive create (`flag: "wx"`) so concurrent stdio+HTTP first
 * boots agree on a single `firstRunAt` (first writer wins). No-op when the gate
 * is dark — so the v1.0 flag-flip starts a clean 14-day trial.
 */
export async function ensureTrialStarted(
  appDataDir: string,
  now: () => number,
  gateEnabled: boolean,
): Promise<void> {
  if (!gateEnabled) return;
  const filePath = trialFilePath(appDataDir);
  if (fs.existsSync(filePath)) return;
  const body: TrialFile = { version: 1, firstRunAt: new Date(now()).toISOString() };
  try {
    fs.writeFileSync(filePath, JSON.stringify(body), { flag: "wx" });
  } catch {
    // Lost the race to a concurrently-starting process — its file stands.
  }
}

/**
 * Activate a license: verify its signature + known version, persist atomically,
 * and return the freshly-resolved state. Does NOT reject an expired update
 * window — a user may activate an older license and still run forever; they
 * simply won't receive new updates until they renew.
 */
export async function activateLicense(
  appDataDir: string,
  blob: string,
  // Injectable for tests (sign with a temp keypair) — mirrors the seam on
  // resolveLicenseState. Production uses the pinned-key signature verifier.
  verify: (blob: string) => SignatureVerified = verifyLicenseSignature,
): Promise<LicenseState> {
  const meta = verify(blob); // throws on malformed / bad signature
  if (!knownVersion(meta.version)) {
    throw new Error(`Unsupported license version: ${meta.version}`);
  }
  const body: LicenseFile = { version: 1, blob };
  await atomicWrite(licenseFilePath(appDataDir), JSON.stringify(body));
  return resolveLicenseState({ appDataDir, now: () => Date.now(), gateEnabled: true, verify });
}
