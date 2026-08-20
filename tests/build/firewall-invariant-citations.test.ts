/**
 * Regression pin for #1374 — dangling `(security invariant §N)` /
 * `(invariant §N)` / `(security §N)` / bare `(§N)` citations in
 * `src-tauri/src/firewall.rs`.
 *
 * `firewall.rs` is `#![cfg(target_os = "windows")]`. A cfg-stripped external
 * `mod` is never read from disk by rustc on a non-matching target, so on this
 * repo's Linux CI/dev boxes `cargo check`/`cargo test` do not even LEX this
 * file — a dangling citation, or any other silent drift in it, produces zero
 * diagnostic from the Rust toolchain here. That is exactly the failure mode
 * #1374 describes ("a criterion whose evidence lives where the judge cannot
 * look fails silently") applied to the file's own doc comments, so the guard
 * has to live in a platform-independent text check, not a Rust one.
 *
 * The citation-defect pattern is deliberately narrow and excludes `§3`:
 * `CLAUDE.md` and this repo use `§` legitimately and often (`ADR-040 §5`,
 * `JSON-RPC 2.0 §5.1`, `OOXML §2.5.39`, `RFC 4632 §3.1`, `spec §6.4`) — those
 * resolve to a real, findable document, and `invariant §3` specifically
 * resolves too: it's the defense-in-depth path guard defined inline at
 * `cowork_workspace_scan.rs:7`/`:605` and cited (accurately) from
 * `cowork_atomic_json.rs:128`, `src/cli/win-path-guard.ts`, and
 * `tests/shared/unc-check-duplication.test.ts:114`. Excluding it here isn't
 * just convenience — it keeps this test's own defect pattern consistent with
 * the reasoning in this comment, instead of contradicting it if this pattern
 * is ever reused against a wider file set.
 *
 * SCOPE. #1374 fixed all six dangling citations in `firewall.rs`, plus two in
 * `cowork_installer.rs::reconcile_orphan_firewall_rules` — the one function
 * `firewall.rs`'s own fix now points a reader at by name (see `firewall.rs`'s
 * `scan_orphan_rules` doc comment), so that pointer can't lead into a
 * still-dirty comment. The SAME bare-citation pattern remains elsewhere,
 * confirmed still present at the time of this fix in `src-tauri/src/lib.rs`,
 * two more sites in `cowork_installer.rs` itself (`apply_token_to_all_workspaces`
 * and `reconcile_stale_workspace_tokens` — neither reachable from `firewall.rs`'s
 * own citations, the latter only one hop further out via
 * `reconcile_orphan_firewall_rules`'s intra-doc link), three `src/cli/*.ts`
 * files, and `tests/client/cowork-settings.test.ts:126` (the TS-side twin of
 * the exact `(security invariant §13)` citation removed from `firewall.rs:22`
 * in this change). None of that is covered here — full inventory tracked in
 * issue #1531.
 *
 * A green run of this test is NOT a repo-wide guarantee — only a guarantee
 * about `firewall.rs` and the one `cowork_installer.rs` function it reads.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

function readFirewallRs(): string {
  return readFileSync(path.join(repoRoot, "src-tauri/src/firewall.rs"), "utf8");
}

function readCoworkInstallerRs(): string {
  return readFileSync(path.join(repoRoot, "src-tauri/src/cowork_installer.rs"), "utf8");
}

// ---------------------------------------------------------------------------
// Dangling-citation detector
// ---------------------------------------------------------------------------

/**
 * Matches the bare `invariant §N` / `security §N` defect shape, with or
 * without surrounding parens (two of the six original citations in
 * `firewall.rs` — `:323` and `:328` — carried no parens at all, so requiring
 * them would have missed exactly those two), plus the label-less `(§N)` form.
 * `§3` is excluded — see the file header.
 *
 * The third branch is not hypothetical: `(§N)` with no `invariant`/`security`
 * label in front of it is already live one `mod` away, same author and same
 * subsystem, at `src-tauri/src/lib.rs:4169` (`(§12)`) and `:4882` (`(§9)`) —
 * see issue #1531, which records it as a third citation shape. Those sites
 * are out of this test's scope (file header, SCOPE), but the shape has to be
 * in the detector or the same defect could land inside `firewall.rs` unseen.
 *
 * It cannot swallow the legitimate `§` uses this repo makes, because it
 * requires the `(` to be followed by the `§` itself and the `)` to follow the
 * digits directly: `(ADR-040 §5)` has a label between `(` and `§`, and
 * `(RFC 4632 §3.1)` has both that and a subsection number where the closing
 * paren must be. Both are covered in the positive-control test below.
 */
