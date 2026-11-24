import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildStagingOverlay,
  licenseUpdateEndpointFrom,
  PRODUCTION_ENDPOINT,
  STAGING_VERSION,
  validateManifestUrl,
} from "../../scripts/staging-update/build-staging.mjs";

/**
 * #2280 — the staging update channel. A staging build is an ordinary desktop
 * build made with a `cargo tauri build --config <overlay>` that points the
 * updater at another manifest. Bryan rejected a runtime endpoint override in
 * shipped builds (2026-10-22, OPS08) as updater attack surface, so the whole
 * safety argument is "only a build-time overlay can redirect the updater, and
 * the release path never applies one". These tests pin that argument's parts:
 *
 *   1. The shipped config still reads the production manifest, with nothing
 *      else in `src-tauri/` that Tauri would auto-merge over it.
 *   2. No workflow can apply an overlay: no `--config` in a tauri-action
 *      `args`, no `TAURI_CONFIG`, no reference to the staging script.
 *   3. The overlay has a fixed shape that never touches the pubkey or the
 *      transport, and refuses the production pointer.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("the shipped updater config", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    plugins: { updater: Record<string, unknown> & { endpoints: string[] } };
  };

  it("reads only the production manifest", () => {
    expect(conf.plugins.updater.endpoints).toEqual([PRODUCTION_ENDPOINT]);
  });

  it("never allows insecure transport", () => {
    expect(JSON.stringify(conf)).not.toMatch(/dangerousInsecureTransportProtocol/);
  });

  it("has no sibling config Tauri would merge into a release build", () => {
    // Tauri auto-merges tauri.{windows,macos,linux,android,ios}.conf.json and
    // also reads tauri.conf.json5 / Tauri.toml as the base. Any of them could
    // carry an updater endpoint into a release build without a `--config`.
    const extras = readdirSync(path.join(ROOT, "src-tauri")).filter(
      (f) => /^tauri\b.*\.(json5?|toml)$/i.test(f) && f !== "tauri.conf.json",
    );
    expect(extras).toEqual([]);
  });
});

describe("no release workflow can apply a staging overlay", () => {
  const dir = path.join(ROOT, ".github/workflows");
  const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it("found the workflows", () => {
    expect(workflows).toContain("tauri-release.yml");
  });

  for (const f of workflows) {
    it(`${f} passes no config overlay to Tauri`, () => {
      const text = readFileSync(path.join(dir, f), "utf8");
      expect(text, "TAURI_CONFIG merges JSON into the build config").not.toMatch(/TAURI_CONFIG/);
      expect(text).not.toMatch(/staging-update|build:tauri:staging|staging-updater/);
      // tauri-action forwards `args` to `tauri build`; `-c`/`--config` there
      // would merge an overlay into the signed release.
      for (const m of text.matchAll(/^\s*args:\s*(.*)$/gm)) {
        // A block scalar or a list on the following lines would hide its
        // contents from the single-line check below, so require one line.
        expect(m[1].trim(), `${f}: \`args:\` must be a single-line value`).not.toMatch(/^([|>]|$)/);
        expect(m[1], `${f}: ${m[0].trim()}`).not.toMatch(/(^|[\s"'])(--config|-c)(?=[\s=]|$)/);
      }
    });
  }

  it("the release build script applies no overlay", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:tauri"]).not.toMatch(/--config|TAURI_CONFIG/);
    expect(pkg.scripts["build:tauri:staging"]).toBe(
      "node scripts/staging-update/build-staging.mjs",
    );
  });
});

describe("the staging overlay", () => {
  const STAGING =
    "https://github.com/example/tandem-update-staging/releases/latest/download/latest.json";

  it("has exactly the three keys the script documents", () => {
    expect(buildStagingOverlay(STAGING)).toEqual({
      version: STAGING_VERSION,
      bundle: { createUpdaterArtifacts: false },
      plugins: { updater: { endpoints: [STAGING] } },
    });
  });

  it("keeps the production pubkey and transport (merge patch leaves absent keys alone)", () => {
    const text = JSON.stringify(buildStagingOverlay(STAGING));
    expect(text).not.toMatch(/pubkey|dangerousInsecureTransportProtocol|identifier|windows/);
  });

  it("uses a version below every real release", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as { version: string };
    const n = (v: string) => v.split(/[.-]/).slice(0, 3).map(Number);
    const [a, b, c] = n(STAGING_VERSION);
    const [x, y, z] = n(conf.version);
    expect(a * 1e6 + b * 1e3 + c).toBeLessThan(x * 1e6 + y * 1e3 + z);
    expect(STAGING_VERSION).toMatch(/^\d+\.\d+\.\d+$/); // MSI wants numeric-only
  });

  it("accepts a real release's per-tag manifest (the RC forward-update row)", () => {
    const perTag = "https://github.com/bloknayrb/tandem/releases/download/v1.0.0-rc.1/latest.json";
    expect(validateManifestUrl(perTag)).toBe(perTag);
  });

  it.each([
    PRODUCTION_ENDPOINT,
    "https://github.com/bloknayrb/tandem/releases/latest",
    "https://GitHub.com/BloknayrB/Tandem/releases/latest/download/latest.json",
    "https://www.github.com/bloknayrb/tandem/releases/latest/download/latest.json",
    "https://github.com./bloknayrb/tandem/releases/latest/download/latest.json",
    "https://github.com/bloknayrb/tandem//releases/latest/download/latest.json",
    "https://github.com/bloknayrb/tandem/releases/%6catest/download/latest.json",
  ])("refuses the production pointer: %s", (u) => {
    expect(() => validateManifestUrl(u)).toThrow(/production/);
  });

  it.each([
    ["http://example.com/latest.json", /https/],
    ["file:///tmp/latest.json", /https/],
    ["https://user:pw@example.com/latest.json", /credentials/],
    ["not a url", /not a URL/],
    ["https://example.com/%E0%A4%A/latest.json", /malformed/],
    ["", /required/],
  ])("refuses %s", (u, why) => {
    expect(() => validateManifestUrl(u)).toThrow(why);
  });
});

describe("licence-route note", () => {
  it("reads the const out of lib.rs", () => {
    // Not pinned to "" -- license-flip-consts.test.ts owns the value. This only
    // proves the script's regex still finds the const, so the note cannot go
    // silent after a reformat.
    expect(licenseUpdateEndpointFrom(read("src-tauri/src/lib.rs"))).not.toBeNull();
    expect(
      licenseUpdateEndpointFrom('const LICENSE_UPDATE_ENDPOINT: &str = "https://x.example/u";'),
    ).toBe("https://x.example/u");
  });
});
