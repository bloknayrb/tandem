/**
 * Repo-wide guard for #1531 — no dangling `§N` citations in source.
 *
 * #1374 fixed `firewall.rs` and one function of `cowork_installer.rs` and left
 * a narrow test behind, whose own header said in as many words that a green run
 * was NOT a repo-wide guarantee and pointed at #1531 for the rest. This is that
 * rest: the same detector (`./dangling-citations`), run over the whole source
 * tree instead of two files.
 *
 * SCOPE, and why `docs/**` is not in it. A `§N` inside a document is usually a
 * pointer to a section of *that document*, which resolves fine — `decisions.md`
 * numbers its own ADR sections, and the licensing docs cross-reference their
 * own. The defect this pattern describes is a citation into a numbered list
 * that was never written down, and prose that carries its own numbered
 * headings does not have that problem. Including `docs/**` would therefore
 * produce a long list of false positives, and a guard whose failures are mostly
 * noise gets suppressed rather than fixed. The trade-off is stated rather than
 * left implicit: a genuinely dangling citation added to a doc will not be
 * caught here.
 *
 * `infra/**` and `scripts/**` are in scope — they are code, and the habit
 * travels with the author, not the directory.
 *
 * This file and `dangling-citations.ts` are excluded from their own scan,
 * because both quote the defect shape verbatim as fixtures and documentation.
 * That exclusion is the reason the positive control below is not optional: it
 * is the only thing standing between "no defects" and "the detector matches
 * nothing".
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { danglingCitations } from "./dangling-citations.js";

const repoRoot = path.resolve(__dirname, "../..");

/** Directories scanned. Tracked files only — `git ls-files` skips build output. */
const SCANNED_ROOTS = ["src", "src-tauri/src", "tests", "scripts", "infra"];

/**
 * The two files that quote the defect shape as fixtures. Excluding them by
 * exact path rather than by a `tests/build/` glob keeps every other guard in
 * this directory inside the scan.
 */
const SELF_EXCLUDED = new Set([
  "tests/build/dangling-citations.ts",
  "tests/build/invariant-citations.test.ts",
]);

function scannedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", ...SCANNED_ROOTS], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((f) => f.length > 0)
    .filter((f) => !SELF_EXCLUDED.has(f));
}

describe("#1531: dangling §N citations are gone from source", () => {
  it("scans a plausible number of files (guards against an empty sweep)", () => {
    // A `git ls-files` that returned nothing — wrong cwd, a renamed directory —
    // would make the next test pass while checking zero bytes.
    expect(scannedFiles().length).toBeGreaterThan(400);
  });

  it("no source file carries one", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      let text: string;
      try {
        text = readFileSync(path.join(repoRoot, file), "utf8");
      } catch {
        continue; // deleted between ls-files and read; nothing to judge
      }
      // Line-by-line so the failure message names the line, not just the file.
      text.split("\n").forEach((line, i) => {
        for (const hit of danglingCitations(line)) {
          offenders.push(`${file}:${i + 1}: ${hit}  ||  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "Dangling §N citation(s). These point at a numbered list that does not " +
        "exist in this repo — see tests/build/dangling-citations.ts. Replace " +
        "each with the rationale it was standing in for, or with a citation " +
        "that names a real document (ADR-0NN §N, RFC NNNN §N.N).",
    ).toEqual([]);
  });
});

describe("positive control: the detector catches every shape it claims to", () => {
  // Without this, the sweep above passes for free if the pattern ever stops
  // matching — the classic way a repo-wide guard rots into decoration.

  it("catches the labelled shapes, parens or not", () => {
    expect(danglingCitations("(security §4).")).toEqual(["security §4"]);
    expect(danglingCitations("(security invariant §13).")).toEqual(["security invariant §13"]);
    expect(danglingCitations("(invariant §5).")).toEqual(["invariant §5"]);
    expect(danglingCitations("per security invariant §5.")).toEqual(["security invariant §5"]);
    expect(danglingCitations("Security invariant §5: reject too-broad prefixes.")).toEqual([
      "Security invariant §5",
    ]);
  });

  it("catches the label-less shape, including a dotted numeral", () => {
    // Its match includes the parens, since they are the only thing separating
    // it from a subsection reference.
    expect(danglingCitations("Rule naming follows (§7).")).toEqual(["(§7)"]);
    expect(danglingCitations("matching ModelEditModal (§3.4): v1.0 ships local")).toEqual([
      "(§3.4)",
    ]);
  });

  it("catches the exact citations #1531 enumerated", () => {
    // One per site the issue listed, so a regression at any of them reddens
    // here even if the sweep's file list ever narrows.
    expect(danglingCitations("does NOT write plugin entries (invariant §4)")).toEqual([
      "invariant §4",
    ]);
    expect(danglingCitations("Stale-token reconciliation (invariant §12)")).toEqual([
      "invariant §12",
    ]);
    expect(danglingCitations("treats remove failures as non-fatal (§12).")).toEqual(["(§12)"]);
    expect(danglingCitations("against invariant §3 before any file I/O (§9).")).toEqual(["(§9)"]);
    expect(danglingCitations("use the new token (security invariant §6).")).toEqual([
      "security invariant §6",
    ]);
    expect(danglingCitations("**Ordering contract (§4):** on the enable path")).toEqual(["(§4)"]);
    expect(danglingCitations("tandem.exe (security invariant §10 — prevents")).toEqual([
      "security invariant §10",
    ]);
    expect(danglingCitations("one distinct hint per variant (security invariant §13)")).toEqual([
      "security invariant §13",
    ]);
    expect(danglingCitations("one authority — the server** (§2). This")).toEqual(["(§2)"]);
  });

  it("does not touch a citation that names its document", () => {
    expect(
      danglingCitations("ADR-040 §5, JSON-RPC 2.0 §5.1, OOXML §2.5.39, RFC 4632 §3.1, spec §6.4"),
    ).toEqual([]);
    // Same citations, parenthesised — the label-less branch must still miss
    // them, because the label sits between the `(` and the `§`.
    expect(
      danglingCitations("(ADR-040 §5), (JSON-RPC 2.0 §5.1), (OOXML §2.5.39), (RFC 4632 §3.1)"),
    ).toEqual([]);
  });

  it("carves out §3, and only the exact integer", () => {
    expect(danglingCitations("(invariant §3) — the path guard.")).toEqual([]);
    expect(danglingCitations("(§3) — the path guard.")).toEqual([]);
    // §3.1 is not §3: a dotted numeral is a different citation, and the one
    // real §3 is an integer.
    expect(danglingCitations("(§3.1)")).toEqual(["(§3.1)"]);
    expect(danglingCitations("(§30)")).toEqual(["(§30)"]);
  });
});
