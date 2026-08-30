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
 *   1. It is red today and stays red. `documents/open.ts` sits in a large
 *      strongly-connected component that closes through `mcp/api-routes.ts`,
 *      all static value imports. (The illustration used to be
 *      `open.ts -> mcp/file-opener.ts -> mcp/annotations.ts -> mcp/document.ts
 *      -> open.ts`; Unit 7c deleted the second node, so that particular path
 *      is gone while the argument is not: the SCC survives it.)
 *      None of that is in ADR-034's scope, so a gate keyed on it could only
 *      ever be skipped.
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
 * it is written, it fails on *deletion* as well as addition, and most mutants
 * that matter show up as a row: an `export … from "…reload-family.js"` left
 * behind adds a fan-in row; a launder through a new compat module adds a
 * fan-in row from that new module; emptying `documents/` removes rows.
 *
 * **"Most" is exact, and the exception was demonstrated rather than reasoned
 * about.** A guard keyed on an EDGE is defeated by anything that does not
 * create one. A sanctioned consumer can `export { restoreDocumentFromBackup };`
 * — a BARE re-export, no specifier — and any module may then import it from
 * there. No new specifier, so no new row here, and 25 specs stayed green with
 * an arbitrary extra consumer in place. The `export … from` form is caught
 * only incidentally, because it happens to carry a specifier. The re-export
 * question is asked directly in `tests/server/documents-open.test.ts` instead,
 * where the sanctioned list lives.
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

/**
 * tsconfig `paths`, DERIVED — never hand-written.
 *
 * `resolveSpec` treats an unrecognised non-relative specifier as a package
 * import and drops it. So a hand-written table plus one new alias
 * (`"@docs/*": ["src/server/documents/*"]`) makes every `@docs/...` edge
 * vanish from this graph with nothing reported: not an edge, not unresolved,
 * green. Reading the real table means a new alias is either handled or it
 * fails the pin below — it cannot silently narrow the sweep.
 */
