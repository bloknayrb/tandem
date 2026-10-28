import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #2231: the licence grace period keeps updates flowing with NO Rust change,
 * because the desktop's `update_route` withholds updates by the status name
 * `restricted` only — a `grace` status (no `licenseId`) falls through to the
 * public manifest, exactly as a trial does. That also unblocks
 * UNSUPPORTED_VERSION's own remedy ("update Tandem") during the grace period.
 *
 * Pinned from source because the TypeScript suite cannot run the Rust, and a
 * second deny literal added there would silently stop shipping builds to every
 * device in grace. `grace_keeps_the_public_manifest` in `src-tauri/src/lib.rs`
 * is the behavioural twin, run by `cargo test`.
 */
const LIB_RS = readFileSync(join(import.meta.dirname, "../../src-tauri/src/lib.rs"), "utf-8");

function updateRouteBody(): string {
  const start = LIB_RS.indexOf("fn update_route(");
  expect(start, "update_route not found in lib.rs").toBeGreaterThan(-1);
  const rest = LIB_RS.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n"));
}

describe("update_route withholds by the name `restricted` only (#2231)", () => {
  it("has exactly one status literal it denies on, and it is `restricted`", () => {
    const body = updateRouteBody();
    const denials = [...body.matchAll(/status\.as_deref\(\)\s*==\s*Some\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(denials).toEqual(["restricted"]);
    expect(body).not.toContain('"grace"');
  });

  it("the Rust suite carries the behavioural twin", () => {
    expect(LIB_RS).toContain("fn grace_keeps_the_public_manifest()");
  });
});
