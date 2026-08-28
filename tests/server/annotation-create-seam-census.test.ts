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

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(ROOT, "src");

/** Where the identifiers are defined — excluded, or every census is self-satisfying. */
const DEFINITION = "src/server/annotations/lifecycle.ts";

function walk(dir: string, out: string[] = []): string[] {
  // `withFileTypes` so the directory test costs no extra syscall per entry.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Every file under `src/` read exactly once, as repo-relative POSIX path →
 * contents.
 *
 * One pass, not one per identifier: this suite shares a worker pool with two
 * other whole-`src` walks (`documents-open.test.ts`,
 * `client-log-callsites.test.ts`), and a re-read per lookup was measurably
 * enough extra Windows filesystem contention to push those two over their
 * timeouts in the full run.
 */
const SRC_FILES: ReadonlyMap<string, string> = new Map(
  walk(SRC)
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
    .map((rel) => [rel, readFileSync(path.join(ROOT, rel), "utf8")] as const),
);

function importersOf(identifier: string): string[] {
  const pattern = new RegExp(`\\b${identifier}\\b`);
  return [...SRC_FILES]
    .filter(([rel, contents]) => rel !== DEFINITION && pattern.test(contents))
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
});