function tsconfigAliases(): Array<[string, string]> {
  // Parsed as strict JSON on purpose. `stripComments` is for TypeScript and
  // blanks non-specifier strings, which would erase these very values -- and a
  // naive regex stripper is no better here, because `"src/server/*"` contains a
  // block-comment opener. tsconfig.json has no comments today; if that changes,
  // this throws rather than silently reading a truncated table.
  const raw = readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8");
  const paths = (JSON.parse(raw) as { compilerOptions: { paths: Record<string, string[]> } })
    .compilerOptions.paths;
  return Object.entries(paths).map(([from, [to]]) => [
    from.replace(/\*$/, ""),
    (to as string).replace(/^src\//, "").replace(/\*$/, ""),
  ]);
}
const ALIASES = tsconfigAliases();

type EdgeKind = "value" | "type" | "dynamic";
interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/**
 * Blank comments to spaces, preserving offsets, so a prose mention of a module
 * specifier is not read as an import.
 *
 * This is a scanner rather than two regexes because the regex version was
 * unsound in both directions, and both were demonstrated: a string containing
 * `/*` (e.g. `const g = "docs/*"`) opened a block comment that ran to the
 * file's next `*​/` and swallowed every import in between — failing GREEN; and
 * a `//` guard written as `[^:]` to protect `https://` let `"a://…"` be read
 * as live code — failing red. Comments and strings have to be recognised in
 * one pass, because which one you are inside decides what the other means.
 */
/**
 * Is the string literal starting at `quoteAt` a module specifier?
 *
 * Only `from "…"`, a bare side-effect `import "…"`, and `import("…")` count.
 * Everything else is data, and its contents must not be readable as code.
 */
function inSpecifierPosition(text: string, quoteAt: number): boolean {
  let k = quoteAt - 1;
  while (k >= 0 && /\s/.test(text[k])) k -= 1;
  if (text[k] === "(") {
    let m = k - 1;
    while (m >= 0 && /\s/.test(text[m])) m -= 1;
    return /\bimport$/.test(text.slice(Math.max(0, m - 5), m + 1));
  }
  return /\b(?:from|import)$/.test(text.slice(Math.max(0, k - 5), k + 1));
}

function stripComments(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j += 1;
      blank(i, j);
      i = j;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? text.length : end + 2;
      blank(i, j);
      i = j;
    } else if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === "\\") j += 1;
        else if (quote !== "`" && text[j] === "\n") break;
        j += 1;
      }
      // A module specifier IS a string, so these cannot all be blanked. But a
      // string that is NOT in specifier position must be, or its contents stay
      // readable and `const s = "a://import { z } from '../x.js'"` invents an
      // edge. Position is decided by the token before the quote.
      if (!inSpecifierPosition(text, i)) blank(i + 1, Math.min(j, text.length));
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join("");
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
const DYNAMIC = /\bimport\s*\(\s*(["'`])([^"'`]*)\1\s*\)/g;
/** Any other `import(` — a template with `${…}`, a concatenation, a variable.
 *  Recorded as unresolved so it fails closed; `await import()` is the
 *  sanctioned idiom in exactly this area, so a spelling the resolver cannot
 *  read must not simply disappear from the graph. */
const DYNAMIC_OPAQUE = /\bimport\s*\((?!\s*(["'`])[^"'`]*\1\s*\))\s*[^)]/g;

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
    for (const m of text.matchAll(DYNAMIC)) {
      if (m[2].includes("${")) unresolved.push([rel, m[2]]);
      else record(m[2], "dynamic");
    }
    for (const m of text.matchAll(DYNAMIC_OPAQUE)) unresolved.push([rel, m[0].trim()]);
  }
  return { edges, unresolved };
}

function format(e: Edge): string {
  return `${e.from} -> ${e.to} (${e.kind})`;
}

/**
 * Count the rows, do not dedupe them.
 *
 * A `Set` keyed on the formatted string was the guard's worst hole: sixteen
 * modules already hold a `(value)` row into `documents/`, so any of them could
 * add `export * from "../documents/open.js"` — turning an already-sanctioned
 * module into an unrestricted public facade for the whole directory — and the
 * set came out byte-identical. Counting makes a second statement a second row.
 */
function tally(edges: Edge[]): string[] {
  const counts = new Map<string, number>();
  for (const e of edges) counts.set(format(e), (counts.get(format(e)) ?? 0) + 1);
  return [...counts].map(([row, n]) => `${row} x${n}`).sort();
}

/**
 * Written down, not derived: this is the review inventory. Every import edge
 * that crosses into or out of `src/server/documents/`. Adding a row is a
 * decision someone makes deliberately; that edit is the point of the file.
 */
const FAN_IN = [
  "server/bootstrap/hocuspocus-lifecycle.ts -> server/documents/dirty.ts (value) x1",
  "server/bootstrap/hocuspocus-lifecycle.ts -> server/documents/registry.ts (value) x1",
  "server/events/observers/ctrl-meta.ts -> server/documents/registry.ts (value) x1",
  "server/events/queue.ts -> server/documents/dirty.ts (value) x1",
  "server/index.ts -> server/documents/open.ts (value) x1",
  "server/local-model/collaborator.ts -> server/documents/registry.ts (value) x1",
  "server/mcp/convert.ts -> server/documents/open.ts (value) x1",
  "server/mcp/document-service.ts -> server/documents/dirty.ts (value) x1",
  // x2: document-service.ts both imports from the registry AND re-exports
  // fifteen of its symbols. That facade is why callers spent two units
  // importing registry symbols through document-service, which is what made
  // the open path look like it depended on a subsystem it does not touch.
  // The deduped version of this list could not see the second statement.
  "server/mcp/document-service.ts -> server/documents/registry.ts (value) x2",
  "server/mcp/document.ts -> server/documents/open.ts (value) x1",
  // The reload family's four consumers, reaching it by its name on the seam.
  //
  // These four rows REPLACED six of the opposite shape
  // (`mcp/file-opener.ts -> documents/{autosave,registry,populate,
  // annotation-wiring,conflict,watcher}.ts`), whose written rationale was that
  // leaving the shared content machinery behind in `mcp/` would have made
  // `documents/` import back into `mcp/`. Unit 7c settled that differently and
  // better: the reload family moved INTO `documents/`, so those six are now
  // intra-directory calls that no inventory needs to sanction, and what crosses
  // the boundary is four consumers asking for a published entry point. The
  // direction reversed, and reversing it is the improvement.
  //
  // **It is a trade, not an equivalence, and the losing half is written down
  // here so nobody has to rediscover it.** Those six edges were inventoried
  // and are now pinned by nothing but the intra-`documents/` acyclicity check.
  // Concretely: any module inside `documents/` may now import and call any
  // reload-family symbol with zero constraint — adding
  // `import { resolveExternalConflict } from "./reload-family"` to `open.ts`
  // is green across every spec in this file and in `documents-open.test.ts`.
  // The entitlement inventory therefore covers strictly LESS area after 7c
  // than before. That was accepted because the six rows were sanctioning
  // `mcp/` reaching into `documents/`'s internals — a thing that should not
  // happen at all rather than a thing worth enumerating — while the four rows
  // that replaced them sanction the calls that genuinely cross a seam.
  //
  // Which symbols each may take is a separate, narrower question, kept in
  // `tests/server/documents-open.test.ts`'s SANCTIONED map.
  "server/mcp/docx-apply.ts -> server/documents/reload-family.ts (value) x1",
  "server/mcp/routes/backups.ts -> server/documents/reload-family.ts (value) x1",
  "server/mcp/routes/document-reload.ts -> server/documents/reload-family.ts (value) x1",
  "server/mcp/routes/external-conflict.ts -> server/documents/reload-family.ts (value) x1",
  // document-service reaching in is the point of the conflict split: it read
  // `Y_MAP_EXTERNAL_CONFLICT` through a helper it owned, so the watcher had to
  // import document-service to ask a question about a map it writes itself.
  "server/mcp/document-service.ts -> server/documents/annotation-wiring.ts (value) x1",
  "server/mcp/document-service.ts -> server/documents/conflict.ts (value) x1",
  "server/mcp/document-service.ts -> server/documents/watcher.ts (value) x1",
  // The restore path, by its name on the seam. This edge replaced a dynamic
  // import whose only purpose was breaking the cycle; a static edge here is
  // the cycle being gone rather than deferred.
  "server/mcp/document-service.ts -> server/documents/open.ts (value) x1",
  "server/mcp/presence-expiry.ts -> server/documents/registry.ts (value) x1",
  // Route infrastructure reaching the open seam, added by ADR-034 Unit 7b.
  // `send-open-result.ts` owns `sendOpenResult`, the one place the three open
  // routes project `OpenSuccess` onto the wire — the alternative was three
  // routes each importing `toWireResult` themselves, which is three edges
  // instead of one and three places to forget the projection.
  //
  // It is deliberately NOT in `_shared.ts`, where it first landed: every route
  // imports that module, so the edge below would be inherited by all of them
  // and pull `open.ts -> autosave.ts -> mcp/document-service.ts` into their
  // module init. `rename-route.test.ts` went red on exactly that. A leaf every
  // route imports has to stay a leaf, and this inventory is where a future
  // "just put it in _shared" would show up as a widened edge.
  "server/mcp/routes/send-open-result.ts -> server/documents/open.ts (value) x1",
  "server/mcp/routes/backups.ts -> server/documents/registry.ts (value) x1",
  "server/mcp/routes/document-raw.ts -> server/documents/registry.ts (value) x1",
  "server/mcp/routes/document-reload.ts -> server/documents/registry.ts (value) x1",
  "server/mcp/routes/external-conflict.ts -> server/documents/registry.ts (value) x1",
  "server/mcp/routes/mode-release.ts -> server/documents/registry.ts (value) x1",
  "server/mcp/routes/open.ts -> server/documents/open.ts (value) x1",
  "server/mcp/routes/scratchpad.ts -> server/documents/open.ts (value) x1",
  "server/mcp/routes/upload.ts -> server/documents/open.ts (value) x1",
  "server/startup-file.ts -> server/documents/open.ts (value) x1",
];

/**
 * The fan-out is the half that carried ADR-034's residue, and the residue is
 * now gone: `open.ts` had two rows naming `mcp/file-opener.ts` — the pipeline
 * that had not moved yet — and Unit 7a replaced them, then Unit 7c deleted
 * the target module outright. Zero rows name it today.
 */
const FAN_OUT = [
  "server/documents/dirty.ts -> server/yjs/provider.ts (value) x1",
  "server/documents/dirty.ts -> shared/constants.ts (value) x1",
  "server/documents/dirty.ts -> shared/origins.ts (value) x1",
  "server/documents/populate.ts -> server/events/queue.ts (value) x1",
  "server/documents/populate.ts -> server/file-io/index.ts (value) x1",
  "server/documents/populate.ts -> server/notifications.ts (value) x1",
  "server/documents/populate.ts -> server/session/manager.ts (value) x1",
  "server/documents/populate.ts -> shared/constants.ts (value) x1",
  "server/documents/populate.ts -> shared/origins.ts (value) x1",
  "server/documents/populate.ts -> shared/types.ts (type) x1",
  "server/documents/populate.ts -> shared/utils.ts (value) x1",
  "server/documents/annotation-wiring.ts -> server/annotations/doc-hash.ts (value) x1",
  "server/documents/annotation-wiring.ts -> server/annotations/rename-recovery.ts (value) x1",
  "server/documents/annotation-wiring.ts -> server/annotations/store.ts (value) x1",
  "server/documents/annotation-wiring.ts -> server/annotations/sync.ts (value) x1",
  "server/documents/annotation-wiring.ts -> server/events/queue.ts (value) x1",
  "server/documents/annotation-wiring.ts -> server/notifications.ts (value) x1",
  "server/documents/annotation-wiring.ts -> shared/utils.ts (value) x1",
  "server/documents/conflict.ts -> server/notifications.ts (value) x1",
  "server/documents/conflict.ts -> server/session/manager.ts (value) x1",
  "server/documents/conflict.ts -> shared/constants.ts (value) x1",
  "server/documents/conflict.ts -> shared/origins.ts (value) x1",
  "server/documents/conflict.ts -> shared/types.ts (type) x1",
  "server/documents/conflict.ts -> shared/utils.ts (value) x1",
  // TWO things in documents/ still reach document-service, and they leave
  // together or not at all. Autosave is why `ensureAutoSave` got its own
  // module instead of riding the open seam: leaving it in open.ts would have
  // put this edge back on the pipeline that just shed it. The reload family
  // brought the second one in with it (Unit 7c) for `canSaveToDisk` /
  // `saveDocumentToDisk` — a known, deliberate cost of that move, not a
  // regression. Both disappear when `autoSaveAllToDisk` moves out of
  // document-service; neither disappears before that.
  //
  // This comment read "Autosave is the ONLY thing" until 7c made it false.
  "server/documents/autosave.ts -> server/mcp/document-service.ts (value) x1",
  "server/documents/autosave.ts -> server/session/manager.ts (value) x1",
  // The reload family, moved here by Unit 7c. Eight of these eleven are new
  // edges OUT of documents/ that did not exist before, because the code that
  // makes them used to live in mcp/ — they are the accounting cost of turning
  // six inbound rows into four, and every one is one-directional.
  "server/documents/reload-family.ts -> server/file-io/doc-backup.ts (value) x1",
  "server/documents/reload-family.ts -> server/file-io/docx-size-gate.ts (value) x1",
  "server/documents/reload-family.ts -> server/file-io/index.ts (value) x1",
  "server/documents/reload-family.ts -> server/file-watcher.ts (value) x1",
  "server/documents/reload-family.ts -> server/mcp/document-service.ts (value) x1",
  "server/documents/reload-family.ts -> server/notifications.ts (value) x1",
  "server/documents/reload-family.ts -> server/platform.ts (value) x1",
  "server/documents/reload-family.ts -> server/yjs/provider.ts (value) x1",
  "server/documents/reload-family.ts -> shared/constants.ts (value) x1",
  "server/documents/reload-family.ts -> shared/origins.ts (value) x1",
  "server/documents/reload-family.ts -> shared/utils.ts (value) x1",
  "server/documents/autosave.ts -> server/yjs/provider.ts (value) x1",
  "server/documents/open.ts -> server/file-io/index.ts (value) x1",
  // Two edges from the seam back into mcp/, both ADR-034 residue: format
  // detection/id derivation, and the welcome-doc tutorial annotations.
  "server/documents/open.ts -> server/mcp/document-model.ts (value) x1",
  "server/documents/open.ts -> server/mcp/tutorial-annotations.ts (value) x1",
  "server/documents/open.ts -> server/session/manager.ts (value) x1",
  "server/documents/open.ts -> server/yjs/provider.ts (value) x1",
  "server/documents/open.ts -> shared/constants.ts (value) x1",
  "server/documents/open.ts -> shared/cross-basename.ts (value) x1",
  "server/documents/open.ts -> shared/origins.ts (value) x1",
  "server/documents/open.ts -> shared/paths.ts (value) x1",
  "server/documents/open.ts -> shared/types.ts (type) x1",
  "server/documents/open.ts -> shared/windows-path-safety.ts (value) x1",
  "server/documents/watcher.ts -> server/annotations/doc-hash.ts (value) x1",
  "server/documents/watcher.ts -> server/annotations/migration-log.ts (value) x1",
  "server/documents/watcher.ts -> server/events/queue.ts (value) x1",
  "server/documents/watcher.ts -> server/file-io/index.ts (value) x1",
  "server/documents/watcher.ts -> server/file-watcher.ts (value) x1",
  // One of FIVE edges out of documents/ that point back at mcp/, and the
  // reason this list is phrased as residue rather than as a contract:
  // annotation sanitization has not been split out of the MCP layer yet.
  //
  // This said "the one edge" when it was written and was already wrong then —
  // `open.ts -> mcp/document-model.ts`, `open.ts -> mcp/tutorial-annotations.ts`
  // and `autosave.ts -> mcp/document-service.ts` all existed, making four.
  // Unit 7c added a fifth (`reload-family.ts -> mcp/document-service.ts`) and
  // corrected the count. Each has its own reason and they do not leave
  // together. Count them from the rows below rather than trusting this number:
  // review handed me "four" for the post-7c graph and the rows said five.
  "server/documents/watcher.ts -> server/mcp/annotations.ts (value) x1",
  "server/documents/watcher.ts -> server/notifications.ts (value) x1",
  "server/documents/watcher.ts -> server/positions.ts (value) x1",
  "server/documents/watcher.ts -> server/yjs/provider.ts (value) x1",
  "server/documents/watcher.ts -> shared/constants.ts (value) x1",
  "server/documents/watcher.ts -> shared/origins.ts (value) x1",
  "server/documents/watcher.ts -> shared/positions/types.ts (value) x1",
  "server/documents/watcher.ts -> shared/snapshot.ts (value) x1",
  "server/documents/watcher.ts -> shared/types.ts (type) x1",
  "server/documents/watcher.ts -> shared/utils.ts (value) x1",
  "server/documents/registry.ts -> server/yjs/provider.ts (value) x1",
  "server/documents/registry.ts -> shared/constants.ts (value) x1",
  "server/documents/registry.ts -> shared/origins.ts (value) x1",
];

describe("stripComments", () => {
  // Checked directly rather than through the graph. Both cases below were live
  // defects in the two-regex version this replaced, and NEITHER is observable
  // downstream: a swallowed import removes an edge, which looks exactly like a
  // module that simply does not import that thing, and an invented edge only
  // surfaces if it happens to cross the boundary. The helper is the only place
  // they are visible, so it is the place to assert them.

  it("a string containing a block-comment opener does not open a comment", () => {
    const src = [
      'const glob = "docs/*";',
      'import { x } from "../documents/open.js";',
      "/** a real doc comment */",
    ].join("\n");

    expect(
      stripComments(src),
      "the block pass used to run first, so this string opened a comment that ran to the file's next terminator and blanked every import between — and the graph then read as complete",
    ).toContain('from "../documents/open.js"');
  });

  it("a // inside a string neither survives as code nor blanks its line", () => {
    const src = "const s = \"a://import { z } from '../documents/open.js'\";\nconst after = 1;";
    const out = stripComments(src);

    expect(out, "the string's contents must not be readable as an import").not.toContain(
      "import { z }",
    );
    expect(out, "and the [^:] guard that used to protect https:// must not be needed").toContain(
      "const after = 1;",
    );
  });

  it("preserves offsets, so blanking cannot shift what follows", () => {
    const src = "// note\nimport { x } from './y.js';";
    expect(stripComments(src)).toHaveLength(src.length);
    expect(stripComments(src)).toContain("import { x }");
  });
});

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

  it("the alias table matches tsconfig, and every alias maps into src/", () => {
    // Derivation alone is not enough: an alias pointing outside `src/` would
    // resolve to a path this walker never lists, so the edge disappears just as
    // quietly as an unhandled one.
    expect(ALIASES.length, "control: tsconfig still declares path aliases").toBeGreaterThan(0);
    for (const [from, to] of ALIASES) {
      expect(
        from.startsWith("@"),
        `${from} is not an alias spelling this resolver understands`,
      ).toBe(true);
      expect(
        sourceFiles().some((f) => f.startsWith(to)),
        `alias ${from} maps to ${to}, which is not under src/ — edges through it would vanish from this graph`,
      ).toBe(true);
    }
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
    const actual = tally(
      edges.filter((e) => e.to.startsWith(DOCUMENTS) && !e.from.startsWith(DOCUMENTS)),
    );
    expect(
      actual,
      "a module reaching into documents/ must be written down here — and a row that DISAPPEARS is equally a change, which is why this is an exact set rather than a subset check",
    ).toEqual([...FAN_IN].sort());
  });

  it("documents/ reaches out only to these", () => {
    const actual = tally(
      edges.filter((e) => e.from.startsWith(DOCUMENTS) && !e.to.startsWith(DOCUMENTS)),
    );
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
   * Every way of widening THIS MODULE'S surface — a split `import` plus a bare
   * `export {}`, a wrapper function, a dynamic re-export, `export *`, an
   * aliased path — puts the new name back on this list.
   *
   * **Scope, stated because an earlier version of this comment overstated
   * it.** It said a two-hop launder through a new compat module was also
   * caught here. It is not: this spec reads the export surface of
   * `reload-family.ts` and nothing else, so a compat module that re-exports
   * from somewhere else is invisible to it. That case is the fan-in
   * inventory's, and the BARE re-export sub-case is neither's — it is pinned
   * in `tests/server/documents-open.test.ts`. A comment that claims a
   * neighbouring spec's coverage is worse than an unpinned guard, because it
   * makes the next reader stop looking.
   */
  it("documents/reload-family.ts exports exactly what is written down", async () => {
    const mod = await import("../../src/server/documents/reload-family.js");
    expect(
      Object.keys(mod).sort(),
      "ADR-034 shrank this surface to three: Unit 7a moved the open entries out of what was then mcp/file-opener.ts, and 7c moved the remaining reload family here and deleted that module. A name reappearing here is the seam being undone, whatever syntax put it there",
    ).toEqual(
      ["reloadDocumentFromMarkdown", "resolveExternalConflict", "restoreDocumentFromBackup"].sort(),
    );
  });

  it("documents/open.ts exports exactly what is written down", async () => {
    const mod = await import("../../src/server/documents/open.js");
    expect(
      Object.keys(mod).sort(),
      "the seam's own surface — 7a added openFromRestore here, 7b added toWireResult",
    ).toEqual(
      [
        // `toWireResult` is the single projector from the internal `OpenSuccess`
        // union onto the flat JSON six sites put on the wire. It is exported
        // because those six live in three other modules — a second copy of the
        // projection is exactly what Unit 7b exists to prevent.
        "kindOfOpenResult",
        "openFromDisk",
        "openFromRestore",
        "openFromUpload",
        "openScratchpad",
        "toWireResult",
      ].sort(),
    );
  });
});
