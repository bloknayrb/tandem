/**
 * Regression pin for #1265: `tsup.config.ts` emitted a `dist/codex-agent`
 * outDir, but `src-tauri/tauri.conf.json`'s `bundle.resources` never listed
 * it, so the packaged desktop app had no `dist/codex-agent/index.js` on disk
 * for `supervisor.ts` to spawn — the Codex worker could not start at all.
 *
 * WHAT THIS IS: a walk from tsup's outDirs to bundle.resources, asserting
 * every outDir is either declared there or explicitly allowlisted as
 * npm-only. The direction matters: a test that instead walks
 * bundle.resources and asserts each entry exists on disk would have stayed
 * green through the #1265 bug, because every entry that *was* declared was
 * correct — the bug was an omission, not a wrong path. Only walking outDirs
 * -> resources (the inverse) can catch "we added a new tsup entry and forgot
 * to wire it into the bundle".
 *
 * WHAT THIS IS NOT: a build verification. It parses `tsup.config.ts` and
 * `tauri.conf.json` as text/JSON — no `tsup` invocation, no `dist/` required,
 * so it runs the same in CI and on a fresh checkout. Mirrors the cross-file
 * consistency-check shape of `tests/build/linux-runtime-deps.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");

const tsupConfigSource = readFileSync(join(repoRoot, "tsup.config.ts"), "utf8");
const tauriConf = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8")) as {
  bundle?: { resources?: Record<string, string> };
};

/**
 * outDirs that deliberately do NOT ship in the desktop bundle's resources —
 * they distribute via npm instead (the `tandem-editor` package / the plugin
 * monitor subcommand), not the Tauri sidecar bundle. Anything else missing
 * from `bundle.resources` is a bug, not an intentional omission.
 */
const NPM_ONLY_OUT_DIRS = new Set([
  "dist/monitor", // ships via npm as the `tandem monitor` plugin subcommand
  "dist/cli", // ships via npm as the `tandem` CLI entry point
]);

/**
 * Extracts every `outDir: "..."` string literal from the tsup multi-entry
 * config. Regex, not a `tsup.config.ts` import/eval, so this test needs no
 * build step and can't accidentally execute build-time side effects.
 */
function tsupOutDirs(): string[] {
  return [...tsupConfigSource.matchAll(/outDir:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** Normalizes `bundle.resources` values ("dist/server/") to bare outDir form ("dist/server"). */
function bundleResourceDirs(): Set<string> {
  const resources = tauriConf.bundle?.resources ?? {};
  return new Set(Object.values(resources).map((value) => value.replace(/\/$/, "")));
}

describe("every tsup outDir is declared in tauri bundle.resources or explicitly allowlisted", () => {
  const outDirs = tsupOutDirs();

  it("parses tsup outDirs (guards the regex itself)", () => {
    // If this ever comes back empty the whole suite silently passes: every
    // check below is driven off this list. A parse failure must fail loudly,
    // not disarm the file.
    expect(outDirs.length).toBeGreaterThan(0);
    expect(outDirs).toContain("dist/server");
  });

  const resourceDirs = bundleResourceDirs();

  for (const outDir of outDirs) {
    if (NPM_ONLY_OUT_DIRS.has(outDir)) {
      it(`${outDir} is npm-only, explicitly allowlisted out of bundle.resources`, () => {
        expect(NPM_ONLY_OUT_DIRS.has(outDir)).toBe(true);
      });
    } else {
      it(`${outDir} is declared in tauri.conf.json bundle.resources`, () => {
        expect(resourceDirs.has(outDir)).toBe(true);
      });
    }
  }

  it("the npm-only allowlist contains no stale entries", () => {
    // Every allowlisted outDir must still exist in tsup's config — otherwise
    // the allowlist is silently vestigial and hides nothing.
    for (const allowlisted of NPM_ONLY_OUT_DIRS) {
      expect(outDirs).toContain(allowlisted);
    }
  });
});
