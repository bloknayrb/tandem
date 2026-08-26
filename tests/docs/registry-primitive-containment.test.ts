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
 * Three halves, because each catches what the others cannot:
 *
 *   1. A **runtime** assertion that the production barrels do not export the
 *      primitives. Immune to text games — renamed re-exports, `export *`,
 *      indirection through another module — because it asks the loaded module
 *      what its exports actually are.
 *   2. A **source sweep** for the `unsafe*` names and for imports of the test
 *      seam. This catches what the runtime check cannot: a production module
 *      importing `registry.js` directly and calling `unsafeAddDoc` without ever
 *      passing through a barrel.
 *   3. An **exact pin on `registry.ts`'s exported surface**. Halves 1 and 2 are
 *      both keyed to a fixed vocabulary — the three `unsafe*` spellings and the
 *      three old primitive names — and `registry.ts` is necessarily exempt from
 *      the sweep, being the owner. So a NEW export from `registry.ts` that hands
 *      out the same capability under a name neither list has heard of satisfies
 *      every assertion in halves 1 and 2 while reintroducing exactly what this
 *      file exists to prevent. A name list cannot see a rename; an exact set
 *      can. The cost is that any addition to `registry.ts` — read accessor
 *      included — turns this red until someone writes the name down, which is
 *      the point: that edit is the review moment.
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

  it("exports exactly the surface ADR-033 sanctions, and nothing else", async () => {
    // Pinned deliberately as an exact set rather than an absence check. See
    // half 3 in this file's header: an absence check keyed to known names is
    // defeated by a new name, and the one file that can introduce a new
    // primitive is the one file the source sweep cannot police.
    //
    // Adding a legitimate export here is a one-line edit. If the export you are
    // adding writes `openDocs` or `activeDocId` WITHOUT ending in exactly one
    // `broadcastOpenDocs()`, it belongs behind `registry-testing.ts` with an
    // `unsafe` prefix instead — that is what this pin is asking you to notice.
    const SANCTIONED = [
      // Reads.
      "docCount",
      "getActiveDocEpoch",
      "getActiveDocId",
      "getCurrentDoc",
      "getOpenDocs",
      "hasDoc",
      "isDirtyMirrorEligible",
      "requireDocument",
      "toDocListEntry",
      // The publish, and the composites that each end in exactly one.
      "activateDocument",
      "broadcastOpenDocs",
      "closeDocument",
      "openDocument",
      "openDocumentWhenReady",
      "updateDocumentWhenReady",
      // The declared escape hatch, reachable only through registry-testing.ts.
      "unsafeAddDoc",
      "unsafeRemoveDoc",
      "unsafeSetActiveDocId",
    ].sort();

    const mod = await import("../../src/server/documents/registry.js");
    expect(Object.keys(mod).sort()).toEqual(SANCTIONED);
  });
});
