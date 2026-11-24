/**
 * What `npm install -g tandem-editor` downloads (#1825).
 *
 * Every bundle but one inlines its whole import graph (`noExternal: [/.*\/]`
 * in tsup.config.ts) and the client is a Vite build, so a package those
 * bundles use is a BUILD input, not something the installed package resolves
 * at run time. Listing such packages under `dependencies` made every global
 * install download them anyway: 437 production packages in the lockfile where
 * 169 are needed.
 *
 * `dependencies` is therefore exactly what something resolves from a sibling
 * `node_modules` at run time:
 *
 * - the five bare imports of `dist/cli/index.js`, the one bundle that is
 *   deliberately NOT self-contained (see its tsup block): the MCP SDK,
 *   `env-paths`, `undici`, `zod` and (lazily) `update-notifier`;
 * - `@napi-rs/keyring`, kept external in every bundle because it dispatches to
 *   a platform `.node` binary at run time (`nativeExternals`).
 *
 * Adding a package used by a bundled entry needs no `dependencies` entry: tsup
 * bundles anything not listed there, so putting it in `devDependencies` is
 * both correct and the safe default. Adding a NEW run-time external — a cli
 * import that must stay external, or a native module — is the only reason to
 * change this list, and the change belongs here with its reason.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const RUNTIME_RESOLVED = [
  "@modelcontextprotocol/sdk",
  "@napi-rs/keyring",
  "env-paths",
  "undici",
  "update-notifier",
  "zod",
];

describe("npm production dependencies (#1825)", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };

  it("lists only packages something resolves from node_modules at run time", () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(RUNTIME_RESOLVED);
  });

  it("keeps the native module external in tsup, which is why it must stay a dependency", () => {
    const tsup = readFileSync(path.join(ROOT, "tsup.config.ts"), "utf8");
    expect(tsup).toMatch(/nativeExternals\s*=\s*\[\/\^@napi-rs\\\/keyring\/\]/);
  });
});
