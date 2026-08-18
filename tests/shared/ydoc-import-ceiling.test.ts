/**
 * `src/shared/positions/ydoc.ts` is the first runtime Y.Doc logic in
 * `src/shared/`, and its whole reason for existing is that the client cannot
 * import `src/server/mcp/document-model.ts` — that module pulls `node:path` and
 * `saveMarkdown`, and with it the remark/unified pipeline, at module level.
 *
 * The three-import ceiling is what keeps that true. It CANNOT be held by
 * convention: `biome.json` disables the linter entirely, there is no
 * `no-restricted-imports` rule and no dependency-cruiser, so a stray import
 * would land with nothing to object. A comment asking people not to is not a
 * mechanism — this test is.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODULE = path.join(ROOT, "src/shared/positions/ydoc.ts");

/** Every module specifier the file imports, in source order. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  return [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}

describe("shared/positions/ydoc import ceiling", () => {
  it("imports exactly yjs, ./types.js and ../offsets.js", () => {
    // Asserted as an exact set, not a denylist of forbidden modules. A denylist
    // only catches the imports someone thought to forbid; the danger here is a
    // NEW transitive edge nobody has named yet, and `node:path` was never the
    // point — reaching anything in `src/server` is.
    expect([...new Set(importsOf(MODULE))].sort()).toEqual(["../offsets.js", "./types.js", "yjs"]);
  });

  it("reaches nothing under src/server, by any spelling", () => {
    // Belt and braces over the exact-set assertion above, and the one that
    // states the actual invariant in words a reader can check against intent.
    const offenders = importsOf(MODULE).filter((s) => /server/.test(s));
    expect(offenders).toEqual([]);
  });

  it("reaches nothing outside src/shared transitively either", () => {
    // The direct ceiling is necessary but NOT sufficient, and the gap is easy to
    // miss: if `../offsets.js` grew a `node:path` or `src/server` import
    // tomorrow, every assertion above would still pass while the browser bundle
    // quietly regained the dependency this extraction removed. The invariant is
    // about the CLOSURE, so the test has to walk it.
    const seen = new Set<string>();
    const escapes: string[] = [];

    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (!spec.startsWith(".")) continue; // bare specifiers are packages
        const resolved = path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts"));
        const rel = path.relative(ROOT, resolved).replace(/\\/g, "/");
        if (!rel.startsWith("src/shared/")) {
          escapes.push(`${path.relative(ROOT, file).replace(/\\/g, "/")} -> ${rel}`);
          continue;
        }
        visit(resolved);
      }
    };
    visit(MODULE);

    expect(escapes, "relative imports escaping src/shared").toEqual([]);
    // Positive anchor: an empty `escapes` is also what a walk that visited
    // nothing produces.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it("is not re-exported through the yjs-free barrel", () => {
    // `shared/positions/index.ts` is imported for types by both halves of the
    // app. Routing this module through it would make every one of those
    // consumers pull `yjs` in invisibly — the leak this extraction exists to
    // prevent, reintroduced one convenience re-export later.
    const barrel = readFileSync(path.join(ROOT, "src/shared/positions/index.ts"), "utf-8");
    expect(barrel).not.toContain("ydoc");
  });
});
