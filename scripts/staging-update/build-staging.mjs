#!/usr/bin/env node

/**
 * Build a STAGING desktop build: an ordinary Tandem build whose updater reads a
 * manifest URL the operator names, instead of the public
 * `releases/latest/download/latest.json` (#2280).
 *
 * Why a build, not a switch. Bryan decided on 2026-10-22 (OPS08 in
 * docs/reviews/2026-10-20-docs-audit.md) that a shipped build must have no
 * runtime updater-endpoint override: an environment variable, setting or flag
 * that redirects the updater is attack surface on the one path that replaces
 * Tandem's own binaries. So the redirect here is a Tauri `--config` overlay
 * (JSON Merge Patch, RFC 7396) applied at `cargo tauri build` time and baked
 * into that one binary. The release workflow passes no `--config` and sets no
 * `TAURI_CONFIG`, so a release build cannot pick it up, and nothing in a
 * built binary can change it afterwards.
 * `tests/scripts/staging-update-channel.test.ts` pins both halves.
 *
 * What the overlay changes, and why each key:
 *   - `plugins.updater.endpoints`: the staging manifest. The `pubkey` is NOT
 *     overridden, so a staging build still accepts only artifacts signed with
 *     the real updater key -- the rehearsal verifies real signatures, and a
 *     compromised staging host can offer nothing but a genuine signed Tandem.
 *   - `version`: STAGING_VERSION, lower than every real release, so a real
 *     release's own manifest and artifacts read as an update without
 *     re-signing anything or faking a version, and the post-update check is
 *     simply "the version changed to the release's". It is also how the build
 *     is told apart from a real one (About, Copy Diagnostics, the exe's
 *     ProductVersion).
 *   - `bundle.createUpdaterArtifacts: false`: a staging build is only ever an
 *     update CONSUMER, so it never needs the updater private key. Without this,
 *     `tauri build` fails at the end for want of TAURI_SIGNING_PRIVATE_KEY, and
 *     the tempting fix would be to put that key on the operator's machine.
 *
 * Scope: the PUBLIC update route only. While `LICENSE_UPDATE_ENDPOINT` in
 * src-tauri/src/lib.rs is empty every device takes that route. Once it is set,
 * a licensed device's staging build goes to the compiled licence endpoint and
 * ignores this manifest; this script says so when it sees a non-empty const.
 *
 * Usage:
 *   npm run build:tauri:staging -- --manifest-url <https URL> [--print-overlay]
 *
 * The procedure that uses it is docs/bad-release-runbook.md.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Lower than any Tandem release, numeric-only so the MSI bundler accepts it. */
export const STAGING_VERSION = "0.0.1";

/** The public manifest a release build reads; a staging build must not. */
export const PRODUCTION_ENDPOINT =
  "https://github.com/bloknayrb/tandem/releases/latest/download/latest.json";

/**
 * Refuse a manifest URL that would make the staging build pointless or the
 * rehearsal unsafe. Returns the normalized URL string, or throws.
 *
 * The real repo's `releases/latest` (any spelling) is refused because it IS the
 * production pointer: a rehearsal against it would have to move the real
 * `latest` to see anything, which is what the v1.0 criterion forbids. The real
 * repo's per-tag `releases/download/<tag>/latest.json` is allowed: it is an
 * immutable asset of a release that already exists, and it is what makes the
 * RC forward-update row runnable without any staging host.
 */
export function validateManifestUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("--manifest-url is required");
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`--manifest-url is not a URL: ${raw}`);
  }
  // Tauri refuses a non-https endpoint in a release-profile build unless the
  // overlay also sets dangerousInsecureTransportProtocol, which this never does.
  if (url.protocol !== "https:") {
    throw new Error(`--manifest-url must be https, got ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "--manifest-url must not carry credentials; they would be baked into the binary",
    );
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const pathname = decodeURIComponent(url.pathname).toLowerCase().replace(/\/+/g, "/");
  if (
    (host === "github.com" || host === "www.github.com") &&
    pathname.startsWith("/bloknayrb/tandem/releases/latest")
  ) {
    throw new Error(
      "--manifest-url names the production `releases/latest` pointer. Use a staging " +
        "repository's releases/latest, or a real release's per-tag " +
        "releases/download/<tag>/latest.json (docs/bad-release-runbook.md).",
    );
  }
  return url.toString();
}

/** The `--config` overlay. A fixed shape: tests pin its exact keys. */
export function buildStagingOverlay(manifestUrl) {
  return {
    version: STAGING_VERSION,
    bundle: { createUpdaterArtifacts: false },
    plugins: { updater: { endpoints: [validateManifestUrl(manifestUrl)] } },
  };
}

/** The value of `LICENSE_UPDATE_ENDPOINT` in lib.rs source, or null if absent. */
export function licenseUpdateEndpointFrom(libRs) {
  const m = /const\s+LICENSE_UPDATE_ENDPOINT\s*:\s*&str\s*=\s*"([^"]*)"\s*;/.exec(libRs);
  return m ? m[1] : null;
}

function parseArgs(argv) {
  const out = { manifestUrl: undefined, printOverlay: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--print-overlay") out.printOverlay = true;
    else if (a === "--manifest-url") out.manifestUrl = argv[++i];
    else if (a.startsWith("--manifest-url=")) out.manifestUrl = a.slice("--manifest-url=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const overlay = buildStagingOverlay(args.manifestUrl);
  const json = `${JSON.stringify(overlay, null, 2)}\n`;
  if (args.printOverlay) {
    process.stdout.write(json);
    return;
  }

  const licensed = licenseUpdateEndpointFrom(
    readFileSync(path.join(repoRoot, "src-tauri/src/lib.rs"), "utf8"),
  );
  if (licensed) {
    console.warn(
      `NOTE: LICENSE_UPDATE_ENDPOINT is set (${licensed}). A LICENSED device running this ` +
        "staging build takes the licence route and never reads the staging manifest; " +
        "only a trialing or unlicensed device exercises it.",
    );
  }

  // Outside the repo on purpose: an overlay file in the tree is one careless
  // `--config` away from a release build.
  const dir = mkdtempSync(path.join(tmpdir(), "tandem-staging-"));
  const overlayPath = path.join(dir, "tauri.staging-updater.conf.json");
  writeFileSync(overlayPath, json);
  console.log(`staging overlay: ${overlayPath}\n${json}`);

  const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: repoRoot, stdio: "inherit" });
  run(process.execPath, ["scripts/download-node-sidecar.mjs"]);
  run(process.execPath, ["scripts/build-reaper.mjs"]);
  run("cargo", ["tauri", "build", "--config", overlayPath]);
  console.log(
    `\nStaging build done: version ${STAGING_VERSION}, updater -> ${overlay.plugins.updater.endpoints[0]}.\n` +
      "Install it on a TEST machine only: it shares the real app's identifier and data directory.",
  );
}

function realpathOrNull(candidate) {
  if (!candidate) return null;
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

const invokedPath = realpathOrNull(process.argv[1]);
if (invokedPath !== null && invokedPath === realpathOrNull(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
