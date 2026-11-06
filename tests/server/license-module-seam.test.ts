import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODE_FILES,
  closure,
  IMPORTS,
  sidecarEntries,
  specifiers,
  UNRESOLVED,
} from "../helpers/import-graph.js";
import { SRC_FILES, stripComments } from "../helpers/src-tree.js";

/**
 * The licence module seam (#1521), keyed on modules, not names.
 *
 * Pins **module → importer files** for every module under `src/server/license/`
 * (subdirectories included) — static imports and type imports, `export … from`
 * re-exports, bare side-effect imports and `import()` strings — read off the
 * code as implemented. A new importer of the licence decision is a new place
 * licence state is consulted; it must be added here, which is a diff someone
 * reviews.
 *
 * And the forbidden half: the bundles built WITHOUT the licence `define` (every
 * tsup sidecar, the stdio bridge's script and the shared SSE consumer) must
 * never reach `src/server/license/` by any import chain — `gate-flag.ts` would
 * fall back to the env var there, and esbuild leaves an absent define as a bare
 * free global. They key on the wire payload `error === "LICENSE_REQUIRED"`.
 *
 * The import walk lives in `tests/helpers/import-graph.ts` (shared with the
 * ownership flag's seam test since #2358) and fails closed: an unresolvable
 * relative specifier is collected and asserted empty below. A path alias
 * (`@server/…`) is refused outright for the same reason. The walk's own
 * positive controls are in `tests/helpers/import-graph.test.ts`.
 *
 * Reachability of the refusals themselves is the armed probe's job
 * (`license-armed-restricted.test.ts`), not this one's.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const LICENSE_PREFIX = "src/server/license/";

/** module (path under src/server/license, no `.ts`) → sorted importers outside it. */
function importerMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const f of CODE_FILES.filter((f) => f.startsWith(LICENSE_PREFIX))) {
    map[f.slice(LICENSE_PREFIX.length).replace(/\.ts$/, "")] = [];
  }
  for (const [file, targets] of IMPORTS) {
    if (file.startsWith(LICENSE_PREFIX)) continue;
    for (const t of targets) {
      if (!t.startsWith(LICENSE_PREFIX)) continue;
      const mod = t.slice(LICENSE_PREFIX.length).replace(/\.ts$/, "");
      if (!map[mod].includes(file)) map[mod].push(file);
    }
  }
  for (const k of Object.keys(map)) map[k].sort();
  return map;
}

