import fs from "fs";
import type { LicenseUnverifiableCode } from "../../shared/license-copy.js";
import { atomicWriteConfigFile } from "../integrations/storage.js";
import { resolveAppDataDir } from "../platform.js";
import { LicenseActivationError } from "./activation.js";
import { GATE_ENABLED } from "./gate-flag.js";
import type { LicenseFile, LicenseState, SignatureVerified, TrialFile } from "./license-types.js";
import { MAX_NORMALIZE_INPUT, normalizePastedLicense } from "./paste.js";
import { licenseFilePath, TRIAL_MS, trialFilePath } from "./paths.js";
import { LicenseVerifyError, verifyLicenseSignature } from "./verifier.js";

// Known license schema majors. The signed `version` field becomes load-bearing:
// an unknown major is rejected rather than silently honored (review §12 L3).
const KNOWN_VERSION_MAJORS = new Set(["1"]);
function knownVersion(v: string): boolean {
  return typeof v === "string" && KNOWN_VERSION_MAJORS.has(v.split(".")[0]);
}

/**
 * One-shot log guard.
 *
 * `resolveLicenseState` is called PER DISPATCH — every gated MCP tool call,
 * every Hocuspocus authenticate, and every 60-second client status poll. An
 * unconditional log line on the unverifiable path would therefore emit
 * continuously for as long as the bad file sits on disk, burying everything
 * else in the log a support request would ask for. Log the condition once per
 * process; the state itself (`licenseUnverifiable`) is what surfaces it to the
 * user, on every read, in the UI.
 */
const loggedOnce = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  console.error(message);
}

/** Test-only: forget which warnings have been emitted. */
export function _resetLicenseWarningsForTests(): void {
  loggedOnce.clear();
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
  //
  // `licenseUnverifiable` records the case where a license file EXISTS but does
  // not verify — a tester holding a pre-key-rotation license, a corrupted file,
  // or a license from a newer schema. Enforcement is unchanged (an unverified
  // license must never unlock, so we still fall through to the trial clock),
  // but the state has to say so: without it, every surface tells a person with a
  // license sitting on disk that their *trial* ended — a trial they may never
  // have had. It was previously swallowed by a bare `catch {}` with no log, no
  // status and no UI.
  //
  // It carries the CODE, not a boolean. "Have it reissued", "the file is
  // damaged" and "update Tandem" are three different user actions, and a
  // boolean forced every surface to hedge across all three in one sentence.
  let licenseUnverifiable: LicenseUnverifiableCode | undefined;
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
      licenseUnverifiable = "UNSUPPORTED_VERSION";
      warnOnce(
        "version",
        `[license] license.json holds an unsupported schema version (${meta.version}) — ` +
          "treating this device as unlicensed. A newer Tandem may be required.",
      );
    } catch (err) {
      // Code only — never the message, which can embed blob bytes.
      licenseUnverifiable = err instanceof LicenseVerifyError ? err.code : "UNKNOWN";
      warnOnce(
        `verify:${licenseUnverifiable}`,
        `[license] license.json failed verification (${licenseUnverifiable}) — treating this ` +
          "device as unlicensed. A license issued before a signing-key change must be reissued.",
      );
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
      licenseUnverifiable,
      trial: {
        firstRunAt: new Date(firstRunAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        daysRemaining,
      },
    };
  }

  // 3. Trial expired, no license ⇒ restricted (read-only escape hatch).
  return {
    gateActive: true,
    status: "restricted",
    updateWindowCurrent: false,
    licenseUnverifiable,
  };
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
    // The directory may not exist yet — `tandem activate ./x.license`, which the
    // license email recommends, is often the FIRST thing a buyer runs, before
    // Tandem has ever launched. (The activate path gets its mkdir from
    // `atomicWriteConfigFile`; this one writes directly for the `wx` semantics.)
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(body), { flag: "wx" });
  } catch {
    // Lost the race to a concurrently-starting process — its file stands.
    // (Or the directory is unwritable, in which case the trial fails OPEN by
    // design: a missing trial.json reads as "day 0 = now" on every call. That's
    // consistent with ADR-040's deliberately-soft clock.)
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
  rawBlob: string,
  // Injectable for tests (sign with a temp keypair) — mirrors the seam on
  // resolveLicenseState. Production uses the pinned-key signature verifier.
  verify: (blob: string) => SignatureVerified = verifyLicenseSignature,
): Promise<LicenseState> {
  // Bound BEFORE normalizing. `normalizePastedLicense` allocates a copy per
  // pass, and the route's body parser admits up to 70 MB — its `Content-Length`
  // pre-check can be sidestepped with chunked transfer encoding, so this is the
  // guard that actually holds. Rejecting (rather than truncating) also gives the
  // buyer the right message: they pasted the whole email.
  if (rawBlob.length > MAX_NORMALIZE_INPUT) {
    throw new LicenseActivationError("TOO_LONG", "License input exceeds maximum length");
  }

  // Normalize before PERSISTING, not just before verifying. The production
  // verifier repairs transport damage itself, but what lands in `license.json`
  // must be clean bytes — otherwise every subsequent read re-repairs them, and
  // an injected test verifier (which has no reason to normalize) would reject
  // what activation just accepted.
  const blob = normalizePastedLicense(rawBlob);

  let meta: SignatureVerified;
  try {
    meta = verify(blob);
  } catch (err) {
    if (err instanceof LicenseVerifyError) {
      throw new LicenseActivationError(err.code, err.message, { cause: err });
    }
    throw new LicenseActivationError("MALFORMED", "License could not be read", { cause: err });
  }
  if (!knownVersion(meta.version)) {
    throw new LicenseActivationError(
      "UNSUPPORTED_VERSION",
      `Unsupported license version: ${meta.version}`,
    );
  }

  // Persist. Kept in its OWN try so a filesystem failure can never be reported
  // as a bad license — the blob above is already proven good at this point.
  const body: LicenseFile = { version: 1, blob };
  try {
    // `atomicWriteConfigFile` (not the generic `atomicWrite`) because it creates
    // the file 0o600 and does its own recursive mkdir. `license.json` embeds the
    // buyer's name and email inside the signed blob — the only identity PII
    // Tandem writes to disk — so owner-only permissions are the right default,
    // and it's the same helper the other app-data config stores already share.
    await atomicWriteConfigFile(licenseFilePath(appDataDir), JSON.stringify(body));
  } catch (err) {
    throw new LicenseActivationError(
      "WRITE_FAILED",
      `Could not save the license to ${appDataDir}`,
      { cause: err },
    );
  }
  return resolveLicenseState({ appDataDir, now: () => Date.now(), gateEnabled: true, verify });
}
