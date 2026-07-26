/**
 * `tandem activate <license-or-path>` and `tandem license` (#1116, ADR-040).
 *
 * Both operate on the LOCAL appData store directly — no running server required.
 * The server re-resolves license state per dispatch (no cache), so activating
 * here takes effect on the running server's next tool call / reconnect.
 */
import fs from "fs";
import { LicenseActivationError } from "../server/license/errors.js";
import { GATE_ENABLED } from "../server/license/gate-flag.js";
import { activateLicense, resolveLicenseState } from "../server/license/license-state.js";
import type { LicenseState } from "../server/license/license-types.js";
import { activationErrorMessage } from "../server/license/messages.js";
import { normalizePastedLicense } from "../server/license/paste.js";
import { resolveAppDataDir } from "../server/platform.js";
import { TANDEM_PURCHASE_URL, TANDEM_SUPPORT_EMAIL } from "../shared/constants.js";

/**
 * Resolve the activate argument to a license blob. If it names a readable file
 * (e.g. a `.license` file emailed to a beta tester), read that file's contents;
 * otherwise treat the argument itself as the pasted blob. `fs.existsSync` never
 * throws — a base64 blob containing `/` simply isn't a real path and falls
 * through to the literal branch.
 */
export function resolveLicenseInput(
  arg: string,
  fileExists: (p: string) => boolean,
  readFile: (p: string) => string,
): string {
  // `normalizePastedLicense` (not a bare trim) so a blob copied out of a
  // quoted-printable-encoded email still activates — see paste.ts.
  if (fileExists(arg)) return normalizePastedLicense(readFile(arg));
  return normalizePastedLicense(arg);
}

/**
 * Human-readable lines for `tandem license`. Pure (given an already-resolved
 * state) so the formatting is unit-testable without touching disk.
 */
export function formatLicenseStatus(state: LicenseState, enforcementOn: boolean): string[] {
  const lines: string[] = ["", "Tandem license", ""];
  lines.push(`  Enforcement:   ${enforcementOn ? "on" : "off (activates at v1.0)"}`);
  if (state.gateActive && state.status === "trial") {
    lines.push(`  Status:        trial (${state.trial.daysRemaining} of 14 days remaining)`);
  } else if (state.gateActive && state.status === "restricted") {
    lines.push("  Status:        restricted — trial ended; activate a license to keep editing");
    lines.push(`  Buy a license: ${TANDEM_PURCHASE_URL}`);
  } else {
    // licensed (gate-active) — or the dark arm, which `tandem license` never
    // produces (it forces gateEnabled:true), but the union requires the branch.
    lines.push("  Status:        licensed");
    if (state.gateActive && state.status === "licensed") {
      lines.push(`  Licensee:      ${state.license.name} (${state.license.type})`);
      const window = state.updateWindowCurrent ? "current" : "expired";
      const through = state.license.expiresAt
        ? ` (through ${state.license.expiresAt.slice(0, 10)})`
        : "";
      lines.push(`  Update window: ${window}${through}`);
      if (!state.updateWindowCurrent) {
        // The single most confusing state in the whole system: the app keeps
        // saying "You're up to date" because the update endpoint is returning
        // no-update, not because there is nothing to install.
        lines.push("                 (Tandem keeps running; new releases are no longer offered.)");
      }
    }
  }
  // A license file exists but doesn't verify. Without this line all three
  // surfaces tell the holder of a license that their *trial* ended.
  if (state.gateActive && state.status !== "licensed" && state.licenseUnverifiable) {
    lines.push("");
    lines.push("  A license file is installed but could not be verified.");
    lines.push("  It may have been issued before a signing-key change, or the file may be");
    lines.push(`  damaged. Re-activate it, or email ${TANDEM_SUPPORT_EMAIL} to have it reissued.`);
  }
  lines.push("");
  return lines;
}

/**
 * `tandem license` — print the on-device license/trial state. Forces full
 * resolution (gateEnabled: true) so a beta tester can confirm an installed
 * license even while enforcement still ships dark; the "Enforcement" line
 * separately reports the real build flag.
 */
export async function runLicenseStatus(): Promise<void> {
  const state = resolveLicenseState({
    appDataDir: resolveAppDataDir(),
    now: () => Date.now(),
    gateEnabled: true,
  });
  for (const line of formatLicenseStatus(state, GATE_ENABLED)) console.log(line);
}

/**
 * `tandem activate <license-or-path>` — verify + persist a signed license.
 * Exits non-zero with a generic message on a bad license (no blob bytes echoed).
 */
export async function runActivate(args: string[]): Promise<void> {
  const input = args[1];
  if (!input) {
    console.error("Usage: tandem activate <license-string-or-path>");
    process.exit(1);
  }
  const blob = resolveLicenseInput(input, fs.existsSync, (p) => fs.readFileSync(p, "utf-8"));
  try {
    const state = await activateLicense(resolveAppDataDir(), blob);
    const lic = state.gateActive && state.status === "licensed" ? state.license : null;
    const who = lic ? `${lic.name} (${lic.type})` : "this device";
    console.log(`\n✓ License activated for ${who}.`);
    if (lic?.expiresAt) {
      console.log(`  Updates included through ${lic.expiresAt.slice(0, 10)}.`);
    }
    console.log("");
  } catch (err) {
    // Same per-cause copy the HTTP route uses — one taxonomy, two transports.
    const code = err instanceof LicenseActivationError ? err.code : "UNKNOWN";
    console.error(`\n[Tandem] License activation failed.\n${activationErrorMessage(code)}\n`);
    process.exit(1);
  }
}
