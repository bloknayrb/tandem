import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The Linux tray library and the package smoke that proves it resolves.
 *
 * The `.deb` says `Depends: libappindicator3-1`. tauri-cli injects that entry
 * (`tauri_config_to_bundle_settings`, crates/tauri-cli/src/interface/rust.rs),
 * and config can append to it but never remove it. Debian 12 and 13 have no
 * real `libappindicator3-1`. The `.deb` installs there anyway because
 * `libayatana-appindicator3-1` declares `Provides: libappindicator3-1 (= 12.10)`
 * — measured 2026-11-06 on ubuntu:22.04, ubuntu:24.04, debian:12, debian:13
 * and debian:sid. On Ubuntu the real package exists and is what apt installs.
 *
 * Why the ayatana dependency is NOT the fix, and why the env var below pins
 * libappindicator: the in-app updater applies a `.deb` with `dpkg -i`
 * (tauri-plugin-updater 2.14.0, `src/updater.rs:1336`), which resolves no
 * dependencies. Every existing Ubuntu install holds the real
 * `libappindicator3-1`, and ayatana `Conflicts` with it. Measured: a `.deb`
 * whose only change is `Depends: libayatana-appindicator3-1`, applied with
 * `dpkg -i` over 0.30.0, leaves tandem `iU` (unconfigured), and apt then
 * refuses every operation until `--fix-broken`. Unset, tauri-cli prefers
 * ayatana whenever its pkg-config file is present, so a runner image that
 * gained `libayatana-appindicator3-dev` would cause that silently.
 *
 * `tauri-release.yml` runs only on tags, so this file is the only PR-time
 * guard (the ADR-051 case). Every finder throws, per release-signing-gates:
 * a finder returning `undefined` makes deleting the step the one change that
 * passes.
 */

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, unknown> };

const workflow = parse(
  readFileSync(path.join(ROOT, ".github/workflows/tauri-release.yml"), "utf-8"),
) as { jobs: Record<string, { steps: Step[] }> };

const buildJob = workflow.jobs["build-tauri"];
if (!buildJob) throw new Error("tauri-release.yml: no `build-tauri` job");

function onlyStep(what: string, pred: (s: Step) => boolean): Step {
  const found = buildJob.steps.filter(pred);
  if (found.length !== 1) {
    throw new Error(`tauri-release.yml: expected exactly one ${what} step, found ${found.length}`);
  }
  return found[0] as Step;
}

const runIncludes = (marker: string) => (s: Step) =>
  typeof s.run === "string" && s.run.includes(marker);

const smokeScriptPath = path.join(ROOT, "scripts/smoke/linux-package-smoke.sh");
const smokeScript = readFileSync(smokeScriptPath, "utf-8");

describe("Linux tray library choice (tauri-cli's injected dependency)", () => {
  const tauriAction = onlyStep(
    "tauri-action",
    (s) => typeof s.uses === "string" && s.uses.startsWith("tauri-apps/tauri-action@"),
  );
  // Located by a package this file does not assert about.
  const install = onlyStep("Linux dependency install", runIncludes("libwebkit2gtk-4.1-dev"));

  it('pins TAURI_LINUX_AYATANA_APPINDICATOR to "false" on the tauri-action step', () => {
    // "false" is not a documented value: tauri-cli treats "true"/"1" as
    // ayatana and ANY other set value as "force libappindicator, fail the build
    // if appindicator3-0.1.pc is missing". Unset means "prefer ayatana".
    expect(tauriAction.env?.TAURI_LINUX_AYATANA_APPINDICATOR).toBe("false");
  });

  it("installs the libappindicator -dev package and not the ayatana one", () => {
    const line = (install.run as string)
      .split("\n")
      .find((l) => /^\s*sudo apt-get install\b/.test(l));
    if (!line) throw new Error("no `sudo apt-get install` line in the Linux dependency step");
    const pkgs = line.trim().split(/\s+/);
    // Required: with the env var "false", tauri-cli `expect`s this .pc.
    expect(pkgs).toContain("libappindicator3-dev");
    // Belt and braces: with both present, any future drop of the env var flips
    // the package to ayatana with no error.
    expect(pkgs).not.toContain("libayatana-appindicator3-dev");
  });
});

describe("Linux package smoke wiring", () => {
  const smoke = onlyStep("package smoke", runIncludes("linux-package-smoke.sh"));
  const run = smoke.run as string;

  it("runs the .deb on Ubuntu LTS and Debian, and the .rpm on Fedora", () => {
    // Anchored whole lines in the step's own body, so a comment cannot satisfy it.
    const legs = [...run.matchAll(/^\s*run_smoke\s+(\S+)\s+(\S+)\s*$/gm)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(legs).toEqual([
      "deb ubuntu:22.04",
      "deb ubuntu:24.04",
      "deb debian:12",
      "deb debian:13",
      "rpm fedora:44",
    ]);
  });

  it("reads docker's own failure (125) as an environment fault, not a defect", () => {
    expect(run).toMatch(/^\s*125\)\s*echo "::warning::/m);
    expect(run).toMatch(/^\s*3\)\s*echo "::warning::/m);
  });
});

describe("linux-package-smoke.sh", () => {
  it("parses (it only ever runs on a tag build)", () => {
    const r = spawnSync("bash", ["-n", smokeScriptPath], { encoding: "utf-8" });
    expect(r.error).toBeUndefined();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("checks the four sonames libappindicator-sys dlopens, in its order", () => {
    const m = smokeScript.match(/^TRAY_SONAMES="([^"]+)"$/m);
    if (!m) throw new Error("TRAY_SONAMES not found in linux-package-smoke.sh");
    expect(m[1].split(" ")).toEqual([
      "libayatana-appindicator3.so.1",
      "libappindicator3.so.1",
      "libayatana-appindicator3.so",
      "libappindicator3.so",
    ]);
  });

  it("is tied to the libappindicator-sys version that list was copied from", () => {
    // The list above is 0.9.0's (backcompat on). A bump must revisit it.
    const lock = readFileSync(path.join(ROOT, "src-tauri/Cargo.lock"), "utf-8");
    const m = lock.match(/^name = "libappindicator-sys"\nversion = "([^"]+)"$/m);
    if (!m) throw new Error("libappindicator-sys not found in src-tauri/Cargo.lock");
    expect(m[1]).toBe("0.9.0");
  });

  it("checks the tray library after install and before uninstall", () => {
    const at = (marker: string) => {
      const i = smokeScript.indexOf(marker);
      if (i < 0) throw new Error(`'${marker}' not found in linux-package-smoke.sh`);
      return i;
    };
    const tray = at("=== [4b] tray library");
    expect(tray).toBeGreaterThan(at("=== [2] install ==="));
    expect(tray).toBeLessThan(at("=== [7] uninstall ==="));
  });

  it("makes an unreachable apt mirror an environment fault", () => {
    // Without Error-Mode=any, apt-get update exits 0 with every index failed.
    expect(smokeScript).toMatch(/^\s*apt-get update\b.*-o APT::Update::Error-Mode=any/m);
  });
});
