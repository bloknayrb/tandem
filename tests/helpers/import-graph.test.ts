import { describe, expect, it } from "vitest";
import {
  buildImportGraph,
  CODE_FILES,
  closure,
  closureIn,
  IMPORTS,
  specifiers,
} from "./import-graph.js";

/**
 * Positive controls for the import walk the module-seam guards share (#2358).
 * Every seam guard's forbidden half ("no define-less bundle reaches X") is
 * true of an empty graph, so the walk has to prove on its own that it follows
 * real edges of every shape.
 */
describe("the shared import walk", () => {
  it("follows a fixture chain through every specifier shape it claims", () => {
    const files = new Map<string, string>([
      ["src/a/index.ts", 'import { b } from "../b/b.js";\nexport const a = b;'],
      ["src/b/b.ts", 'export { c } from "./c.js";\nexport const b = 1;'],
      ["src/b/c.ts", 'import type { D } from "../d/d.js";\nexport const c = 1 as unknown as D;'],
      ["src/d/d.ts", 'import "./side.js";\nexport type D = number;'],
      ["src/d/side.ts", 'export const lazy = () => import("../e/e.js");'],
      ["src/e/e.ts", "export const e = 1;"],
    ]);
    const graph = buildImportGraph(files);
    expect(graph.unresolved).toEqual([]);
    expect([...closureIn(graph.imports, "src/a/index.ts")].sort()).toEqual([
      "src/a/index.ts",
      "src/b/b.ts",
      "src/b/c.ts",
      "src/d/d.ts",
      "src/d/side.ts",
      "src/e/e.ts",
    ]);
  });

  it("reports a relative specifier it cannot resolve instead of dropping it", () => {
    const graph = buildImportGraph(new Map([["src/x.ts", 'import { y } from "./nowhere.js";']]));
    expect(graph.unresolved).toEqual(["src/x.ts -> ./nowhere.js"]);
  });

  it("sees an import that follows a line comment holding src/*", () => {
    const fixture = '// see src/* for the list\nimport { z } from "./z.js";\n/** later */';
    expect(specifiers(fixture)).toContain("./z.js");
  });

  it("finds known transitive paths in the real tree", () => {
    expect(CODE_FILES.length).toBeGreaterThan(300);
    expect([...IMPORTS.values()].flat().length).toBeGreaterThan(1000);
    const server = closure("src/server/index.ts");
    expect(server.has("src/server/license/ai-refusal.ts")).toBe(true);
    expect(server.has("src/server/ownership-flag.ts")).toBe(true);
    expect(closure("src/shared/sse-consumer.ts").has("src/shared/license-copy.ts")).toBe(true);
  });
});
