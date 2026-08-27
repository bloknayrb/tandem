/**
 * The `src/server/documents/` boundary is an inventory, not a cycle check.
 *
 * ADR-034 moves the file-open pipeline behind named entry points under
 * `documents/`. The thing that can silently undo that is not a behavioural
 * break — it is an import edge: a module reaching past the seam, or the seam
 * reaching back into the implementation it replaced.
 *
 * **Why an edge inventory rather than "assert no cycles".** Both were tried on
 * paper first and the cycle framing loses three ways:
 *
 *   1. It is red today and stays red. `documents/open.ts` already sits in a
 *      large strongly-connected component — `open.ts -> mcp/file-opener.ts
 *      -> mcp/annotations.ts -> mcp/document.ts -> open.ts`, all static value
 *      imports, closed by Unit 6's own redirect of `mcp/document.ts` at the
 *      seam. Four more paths close through `mcp/api-routes.ts`. None of that is
 *      in ADR-034's scope, so a gate keyed on it could only ever be skipped.
 *   2. A gate keyed on a *directory* is satisfied by emptying the directory.
 *      Move the pipeline to `src/server/mcp/open-pipeline.ts`, leave
 *      `documents/open.ts` as a facade, and "no cycle through documents/" is
 *      green with the deliverable unmet.
 *   3. It would need a dynamic-`import()` exemption (ADR-034 Unit 7a keeps one
 *      deliberately), and that exemption is a general-purpose cycle solvent:
 *      any new cycle is dissolved by rewriting one edge as `await import()`,
 *      which is precisely the idiom this unit teaches.
 *
 * An exact-set inventory has none of those properties. It is green the moment
 * it is written, it fails on *deletion* as well as addition, and every mutant
 * that matters shows up as a row: a re-export left in `file-opener.ts` adds a
 * fan-in row; a two-hop launder through a new compat module adds a fan-in row
 * from a new module; emptying `documents/` removes rows.
 *
 * The one cycle property this unit actually controls is kept, narrowly: no
 * cycle may be contained *entirely within* `documents/`. That is green today
 * and the sibling modules ADR-034 adds must not tangle with each other.
 *
 * Companion to `registry-primitive-containment.test.ts`, whose three-layer
 * shape this borrows: a runtime surface pin that text games cannot reach, plus
 * source-derived sweeps that catch what the runtime cannot see.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, posix, relative } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(REPO_ROOT, "src");
const DOCUMENTS = "server/documents/";
const TESTING_SEAM = "server/documents/registry-testing.ts";

/** tsconfig `paths`. A resolver that skips non-relative specifiers drops these
 *  silently, and `@server/*` is configured-but-unused today — which is worse
 *  than unused, because it reads as unremarkable the first time it appears. */
const ALIASES: Array<[string, string]> = [
  ["@server/", "server/"],
  ["@shared/", "shared/"],
  ["@client/", "client/"],
];

type EdgeKind = "value" | "type" | "dynamic";
interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/**
 * Blank comments to spaces rather than deleting them, so a prose mention of a
 * module specifier cannot be read as an import.
 *
 * The `[^:]` guard is load-bearing, not noise: without it the `//` in a URL
 * inside a string literal is read as a line comment and blanks the rest of
 * that line — including any specifier on it.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** Every source file under `src/`, not narrowed to `.ts`. Scoping this to the
 *  extension the boundary happens to use today would let a `.mts`/`.cts`/
 *  `.svelte` module cross it unseen, and a sweep that finds zero offenders
 *  reads exactly like a pass. Declaration files carry no runtime edges. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|cts|svelte)$/.test(name) && !/\.d\.[mc]?ts$/.test(name)) {
        out.push(relative(SRC, full).split("\\").join("/"));
      }
    }
  };
  walk(SRC);
  return out.sort();
}

/**
 * Resolve a specifier to a src-relative path, or `null` for a package import.
 * Returns `"UNRESOLVED:<spec>"` for anything it cannot place — the caller
 * fails closed on those rather than skipping them, because a resolver that
 * quietly drops what it does not understand reports a clean graph.
 */
