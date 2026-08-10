/**
 * Alignment pin for the two hand-maintained lists of subnet-detection reasons
 * (#1298).
 *
 * `SubnetDetectionReason` exists in two places that nothing else compares:
 *
 *   1. `SubnetDetectionReason` in `src-tauri/src/firewall.rs` — the authority.
 *      serde's `rename_all = "camelCase"` decides the wire spelling.
 *   2. `SubnetDetectionReason` in `src/client/types.ts` — a hand-written union
 *      keyed on those exact strings, which `SUBNET_REASON_HINT` indexes.
 *
 * The failure is silent in both directions. A Rust-side rename produces ZERO
 * TypeScript errors: the client's `Record` lookup misses, `||` swallows it, and
 * every affected user gets the generic "couldn't work out the Hyper-V subnet"
 * fallback instead of the specific recovery advice the reason exists to give.
 * A TS-side entry with no Rust counterpart is dead copy nobody will ever see.
 *
 * The serde spelling itself is pinned separately, in
 * `subnet_reason_rides_along_as_a_sibling_field_on_the_wire`. This test pins
 * that the two LISTS hold the same members; that one pins how each member is
 * spelled on the wire. Both are needed — matching lists with a drifted
 * spelling would still fall through to the fallback.
 *
 * Lives in `tests/build/` (the node project): it parses files as text and needs
 * no svelte plugin.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

/** `NoAdapter` -> `noAdapter`, matching serde's `RenameRule::CamelCase`. */
function toCamel(variant: string): string {
  return variant.slice(0, 1).toLowerCase() + variant.slice(1);
}

function rustReasons(): string[] {
  const src = readFileSync(path.join(repoRoot, "src-tauri/src/firewall.rs"), "utf8");
  const block = /pub enum SubnetDetectionReason \{([\s\S]*?)\n\}/.exec(src);
  expect(block, "SubnetDetectionReason enum not found in firewall.rs").not.toBeNull();

  // Variant lines only: skip doc comments, attributes and blank lines. The
  // enum is fieldless, so a bare identifier followed by a comma is the shape.
  const variants = [...(block?.[1] ?? "").matchAll(/^\s{4}([A-Z]\w*),\s*$/gm)].map((m) => m[1]);
  expect(variants.length, "parsed no variants — the enum's shape changed").toBeGreaterThan(0);
  return variants.map(toCamel);
}

function tsReasons(): string[] {
  const src = readFileSync(path.join(repoRoot, "src/client/types.ts"), "utf8");
  const decl = /export type SubnetDetectionReason =([^;]+);/.exec(src);
  expect(decl, "SubnetDetectionReason union not found in types.ts").not.toBeNull();
  const members = [...(decl?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(
    members.length,
    "parsed no union members — the declaration's shape changed",
  ).toBeGreaterThan(0);
  return members;
}

describe("SubnetDetectionReason stays aligned across Rust and TypeScript", () => {
  it("has the same members on both sides", () => {
    const rust = rustReasons().sort();
    const ts = tsReasons().sort();
    expect(ts, `Rust has ${rust.join(", ")}; TypeScript has ${ts.join(", ")}`).toEqual(rust);
  });

  it("parses a plausible set from each side, so a regex that matches nothing cannot pass", () => {
    // The positive control. Both extractors above assert non-empty, but this
    // states the expected shape outright: an alignment test whose two sides are
    // both empty arrays is perfectly aligned and perfectly useless.
    expect(rustReasons()).toContain("noAdapter");
    expect(tsReasons()).toContain("noAdapter");
    expect(rustReasons().length).toBeGreaterThanOrEqual(4);
  });
});
