/**
 * Drift guard for the npx bridge version pin.
 *
 * The `tandem` MCP bridge is launched via `npx -y tandem-editor@<version> mcp-stdio`.
 * Pinning an EXACT version is what forces `npm exec` past a stale global
 * `tandem-editor` (the root cause of the "Server disconnected" / "Could not
 * attach to MCP server tandem" failure). Two surfaces hardcode that version and
 * WILL silently rot if left unguarded:
 *   - `.claude-plugin/plugin.json` — static JSON shipped from this repo to the
 *     marketplace (its own top-level `version` field was already 5 minors stale).
 *   - `src-tauri/Cargo.toml` — the Cowork installer pins via `env!("CARGO_PKG_VERSION")`,
 *     which is only correct while the Rust crate version equals the npm version.
 *   - `src-tauri/tauri.conf.json` — drives the desktop bundle artifact names
 *     (`Tandem_<version>_x64.dmg`, …) AND the tauri-action `__VERSION__` that
 *     names/targets the GitHub release. A stale value here builds correctly-coded
 *     installers under the WRONG version and uploads them onto the PREVIOUS
 *     release (observed on v0.15.0: 0.14.3-named artifacts clobbered the
 *     published v0.14.3 release). This surface has no CARGO_PKG_VERSION-style
 *     derivation, so it silently rots.
 *
 * This test fails CI the moment any of them diverges from package.json.
 * (`src/server/integrations/apply.ts` build-injects the version from package.json
 * via tsup defines, so it cannot drift and needs no assertion here.)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
const expected = pkg.version;

const plugin = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin/plugin.json"), "utf8")) as {
  version: string;
  mcpServers: Record<string, { command?: string; args?: string[] }>;
};

const cargoToml = readFileSync(join(repoRoot, "src-tauri/Cargo.toml"), "utf8");

const tauriConf = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8")) as {
  version: string;
};

/** Pull the version from the first `[package]` table in Cargo.toml. */
function cargoPackageVersion(toml: string): string {
  const pkgSection = toml.split(/^\[/m).find((s) => s.startsWith("package]"));
  const m = pkgSection?.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return m?.[1] ?? "";
}

/** Extract the `tandem-editor@<version>` pin from an `npx -y <spec> <cmd>` args array. */
function pinnedVersion(args: string[] | undefined): string | undefined {
  const spec = args?.find((a) => a.startsWith("tandem-editor@"));
  return spec?.slice("tandem-editor@".length);
}

describe("plugin/version pin drift guard", () => {
  it("plugin.json top-level version matches package.json", () => {
    expect(plugin.version).toBe(expected);
  });

  it("src-tauri/Cargo.toml [package] version matches package.json", () => {
    // The Cowork installer pins tandem-editor via env!("CARGO_PKG_VERSION"),
    // so a divergent crate version would pin the WRONG npm package version.
    expect(cargoPackageVersion(cargoToml)).toBe(expected);
  });

  it("src-tauri/tauri.conf.json version matches package.json", () => {
    // Drives desktop artifact names and the tauri-action release __VERSION__.
    // A stale value ships mis-versioned installers onto the wrong release.
    expect(tauriConf.version).toBe(expected);
  });

  it("every plugin.json npx tandem-editor entry pins the package.json version", () => {
    const npxEntries = Object.entries(plugin.mcpServers).filter(
      ([, e]) => e.command === "npx" && e.args?.some((a) => a.startsWith("tandem-editor")),
    );
    // Guards against the pin being dropped back to a bare `tandem-editor`.
    expect(npxEntries.length).toBeGreaterThan(0);
    for (const [name, entry] of npxEntries) {
      expect(pinnedVersion(entry.args), `${name} must pin tandem-editor@${expected}`).toBe(
        expected,
      );
    }
  });
});