describe("licence module seam (#1521)", () => {
  /**
   * The miss a regex comment-stripper made: a line comment holding `src/*`
   * opens a phantom block comment, and the real import on the next line
   * vanished until the next `*\/`. Shaped exactly like that, inline, so the
   * extractor is pinned rather than the tree it happens to scan today.
   */
  it("the extractor sees an import that follows a line comment holding src/*", () => {
    const fixture = [
      "// see the files under src/* for the full list",
      'import { aiRefusal } from "../server/license/ai-refusal.js";',
      "",
      "/**",
      " * A later JSDoc whose terminator closed the phantom block.",
      " */",
      "export const x = aiRefusal;",
    ].join("\n");
    expect(specifiers(fixture)).toContain("../server/license/ai-refusal.js");
    // And the stripper this replaced really does lose it — the reason not to use it.
    expect(specifiers(stripComments(fixture))).not.toContain("../server/license/ai-refusal.js");
  });

  it("the import walk resolves every relative specifier in src (fails closed)", () => {
    // Exactly the known PROSE specifiers — comments are read on purpose (see
    // `specifiers`), so a usage example in a docblock lands here. Set equality:
    // any new unresolved specifier fails, and so does a stale entry.
    expect(UNRESOLVED).toEqual([
      // registry.ts:5 docblock: "Each entry is a lazy import: `() => import(...)`".
      "src/client/svelte-harness/registry.ts -> ../path/to/Component.svelte",
    ]);
    // Anti-vacuity: the walk found real edges.
    expect([...IMPORTS.values()].flat().length).toBeGreaterThan(100);
  });

  it("each src/server/license module is imported by exactly the reviewed files", () => {
    expect(importerMap()).toEqual({
      activation: ["src/cli/license.ts", "src/server/mcp/routes/license.ts"],
      "ai-refusal": [
        "src/server/events/queue.ts",
        "src/server/events/sse.ts",
        "src/server/events/wake-socket.ts",
        "src/server/launcher/api-routes.ts",
        "src/server/launcher/supervisor.ts",
        "src/server/local-model/collaborator.ts",
        "src/server/mcp/awareness.ts",
        "src/server/mcp/channel-routes.ts",
        "src/server/mcp/server.ts",
      ],
      "gate-flag": ["src/cli/license.ts", "src/server/index.ts"],
      // #2231: the grace record. license-state.ts is its only importer, and
      // importers inside src/server/license/ are not listed here.
      grace: [],
      "kv-store": [],
      "license-state": [
        "src/cli/license.ts",
        "src/server/index.ts",
        "src/server/mcp/routes/license.ts",
      ],
      "license-types": ["src/cli/license.ts", "src/server/mcp/routes/license.ts"],
      paste: [],
      paths: [],
      "public-key": [],
      verifier: [],
    });
  });

  /** Every `sidecarBundle("<name>")` in tsup.config.ts — the bundles that carry
   * no licence `define`. Derived, so a new sidecar joins the check by itself. */
  const SIDECAR_ENTRIES = sidecarEntries(readFileSync(join(ROOT, "tsup.config.ts"), "utf-8"));

  const DEFINE_LESS_ROOTS = [
    ...SIDECAR_ENTRIES,
    "src/cli/mcp-stdio.ts",
    "src/shared/sse-consumer.ts",
  ];

  it("the define-less roots are derived from tsup's sidecar entries", () => {
    expect(SIDECAR_ENTRIES.length).toBeGreaterThan(0);
    expect(SIDECAR_ENTRIES).toEqual(
      expect.arrayContaining([
        "src/channel/index.ts",
        "src/monitor/index.ts",
        "src/stdio-bridge/index.ts",
      ]),
    );
    for (const entry of SIDECAR_ENTRIES) {
      expect(SRC_FILES.has(entry), `${entry} exists`).toBe(true);
      expect(DEFINE_LESS_ROOTS).toContain(entry);
    }
  });

  /**
   * The relative-import walk is blind to a path alias, so a `@server/…` import
   * in a define-less bundle would reach the licence modules unseen. The aliases
   * exist in tsconfig for the client only; fail closed on any other use rather
   * than teach the walker to resolve them.
   */
  it("no file outside src/client imports through a @server/ @shared/ @client/ alias", () => {
    const hits = CODE_FILES.filter((f) => !f.startsWith("src/client/")).filter((f) =>
      specifiers(SRC_FILES.get(f) as string).some((s) => /^@(server|shared|client)\//.test(s)),
    );
    expect(hits).toEqual([]);
  });

  it("no define-less bundle reaches src/server/license by any import chain", () => {
    for (const root of DEFINE_LESS_ROOTS) {
      const reach = closure(root);
      // Anti-vacuity: the walk really follows imports (each root pulls in more
      // than itself), so an empty result is evidence, not a broken walker.
      expect(reach.size, `${root} closure`).toBeGreaterThan(1);
      const hits = [...reach].filter((f) => f.startsWith(LICENSE_PREFIX));
      expect(hits, `${root} must not reach the licence modules`).toEqual([]);
    }
    // And the wire constant they DO use is reached — the positive twin.
    expect([...closure("src/shared/sse-consumer.ts")]).toContain("src/shared/license-copy.ts");
  });

  it("no file imports a deleted license-gate / connection-gate module", () => {
    const hits = CODE_FILES.filter((f) =>
      specifiers(SRC_FILES.get(f) as string).some((s) =>
        /\/(license-gate|connection-gate)\.js$/.test(s),
      ),
    );
    expect(hits).toEqual([]);
  });

  it("the gate flag is read in gate-flag.ts only", () => {
    const hits = CODE_FILES.filter((f) => f !== `${LICENSE_PREFIX}gate-flag.ts`).filter((f) =>
      /TANDEM_LICENSE_GATE|__LICENSE_GATE_ENABLED__/.test(
        stripComments(SRC_FILES.get(f) as string),
      ),
    );
    expect(hits).toEqual([]);
    // Positive twin: the one legitimate reader really does read it.
    expect(SRC_FILES.get(`${LICENSE_PREFIX}gate-flag.ts`)).toMatch(/TANDEM_LICENSE_GATE/);
  });
});

describe("licence bindings that a refactor could quietly change (#1521)", () => {
  const supervisor = SRC_FILES.get("src/server/launcher/supervisor.ts") as string;
  const collaborator = SRC_FILES.get("src/server/local-model/collaborator.ts") as string;

  /**
   * The launched Claude's push subscription is `"external"` (the Solo gate) and
   * carries NO `onRevoke`: a refused event must skip it, never unsubscribe it,
   * so a child still running at expiry is woken again after activation. An
   * `onRevoke` added here would silently strand that child.
   */
  it("the supervisor's push subscription is external with no onRevoke", () => {
    const body = /export function defaultSubscribeToEvents\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(
      supervisor,
    )?.[1];
    expect(body, "defaultSubscribeToEvents is gone").toBeDefined();
    expect(body).toMatch(/\bsubscribe\(cb, "external"\);/);
    expect(body).not.toMatch(/onRevoke/);
  });

  /**
   * Both default to the LIVE decision; an injectable seam whose default became
   * `() => null` would admit everything with every test still green.
   */
  it("the supervisor and the collaborator default to the live aiRefusal", () => {
    expect(supervisor).toMatch(/opts\.aiRefusal \?\? aiRefusal;/);
    expect(collaborator).toMatch(/deps\.aiRefusal \?\? aiRefusal;/);
  });
});
