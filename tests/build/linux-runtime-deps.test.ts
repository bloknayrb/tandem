/**
 * Regression pin for Linux runtime dependencies that a Cargo feature introduces
 * but the Tauri bundler cannot see (#1227).
 *
 * WHAT THIS IS: a pin on couplings we already know about and have already
 * verified. It is the same shape as `plugin-version-pin.test.ts` — keep N
 * surfaces that must agree from silently drifting apart.
 *
 * WHAT THIS IS NOT: detection. It cannot catch a *new* undeclared library,
 * because a row only exists here once someone already knew to write it. Nobody
 * would have added the libxdo row before #923 introduced the problem. Don't
 * read a green run here as "our Linux packaging is sound" — that question is
 * answered by `scripts/smoke/linux-package-smoke.sh`, which installs the real
 * package in the real target distro and loads the binary. This file only
 * guarantees that a fix, once made, stays made.
 *
 * BAR FOR ADDING A ROW: the package names must have been verified by installing
 * them in a container, not inferred from the soname. On Fedora the plausible
 * `xdotool-libs` does not exist; the real provider is `libxdo`, found via
 * `dnf provides 'libxdo.so.3()(64bit)'`. Guessing here produces a test that
 * passes while the package stays broken — worse than no test.
 *
 * Background: `tauri-cli`'s `tauri_config_to_bundle_settings()` emits a fixed
 * dependency list (libwebkit2gtk-4.1-0, libgtk-3-0, libappindicator3-1) plus
 * whatever `bundle.linux.{deb,rpm}.depends` says. It never reads the ELF. So a
 * DT_NEEDED entry added by any other means is invisible to packaging, and the
 * package installs cleanly and then fails to launch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");

const cargoToml = readFileSync(join(repoRoot, "src-tauri/Cargo.toml"), "utf8");
const tauriConf = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8")) as {
  bundle?: {
    linux?: {
      deb?: { depends?: string[] };
      rpm?: { depends?: string[] };
    };
  };
};

/**
 * Each row: a Cargo feature that adds a hard DT_NEEDED, and the package that
 * provides it on each distro family. `verifiedBy` is not decoration — it is the
 * evidence that the names are real, and the reason a future row can't be
 * added on a guess.
 */
const FEATURE_RUNTIME_DEPS = [
  {
    feature: "linux-libxdo",
    soname: "libxdo.so.3",
    deb: "libxdo3",
    rpm: "libxdo",
    verifiedBy: "docs/spikes/linux-container-install-smoke.md",
  },
] as const;

const debDepends = tauriConf.bundle?.linux?.deb?.depends ?? [];
const rpmDepends = tauriConf.bundle?.linux?.rpm?.depends ?? [];

/**
 * Matches the feature list of the `tauri` dependency line specifically, not any
 * occurrence of the string anywhere in the file — a mention in a comment (there
 * is one, right above the dependency) must not read as the feature being on.
 */
function tauriFeatures(): string[] {
  const line = cargoToml.split("\n").find((l) => /^tauri\s*=\s*\{/.test(l));
  if (!line) return [];
  const features = /features\s*=\s*\[([^\]]*)\]/.exec(line);
  if (!features) return [];
  return [...features[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("Linux runtime dependencies the bundler cannot infer", () => {
  const enabled = tauriFeatures();

  it("parses the tauri feature list (guards the regex itself)", () => {
    // If this ever comes back empty the whole suite silently passes: every
    // coupling below is conditional on the feature being detected. A parse
    // failure must fail loudly, not disarm the file.
    expect(enabled.length).toBeGreaterThan(0);
    expect(enabled).toContain("tray-icon");
  });

  for (const dep of FEATURE_RUNTIME_DEPS) {
    describe(`${dep.feature} → ${dep.soname}`, () => {
      const isEnabled = enabled.includes(dep.feature);

      it.runIf(isEnabled)(`declares ${dep.deb} in bundle.linux.deb.depends`, () => {
        expect(debDepends).toContain(dep.deb);
      });

      it.runIf(isEnabled)(`declares ${dep.rpm} in bundle.linux.rpm.depends`, () => {
        expect(rpmDepends).toContain(dep.rpm);
      });

      // The converse. A stale depends entry is a smaller problem than a missing
      // one — it makes users install a library nothing needs — but it is still
      // a lie in the package metadata, and it is the state you land in if the
      // feature is ever dropped.
      it.runIf(!isEnabled)("does not declare a dependency for a disabled feature", () => {
        expect(debDepends).not.toContain(dep.deb);
        expect(rpmDepends).not.toContain(dep.rpm);
      });
    });
  }
});
