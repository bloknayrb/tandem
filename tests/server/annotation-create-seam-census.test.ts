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
 * matches the identifiers on **word boundaries**, which is what keeps a longer
 * name that merely CONTAINS one — `createAnnotationLifecycleForTests` contains
 * `createAnnotationLifecycle` — from being counted as a use of it. (An earlier
 * version of this sentence had that backwards, claiming the boundaries were
 * what caught such a rename.)
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

  it("no src/ file imports from tests/ — the confinement this unit relies on", () => {
    // Unit 8j-1 moved the wide-typed create wrapper into
    // `tests/helpers/ydoc-factory.ts` and called that containment "structural".
    // **It is — for most of `src/`, and this assertion is what covers the rest.**
    // `tsconfig.server.json` sets `rootDir: "src"`, and `npm run typecheck` runs
    // it, so a `src/server` file importing from `tests/` fails with TS6059. But
    // `tsconfig.client.json` and the base config set no `rootDir`, so the same
    // import from `src/client` produces no type error at all — it would just
    // bundle test code into `dist/`, silently.
    //
    // So the unqualified claim is made true here rather than softened in the
    // prose. This is the general rule, not a rule about one symbol: the point of
    // moving an export into `tests/` is that the boundary holds for everything.
    // **Three shapes, because review defeated the first two-shape version.** It
    // was `/from\s+["'][^"']*\/tests\//`, and the comment above it claimed to
    // cover "the relative climb and an alias" while the alias probe asserted
    // `false` — prose promising coverage the assertion below it disproved.
    // Worse, the same slash-delimited key missed the shape that is legal TODAY:
    // `tsconfig.json` sets `baseUrl: "."`, so a bare `from "tests/helpers/x.js"`
    // resolves from the repo root, typechecks under the client config, and
    // contains no `/tests/` at all. And `await import("../../tests/…")` has no
    // `from` keyword. Each arm below is a live specifier form, not decoration.
    const reachesTests = /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*["'](?:\.{1,2}\/)*@?tests\//;

    // The assertion is an empty set, so it carries its own proof that the
    // pattern fires — one probe per arm, plus near-misses that must NOT match,
    // so the pattern is shown to discriminate rather than merely to match.
    for (const offender of [
      'import { x } from "../../tests/helpers/ydoc-factory.js";', // relative climb
      'import { x } from "tests/helpers/ydoc-factory.js";', // baseUrl, legal today
      'const { x } = await import("../../tests/helpers/ydoc-factory.js");', // dynamic
      'import { x } from "@tests/helpers/ydoc-factory.js";', // alias, if one is ever added
    ]) {
      expect(reachesTests.test(offender), `must match: ${offender}`).toBe(true);
    }
    for (const innocent of [
      'import { x } from "./latests/thing.js";', // substring near-miss
      'import { x } from "../contests/thing.js";',
      "// we deliberately do not import from tests/ here",
    ]) {
      expect(reachesTests.test(innocent), `must NOT match: ${innocent}`).toBe(false);
    }

    const offenders = [...SRC_FILES]
      .filter(([, contents]) => reachesTests.test(stripComments(contents)))
      .map(([rel]) => rel);
    expect(
      offenders,
      "a src/ file reaching into tests/ bundles test code into dist/ — move the helper, do not widen this",
    ).toStrictEqual([]);
  });

  it("mintAnnotation — the wide-typed compatibility entry — is not reachable cross-file", () => {
    // It accepts `note` and `highlight`, which the seam refuses. Until Unit 8j
    // exactly one file held that width: `mcp/annotations.ts::createAnnotation`,
    // a production export with zero production callers of its own. That wrapper
    // now lives in `tests/helpers/ydoc-factory.ts`, so this set is empty.
    //
    // **Read the title as the claim it makes.** `importersOf` excludes the
    // DEFINITION file, so an empty set means "no other `src/` file mentions
    // it" — NOT "nothing calls it". `createAnnotationLifecycle` calls
    // `mintAnnotation` in that very file, on the production path. An earlier
    // version of this spec was titled "has NO production caller" and was simply
    // false. The property being pinned is cross-file confinement of the wide
    // `type` parameter, which is worth pinning; it is a different property from
    // the one `acceptPending` below has.
    //
    // **An empty expectation is a zero check, so it carries its own anchor.**
    // The `[]` below is only meaningful because the sweep can demonstrably see
    // this identifier: unexcluded, it finds the definition. Without that line,
    // a typo in the name would satisfy the assertion just as well as the
    // confinement does.
    expect(filesMentioning("mintAnnotation", [])).toContain(DEFINITION);
    expect(importersOf("mintAnnotation")).toStrictEqual([]);
  });

  it("the lifecycle module's export list is what it was — an alias defeats every sweep above", () => {
    // **The defeat this exists for, constructed during review:** add
    // `export const mint = mintAnnotation;` to the lifecycle and call
    // `lifecycle.mint(…)` from a `src/` file. The wide-typed minter is reachable
    // from production again, and BOTH assertions above stay green — the
    // definition file still contains the literal "mintAnnotation" (so the
    // anchor passes) and no other file mentions that identifier (so the
    // importer set is still empty). Every census in this file keys on an
    // identifier, and an alias is a second name for the same value.
    //
    // Pinning the export SET closes it, because an alias has to be exported to
    // be reachable. This is a list someone chose, which is the whole premise of
    // the file: adding an export to the lifecycle means saying so here.
    //
    // **Both regexes tolerate leading whitespace, and that is not cosmetic.**
    // They were `^export`, which review defeated by ending a block comment on
    // the same physical line: `/* … *\/ export const mint = …`. The fix is split
    // across two files — `stripComments` now preserves the comment's newlines
    // (so `export` returns to the start of its own line) and the anchors below
    // allow the indent that leaves behind. Either half alone still loses.
    const source = SRC_FILES.get(DEFINITION);
    expect(source, "the definition file must be in the sweep").toBeDefined();
    const exported = [
      ...stripComments(source ?? "").matchAll(
        /^[ \t]*export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+(\w+)/gm,
      ),
    ]
      .map((m) => m[1])
      .sort();
    expect(
      exported,
      "a new lifecycle export is a decision: add it to this list on purpose. A removal is equally a failure — the pin is two-sided.",
    ).toStrictEqual([
      "AnnotationLifecycle",
      "AnnotationReplier",
      "ClaudeReplyResult",
      "CreateExtras",
      "CreateInput",
      "CreateResult",
      "EditPatch",
      "EditResult",
      "LifecycleResult",
      "MintExtras",
      "RemoveRecordResult",
      "RemoveResult",
      "ReplyRefusalCode",
      "ReplyResult",
      "acceptPending",
      "addUserReply",
      "createAnnotationLifecycle",
      "describeReplyWriteRefusal",
      "dismissPending",
      "mintAnnotation",
      "removeAnnotationRecord",
    ]);

    // The regex must be able to PARSE every export, or a form it cannot read
    // vanishes from the list silently and the pin quietly covers less. Counting
    // `^export` lines in the stripped source and requiring the two to agree is
    // what makes an unparsed form a failure rather than an omission.
    const exportLines = (stripComments(source ?? "").match(/^[ \t]*export\s/gm) ?? []).length;
    expect(
      exported,
      "an export form the name regex cannot parse would vanish from the pin silently. WIDEN THE REGEX — do not edit the list above to match.",
    ).toHaveLength(exportLines);
  });

  it("nothing invokes create through an already-built lifecycle it did not import", () => {
    // The two assertions above key on the *constructor*, which is one whole
    // class of new caller short: `YDocStore` exposes `readonly lifecycle`,
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
    // read. The store method was deleted and the wide wrapper was MOVED into
    // `tests/helpers/ydoc-factory.ts` — it still exists and still calls
    // `mintAnnotation`, just from outside `src/`. Either way the server half of
    // this list is now empty.
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
    expect(
      filesMatching(/\bcreateAnnotation\(/),
      "the Toolbar entry is this assertion's anchor, not an accident: if that file moves or renames its local helper, RE-ANCHOR — emptying the array turns this into a zero check",
    ).toStrictEqual(["src/client/editor/toolbar/Toolbar.svelte"]);
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
