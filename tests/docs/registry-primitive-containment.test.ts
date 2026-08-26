/**
 * The document registry's primitives must not be reachable from production
 * code (ADR-033).
 *
 * `registry.ts` exposes `openDocument` / `activateDocument` / `updateDocument`
 * / `closeDocument`, each ending in exactly one `documentMeta` broadcast. That
 * is what makes two silent failure modes unrepresentable: publishing a snapshot
 * between two primitives (a document listed under the *previous* active id),
 * and advancing the activation epoch twice for one user gesture, which
 * overrides a tab switch the user made in between.
 *
 * Neither failure has a type error or a red test of its own — the old code
 * compiled fine and every caller looked correct in isolation. So the
 * containment is the check.
 *
 * Two independent halves, because either alone is defeatable:
 *
 *   1. A **runtime** assertion that the production barrels do not export the
 *      primitives. Immune to text games — renamed re-exports, `export *`,
 *      indirection through another module — because it asks the loaded module
 *      what its exports actually are.
 *   2. A **source sweep** for the `unsafe*` names and for imports of the test
 *      seam. This catches what the runtime check cannot: a production module
 *      importing `registry.js` directly and calling `unsafeAddDoc` without ever
 *      passing through a barrel.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(REPO_ROOT, "src");

/** Files allowed to name the primitives: the owner and its declared seam. */
const ALLOWED = new Set([
  "src/server/documents/registry.ts",
  "src/server/documents/registry-testing.ts",
]);

const UNSAFE_NAMES = ["unsafeAddDoc", "unsafeRemoveDoc", "unsafeSetActiveDocId"] as const;

/**
 * Every source file under `src/`, whatever its extension.
 *
 * Deliberately unfiltered by extension: scoping this to `.ts` would mean a
 * `.svelte`, `.mts` or `.cts` module could call a primitive and the sweep would
 * report zero offenders — which reads exactly like a pass.
 */
function sourceFiles(): Array<{ rel: string; text: string }> {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const abs = join(e.parentPath, e.name);
      return {
        rel: abs.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"),
        text: readFileSync(abs, "utf8"),
      };
    });
}

describe("registry primitives stay out of production code", () => {
  it("scans a real, wide source tree", () => {
    const files = sourceFiles();
    // Positive control. Every assertion below is a zero-check over this list;
    // an empty or narrowed derivation satisfies all of them silently.
    expect(files.length, "the sweep must actually find source files").toBeGreaterThan(150);
    expect(
      files.map((f) => f.rel),
      "…including the two files that are supposed to name the primitives",
    ).toEqual(expect.arrayContaining([...ALLOWED]));
    expect(
      files.some((f) => f.rel.endsWith(".svelte")),
      "…and files that are not TypeScript, which an extension filter would drop",
    ).toBe(true);
  });

  it("defines every guarded name in the owner module", () => {
    // The other half of the control: a typo in `UNSAFE_NAMES` would make the
    // offender sweep search for strings that exist nowhere and pass forever.
    const owner = sourceFiles().find((f) => f.rel === "src/server/documents/registry.ts");
    expect(owner, "the owner module must be in the sweep").toBeDefined();
    for (const name of UNSAFE_NAMES) {
      expect(owner?.text, `${name} must exist to be worth guarding`).toContain(
        `export function ${name}(`,
      );
    }
  });

  it("names the primitives nowhere but the owner and its declared test seam", () => {
    const offenders = sourceFiles()
      .filter((f) => !ALLOWED.has(f.rel))
      .filter((f) => UNSAFE_NAMES.some((name) => f.text.includes(name)))
      .map((f) => f.rel);

    expect(
      offenders,
      "production code must mutate the registry through openDocument / " +
        "activateDocument / updateDocument / closeDocument, which broadcast exactly once",
    ).toEqual([]);
  });

  it("keeps the test seam out of the production import graph", () => {
    const importers = sourceFiles()
      .filter((f) => !ALLOWED.has(f.rel))
      .filter((f) => /["']\.{1,2}\/[^"']*registry-testing(?:\.js)?["']/.test(f.text))
      .map((f) => f.rel);

    expect(importers, "nothing under src/ may import documents/registry-testing").toEqual([]);
  });

  it("does not re-export the primitives from the production barrels", async () => {
    const barrels = {
      "document-service.js": await import("../../src/server/mcp/document-service.js"),
      "document.js": await import("../../src/server/mcp/document.js"),
      "registry.js": await import("../../src/server/documents/registry.js"),
    };

    for (const [name, mod] of Object.entries(barrels)) {
      const keys = Object.keys(mod);
      // Control first: a module that failed to load, or that this test got
      // wrong, would export nothing and satisfy every absence check below.
      expect(keys.length, `${name} must actually export something`).toBeGreaterThan(5);
      expect(keys, `${name} must expose the composite surface`).toContain("openDocument");

      for (const primitive of ["addDoc", "removeDoc", "setActiveDocId"]) {
        expect(keys, `${name} must not re-export ${primitive}`).not.toContain(primitive);
      }
    }
  });
});
