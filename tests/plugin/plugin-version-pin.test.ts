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
 *     (`Tandem_<version>_x64.dmg`, …). A stale value here builds
 *     correctly-coded installers under the WRONG version. It used to also
 *     mis-*target* the release, via the tauri-action `__VERSION__`
 *     substitution — that is how v0.15.0's 0.14.3-named artifacts clobbered
 *     the published v0.14.3 release. `tauri-release.yml` no longer works that
 *     way: the release is targeted by the pushed git tag, and its
 *     `create-release` job fails the build outright when the tag and this file
 *     disagree. So the wrong-release failure mode is gone; the wrong-*name*
 *     one is what this assertion still guards, and this surface has no
 *     CARGO_PKG_VERSION-style derivation, so it silently rots.
 *
 *   - `.claude-plugin/marketplace.json` — the plugin entry's `source.ref`, the
 *     release tag the marketplace installs the plugin from. Without it the
 *     plugin installs from the default branch, which under the licensor's
 *     2026-10-09 decision (A7: a version of the Licensed Work is a published
 *     release) is a copy that belongs to no version. This surface is the one exception to
 *     "matches package.json": see its test below for why it may lag by one.
 *
 * This test fails CI the moment any of them diverges from package.json
 * (the marketplace ref aside, which may trail it by one release).
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
  name: string;
  version: string;
  mcpServers: Record<string, { command?: string; args?: string[] }>;
  experimental?: { monitors?: Array<{ command?: string }> };
};

const cargoToml = readFileSync(join(repoRoot, "src-tauri/Cargo.toml"), "utf8");

const tauriConf = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8")) as {
  version: string;
};

const marketplace = JSON.parse(
  readFileSync(join(repoRoot, ".claude-plugin/marketplace.json"), "utf8"),
) as { plugins: Array<{ name: string; source?: { ref?: string } }> };

/** Every `## [x.y.z]` release heading in CHANGELOG.md, newest first. */
const changelogVersions = [
  ...readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8").matchAll(/^## \[(\d[^\]]*)\]/gm),
].map((m) => m[1]);

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

/**
 * Extract the `tandem-editor@<version>` pin from a shell-STRING command.
 * `experimental.monitors[]` entries carry a single `command` string
 * (`npx -y tandem-editor@<v> monitor`), NOT a `command`+`args[]` pair, so the
 * `args`-array walker above can't see them — a monitor pin would silently rot.
 */
function pinnedVersionFromCommand(command: string | undefined): string | undefined {
  return command?.match(/tandem-editor@(\S+)/)?.[1];
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
    // Drives desktop artifact names. A stale value ships mis-versioned
    // installers; the release it lands ON is now the pushed git tag, and
    // tauri-release.yml's create-release job refuses to build when the two
    // disagree.
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

  it("every plugin.json experimental.monitors npx entry pins the package.json version", () => {
    // The monitor ships via `npx -y tandem-editor@<v> monitor` because dist/ is
    // gitignored — a github plugin clone carries no built monitor binary, while
    // npm ships dist, so npx delivers it. The pin lives in a shell-string
    // `command`, invisible to the mcpServers args-walker above, so it needs its
    // own guard or it silently rots on the next release bump.
    const monitors = plugin.experimental?.monitors ?? [];
    const npxMonitors = monitors.filter((m) => m.command?.includes("tandem-editor"));
    // Guards against the pin being dropped to a bare `tandem-editor`, or the
    // npx monitor entry disappearing entirely.
    expect(npxMonitors.length).toBeGreaterThan(0);
    for (const m of npxMonitors) {
      expect(
        pinnedVersionFromCommand(m.command),
        `monitor command "${m.command}" must pin tandem-editor@${expected}`,
      ).toBe(expected);
    }
  });

  it("marketplace.json pins the plugin to a published stable release tag, at most one release behind", () => {
    // Not equality with package.json, on purpose. The ref must never name a
    // tag that does not exist yet, and the tag is cut from master AFTER the
    // version-bump PR merges, so the bump PR has to leave the ref on the
    // previous release. The release skill bumps it in a follow-up once the
    // new release is published and on npm (the tagged plugin.json pins
    // `npx tandem-editor@<that version>`, so an earlier ref bump would ship a
    // plugin whose MCP server cannot be fetched). Tightening this to equality
    // would turn every release-bump PR red.
    //
    // What this CAN guard: the ref is present (a dropped ref silently goes back
    // to installing from the default branch), it is a `v<x.y.z>` tag with no
    // prerelease suffix (plugin users stay on stable, like `releases/latest`),
    // and it lags package.json by at most one stable release, so a forgotten
    // follow-up fails CI at the next bump. What it CANNOT guard: that the tag
    // exists. CI's checkout is depth-1 and tagless, so the CHANGELOG heading
    // stands in for "this version was released".
    const entry = marketplace.plugins.find((p) => p.name === plugin.name);
    const ref = entry?.source?.ref;
    expect(ref, "marketplace.json's plugin entry must set source.ref").toBeDefined();
    const refVersion = /^v(\d+\.\d+\.\d+)$/.exec(ref ?? "")?.[1];
    expect(refVersion, `source.ref "${ref}" must be a stable v<x.y.z> release tag`).toBeDefined();

    const current = changelogVersions.indexOf(expected);
    expect(current, `CHANGELOG.md has no ## [${expected}] heading`).toBeGreaterThanOrEqual(0);
    const previousStable = changelogVersions.slice(current + 1).find((v) => !v.includes("-"));
    const allowed = [expected, previousStable].filter(
      (v): v is string => v !== undefined && !v.includes("-"),
    );
    expect(allowed).toContain(refVersion);
  });
});
