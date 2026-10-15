/**
 * `v1-walkthrough.json` — whether the user has been through the setup wizard
 * on v1.0 (#2198).
 *
 * Bryan, 2026-10-12: "on first launch after updating to v1.0, all users should
 * have to walk through the setup/connection wizard, even if it is not their
 * first launch". "Have to" is a one-click confirm (2026-10-13): the wizard
 * opens pre-filled with **Keep this setup**; closing it without Keep or a
 * successful Apply brings it back on the next launch; after either it never
 * shows again.
 *
 *   - **No record IS pending.** Nothing is written at boot, and this is not
 *     keyed on `checkVersionChange`, which stamps the new version on the same
 *     run — a walkthrough keyed on it could not come back next launch.
 *   - **Written once**, by the confirm route (Keep) or a successful Apply, via
 *     `atomicWriteConfigFile`: a single write, no read-modify-write, so no lock.
 *   - **An unreadable record reads as not pending** (logged), matching the
 *     first-run route's fail-toward-not-auto-opening rule: a wedged file must
 *     not trap the user behind a modal every launch.
 *
 * Everything takes `base` (the app-data dir) as a parameter, never a path
 * frozen at module load, so the vitest app-data isolation reaches it.
 */

import path from "node:path";

import { TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV } from "../../shared/constants.js";
import { isV1Release } from "../version-check.js";
import { atomicWriteConfigFile, readBoundedJsonFileSync } from "./storage.js";

export const WALKTHROUGH_FILE_NAME = "v1-walkthrough.json";
/**
 * Forces the walkthrough ON for a build that is not a v1.0 release, so a
 * release candidate can be smoke-tested (`isV1Release` deliberately rejects
 * `1.0.0-rc.*`). It can only switch the walkthrough on, never off: the off
 * switch is `TANDEM_DISABLE_FIRST_RUN_WIZARD`, and that one wins.
 */
export const TANDEM_FORCE_V1_WALKTHROUGH_ENV = "TANDEM_FORCE_V1_WALKTHROUGH";
const WALKTHROUGH_VERSION = 1;
const MAX_WALKTHROUGH_BYTES = 1024;
/** Read on every first-run GET: say an unreadable record is ignored once. */
let loggedUnreadable = false;

export type WalkthroughVia = "keep" | "apply";

interface WalkthroughRecord {
  version: number;
  /** The app version the walkthrough was confirmed on. */
  confirmedOn: string;
  via: WalkthroughVia;
}

export function walkthroughPath(base: string): string {
  return path.join(base, WALKTHROUGH_FILE_NAME);
}

/** The record, `null` when there is none, or `"unreadable"`. */
function readRecord(base: string): WalkthroughRecord | null | "unreadable" {
  const raw = readBoundedJsonFileSync(walkthroughPath(base), MAX_WALKTHROUGH_BYTES);
  if (raw === null || raw === "unreadable") return raw;
  const parsed = raw as Partial<WalkthroughRecord> | null;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.version !== "number" ||
    typeof parsed.confirmedOn !== "string" ||
    (parsed.via !== "keep" && parsed.via !== "apply")
  ) {
    return "unreadable";
  }
  return { version: parsed.version, confirmedOn: parsed.confirmedOn, via: parsed.via };
}

/**
 * Whether this run owes the user the v1.0 walkthrough. Synchronous (the
 * supervisor reads it at boot, before any await it would otherwise need);
 * never throws.
 *
 * Confirmed means a record confirmed on a v1.0 release, or on this exact
 * version — the latter is what lets a forced rc run be confirmed, while still
 * owing the real walkthrough at 1.0.0.
 */
export function isWalkthroughPending(
  base: string,
  appVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV] === "1") return false;
  if (!isV1Release(appVersion) && env[TANDEM_FORCE_V1_WALKTHROUGH_ENV] !== "1") return false;
  const record = readRecord(base);
  if (record === "unreadable") {
    if (!loggedUnreadable) {
      loggedUnreadable = true;
      console.error("[Tandem] Could not read the v1.0 walkthrough record — not showing it");
    }
    return false;
  }
  if (record === null) return true;
  return !(isV1Release(record.confirmedOn) || record.confirmedOn === appVersion);
}

/** The user kept their setup, or applied one: the walkthrough is done. */
export async function markWalkthroughConfirmed(
  base: string,
  appVersion: string,
  via: WalkthroughVia,
): Promise<void> {
  const record: WalkthroughRecord = { version: WALKTHROUGH_VERSION, confirmedOn: appVersion, via };
  await atomicWriteConfigFile(walkthroughPath(base), `${JSON.stringify(record, null, 2)}\n`);
}
