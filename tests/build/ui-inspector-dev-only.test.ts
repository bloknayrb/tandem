/**
 * Regression pin: the UI element inspector must stay out of everything we ship.
 *
 * WHAT THIS IS: a pin on three one-line mistakes that each produce a shipped
 * artifact nobody asked for, with no other signal — no type error, no failing
 * behaviour test, no lint. Every assertion here corresponds to a decision made
 * deliberately when the plugin was added, not to a bug that was found.
 *
 * WHAT THIS IS NOT: proof the inspector is absent from a built bundle. That is
 * a property of the actual build output, and the only real check for it is
 * `npm run build` followed by grepping `dist/client/` — which this suite does
 * not run. This file guards the *inputs* that make that build come out right.
 *
 * The three mistakes, and why each is silent:
 *
 *  1. Dropping `optional = true` from the Cargo dependency, or adding the
 *     `ui-inspector` feature to a `default` feature list. Cargo cannot gate a
 *     dependency on `cfg(debug_assertions)`, so a non-optional dep links `xcap`
 *     (native screen capture) and its platform graphics chain into every
 *     release build. Everything still compiles and every test still passes.
 *  2. Moving either `@tauri-ui-inspector/*` package into `dependencies`. The
 *     npm package ships `dist/`, so no inspector *code* would reach a user —
 *     but every `npm i -g tandem-editor` would then download both packages and
 *     their transitive graph for a tool only this repo's developers can run.
 *  3. Turning the dynamic `import()` in `src/client/main.ts` into a static
 *     top-level import. Vite drops an `import.meta.env.DEV` branch from a
 *     production build only if nothing outside the branch pulls the module in;
 *     a static import defeats that while the dev experience stays identical,
 *     so the regression is invisible until someone greps a shipped bundle.
 *
 * See CONTRIBUTING.md ("UI element inspector") for the developer-facing half.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");

const cargoToml = readFileSync(join(repoRoot, "src-tauri/Cargo.toml"), "utf8");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const NPM_PACKAGES = ["@tauri-ui-inspector/inspector", "@tauri-ui-inspector/adapter-svelte"];

describe("ui-inspector stays development-only", () => {
  it("the Cargo dependency is optional", () => {
    const line = cargoToml
      .split("\n")
      .find((l) => l.trimStart().startsWith("tauri-plugin-ui-inspector"));

    expect(
      line,
      "tauri-plugin-ui-inspector is no longer declared in src-tauri/Cargo.toml",
    ).toBeDefined();
    expect(
      line,
      "tauri-plugin-ui-inspector must stay `optional = true` — a non-optional dep links xcap into release builds",
    ).toContain("optional = true");
  });

  it("no default feature turns the inspector on", () => {
    // Absence of a `default = [...]` key is the current state and is fine; the
    // assertion is about what happens if one is ever added.
    const defaultFeature = /^\s*default\s*=\s*\[(.*?)\]/ms.exec(cargoToml);
    if (defaultFeature) {
      expect(
        defaultFeature[1],
        "the `ui-inspector` feature must never be in Cargo's default feature set",
      ).not.toContain("ui-inspector");
    }
  });

  it("the feature pulls in tauri/dynamic-acl", () => {
    // The runtime `add_capability` call in src-tauri/src/lib.rs does not compile
    // without it, so this is really a pin on the pairing: someone trimming what
    // looks like an unrelated tauri feature breaks the permission grant, and the
    // symptom is a rejected IPC call at runtime, not a build error elsewhere.
    const feature = /^\s*ui-inspector\s*=\s*\[(.*?)\]/ms.exec(cargoToml);
    expect(feature, "the `ui-inspector` feature is no longer declared").not.toBeNull();
    expect(feature?.[1]).toContain("tauri/dynamic-acl");
  });

  it.each(NPM_PACKAGES)("%s is a devDependency, not a dependency", (name) => {
    expect(
      packageJson.devDependencies?.[name],
      `${name} must be declared in devDependencies`,
    ).toBeDefined();
    expect(
      packageJson.dependencies?.[name],
      `${name} in dependencies would make every tandem-editor install download it`,
    ).toBeUndefined();
  });

  it("nothing under src/ imports the inspector statically", () => {
    const srcRoot = join(repoRoot, "src");
    const files = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
      .filter((rel) => /\.(ts|svelte)$/.test(rel))
      .map((rel) => join(srcRoot, rel));

    // Guard the guard: if the walk ever returns nothing (a moved directory, a
    // changed readdir contract), this test would pass vacuously and stop
    // protecting anything.
    expect(files.length).toBeGreaterThan(100);

    // A static `import … from "@tauri-ui-inspector/…"` anywhere in src/ defeats
    // the production tree-shake. `import("@tauri-ui-inspector/…")` is the only
    // permitted form, so the pattern below deliberately does NOT match a call.
    const staticImport = /(?:^|\n)\s*import\s[^;]*?from\s*["']@tauri-ui-inspector\//;

    const offenders = files.filter((file) => staticImport.test(readFileSync(file, "utf8")));

    expect(
      offenders.map((f) => f.slice(repoRoot.length + 1)),
      "use `await import(...)` inside the import.meta.env.DEV branch instead",
    ).toEqual([]);
  });
});