function resolveSpec(spec: string, fromRel: string): string | null {
  let base: string;
  const alias = ALIASES.find(([a]) => spec.startsWith(a));
  if (alias) base = alias[1] + spec.slice(alias[0].length);
  else if (spec.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  else return null;

  const candidates = base.endsWith(".js")
    ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`, base]
    : [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  for (const c of candidates) {
    if (statSync(join(SRC, c), { throwIfNoEntry: false })?.isFile()) return c;
  }
  return `UNRESOLVED:${spec}`;
}

/**
 * Classification is **per statement**, never per target module. `open.ts` names
 * `mcp/file-opener.js` twice two lines apart — once `import type`, once
 * `export … from` — and collapsing those by target lets the type edge swallow
 * the value edge, which turns every assertion below green at once.
 *
 * `export … from` is counted. The repo's other import walker
 * (`tests/shared/ydoc-import-ceiling.test.ts`) matches `import … from` only, so
 * reusing it here would ship a gate blind to a re-export — the single most
 * likely way this boundary gets undone.
 */
const STATEMENT =
  /\b(?:import|export)\s+(type\s+)?(?:[^;'"]*?\s+)?from\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function buildGraph(): { edges: Edge[]; unresolved: Array<[string, string]> } {
  const edges: Edge[] = [];
  const unresolved: Array<[string, string]> = [];
  for (const rel of sourceFiles()) {
    const text = stripComments(readFileSync(join(SRC, rel), "utf8"));
    const record = (spec: string, kind: EdgeKind) => {
      const to = resolveSpec(spec, rel);
      if (to === null) return;
      if (to.startsWith("UNRESOLVED:")) unresolved.push([rel, spec]);
      else edges.push({ from: rel, to, kind });
    };
    for (const m of text.matchAll(STATEMENT)) {
      record(m[2] ?? m[3], m[1] ? "type" : "value");
    }
    for (const m of text.matchAll(DYNAMIC)) record(m[1], "dynamic");
  }
  return { edges, unresolved };
}

function format(e: Edge): string {
  return `${e.from} -> ${e.to} (${e.kind})`;
}

/**
 * Written down, not derived: this is the review inventory. Every import edge
 * that crosses into or out of `src/server/documents/`. Adding a row is a
 * decision someone makes deliberately; that edit is the point of the file.
 */
const FAN_IN = [
  "server/bootstrap/hocuspocus-lifecycle.ts -> server/documents/dirty.ts (value)",
  "server/bootstrap/hocuspocus-lifecycle.ts -> server/documents/registry.ts (value)",
  "server/events/observers/ctrl-meta.ts -> server/documents/registry.ts (value)",
  "server/events/queue.ts -> server/documents/dirty.ts (value)",
  "server/index.ts -> server/documents/open.ts (value)",
  "server/local-model/collaborator.ts -> server/documents/registry.ts (value)",
  "server/mcp/convert.ts -> server/documents/open.ts (value)",
  "server/mcp/document-service.ts -> server/documents/dirty.ts (value)",
  "server/mcp/document-service.ts -> server/documents/registry.ts (value)",
  "server/mcp/document.ts -> server/documents/open.ts (value)",
  "server/mcp/file-opener.ts -> server/documents/dirty.ts (value)",
  "server/mcp/file-opener.ts -> server/documents/registry.ts (value)",
  "server/mcp/presence-expiry.ts -> server/documents/registry.ts (value)",
  "server/mcp/routes/backups.ts -> server/documents/registry.ts (value)",
  "server/mcp/routes/document-raw.ts -> server/documents/registry.ts (value)",
  "server/mcp/routes/document-reload.ts -> server/documents/registry.ts (value)",
  "server/mcp/routes/external-conflict.ts -> server/documents/registry.ts (value)",
  "server/mcp/routes/mode-release.ts -> server/documents/registry.ts (value)",
  "server/mcp/routes/open.ts -> server/documents/open.ts (value)",
  "server/mcp/routes/scratchpad.ts -> server/documents/open.ts (value)",
  "server/mcp/routes/upload.ts -> server/documents/open.ts (value)",
  "server/startup-file.ts -> server/documents/open.ts (value)",
];

/**
 * The fan-out is the half that carries ADR-034's residue. `open.ts`'s two rows
 * naming `mcp/file-opener.ts` are the pipeline that has not moved yet; Unit 7a
 * replaces them, Unit 7c deletes the target.
 */
const FAN_OUT = [
  "server/documents/dirty.ts -> server/yjs/provider.ts (value)",
  "server/documents/dirty.ts -> shared/constants.ts (value)",
  "server/documents/dirty.ts -> shared/origins.ts (value)",
  "server/documents/open.ts -> server/mcp/file-opener.ts (type)",
  "server/documents/open.ts -> server/mcp/file-opener.ts (value)",
  "server/documents/registry.ts -> server/yjs/provider.ts (value)",
  "server/documents/registry.ts -> shared/constants.ts (value)",
  "server/documents/registry.ts -> shared/origins.ts (value)",
];

describe("the documents/ boundary is an inventory", () => {
  const { edges, unresolved } = buildGraph();
  const files = sourceFiles();

  it("the sweep and the resolver both actually did something", () => {
    // Every assertion in this file is of the "found nothing unexpected" family,
    // and all of them are satisfied by a sweep that found nothing at all.
    expect(files.length, "control: the walk found the source tree").toBeGreaterThan(400);
    expect(files, "control: the boundary's own module is in scope").toContain(
      "server/documents/open.ts",
    );
    expect(edges.length, "control: the parser produced edges, not just files").toBeGreaterThan(
      1000,
    );
    expect(
      unresolved,
      "the resolver could not place these specifiers — fail closed rather than skip them, or the graph is quietly incomplete",
    ).toEqual([]);
  });

  it("the resolver can still see a cycle it is not looking for", () => {
    // If the `.js -> .ts` mapping or the alias table breaks, every sweep above
    // reports a clean bill of health. So pin a known, unrelated, deliberately
    // unfixed cycle: this pair must remain mutually reachable.
    const has = (from: string, to: string) =>
      edges.some((e) => e.from === from && e.to === to && e.kind !== "dynamic");
    expect(
      has("server/file-io/markdown.ts", "server/file-io/mdast-ydoc.ts") &&
        has("server/file-io/mdast-ydoc.ts", "server/file-io/markdown.ts"),
      "control: the detector still resolves a known mutual import — if this went false the resolver stopped resolving, and every other assertion here passes vacuously",
    ).toBe(true);
  });

  it("only these modules reach into documents/", () => {
    const actual = [
      ...new Set(
        edges
          .filter((e) => e.to.startsWith(DOCUMENTS) && !e.from.startsWith(DOCUMENTS))
          .map(format),
      ),
    ].sort();
    expect(
      actual,
      "a module reaching into documents/ must be written down here — and a row that DISAPPEARS is equally a change, which is why this is an exact set rather than a subset check",
    ).toEqual([...FAN_IN].sort());
  });

  it("documents/ reaches out only to these", () => {
    const actual = [
      ...new Set(
        edges
          .filter((e) => e.from.startsWith(DOCUMENTS) && !e.to.startsWith(DOCUMENTS))
          .map(format),
      ),
    ].sort();
    expect(
      actual,
      "ADR-034's residue lives in this list: every edge out of documents/ that is not yet where it belongs",
    ).toEqual([...FAN_OUT].sort());
  });

  it("nothing in src/ imports the test-only registry seam", () => {
    // The one module under documents/ that is SUPPOSED to have no namer, so the
    // sweep below has to skip it. Asserting the reason turns an unchecked
    // carve-out into a control — and a src module reaching for the unsafe
    // registry primitives is exactly the breach worth catching.
    // `registry-primitive-containment.test.ts` holds the same line from the
    // symbol side.
    expect(
      edges.filter((e) => e.to === TESTING_SEAM).map(format),
      "registry-testing.ts is reachable only from tests; see registry.ts's note on the unsafe primitives",
    ).toEqual([]);
  });

  it("every other module under documents/ has at least one namer", () => {
    // A watched module with zero fan-in produces an empty result that matches an
    // empty expectation — the per-target version of the vacuity above.
    const modules = files.filter((f) => f.startsWith(DOCUMENTS) && f !== TESTING_SEAM);
    expect(modules.length, "control: documents/ is non-empty").toBeGreaterThan(2);
    for (const m of modules) {
      expect(
        edges.some((e) => e.to === m && e.from !== m),
        `${m} is imported by nothing — either it is dead, or the resolver stopped seeing its consumers`,
      ).toBe(true);
    }
  });

  it("no cycle is contained entirely within documents/", () => {
    // The one cycle property this boundary actually controls: ADR-034's sibling
    // modules must not tangle with each other. Tarjan rather than back-edge
    // detection, so the verdict cannot depend on readdir order — which differs
    // between Windows and CI's Linux runner.
    const nodes = files.filter((f) => f.startsWith(DOCUMENTS));
    const nodeSet = new Set(nodes);
    const adj = new Map<string, Set<string>>(nodes.map((n) => [n, new Set<string>()]));
    for (const e of edges) {
      if (e.from !== e.to && nodeSet.has(e.from) && nodeSet.has(e.to)) adj.get(e.from)?.add(e.to);
    }

    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const sccs: string[][] = [];
    let counter = 0;

    const connect = (v: string) => {
      index.set(v, counter);
      low.set(v, counter);
      counter += 1;
      stack.push(v);
      onStack.add(v);
      for (const w of adj.get(v) ?? []) {
        if (!index.has(w)) {
          connect(w);
          low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
        }
      }
      if (low.get(v) === index.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop() as string;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) sccs.push(scc.sort());
      }
    };
    for (const n of nodes) if (!index.has(n)) connect(n);

    expect(nodes.length, "control: there are documents/ modules to check").toBeGreaterThan(2);
    expect(sccs, "these documents/ modules import each other in a loop").toEqual([]);
  });
});

describe("runtime export surfaces", () => {
  /**
   * The source sweeps above are keyed on module specifiers. This one is not,
   * and that is the point: it asks the loaded module what it actually exports.
   * Every way of laundering the seam past the specifier check — a split
   * `import` plus a bare `export {}`, a wrapper function, a dynamic re-export,
   * `export *`, an aliased path, or a two-hop launder through a new compat
   * module — puts the laundered name back on this list.
   */
  it("mcp/file-opener.ts exports exactly what is written down", async () => {
    const mod = await import("../../src/server/mcp/file-opener.js");
    expect(
      Object.keys(mod).sort(),
      "ADR-034 shrinks this surface: Unit 7a moves the open entries out, 7c deletes the module. A name reappearing here is the seam being undone, whatever syntax put it there",
    ).toEqual(
      [
        "SUPPORTED_EXTENSIONS",
        "__testEvictPartialDocState",
        "openFileByPath",
        "openFileFromContent",
        "openScratchpad",
        "reloadDocumentFromMarkdown",
        "resolveExternalConflict",
        "restoreDocumentFromBackup",
        "wireAnnotationStore",
        "wireFileWatcher",
      ].sort(),
    );
  });

  it("documents/open.ts exports exactly what is written down", async () => {
    const mod = await import("../../src/server/documents/open.js");
    expect(
      Object.keys(mod).sort(),
      "the seam's own surface — 7a adds openFromRestore here and 7b adds the result discriminator",
    ).toEqual(["kindOfOpenResult", "openFromDisk", "openFromUpload", "openScratchpad"].sort());
  });
});
