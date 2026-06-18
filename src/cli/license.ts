/**
 * `tandem activate <license-or-path>` and `tandem license` (#1116, ADR-040).
 *
 * Both operate on the LOCAL appData store directly — no running server required.
 * The server re-resolves license state per dispatch (no cache), so activating
 * here takes effect on the running server's next tool call / reconnect.
 */
import fs from "fs";
import { GATE_ENABLED } from "../server/license/gate-flag.js";
import { activateLicense, resolveLicenseState } from "../server/license/license-state.js";
import type { LicenseState } from "../server/license/license-types.js";
import { resolveAppDataDir } from "../server/platform.js";

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
  if (fileExists(arg)) return readFile(arg).trim();
  return arg.trim();
}

/**
 * Human-readable lines for `tandem license`. Pure (given an already-resolved
 * state) so the formatting is unit-testable without touching disk.
 */
export function formatLicenseStatus(state: LicenseState, enforcementOn: boolean): string[] {
  const lines: string[] = ["", "Tandem license", ""];
  lines.push(`  Enforcement:   ${enforcementOn ? "on" : "off (activates at v1.0)"}`);
  if (state.status === "trial") {
    lines.push(`  Status:        trial (${state.trial?.daysRemaining ?? 0} days remaining)`);
  } else if (state.status === "restricted") {
    lines.push("  Status:        restricted — trial ended; activate a license to keep editing");
  } else {
    lines.push("  Status:        licensed");
    if (state.license) {
      lines.push(`  Licensee:      ${state.license.name} (${state.license.type})`);
    }
    const window = state.updateWindowCurrent ? "current" : "expired";
    const through = state.license?.expiresAt
      ? ` (through ${state.license.expiresAt.slice(0, 10)})`
      : "";
    lines.push(`  Update window: ${window}${through}`);
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
    const who = state.license ? `${state.license.name} (${state.license.type})` : "this device";
    console.log(`\n✓ License activated for ${who}.`);
    if (state.license?.expiresAt) {
      console.log(`  Updates included through ${state.license.expiresAt.slice(0, 10)}.`);
    }
    console.log("");
  } catch {
    console.error(
      "\n[Tandem] License activation failed: the license could not be verified.\n" +
        "Check that you pasted the full license string (or gave the correct file path).\n",
    );
    process.exit(1);
  }
}
