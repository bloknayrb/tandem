import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The E2E specs gated on `BYO_MODELS_ENABLED` (#1123 PR 8a; ADR-039's
 * amendment on E2E for the Models specs).
 *
 * Local models ship dark, and `check` runs E2E dark, so every spec that needs
 * them is skipped there, and a skip reads exactly like a pass in a green run.
 * The set is pinned here, so adding a skip is a visible edit to
 * `tests/e2e/local-model-gated-specs.json` (also read by the `byo-flag-on`
 * job's anchor, `scripts/ci/byo-flag-on-anchor.mjs`) rather than a quiet way to
 * make a failing spec go away. Each gated spec skips at FILE level, by one
 * column-0 `test.skip(!BYO_MODELS_ENABLED, ...)` after its imports; a skip
 * indented into a hook or a test would skip less than the anchor assumes.
 *
 * Flag-neutral on purpose: nothing here reads the flag's value. Lit, the
 * skips are inert (`test.skip(false, ...)`) and this stays green, so it cannot
 * force their removal; the flip's list in ADR-039 names them for deletion,
 * with this file and the JSON list. The skip must sit on ONE line (keep its
 * message short enough that the formatter never wraps it); a wrapped one fails
 * here, closed. It cannot see an aliased import of the
 * flag (`import { BYO_MODELS_ENABLED as on }`): a spec doing that escapes the
 * scan, so review is the guard for that spelling.
 */

const E2E_DIR = join(import.meta.dirname, "..", "e2e");
const BACKSLASH = String.fromCharCode(92);
const FLAG = "BYO_MODELS_ENABLED";
const GATED: string[] = JSON.parse(
  readFileSync(join(E2E_DIR, "local-model-gated-specs.json"), "utf-8"),
);

// Any spelling of a skip, fixme or configure keyed on the flag.
const SKIP =
  /^([ \t]*)test\.(?:skip|fixme|describe\.skip|describe\.fixme|describe\.configure)\([^\n]*\bBYO_MODELS_ENABLED\b/gm;
const IMPORT_LINE =
  /^import \{[^}]*\bBYO_MODELS_ENABLED\b[^}]*\} from "\.\.\/\.\.\/src\/shared\/constants";$/;
const SKIP_LINE = /^test\.skip\(!BYO_MODELS_ENABLED, "[^"\n]+"\);$/;
const GUARD_LINE = "  if (!BYO_MODELS_ENABLED) return;";

function specs(): Array<{ name: string; text: string }> {
  return readdirSync(E2E_DIR, { recursive: true, encoding: "utf-8" })
    .filter((entry) => entry.endsWith(".spec.ts"))
    .map((entry) => ({
      name: entry.replaceAll(BACKSLASH, "/"),
      text: readFileSync(join(E2E_DIR, entry), "utf-8"),
    }));
}

/** The lines that are code, not comment: a line comment or a JSDoc/block line is dropped. */
function codeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));
}

describe("E2E local-model skips while local models ship dark (ADR-039)", () => {
  it("the gated list is a non-empty, sorted list of spec files", () => {
    expect(GATED.length).toBeGreaterThan(0);
    expect([...GATED].sort()).toEqual(GATED);
    for (const name of GATED) expect(name).toMatch(/\.spec\.ts$/);
  });

  it("every skip keyed on the flag is file-level, one per gated spec, and nowhere else", () => {
    const found: Record<string, string[]> = {};
    for (const { name, text } of specs()) {
      const scopes = [...text.matchAll(SKIP)].map((m) => (m[1] === "" ? "file" : "test"));
      if (scopes.length > 0) found[name] = scopes;
    }
    // Positive anchor: the scan read the directory and found skips, so an
    // empty result can't satisfy the equality below by accident.
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found).toEqual(Object.fromEntries(GATED.map((name) => [name, ["file"]])));
  });

  it("the specs naming the flag are exactly the gated list", () => {
    const naming = specs()
      .filter(({ text }) => codeLines(text).some((line) => line.includes(FLAG)))
      .map(({ name }) => name)
      .sort();
    expect(naming).toEqual(GATED);
  });

  it.each(GATED)(
    "%s names the flag only in its import, its skip and one guard per afterEach",
    (name) => {
      const text = readFileSync(join(E2E_DIR, name), "utf-8");
      const lines = codeLines(text).filter((line) => line.includes(FLAG));
      const imports = lines.filter((l) => IMPORT_LINE.test(l));
      const skips = lines.filter((l) => SKIP_LINE.test(l));
      const guards = lines.filter((l) => l === GUARD_LINE);
      expect(imports, "one import of the flag").toHaveLength(1);
      expect(skips, "one column-0 file-level skip").toHaveLength(1);
      expect(
        imports.length + skips.length + guards.length,
        `other uses: ${lines.join(" | ")}`,
      ).toBe(lines.length);
      const afterEachHooks = text.match(/^test\.afterEach\(/gm) ?? [];
      expect(guards).toHaveLength(afterEachHooks.length);
      // Each hook's first statement is the guard.
      for (const hook of text.split(/^test\.afterEach\(/m).slice(1)) {
        expect(hook.split("\n")[1]).toBe(GUARD_LINE);
      }
    },
  );
});
