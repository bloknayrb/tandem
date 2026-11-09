import { posix } from "node:path";
import { SRC_FILES } from "./src-tree.js";

/**
 * The relative-import graph of `src/`, shared by the module-seam guards
 * (`tests/server/license-module-seam.test.ts`, `ownership-module-seam.test.ts`).
 *
 * Moved here from the licence seam test when the ownership flag needed the same
 * walk (#2358), with that test's assertions unchanged. A guard built on a walk
 * that silently resolves fewer edges passes vacuously — its "no define-less
 * bundle reaches X" becomes true of an empty graph — so the walk carries its
 * own positive controls (`tests/helpers/import-graph.test.ts`): a known
 * transitive path, and a fixture chain through every specifier shape below.
 *
 * **The walk fails closed.** A relative specifier it cannot resolve is
 * collected in `UNRESOLVED` rather than silently dropped from the graph — a
 * dropped edge is exactly how a forbidden import would read as absent.
 */

/** File extensions the walk treats as code. */
export const CODE = /\.(ts|mts|svelte|js|mjs)$/;

/**
 * Every module specifier in a file. The `import|export … from` arm spans lines
 * (`[^;'"]` matches newlines), so a multi-line `export { a, b } from "…"` and
 * an `import type { T } from "…"` both count; pattern borrowed from
 * `tests/docs/documents-boundary.test.ts`.
 *
 * **Comments are deliberately NOT stripped.** A regex comment stripper that
 * removes block comments first reads a line comment holding `src/*` as the
 * opening of a block, and silently deletes every import up to the next `*\/` —
 * neither resolved nor reported (live in `annotations/lifecycle.ts`). Over-
 * reading a commented-out import errs safe: it can only ADD an edge, or fail
 * the UNRESOLVED check loudly, never hide one.
 */
export function specifiers(src: string): string[] {
  const out: string[] = [];
  const pattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\s+)?from\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of src.matchAll(pattern)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Resolve a relative specifier to a known `src/` file, mapping `.js` to `.ts`; `null` if none. */
export function resolveSpec(
  fromRel: string,
  spec: string,
  files: ReadonlyMap<string, string> = SRC_FILES,
): string | null {
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec.replace(/\?.*$/, "")));
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.mjs$/, ".mts"),
    base,
    `${base}.ts`,
    `${base}/index.ts`,
  ];
  return candidates.find((c) => files.has(c)) ?? null;
}

/** The graph of `files`: each code file → the files its relative specifiers resolve to. */
export function buildImportGraph(files: ReadonlyMap<string, string>): {
  codeFiles: string[];
  imports: Map<string, string[]>;
  unresolved: string[];
} {
  const codeFiles = [...files.keys()].filter((f) => CODE.test(f));
  const imports = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const file of codeFiles) {
    const targets: string[] = [];
    for (const spec of specifiers(files.get(file) as string)) {
      if (!spec.startsWith(".")) continue;
      const resolved = resolveSpec(file, spec, files);
      if (resolved) targets.push(resolved);
      else unresolved.push(`${file} -> ${spec}`);
    }
    imports.set(file, targets);
  }
  return { codeFiles, imports, unresolved };
}

/** Every file reachable from `entry` by relative imports in `imports`. */
export function closureIn(imports: ReadonlyMap<string, string[]>, entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const t of imports.get(f) ?? []) stack.push(t);
  }
  return seen;
}

const SRC_GRAPH = buildImportGraph(SRC_FILES);

/** Every code file under `src/`. */
export const CODE_FILES: readonly string[] = SRC_GRAPH.codeFiles;
/** `src/` code file → the `src/` files it imports. */
export const IMPORTS: ReadonlyMap<string, string[]> = SRC_GRAPH.imports;
/** Relative specifiers in `src/` the walk could not resolve. */
export const UNRESOLVED: readonly string[] = SRC_GRAPH.unresolved;

/** Every `src/` file reachable from `entry`. */
export function closure(entry: string): Set<string> {
  return closureIn(IMPORTS, entry);
}

/**
 * Every `sidecarBundle("<name>")` entry in tsup.config.ts — the bundles that
 * carry no build `define`. Derived, so a new sidecar joins every check by itself.
 */
export function sidecarEntries(tsupConfigSource: string): string[] {
  return [...tsupConfigSource.matchAll(/sidecarBundle\(\s*"([\w-]+)"\s*\)/g)].map(
    (m) => `src/${m[1]}/index.ts`,
  );
}
