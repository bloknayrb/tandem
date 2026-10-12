import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The licence module seam (#1521 §8), keyed on modules, not names.
 *
 * Pins **module → importer files** for every module under `src/server/license/`
 * — static imports, `import()` strings and re-exports — read off the code as
 * implemented. A new importer of the licence decision is a new place licence
 * state is consulted; it must be added here, which is a diff someone reviews.
 *
 * And the forbidden half: the bundles built WITHOUT the licence `define` (the
 * stdio bridge, the channel shim, the plugin monitor and the shared SSE
 * consumer they use) must never reach `src/server/license/` by any import
 * chain — `gate-flag.ts` would fall back to the env var there, and esbuild
 * leaves an absent define as a bare free global. They key on the wire payload
 * `error === "LICENSE_REQUIRED"` instead.
 *
 * Reachability of the refusals themselves is the armed probe's job
 * (`license-armed-restricted.test.ts`), not this one's.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
const LICENSE_DIR = join(SRC, "server", "license");

const toRel = (abs: string) => relative(ROOT, abs).split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(ts|mts|svelte)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(abs);
  }
  return out;
}

/** Every module specifier: `from "x"` (imports and re-exports) and `import("x")`. */
function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bfrom\s*["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}

/** Resolve a relative specifier to a source file, mapping `.js` to `.ts`. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".svelte.ts"),
    base,
    `${base}.ts`,
    join(base, "index.ts"),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

const FILES = walk(SRC);
const IMPORTS = new Map<string, string[]>();
for (const file of FILES) {
  const targets = specifiers(readFileSync(file, "utf-8"))
    .map((s) => resolveSpec(file, s))
    .filter((t): t is string => t !== null);
  IMPORTS.set(file, targets);
}

/** module (basename under src/server/license) → sorted importer files outside it. */
function importerMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const mod of readdirSync(LICENSE_DIR).filter((f) => f.endsWith(".ts"))) {
    map[mod.replace(/\.ts$/, "")] = [];
  }
  for (const [file, targets] of IMPORTS) {
    if (file.startsWith(LICENSE_DIR + sep)) continue;
    for (const t of targets) {
      if (dirname(t) !== LICENSE_DIR) continue;
      const mod = t.slice(LICENSE_DIR.length + 1).replace(/\.ts$/, "");
      if (!map[mod].includes(toRel(file))) map[mod].push(toRel(file));
    }
  }
  for (const k of Object.keys(map)) map[k].sort();
  return map;
}

/** Every file reachable from `entry` by relative imports. */
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const t of IMPORTS.get(f) ?? []) stack.push(t);
  }
  return seen;
}

describe("licence module seam (#1521)", () => {
  it("each src/server/license module is imported by exactly the reviewed files", () => {
    expect(importerMap()).toEqual({
      activation: ["src/cli/license.ts", "src/server/mcp/routes/license.ts"],
      "ai-refusal": [
        "src/server/events/queue.ts",
        "src/server/events/sse.ts",
        "src/server/events/wake-socket.ts",
        "src/server/launcher/supervisor.ts",
        "src/server/local-model/collaborator.ts",
        "src/server/mcp/awareness.ts",
        "src/server/mcp/channel-routes.ts",
        "src/server/mcp/server.ts",
      ],
      "gate-flag": ["src/cli/license.ts", "src/server/index.ts"],
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

  const DEFINE_LESS_ROOTS = [
    "src/cli/mcp-stdio.ts",
    "src/channel/index.ts",
    "src/monitor/index.ts",
    "src/shared/sse-consumer.ts",
  ];

  it("no define-less bundle reaches src/server/license by any import chain", () => {
    for (const root of DEFINE_LESS_ROOTS) {
      const reach = closure(join(ROOT, root));
      // Anti-vacuity: the walk really follows imports (each root pulls in more
      // than itself), so an empty result is evidence, not a broken walker.
      expect(reach.size, `${root} closure`).toBeGreaterThan(1);
      const hits = [...reach].filter((f) => f.startsWith(LICENSE_DIR + sep)).map(toRel);
      expect(hits, `${root} must not reach the licence modules`).toEqual([]);
    }
    // And the wire constant they DO use is reached — the positive twin.
    expect([...closure(join(ROOT, "src/shared/sse-consumer.ts"))].map(toRel)).toContain(
      "src/shared/license-copy.ts",
    );
  });

  it("no file imports a deleted license-gate / connection-gate module", () => {
    const hits = FILES.filter((f) =>
      specifiers(readFileSync(f, "utf-8")).some((s) =>
        /\/(license-gate|connection-gate)\.js$/.test(s),
      ),
    ).map(toRel);
    expect(hits).toEqual([]);
  });

  it("the gate flag is read in gate-flag.ts only", () => {
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const hits = FILES.filter((f) => !f.endsWith(join("license", "gate-flag.ts")))
      .filter((f) =>
        /TANDEM_LICENSE_GATE|__LICENSE_GATE_ENABLED__/.test(
          stripComments(readFileSync(f, "utf-8")),
        ),
      )
      .map(toRel);
    expect(hits).toEqual([]);
    // Positive twin: the one legitimate reader really does read it.
    expect(readFileSync(join(LICENSE_DIR, "gate-flag.ts"), "utf-8")).toMatch(/TANDEM_LICENSE_GATE/);
  });
});
