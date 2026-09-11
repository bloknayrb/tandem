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
  // Backtick joins the quote family here (not the Svelte-attribute `{expr}`
  // branch below): a template literal opened directly as a JS value — e.g.
  // the RHS of `el.dataset.testid = ...` — has no wrapping `{}` of its own.
  // Interpolations inside it are reduced to `{*}` by `normalise()`, same as
  // everywhere else; this only has to find the matching close-backtick.
  if (open === '"' || open === "'" || open === "`") {
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

// Second scan pass: `el.dataset.testid = "..."` assignments (imperative DOM
// sites) are invisible to the attribute-literal scan above — they never
// write the `data-testid=` string, so a testid assigned this way is
// unfixably invisible to the snapshot gate. The lookahead `(?!=)` excludes
// `===`/`!==` comparisons, which are reads, not declarations.
const DATASET_ASSIGN = /\.dataset\.testid\s*=(?!=)/g;
const LEADING_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/**
 * Scan one source string for `.dataset.testid = ...` assignments (the
 * right-hand side is raw JS/TS here, never a Svelte template attribute, so
 * `parseValue`'s quote/backtick/`{expr}` handling only covers the literal
 * case — a bare identifier needs its own check before falling through to
 * "unparseable").
 *
 * Two forms beyond a single quoted literal are handled explicitly rather
 * than falling through to "unparseable" or, worse, silently truncating:
 *
 *  - A backtick-opened template literal (`` `row-${i}` ``) — the natural
 *    form for a per-item imperative testid, and the likelier shape than a
 *    bare identifier for a dynamic one. `parseValue` now treats backtick as
 *    quote-like, so this reuses the same literal branch.
 *  - String concatenation (`"row-" + id`) — `parseValue` on its own would
 *    return only the leading quoted segment ("row-"), which would then get
 *    committed to the snapshot as a standalone Critical-Rule-7 selector that
 *    no element actually carries. Detecting a `+` immediately after the
 *    closing quote folds the whole expression into the same `{*}`
 *    convention `normalise()` already uses for interpolation, rather than
 *    trusting a truncated prefix.
 */
function scanDatasetAssignments(src: string): {
  declarations: { testid: string; raw: string }[];
  skipped: { line: number }[];
} {
  const found: { testid: string; raw: string }[] = [];
  const skippedHere: { line: number }[] = [];
  for (const m of src.matchAll(DATASET_ASSIGN)) {
    let idx = m.index + m[0].length;
    // Skip newlines here too, not just spaces/tabs: biome wraps a long
    // `el.dataset.testid =` assignment onto its own line once the
    // identifier is long enough, leaving the value on the next line while
    // the value itself stays single-line. `parseValue`'s own multi-line
    // rule (its docblock: "Returns null if the value spans multiple
    // lines") still rejects a value that itself spans lines — this only
    // widens what counts as "between `=` and the value", matching the
    // attribute pass's tolerance for that gap.
    while (
      idx < src.length &&
      (src[idx] === " " || src[idx] === "\t" || src[idx] === "\n" || src[idx] === "\r")
    )
      idx++;
    const open = src[idx];
    if (open === '"' || open === "'" || open === "`") {
      const raw = parseValue(src, idx);
      if (raw === null) {
        skippedHere.push({ line: src.slice(0, m.index).split("\n").length });
        continue;
      }
      let normalised = normalise(raw);
      // Find the literal's own closing delimiter (same char `parseValue`
      // matched) to see whether it's concatenated with something else.
      const closeIdx = src.indexOf(open, idx + 1);
      let after = closeIdx + 1;
      while (after < src.length && (src[after] === " " || src[after] === "\t")) after++;
      if (src[after] === "+") {
        normalised = `${normalised}{*}`;
      }
      if (normalised.length === 0) continue;
      if (normalised === "{*}") continue;
      found.push({ testid: normalised, raw });
      continue;
    }
    const identMatch = LEADING_IDENT.exec(src.slice(idx));
    if (identMatch) {
      // Mirrors the attribute pass: a known testid constant resolves to its
      // literal value instead of being treated as an opaque passthrough.
      const resolved = CONSTANT_RESOLUTIONS[identMatch[0]];
      if (resolved !== undefined) {
        found.push({ testid: resolved, raw: identMatch[0] });
        continue;
      }
      // An unresolved bare identifier (`el.dataset.testid = someVar`) is a
      // wrapper passthrough — routing it to `skipped` instead would make a
      // future legitimate one permanently, unfixably red.
      continue;
    }
    skippedHere.push({ line: src.slice(0, m.index).split("\n").length });
  }
  return { declarations: found, skipped: skippedHere };
}

for (const file of walk(CLIENT_ROOT)) {
  const src = readFileSync(file, "utf-8");
  const { declarations: found, skipped: skippedHere } = scanDatasetAssignments(src);
  for (const d of found) {
    declarations.push({
      file: relative(ROOT, file).replace(/\\/g, "/"),
      testid: d.testid,
      raw: d.raw,
    });
  }
  for (const s of skippedHere) {
    skipped.push({
      file: relative(ROOT, file).replace(/\\/g, "/"),
      line: s.line,
      reason: "multi-line or unparseable value",
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

  it("scans dataset.testid assignments but not comparisons, and skips bare identifiers (#1709)", () => {
    const src = 'x.dataset.testid = someVar; y.dataset.testid === "not-an-assignment";';
    const { declarations: found, skipped: skippedHere } = scanDatasetAssignments(src);
    // Neither line produces a declaration or a skip: the `===` comparison is
    // excluded by the lookahead (not a match at all, so not even attempted),
    // and the bare-identifier assignment is a wrapper passthrough.
    expect(found).toEqual([]);
    expect(skippedHere).toEqual([]);
  });

  it("scans a quoted dataset.testid literal into a declaration (#1709)", () => {
    const { declarations: found, skipped: skippedHere } = scanDatasetAssignments(
      'el.dataset.testid = "synthetic-example";',
    );
    expect(found).toEqual([{ testid: "synthetic-example", raw: "synthetic-example" }]);
    expect(skippedHere).toEqual([]);
  });

  it("finds the two live dataset.testid selectors (#1709)", () => {
    expect(sortedSet).toContain("slash-command-menu");
    expect(sortedSet).toContain("heading-chevron");
  });

  it("scans a backtick-opened dataset.testid template literal, folding interpolation to {*} (review round 1)", () => {
    const { declarations: found, skipped: skippedHere } = scanDatasetAssignments(
      "el.dataset.testid = `row-${i}`;",
    );
    // Before the fix, backtick was neither a recognised quote nor an
    // identifier start, so this fell to `skipped` — permanently and
    // unfixably red for the natural per-item imperative-testid form.
    expect(found).toEqual([{ testid: "row-{*}", raw: "row-${i}" }]);
    expect(skippedHere).toEqual([]);
  });

  it("skips a backtick template with no literal context, mirroring the {expr}-only rule (review round 1)", () => {
    const { declarations: found, skipped: skippedHere } = scanDatasetAssignments(
      "el.dataset.testid = `${id}`;",
    );
    expect(found).toEqual([]);
    expect(skippedHere).toEqual([]);
  });

  it("folds a string-concatenated dataset.testid literal into a {*}-suffixed selector, not a truncated prefix (review round 1)", () => {
    const { declarations: found, skipped: skippedHere } = scanDatasetAssignments(
      'el.dataset.testid = "row-" + id;',
    );
    // Before the fix this silently committed "row-" — the leading quoted
    // segment only — as a standalone Critical-Rule-7 contract selector that
    // no element actually carries.
    expect(found).toEqual([{ testid: "row-{*}", raw: "row-" }]);
    expect(skippedHere).toEqual([]);
  });

  it("resolves a known testid constant assigned via dataset.testid (review round 1)", () => {
    const { declarations: found, skipped: skippedHere } = scanDatasetAssignments(
      "el.dataset.testid = ERROR_BOUNDARY_RELOAD_BTN_TESTID;",
    );
    // Before the fix, CONSTANT_RESOLUTIONS was applied only on the
    // attribute-literal pass — this bare identifier fell through as an
    // unresolved wrapper passthrough instead of resolving to its literal.
    expect(found).toEqual([
      { testid: "error-boundary-reload-btn", raw: "ERROR_BOUNDARY_RELOAD_BTN_TESTID" },
    ]);
    expect(skippedHere).toEqual([]);
  });

  it("scans a dataset.testid assignment biome wrapped onto the next line (review round 2, cr-5)", () => {
    // Before the fix, only spaces/tabs were skipped between `=` and the
    // value, so this shape — which biome produces on its own once the
    // identifier is long enough to force a wrap — landed on the newline as
    // `open`, matched neither a quote nor an identifier start, and fell to
    // `skipped` with a "multi-line or unparseable value" message that
    // points at the wrong fix (the value itself is single-line).
    const { declarations: found, skipped: skippedHere } = scanDatasetAssignments(
      'el.dataset.testid =\n  "synthetic-wrapped";',
    );
    expect(found).toEqual([{ testid: "synthetic-wrapped", raw: "synthetic-wrapped" }]);
    expect(skippedHere).toEqual([]);
  });
});
