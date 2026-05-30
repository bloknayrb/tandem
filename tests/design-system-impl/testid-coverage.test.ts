import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Test-selector snapshot gate for the design-system-impl umbrella branch.
 *
 * Walks src/client/ and extracts every `data-testid` declaration, normalises
 * interpolated values (Svelte `{expr}` and JS template `${expr}`) to the
 * literal `{*}` so the snapshot is stable across renames of bound variables.
 * The resulting sorted list is asserted against a committed snapshot file —
 * any removal or rename of a selector in the umbrella branch will fail this
 * test and force the diff into PR review.
 *
 * Sub-PRs that intentionally add or change a testid update the snapshot in
 * the same PR (`vitest -u`) so the change is reviewed alongside the code.
 * See docs/design-system-impl/testid-manifest.md for the human-readable
 * grouping and the rules governing testid changes.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT_ROOT = join(ROOT, "src", "client");
const EXT = new Set([".svelte", ".ts", ".tsx", ".css"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.has(full.slice(full.lastIndexOf("."))) && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Parse the value of a `data-testid=...` attribute starting at `idx`
 * (which points at the character immediately after the `=`).
 *
 * Handles three forms on a single line:
 *  - "literal"   → returns literal
 *  - 'literal'   → returns literal
 *  - {expr}      → returns expr with balanced braces; tracks back-quoted
 *                  template strings so internal `}` inside `${...}` don't
 *                  close the outer brace prematurely
 *
 * Returns null if the value spans multiple lines or fails to parse cleanly —
 * such cases should be rewritten on a single line so this gate stays sharp.
 */
function parseValue(src: string, idx: number): string | null {
  const open = src[idx];
  if (open === '"' || open === "'") {
    const end = src.indexOf(open, idx + 1);
    if (end === -1) return null;
    const v = src.slice(idx + 1, end);
    if (v.includes("\n")) return null;
    return v;
  }
  if (open !== "{") return null;
  let depth = 1;
  let inBacktick = false;
  let i = idx + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") return null;
    if (c === "`") inBacktick = !inBacktick;
    else if (!inBacktick && c === "{") depth++;
    else if (!inBacktick && c === "}") {
      depth--;
      if (depth === 0) return src.slice(idx + 1, i);
    } else if (inBacktick && c === "$" && src[i + 1] === "{") {
      // template-literal interpolation — eat the `${...}` inline
      let td = 1;
      let j = i + 2;
      while (j < src.length && td > 0) {
        if (src[j] === "{") td++;
        else if (src[j] === "}") td--;
        j++;
      }
      i = j - 1;
    }
    i++;
  }
  return null;
}

/** Reduce both `${expr}` and Svelte `{expr}` to literal `{*}` for stable diffs. */
function normalise(raw: string): string {
  let s = raw.trim();
  // Strip wrapping backticks/quotes (template literal or string passed as expr).
  if (
    (s.startsWith("`") && s.endsWith("`")) ||
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  // Reduce JS template interpolations.
  s = s.replace(/\$\{[^}]*\}/g, "{*}");
  // Reduce Svelte inline expressions (single-pair only — we don't expect
  // nested braces inside an attribute value after the template-literal pass).
  s = s.replace(/\{[^}]*\}/g, "{*}");
  return s.trim();
}

/**
 * Resolution table for testid constants imported from sibling modules.
 * Add an entry here whenever a new symbolic testid constant ships so the
 * snapshot stores the literal selector value, not the JS identifier.
 */
const CONSTANT_RESOLUTIONS: Record<string, string> = {
  ERROR_BOUNDARY_RECOVER_BTN_TESTID: "error-boundary-recover-btn",
  ERROR_BOUNDARY_RELOAD_BTN_TESTID: "error-boundary-reload-btn",
};

const BARE_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const ATTR = "data-testid=";
const declarations: { file: string; testid: string; raw: string }[] = [];
const skipped: { file: string; line: number; reason: string }[] = [];

for (const file of walk(CLIENT_ROOT)) {
  const src = readFileSync(file, "utf-8");
  let from = 0;
  while (true) {
    const at = src.indexOf(ATTR, from);
    if (at === -1) break;
    from = at + ATTR.length;
    const raw = parseValue(src, from);
    if (raw === null) {
      const line = src.slice(0, at).split("\n").length;
      skipped.push({
        file: relative(ROOT, file).replace(/\\/g, "/"),
        line,
        reason: "multi-line or unparseable value",
      });
      continue;
    }

    // Constant references resolve to their literal values from the lookup;
    // unknown constants fall through and surface as bare identifiers, which
    // are then filtered out below as wrapper passthroughs.
    const trimmed = raw.trim();
    const resolved = CONSTANT_RESOLUTIONS[trimmed];
    if (resolved !== undefined) {
      declarations.push({
        file: relative(ROOT, file).replace(/\\/g, "/"),
        testid: resolved,
        raw,
      });
      continue;
    }

    const normalised = normalise(raw);
    if (normalised.length === 0) continue;
    // Bare-identifier values (e.g. {testId}, {testid}) are wrapper passthroughs;
    // the real selectors live at the call sites and are captured there.
    if (BARE_IDENT.test(normalised)) continue;
    // A normalised value of just "{*}" is the same — interpolation with no
    // surrounding literal context.
    if (normalised === "{*}") continue;
    declarations.push({
      file: relative(ROOT, file).replace(/\\/g, "/"),
      testid: normalised,
      raw,
    });
  }
}

const sortedSet = [...new Set(declarations.map((d) => d.testid))].sort();

describe("test-selector coverage — src/client/", () => {
  it("matches the committed selector snapshot", async () => {
    const payload = `${sortedSet.join("\n")}\n`;
    await expect(payload).toMatchFileSnapshot("./__snapshots__/testid-set.snap.txt");
  });

  it("every declaration parses to a non-empty normalised selector", () => {
    const empty = declarations.filter((d) => d.testid.length === 0);
    expect(empty).toEqual([]);
  });

  it("no testid declarations were skipped due to multi-line values", () => {
    expect(skipped).toEqual([]);
  });
});
