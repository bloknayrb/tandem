/**
 * Alignment guards for `firewall.rs`'s `FirewallError` and its two TypeScript
 * mirrors, plus two prose-vs-code pins in the same file.
 *
 * WHY A TEXT TEST. `firewall.rs` is `#![cfg(target_os = "windows")]` and is
 * reached only through a `#[cfg(target_os = "windows")] mod`. A cfg-stripped
 * external `mod` is never read from disk by rustc on a non-matching target, so
 * on this repo's Linux CI and dev boxes `cargo check`/`cargo test` do not even
 * LEX this file — drift in it produces zero diagnostic here. That is why these
 * guards are platform-independent text checks rather than Rust ones.
 *
 * HISTORY. This file began life as `firewall-invariant-citations.test.ts`, the
 * regression pin for #1374's dangling-`§N`-citation fix. #1531 widened that
 * job to a repo-wide sweep of the label-less shapes, so the citation half
 * moved to
 * `invariant-citations.test.ts` (detector in `dangling-citations.ts`), whose
 * sweep covers `firewall.rs` along with everything else. Nothing was dropped —
 * what is left here is the part that was never about citations.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

function readFirewallRs(): string {
  return readFileSync(path.join(repoRoot, "src-tauri/src/firewall.rs"), "utf8");
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

describe("forward guards: protect against future drift", () => {
  // None of these could fail when they were written (#1374) — the enum, the
  // union and the switch arms were already in agreement, and the argv-safety
  // phrase was already present. They exist to catch what happens NEXT: a new
  // Rust variant
  // with no TS union member, the same variant with no switch arm (a separate
  // hole — the switch's `default:` arm means the compiler stays quiet), or a
  // "cleanup" of the module doc that quietly drops a "never".

  it("FirewallError's variants stay aligned with FirewallErrorVariant (TS)", () => {
    // Makes the doc comment at firewall.rs:22-31 literally true: it now
    // claims a variant added with no TS arm is "the failure this test pins
    // against" — reusing the extraction shape from
    // `firewall-reason-alignment.test.ts`, which pins the sibling
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
