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

  it("mintAnnotation — the wide-typed compatibility entry — has exactly one caller", () => {
    // It accepts `note` and `highlight`, which the seam refuses. Exactly one
    // caller keeps that width confined to the pre-ADR-035 export Unit 8j
    // deletes; a second would be the width leaking into new code.
    expect(importersOf("mintAnnotation")).toStrictEqual(["src/server/mcp/annotations.ts"]);
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

  it("the deprecated wide create path stays confined to its two server files", () => {
    // `DocumentStore.createAnnotation` still accepts `note` and `highlight`,
    // which the seam refuses, and it is reachable as `store.createAnnotation(…)`
    // from any handler — importing nothing that the two assertions above read.
    // So this keys on the *call shape*, not on a bare identifier: the bare name
    // also appears in four files' prose, and a census that counts sentences is
    // one an unrelated comment edit turns red. `\b` does not match inside
    // `createAnnotationLifecycle` (the next character is a word character).
    //
    // `Toolbar.svelte` is listed and is NOT the same function: the client
    // declares its own local `createAnnotation` and writes under `withBrowser`
    // against the browser's Y.Doc, never reaching server lifecycle code. It
    // stays in the expectation rather than being filtered out because the sweep
    // is deliberately wider than the thing it guards — a filter would also hide
    // a future `src/client` file that reached the server export for real.
    expect(filesMatching(/\bcreateAnnotation\(/)).toStrictEqual([
      "src/client/editor/toolbar/Toolbar.svelte",
      "src/server/mcp/annotations.ts",
      "src/server/mcp/document-store.ts",
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
