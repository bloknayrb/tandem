/**
 * Alignment pin for the hand-maintained reason lists behind `FirewallError`
 * (#1298, extended to a second enum by #1372).
 *
 * Two enums, each spelled out twice with nothing comparing the copies:
 *
 *   1. `SubnetDetectionReason` — why the vEthernet subnet could not be
 *      determined, once PowerShell HAS run.
 *   2. `AdapterEnumerationReason` — why PowerShell could not be started, so it
 *      never ran at all.
 *
 * Each lives in `src-tauri/src/firewall.rs` (the authority, where serde's
 * `rename_all = "camelCase"` decides the wire spelling) and again in
 * `src/client/types.ts` as a hand-written string union that a `Record` hint
 * table indexes.
 *
 * The failure is silent in both directions. A Rust-side rename produces ZERO
 * TypeScript errors: the client's `Record` lookup misses, `||` swallows it, and
 * every affected user gets the generic fallback instead of the specific
 * recovery advice the reason exists to give. A TS-side entry with no Rust
 * counterpart is dead copy nobody will ever see.
 *
 * The serde spellings themselves are pinned separately, in firewall.rs's
 * `*_rides_along_as_a_sibling_field_on_the_wire` tests. This test pins that the
 * two LISTS hold the same members; those pin how each member is spelled on the
 * wire. Both are needed — matching lists with a drifted spelling would still
 * fall through to the fallback. (Renamed from `subnet-reason-alignment.test.ts`
 * when the second enum arrived; nothing but the file name changed about the
 * first enum's coverage.)
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

/**
 * The enums under test, and the floor each must clear.
 *
 * `expect` is a member every list must contain — the positive control. An
 * alignment test whose two sides are both empty arrays is perfectly aligned and
 * perfectly useless, and both extractors below can only produce an empty array
 * by matching nothing.
 */
const ENUMS = [
  { name: "SubnetDetectionReason", min: 4, expect: "noAdapter" },
  { name: "AdapterEnumerationReason", min: 3, expect: "notFound" },
] as const;

function rustReasons(enumName: string): string[] {
  const src = readFileSync(path.join(repoRoot, "src-tauri/src/firewall.rs"), "utf8");
  const block = new RegExp(`pub enum ${enumName} \\{([\\s\\S]*?)\\n\\}`).exec(src);
  expect(block, `${enumName} enum not found in firewall.rs`).not.toBeNull();

  // Variant lines only: skip doc comments, attributes and blank lines. Both
  // enums are fieldless, so a bare identifier followed by a comma is the shape
  // — and they have to stay fieldless, because serde spells a fieldless variant
  // as the bare string the TypeScript union is keyed on. A variant that grew a
  // payload would stop matching here and fail this test rather than silently
  // change the wire.
  const variants = [...(block?.[1] ?? "").matchAll(/^\s{4}([A-Z]\w*),\s*$/gm)].map((m) => m[1]);
  expect(variants.length, `parsed no variants — ${enumName}'s shape changed`).toBeGreaterThan(0);
  return variants.map(toCamel);
}

function tsReasons(typeName: string): string[] {
  const src = readFileSync(path.join(repoRoot, "src/client/types.ts"), "utf8");
  const decl = new RegExp(`export type ${typeName} =([^;]+);`).exec(src);
  expect(decl, `${typeName} union not found in types.ts`).not.toBeNull();
  const members = [...(decl?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(
    members.length,
    `parsed no union members — ${typeName}'s declaration shape changed`,
  ).toBeGreaterThan(0);
  return members;
}

describe.each(ENUMS)("$name stays aligned across Rust and TypeScript", ({
  name,
  min,
  expect: sentinel,
}) => {
  it("has the same members on both sides", () => {
    const rust = rustReasons(name).sort();
    const ts = tsReasons(name).sort();
    expect(ts, `Rust has ${rust.join(", ")}; TypeScript has ${ts.join(", ")}`).toEqual(rust);
  });

  it("parses a plausible set from each side, so a regex that matches nothing cannot pass", () => {
    expect(rustReasons(name)).toContain(sentinel);
    expect(tsReasons(name)).toContain(sentinel);
    expect(rustReasons(name).length).toBeGreaterThanOrEqual(min);
  });
});
