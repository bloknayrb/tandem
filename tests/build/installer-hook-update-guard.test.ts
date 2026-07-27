/**
 * Regression pin for the NSIS pre-uninstall hook (#1236).
 *
 * WHAT THIS IS: a pin on two properties of `installer-hook.nsi` that are
 * invisible in CI — nothing in the repo builds or runs an NSIS installer on
 * Linux, so a bad edit here ships silently and is only discovered by a user
 * whose settings evaporated during an update.
 *
 * The two properties:
 *
 * 1. **The `$UpdateMode` guard.** Tauri's NSIS template runs the OLD
 *    uninstaller when installing over an existing version (`PageLeaveReinstall`
 *    executes the stored `UninstallString` with `/UPDATE` appended), and it
 *    inserts `NSIS_HOOK_PREUNINSTALL` unconditionally at the top of
 *    `Section Uninstall`. Without the guard, every routine upgrade runs the
 *    full scrub and wipes the user's Cowork registrations, firewall rules, and
 *    start-at-login preference.
 *
 * 2. **`${MAINBINARYNAME}` instead of a hardcoded exe name.** With no
 *    `mainBinaryName` in tauri.conf.json and no `[[bin]]` section, Tauri names
 *    the binary after the Cargo package (`tandem-desktop`). The hook previously
 *    hardcoded `tandem.exe`, which matched no file on disk — one of the two
 *    reasons the scrub had never actually run.
 *
 * WHAT THIS IS NOT: proof the hook works. Only a real Windows install/uninstall
 * /update cycle answers that; it is on the manual QA checklist.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hookPath = path.join(repoRoot, "src-tauri/windows/installer-hook.nsi");
const hook = fs.readFileSync(hookPath, "utf8");

/** The body of the NSIS_HOOK_PREUNINSTALL macro, without surrounding noise. */
function preuninstallBody(source: string): string {
  const start = source.indexOf("!macro NSIS_HOOK_PREUNINSTALL");
  expect(start, "NSIS_HOOK_PREUNINSTALL macro is missing").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("!macroend", start);
  expect(end, "NSIS_HOOK_PREUNINSTALL macro is unterminated").toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("installer-hook.nsi pre-uninstall hook", () => {
  const body = preuninstallBody(hook);

  it("guards the scrub behind $UpdateMode so upgrades don't wipe user state", () => {
    expect(body).toMatch(/\$\{If\}\s+\$UpdateMode\s*<>\s*1/);
  });

  it("runs the scrub inside the guard, not beside it", () => {
    const guardAt = body.search(/\$\{If\}\s+\$UpdateMode/);
    const scrubAt = body.indexOf("--uninstall-scrub");
    const endAt = body.indexOf("${EndIf}");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(scrubAt).toBeGreaterThan(guardAt);
    expect(endAt).toBeGreaterThan(scrubAt);
  });

  it("invokes the real binary name, not a hardcoded one", () => {
    expect(body).toContain("${MAINBINARYNAME}.exe");
    // `tandem.exe` was never a file Tauri produced.
    expect(body).not.toContain('"$INSTDIR\\tandem.exe"');
  });

  it("still runs the scrub inside the signed app binary (no separate exe)", () => {
    // Security invariant: a separate `uninstall_scrub.exe` would be
    // plantable on a PATH search path during uninstall.
    expect(body).toContain("$INSTDIR\\");
    expect(body).not.toMatch(/uninstall_scrub\.exe/);
  });
});

describe("tauri.conf.json assumptions the hook depends on", () => {
  const conf = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
  ) as {
    productName?: string;
    bundle?: { windows?: { nsis?: { installMode?: string; installerHooks?: string } } };
  };

  it("keeps the installer hook wired", () => {
    expect(conf.bundle?.windows?.nsis?.installerHooks).toBe("windows/installer-hook.nsi");
  });

  it("leaves installMode unset, so the Run key the scrub deletes is HKCU", () => {
    // Tauri defaults NSIS to currentUser. If this ever becomes "perMachine",
    // `reg delete HKCU\...\Run` in uninstall_scrub.rs deletes the wrong hive
    // and the autostart entry survives uninstall.
    expect(conf.bundle?.windows?.nsis?.installMode).toBeUndefined();
  });

  it("keeps productName aligned with the autostart registration name", () => {
    // `tauri-plugin-autostart` files the registration under
    // `package_info().name`, i.e. productName. `uninstall_scrub.rs` pins the
    // same string; this is the JS-side half of that agreement.
    expect(conf.productName).toBe("Tandem");
  });
});
