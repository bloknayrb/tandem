/**
 * Who may mint an annotation, as a census rather than as prose (ADR-035, Unit 8b).
 *
 * WHY THIS EXISTS. Both create entry points are ordinary exported functions,
 * and neither carries a license gate of its own — the two gates that protect
 * them (`gatedTool` at the MCP registration site, the `MUTATING_TOOLS` check
 * above the local-model dispatch switch) are **name-keyed and upstream**. So a
 * new caller added anywhere in `src/` reaches a `withMcp` write with no gate in
 * front of it, and `tests/server/license-gate-coverage.test.ts` cannot see it:
 * that walk is scoped to `src/server/mcp`.
 *
 * A prose rule in the lifecycle's header cannot fail. This can. It is also the
 * tripwire for Units 8c–8j, which grow the seam: each new family should arrive
 * with its caller named here, so "who can write annotations" stays a list
 * someone chose rather than a thing that accumulated.
 *
 * **The sweep is deliberately wider than the thing it guards.** It walks all of
 * `src/` — every extension, `.svelte` included — rather than the directories
 * the two importers happen to live in today, because a guard scoped to where
 * the answer already is cannot report a new answer somewhere else. It also
 * matches the identifiers on word boundaries, so a longer rename
 * (`createAnnotationLifecycleForTests`) does not slip past a substring check.
 */

import { describe, expect, it } from "vitest";
import { filesMentioning, SRC_FILES, stripComments } from "../helpers/src-tree.js";

/**
 * Where the identifiers are defined — excluded, or every census is
 * self-satisfying.
 */
const DEFINITION = "src/server/annotations/lifecycle.ts";

function importersOf(identifier: string): string[] {
  return filesMentioning(identifier, [DEFINITION]);
}

function filesMatching(pattern: RegExp): string[] {
  return [...SRC_FILES]
    .filter(([rel, contents]) => rel !== DEFINITION && pattern.test(stripComments(contents)))
    .map(([rel]) => rel)
    .sort();
}

describe("annotation create seam — who may mint", () => {
  it("sweeps a src tree that actually contains the known writers", () => {
    // Guard the guard: an empty or mis-rooted file list satisfies every
    // "exactly these" assertion below by containing nothing at all.
    expect(SRC_FILES.size).toBeGreaterThan(100);
    expect(SRC_FILES.has("src/server/mcp/annotations.ts")).toBe(true);
    expect(SRC_FILES.has("src/client/editor/toolbar/Toolbar.svelte")).toBe(true);
    expect(SRC_FILES.has(DEFINITION)).toBe(true);
  });

  it("createAnnotationLifecycle has exactly two production callers", () => {
    // `document-store.ts` — the MCP half, reached by `tandem_comment` through
    // `store.lifecycle`. `local-model/tools.ts` — the local-model half, built
    // per dispatch. Adding a third means deciding, out loud, which license gate
    // stands in front of it.
    expect(importersOf("createAnnotationLifecycle")).toStrictEqual([
      "src/server/local-model/tools.ts",
      "src/server/mcp/document-store.ts",
    ]);
  });

  it("mintAnnotation — the wide-typed compatibility entry — has NO production caller", () => {
    // It accepts `note` and `highlight`, which the seam refuses. Until Unit 8j
    // exactly one caller held that width: `mcp/annotations.ts::createAnnotation`,
    // a production export with zero production callers of its own. That wrapper
    // now lives in `tests/helpers/annotation-minter.ts`, so the width is
    // confined structurally — a `src/` file cannot import from `tests/` — and
    // this set is empty.
    //
    // **An empty expectation is a zero check, so it carries its own anchor.**
    // The `[]` below is only meaningful because the sweep can demonstrably see
    // this identifier: unexcluded, it finds the definition. Without that line,
    // a typo in the name would satisfy the assertion just as well as the
    // confinement does.
    expect(filesMentioning("mintAnnotation", [])).toContain(DEFINITION);
    expect(importersOf("mintAnnotation")).toStrictEqual([]);
  });

  it("nothing invokes create through an already-built lifecycle it did not import", () => {
    // The two assertions above key on the *constructor*, which is one whole
    // class of new caller short: `DocumentStore` exposes `readonly lifecycle`,
    // so a handler anywhere in `src/server/mcp` can write
    // `store.lifecycle.create(...)` while importing nothing this census reads.
    // Keying on the invocation instead is what makes the census answer "who can
    // mint" rather than "who constructed a minter".
    expect(filesMatching(/\b(?:lifecycle|creator)\.create\(/)).toStrictEqual([
      "src/server/local-model/tools.ts",
      "src/server/mcp/annotations.ts",
    ]);
  });

  it("no server file calls the wide create path at all (Unit 8j)", () => {
    // Until Unit 8j this list held three files: `Toolbar.svelte` plus the two
    // server ones — `mcp/annotations.ts`, which declared the wide wrapper, and
    // `document-store.ts`, which exposed it as `store.createAnnotation(…)`,
    // reachable from any handler while importing nothing the assertions above
    // read. Both are deleted, so the server half of this list is now empty.
    //
    // **This narrowing is deliberate and is the unit's point**, not a list edit
    // that follows the code around: the surviving entry is a DIFFERENT function.
    // `Toolbar.svelte` declares its own local `createAnnotation` and writes
    // under `withBrowser` against the browser's Y.Doc, never reaching server
    // lifecycle code. It stays in the expectation rather than being filtered out
    // because the sweep is deliberately wider than the thing it guards — a
    // filter would also hide a future `src/client` file that reached a server
    // export for real. It is also what keeps this from being a zero check: the
    // pattern demonstrably matches something.
    //
    // Keyed on the *call shape*, not a bare identifier — the bare name appears
    // in prose, and a census that counts sentences is one an unrelated comment
    // edit turns red. `\b` does not match inside `createAnnotationLifecycle`.
    expect(filesMatching(/\bcreateAnnotation\(/)).toStrictEqual([
      "src/client/editor/toolbar/Toolbar.svelte",
    ]);
  });

  it("acceptPending / dismissPending have no production caller at all", () => {
    // Not a zero-of-zero check: both identifiers exist and are exported (the
    // first assertion in this file proves the sweep can see their file). They
    // are the pre-ADR-035 parity floor that only `tests/` still calls, so an
    // empty set here is the claim, and a future `src/` caller reaching around
    // `lifecycle.accept` / `.dismiss` is what turns it red.
    expect(importersOf("acceptPending")).toStrictEqual([]);
    expect(importersOf("dismissPending")).toStrictEqual([]);
  });
});
