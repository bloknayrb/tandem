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
 * The relation is EQUALITY. A TS side narrower than Rust leaves entries the
 * installer wrote; a TS side wider than Rust would scan packages the installer
 * never writes into, which is how a foreign package gets handed the scrub.
 *
 * Reads the Rust source rather than a generated list because nothing generates
 * one; the parse is anchored on the two function bodies so a match elsewhere in
 * the file cannot satisfy it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_PACKAGE_PREFIXES,
  MSIX_PACKAGES_DIR,
  MSIX_SESSIONS_SEGMENTS,
  ROAMING_SESSIONS_SEGMENTS,
} from "../../src/cli/uninstall-scrub.js";

const repoRoot = path.resolve(__dirname, "../..");
const rustScan = readFileSync(
  path.join(repoRoot, "src-tauri/src/cowork_workspace_scan.rs"),
  "utf-8",
);

/** The body of a top-level `[pub[(…)]] fn name(...)`, up to its closing column-0 brace. */
function rustFnBody(name: string): string {
  const start = rustScan.search(new RegExp(`^(?:pub(?:\\([^)]*\\))? )?fn ${name}\\b`, "m"));
  expect(start, `fn ${name} not found in cowork_workspace_scan.rs`).toBeGreaterThanOrEqual(0);
  const end = rustScan.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return rustScan.slice(start, end);
}

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
});
