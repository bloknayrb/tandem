import fs from "fs";
import type { LicenseUnverifiableCode } from "../../shared/license-copy.js";
import { atomicWriteConfigFile } from "../integrations/storage.js";
import { resolveAppDataDir } from "../platform.js";
import { LicenseActivationError } from "./activation.js";
import { GATE_ENABLED } from "./gate-flag.js";
import type { LicenseFile, LicenseState, SignatureVerified, TrialFile } from "./license-types.js";
import { MAX_NORMALIZE_INPUT, normalizePastedLicense } from "./paste.js";
import { licenseFilePath, TRIAL_DAYS, TRIAL_MS, trialFilePath } from "./paths.js";
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
 * The epoch ms the trial clock starts from, given a parsed `trial.json` body
 * (#1788). `NaN` when the body is present but cannot run a clock — `NaN` makes
 * `nowMs < expiresAt` false ⇒ restricted (decision 5).
 *
 * Only `null` — file absent, unreadable, unparseable, or a literal `null` body,
 * which `readJson` cannot tell apart — is day 0. Every other body is
 * authoritative, so a bogus `firstRunAt` fails closed.
 *
 * `Date.parse` on a STRING-typed field, not `new Date(x).getTime()`:
 * `new Date(null)` and `new Date(0)` are a **finite** `0` — a 1970 epoch that
 * reads as a usable timestamp — while `new Date("")` is `NaN`. Typing the field
 * first is what makes `null` and `0` fail here rather than silently becoming a
 * 1970 clock.
 */
function trialFirstRunAt(tf: unknown, nowMs: number): number {
  if (tf === null) return nowMs;
  const v = (tf as Partial<TrialFile>).firstRunAt;
  return typeof v === "string" ? Date.parse(v) : NaN;
}

/**
 * The earliest `firstRunAt` that can be a real first run: 2020-01-01Z, comfortably
 * before Tandem existed and comfortably after the two values a broken clock
 * actually produces (the 1970 epoch, and the 2015-2016 dates a dead RTC restores).
 */
const TRIAL_EPOCH_FLOOR_MS = Date.UTC(2020, 0, 1);

/**
 * Can this parsed `trial.json` body run a clock? The predicate `ensureTrialStarted`
 * repairs against, kept beside `trialFirstRunAt` so the two cannot disagree.
 *
 * **Finiteness is not enough, and that gap was live in the first draft of #1788.**
 * `Date.parse` is happy with any well-formed date, so a *valid but wrong*
 * `firstRunAt` passed a bare `Number.isFinite` check and was never repaired —
 * failing in both directions from one root cause:
 *
 * - **Too old ⇒ permanently restricted.** A device whose RTC battery is dead
 *   boots at, say, 2016-01-01, writes that as `firstRunAt`, and NTP then
 *   corrects the clock. The trial is now years expired, the body is "usable",
 *   so the repair never runs and the device is restricted forever with no
 *   recovery — verbatim the failure `ensureTrialStarted` exists to close.
 * - **Too far future ⇒ perpetual trial.** The mirror image, and it fails OPEN:
 *   a `firstRunAt` of 3000-01-01 is finite, so `nowMs < firstRunAt + TRIAL_MS`
 *   holds forever and `daysRemaining` (~355,000) reaches the wire and the
 *   client banner. That contradicted `trialFirstRunAt`'s own promise that a
 *   bogus `firstRunAt` fails closed.
 *
 * So the bound is two-sided. The future edge is `nowMs` rather than a constant
 * because a trial cannot legitimately start after now; a little slack absorbs
 * clock skew between the write and this read.
 *
 * `0` for `nowMs` in the finiteness call is deliberate and not a placeholder:
 * the only body this is asked about is a non-`null` one, where `trialFirstRunAt`
 * does not read `nowMs` at all.
 */
const TRIAL_FUTURE_SLACK_MS = 86_400_000;

function trialBodyIsUsable(tf: unknown, nowMs: number): boolean {
  const firstRunAt = trialFirstRunAt(tf, 0);
  if (!Number.isFinite(firstRunAt)) return false;
  return firstRunAt >= TRIAL_EPOCH_FLOOR_MS && firstRunAt <= nowMs + TRIAL_FUTURE_SLACK_MS;
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
  //
  // readJson<unknown>, not <TrialFile>: the cast is blind (:42-48), and a
  // TrialFile-typed `tf` would narrow away the non-null-but-unusable bodies that
  // carry decision 5 (a whole-body scalar, `firstRunAt: 0`).
  //
  // Before #1788 this read `tf?.firstRunAt ? new Date(tf.firstRunAt).getTime() :
  // nowMs`, which sent every FALSY value down the absent-file branch — so
  // `firstRunAt: ""` was a PERPETUAL 14-day trial on every dispatch, a fail-open
  // and the opposite of what a non-empty unparseable value already did.
  const tf = readJson<unknown>(trialFilePath(appDataDir));
  const firstRunAt = trialFirstRunAt(tf, nowMs);
  const expiresAt = firstRunAt + TRIAL_MS;
  if (nowMs < expiresAt) {
    // DISPLAY clamp, both ends (#1819). `Math.max(0, …)` alone is a lower bound,
    // and two routes push the upper end past `TRIAL_DAYS`:
    //
    // - A stored `firstRunAt` up to `TRIAL_FUTURE_SLACK_MS` (24 h) ahead of now
    //   is "usable" by design — the slack absorbs write/read clock skew — so
    //   `ensureTrialStarted` leaves it and this reads 15. The clock-sanity bound
    //   took this from unbounded to `TRIAL_DAYS + 1`; it did not close it.
    // - `ensureTrialStarted` runs ONCE at startup while this re-reads per
    //   dispatch on a live clock, so a clock moved BACK mid-session yields
    //   `TRIAL_DAYS + N` until restart — the issue's "24 of 14 days left".
    //
    // Clamping here covers all three consumers (the banner, the Settings pill,
    // `tandem license`) in one place. `nowMs < expiresAt` above is deliberately
    // untouched: a backwards clock still LENGTHENS the trial, which is ADR-040
    // §3's deliberately-soft clock, not a hole this issue closes.
    //
    // `warnOnce` writes to `console.error` (stderr — Critical Rule 3) once per
    // process, and it is reachable on a shipped DARK build: `runLicenseStatus`
    // (src/cli/license.ts) and `darkInstallInfo()` (src/server/mcp/routes/
    // license.ts) both resolve with `gateEnabled: true`. One stderr line per
    // process on a genuinely bogus clock is the point.
    const rawDays = Math.ceil((expiresAt - nowMs) / 86_400_000);
    if (rawDays > TRIAL_DAYS) {
      warnOnce(
        "trial:days-clamp",
        `[license] trial clock reports ${rawDays} days remaining, more than the ${TRIAL_DAYS}-day ` +
          "trial — the device clock moved backwards, or trial.json holds a future firstRunAt. " +
          `Reporting ${TRIAL_DAYS}; the clock itself is left alone (ADR-040 §3).`,
      );
    }
    const daysRemaining = Math.min(TRIAL_DAYS, Math.max(0, rawDays));
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
 *
 * **It also REPAIRS an existing file that cannot run a clock**, and that half is
 * what stops #1788's fix from creating a state with no way out. Since #1788 a
 * body that parses but carries an unusable `firstRunAt` resolves `restricted`
 * (correct — the fail-open it replaces was real), but the old
 * `if (existsSync) return;` meant nothing ever rewrote it: post-flip the device
 * was restricted on every boot, forever, told "your trial has ended" having
 * never had one. Reachable from a hand-edited file, a `{}` / `0` / `[]` body, or
 * a `firstRunAt` written by a schema revision this build does not understand —
 * and the spec itself pins `firstRunAt: 0` as restricted, which is exactly what
 * an epoch-ms revision would write.
 *
 * **The repair is gated on a successful READ AND PARSE**, which is the errno
 * discrimination that made this look expensive when it was first deferred. A
 * transient Windows AV/indexer lock, or any other read failure, leaves the file
 * strictly alone — rewriting on a failed read would reset a real, running clock.
 * An unparseable body is left alone too: `readJson` already reads that as day 0,
 * so it is not stuck, and the file may still be recoverable by hand.
 *
 * A repair grants one fresh 14-day trial, which is no new abuse surface:
 * deleting `trial.json` already does that, and ADR-040 §3 makes the clock soft
 * by design.
 */
export async function ensureTrialStarted(
  appDataDir: string,
  now: () => number,
  gateEnabled: boolean,
): Promise<void> {
  if (!gateEnabled) return;
  const filePath = trialFilePath(appDataDir);
  let repairing = false;
  if (fs.existsSync(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      // Unreadable (a lock) or unparseable. Either way this process has no
      // evidence the clock is broken, so it must not overwrite it.
      return;
    }
    if (parsed === null || trialBodyIsUsable(parsed, now())) return;
    repairing = true;
    warnOnce(
      "trial:repair",
      "[license] trial.json holds no usable firstRunAt (missing, unparseable, before 2020, " +
        "or in the future — a dead RTC writes all three) — rewriting it and starting a fresh " +
        "trial clock. Without this the device stays restricted on every boot with no recovery.",
    );
  }
  const body: TrialFile = { version: 1, firstRunAt: new Date(now()).toISOString() };
  try {
    // The directory may not exist yet — `tandem activate ./x.license`, which the
    // license email recommends, is often the FIRST thing a buyer runs, before
    // Tandem has ever launched. (The activate path gets its mkdir from
    // `atomicWriteConfigFile`; this one writes directly for the `wx` semantics.)
    fs.mkdirSync(appDataDir, { recursive: true });
    // `wx` on the CREATE path only. The repair path has already established
    // that a file is there and that it cannot run a clock, so an exclusive
    // create would throw every time and the repair would never land. Two
    // processes repairing at once both write a `firstRunAt` of roughly now, so
    // losing that race costs nothing.
    fs.writeFileSync(filePath, JSON.stringify(body), { flag: repairing ? "w" : "wx" });
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