const DANGLING_CITATION_RE =
  /(?<![\w-])(?:security\s+)?invariant\s*§\s*(\d+)|(?<![\w-])security\s*§\s*(\d+)(?!\w)|\(\s*§\s*(\d+)\s*\)/gi;

function danglingCitations(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(DANGLING_CITATION_RE)) {
    const num = m[1] ?? m[2] ?? m[3];
    if (num === "3") continue; // the one legitimate, resolvable numeral
    found.push(m[0]);
  }
  return found;
}

/**
 * The doc comment directly attached to `reconcile_orphan_firewall_rules` —
 * the one function `firewall.rs`'s rewritten `scan_orphan_rules` doc now
 * names. Extracted narrowly (consecutive `///` lines immediately above the
 * `pub fn` line) so this test says nothing about the rest of the file, which
 * still has other, intentionally untouched dangling citations one hop
 * further out (see the file header).
 */
function reconcileOrphanFirewallRulesDoc(): string {
  const src = readCoworkInstallerRs();
  const match = /((?:\/\/\/[^\n]*\n)+)pub fn reconcile_orphan_firewall_rules\(/.exec(src);
  expect(
    match,
    "reconcile_orphan_firewall_rules's doc comment not found — function signature or doc-comment shape changed",
  ).not.toBeNull();
  const doc = match?.[1] ?? "";
  expect(doc.length, "matched an empty doc comment").toBeGreaterThan(0);
  return doc;
}

/**
 * The `FirewallError` variant names as the wire sees them (camelCase, per
 * `#[serde(rename_all = "camelCase")]`). Shared by both alignment guards
 * below so they can never disagree about what the Rust list is.
 */
function rustFirewallVariants(): string[] {
  const rustSrc = readFirewallRs();
  const enumMatch = /pub enum FirewallError \{([\s\S]*?)\n\}/.exec(rustSrc);
  expect(enumMatch, "FirewallError enum not found in firewall.rs").not.toBeNull();
  const variants = [...(enumMatch?.[1] ?? "").matchAll(/^ {4}([A-Z]\w*)\s*(?:,|\{)/gm)].map(
    (m) => m[1].slice(0, 1).toLowerCase() + m[1].slice(1),
  );
  expect(variants.length, "parsed no variants — the enum's shape changed").toBeGreaterThan(0);
  return variants;
}

/**
 * The `case "…":` labels inside `firewallErrorHint`'s switch — the arms the
 * `FirewallError` doc comment says are pinned. Extracted from that function's
 * body only (`export function firewallErrorHint(` to the next column-0 `}`),
 * because `cowork-helpers.ts` holds three other unrelated switches whose case
 * labels would otherwise be scooped up.
 */
function firewallErrorHintArms(): string[] {
  const helpersSrc = readFileSync(
    path.join(repoRoot, "src/client/cowork/cowork-helpers.ts"),
    "utf8",
  );
  const fnMatch = /export function firewallErrorHint\([\s\S]*?\n\}/.exec(helpersSrc);
  expect(
    fnMatch,
    "firewallErrorHint's body not found in cowork-helpers.ts — signature or formatting changed",
  ).not.toBeNull();
  const body = fnMatch?.[0] ?? "";
  const arms = [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
  expect(arms.length, "parsed no case arms — the switch's shape changed").toBeGreaterThan(0);
  return arms;
}

describe("regression pin (#1374): dangling citations are gone", () => {
  // Both of these fail on the pre-fix source (six live citations in
  // firewall.rs, two more in cowork_installer.rs) and pass after — verified
  // by stashing the fix and re-running before writing this test up.

  it("firewall.rs has no dangling invariant citation left", () => {
    expect(danglingCitations(readFirewallRs())).toEqual([]);
  });

  it("reconcile_orphan_firewall_rules's doc (what firewall.rs now points readers at) is clean too", () => {
    expect(danglingCitations(reconcileOrphanFirewallRulesDoc())).toEqual([]);
  });

  it("positive control: the detector actually catches the defect shape, parens or not, and carves out §3", () => {
    // Guards the detector itself from the bug it's meant to guard against:
    // a pattern that matches nothing would make the two tests above pass for
    // the wrong reason. Covers all six original shapes plus the §3 carve-out.
    expect(danglingCitations("(security §4).")).toEqual(["security §4"]);
    expect(danglingCitations("(security invariant §13).")).toEqual(["security invariant §13"]);
    expect(danglingCitations("(invariant §5).")).toEqual(["invariant §5"]);
    expect(danglingCitations("per security invariant §5.")).toEqual(["security invariant §5"]);
    expect(danglingCitations("Security invariant §5: reject too-broad prefixes.")).toEqual([
      "Security invariant §5",
    ]);
    expect(danglingCitations("(security invariant §12)")).toEqual(["security invariant §12"]);
    // The label-less shape (#1531). Its match includes the parens, since they
    // are the only thing that distinguishes it from a subsection reference.
    expect(danglingCitations("Rule naming follows (§7).")).toEqual(["(§7)"]);
    expect(danglingCitations("(invariant §3) — the path guard.")).toEqual([]);
    expect(danglingCitations("(§3) — the path guard.")).toEqual([]);
    expect(
      danglingCitations("ADR-040 §5, JSON-RPC 2.0 §5.1, OOXML §2.5.39, RFC 4632 §3.1, spec §6.4"),
    ).toEqual([]);
    // Same real citations, parenthesised — the widened branch must still not
    // match them.
    expect(
      danglingCitations("(ADR-040 §5), (JSON-RPC 2.0 §5.1), (OOXML §2.5.39), (RFC 4632 §3.1)"),
    ).toEqual([]);
  });
});

describe("forward guards: protect against future drift, not part of #1374's original defect", () => {
  // None of these can fail on this specific change — the enum, the union and
  // the switch arms were already in agreement, and the argv-safety phrase was
  // already present. They exist to catch what happens NEXT: a new Rust variant
  // with no TS union member, the same variant with no switch arm (a separate
  // hole — the switch's `default:` arm means the compiler stays quiet), or a
  // "cleanup" of the module doc that quietly drops a "never".

  it("FirewallError's variants stay aligned with FirewallErrorVariant (TS)", () => {
    // Makes the doc comment at firewall.rs:22-31 literally true: it now
    // claims a variant added with no TS arm is "the failure this test pins
    // against" — reusing the extraction shape from
    // `subnet-reason-alignment.test.ts`, which pins the sibling
    // `SubnetDetectionReason` list the same way for the same reason.
    const rustVariants = rustFirewallVariants();

    const tsSrc = readFileSync(path.join(repoRoot, "src/client/types.ts"), "utf8");
    // Non-greedy to the next BLANK line, not the next `;` — `netshFailure`'s
    // member has field separators (`exitCode: number; stderrTail: string`)
    // that are themselves semicolons, so stopping at the first `;` truncates
    // the union after the second variant. Verified this fails loudly (wrong
    // list, not a false pass) before switching to the blank-line boundary.
    const unionMatch = /export type FirewallErrorVariant =([\s\S]*?)\n\s*\n/.exec(tsSrc);
    expect(unionMatch, "FirewallErrorVariant union not found in types.ts").not.toBeNull();
    const tsVariants = [...(unionMatch?.[1] ?? "").matchAll(/kind:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(
      tsVariants.length,
      "parsed no union members — the declaration's shape changed",
    ).toBeGreaterThan(0);

    expect(
      tsVariants.slice().sort(),
      `Rust has ${rustVariants.join(", ")}; TypeScript has ${tsVariants.join(", ")}`,
    ).toEqual(rustVariants.slice().sort());
  });

  it("every FirewallError variant has its own arm in firewallErrorHint", () => {
    // The union in `types.ts` is only half of what firewall.rs's doc comment
    // claims is pinned: it names the `firewallErrorHint` switch as the place
    // the per-variant hint actually lives, and that switch ends in a runtime
    // `default:` arm. That arm defeats TypeScript's exhaustiveness check, so
    // a variant added to the Rust enum AND to the TS union but not to the
    // switch typechecks clean and silently renders the generic "Unexpected
    // firewall error (…). Please restart Tandem." fallback — the exact
    // degradation the doc comment says is pinned. Nothing else catches it:
    // `tests/client/cowork-settings.test.ts`'s variant list is hand-written,
    // so it grows only when someone remembers to grow it.
    const rustVariants = rustFirewallVariants();
    const arms = firewallErrorHintArms();
    expect(
      arms.slice().sort(),
      `Rust has ${rustVariants.join(", ")}; firewallErrorHint handles ${arms.join(", ")}`,
    ).toEqual(rustVariants.slice().sort());
  });

  it("the /20 floor in prose still matches the /20 floor in code", () => {
    // NOT a pin on this fix's specific rewording — a forward guard against
    // code/prose drift (e.g. someone changes `< 20` to `< 19` without
    // updating the rewritten comments that now say "wider than /20" instead
    // of citing "§5"). Restricted to comment lines only, with continuation
    // lines joined within a comment block (never across two different
    // blocks, so unrelated comments can't accidentally form the phrase at
    // their boundary) — a naive whole-file, non-global scan would have
    // matched the untouched `Display` string at line ~118
    // ("...is wider than /20 — refused") before ever reaching a rewritten
    // comment, which is exactly the bug this version fixes.
    const src = readFirewallRs();

    const codeMatch = /if prefix < (\d+)/.exec(src);
    expect(
      codeMatch,
      "couldn't find the prefix-floor check in code — did it move or get refactored?",
    ).not.toBeNull();

    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of src.split("\n")) {
      const m = /^\s*(?:\/\/\/|\/\/!|\/\/)\s?(.*)$/.exec(line);
      if (m) {
        current.push(m[1]);
      } else if (current.length > 0) {
        blocks.push(current.join(" "));
        current = [];
      }
    }
    if (current.length > 0) blocks.push(current.join(" "));
    const commentText = blocks.join("\n"); // "\n" between blocks: two different
    // comments can never accidentally join into one phrase at their seam.

    const proseMatches = [...commentText.matchAll(/wider than \/(\d+)/g)].map((m) => m[1]);
    expect(
      proseMatches.length,
      "expected at least two rewritten comments (sites 3 and 5) to use the 'wider than /N' phrasing",
    ).toBeGreaterThanOrEqual(2);

    for (const prose of proseMatches) {
      expect(prose).toBe(codeMatch?.[1]);
    }
  });

  it("the netsh argv-safety rule's 'never concatenation' half survives in the module doc", () => {
    // Pins the phrase MAJOR 3 (round 1) required kept verbatim. Already true
    // before this change too (it was never broken) — this is pure insurance
    // against a future "cleanup" of the module doc dropping it.
    expect(readFirewallRs()).toContain("never string concatenation");
  });
});
