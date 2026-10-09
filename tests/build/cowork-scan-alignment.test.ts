/**
 * Alignment pin for the two Cowork workspace scans (#2136).
 *
 * The desktop uninstaller's scrub walks Claude Desktop's sessions roots with
 * `roots_under` / `is_claude_package_name` in
 * `src-tauri/src/cowork_workspace_scan.rs`; `tandem --uninstall-scrub` walks
 * them with its own TS copy in `src/cli/uninstall-scrub.ts`. The two were kept
 * in step by hand, and #2136 is what that produced: ADR-044 added the
 * `%APPDATA%\Claude` root and the `AnthropicPBC.Claude` package prefix to the
 * Rust side only, and the CLI scrub silently left Tandem's entries (auth token
 * included) wherever Claude Desktop used that root.
 *
 * The relation for the removal prefixes is EQUALITY. A TS side narrower than
 * Rust leaves entries the installer wrote; a TS side wider than Rust would
 * scan packages the installer never writes into, which is how a foreign
 * package gets handed the scrub. The WRITE pattern (`MSIX_PACKAGE_PATTERN`) is
 * a subset of them (#2144: Bryan decided the wider set is removal-only).
 *
 * #2144 added the temp-file sweep both scrubs run: each language matches the
 * other's temp name, and both take the three registry locks in one order.
 *
 * Reads the Rust source rather than a generated list because nothing generates
 * one; the parse is anchored on function bodies so a match elsewhere in the
 * file cannot satisfy it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MSIX_PACKAGES_DIR,
  MSIX_SESSIONS_SEGMENTS,
  PLUGIN_FILES,
  ROAMING_SESSIONS_SEGMENTS,
  SCRUB_TEMP_PREFIX,
} from "../../src/cli/uninstall-scrub.js";
import {
  CLAUDE_PACKAGE_PREFIXES,
  MSIX_PACKAGE_PATTERN,
} from "../../src/server/integrations/apply.js";

const repoRoot = path.resolve(__dirname, "../..");
const readRust = (file: string) =>
  readFileSync(path.join(repoRoot, "src-tauri/src", file), "utf-8");
const rustScan = readRust("cowork_workspace_scan.rs");
const rustAtomic = readRust("cowork_atomic_json.rs");

/** The body of a top-level `[pub[(…)]] fn name(...)`, up to its closing column-0 brace. */
function rustFnBody(name: string, source = rustScan): string {
  const start = source.search(new RegExp(`^(?:pub(?:\\([^)]*\\))? )?fn ${name}\\b`, "m"));
  expect(start, `fn ${name} not found`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** A top-level `[pub(crate) ]const NAME…;` item's text, to the `;` ending its
 *  line (a type like `[&str; 3]` carries one of its own). */
function rustConst(name: string, source: string): string {
  const start = source.search(new RegExp(`^(?:pub(?:\\([^)]*\\))? )?const ${name}\\b`, "m"));
  expect(start, `const ${name} not found`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(";\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const stringLiterals = (text: string) => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]);

function stringArgs(body: string, method: string): string[] {
  return [...body.matchAll(new RegExp(`\\.?${method}\\("([^"]*)"\\)`, "g"))].map((m) => m[1]);
}

describe("CLI and desktop Cowork scans agree (#2136)", () => {
  it("accept the same MSIX package-name prefixes", () => {
    const body = rustFnBody("is_claude_package_name");
    const rust = stringArgs(body, "starts_with");
    // Positive control: an empty parse would make the equality vacuous.
    expect(rust.length).toBeGreaterThan(0);
    // Every `starts_with(` must be a literal the parse can see. A prefix added
    // through a const would leave this equality green while the TS side drifts.
    expect(body.split("starts_with(").length - 1).toBe(rust.length);
    expect([...CLAUDE_PACKAGE_PREFIXES].sort()).toEqual([...rust].sort());
  });

  it("walk the same two sessions-root layouts, in the same order", () => {
    const body = rustFnBody("roots_under");
    // The MSIX branch filters on the predicate pinned above; if it stopped,
    // that pin would be checking a function the scan no longer calls.
    expect(body).toContain("is_claude_package_name(");
    // Exactly the two pushes the literal parse below accounts for. A third
    // root added through a helper or `extend` is the #2136 shape: Rust gains a
    // root and the join literals still match.
    expect(body.split("roots.push(").length - 1).toBe(2);
    expect(body).not.toContain(".extend(");
    expect(stringArgs(body, "join")).toEqual([
      ...MSIX_SESSIONS_SEGMENTS,
      ...ROAMING_SESSIONS_SEGMENTS,
    ]);
  });

  it("join the MSIX root under the same Packages folder", () => {
    // `Packages` is joined in the caller, outside `roots_under`.
    expect(rustFnBody("cowork_roots")).toContain(`.join("${MSIX_PACKAGES_DIR}")`);
  });

  it("keep every WRITE target inside the removal prefixes (#2144)", () => {
    // On the pattern itself, not a sample table: anchored, one of the removal
    // prefixes first, and no alternation that could add a second shape.
    const source = MSIX_PACKAGE_PATTERN.source;
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(source.startsWith("^")).toBe(true);
    expect(source.endsWith("$")).toBe(true);
    expect(source).not.toContain("|");
    expect(CLAUDE_PACKAGE_PREFIXES.some((p) => source.startsWith(`^${escape(p)}`))).toBe(true);
  });
});

describe("the two scrubs sweep each other's temp files (#2144)", () => {
  it("the CLI matcher assumes the shape the desktop writer generates", () => {
    // `isOrphanedTempName`'s desktop regex is `.tandem-tmp-` plus three hex
    // groups; these are the two literals that produce that name.
    expect(rustFnBody("temp_name", rustAtomic)).toContain(
      'format!(".tandem-tmp-{}", unique_suffix())',
    );
    expect(rustFnBody("unique_suffix", rustAtomic)).toContain('format!("{:x}-{:x}-{:x}"');
  });

  it("the desktop matcher knows the CLI's temp prefix", () => {
    expect(stringLiterals(rustConst("CLI_SCRUB_TEMP_PREFIX", rustAtomic))).toEqual([
      SCRUB_TEMP_PREFIX,
    ]);
  });

  it("both sweeps take the three registry locks in one order", () => {
    // Opposite orders would let two concurrent sweeps each hold one lock and
    // time out on the other.
    expect(stringLiterals(rustConst("PLUGIN_FILES", rustAtomic))).toEqual([...PLUGIN_FILES]);
  });
});
