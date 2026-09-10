import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, rustSourceDefining, rustSources } from "./rust-sources.js";

/**
 * **The link between the two consts that flip at v1.0** (#1785).
 *
 * Two flags arm the licensing system, in two languages, and until this file
 * nothing connected them: `LICENSE_GATE_ENABLED` in `tsup.config.ts` (the run
 * gate) and `LICENSE_UPDATE_ENDPOINT` in the Tauri crate (the update window).
 * Flipping the first alone arms the gate and leaves the update window inert —
 * `resolve_update_route` returns `Public` on its first line while the endpoint
 * is empty, and `Public` is the public manifest from `tauri.conf.json`.
 *
 * So this asserts the BICONDITIONAL — gate dark ⟺ endpoint empty — in both
 * directions. `check` is a required status check on `master`, so flipping
 * either const alone turns the merge red. That is the whole of "impossible or
 * loud"; nothing here flips anything.
 *
 * It also carries two count asserts on the route shape. They are the cheapest
 * available pin on the half of #1785 that `cargo test` cannot reach:
 * `build_updater` needs an `AppHandle` no test can construct, so a lazy
 * `UpdateRoute::NoUpdates(_) => app.updater()` — the filed bug, unchanged —
 * would pass every cargo case and the whole TS suite, and the PR would land as
 * a no-op that reads as done.
 *
 * Mutation-checked by hand (restore from a file copy, never `git checkout`):
 * flip either literal ⇒ red; rename either const ⇒ red (not quietly skipped);
 * paste a commented-out `const LICENSE_UPDATE_ENDPOINT: &str = "https://x";`
 * above the live one ⇒ stays GREEN; add a second `app.updater()` ⇒ red; add an
 * `Ok(None) => show_up_to_date_dialog(app)` arm ⇒ red.
 */

const TSUP_CONFIG = join(REPO_ROOT, "tsup.config.ts");

/** The `false` / `true` literal `tsup.config.ts` declares the run gate with. */
function readGateLiteral(): string {
  const src = readFileSync(TSUP_CONFIG, "utf8");
  const match = /const\s+LICENSE_GATE_ENABLED\s*=\s*(true|false)\s*;/.exec(src);
  // Anti-vacuity. `src.match(re)?.[1] === "true"` written without this check
  // yields `false` on a NON-match, which satisfies "dark ⟺ empty" and stays
  // green forever after any rename or reshape of the declaration.
  expect(
    match,
    "tsup.config.ts no longer declares LICENSE_GATE_ENABLED as a boolean literal — " +
      "the pin is disarmed, not passing",
  ).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

/** The string literal the Rust crate declares the update endpoint with. */
function readEndpointLiteral(): string {
  // Resolve the FILE through `rustSourceDefining` rather than reading `lib.rs`
  // at a hardcoded path: that helper exists because a hardcoded scope already
  // failed silently here once (a const extracted into `pending_update.rs` left
  // the scan and the check went quiet), and `lib.rs` is mid-split into six
  // modules. Both failure directions are loud — zero matches and two-or-more
  // both throw rather than picking one.
  const source = rustSourceDefining(
    /const\s+LICENSE_UPDATE_ENDPOINT\s*:\s*&'?\w*\s*str\s*=/,
    "LICENSE_UPDATE_ENDPOINT",
  );
  // The helper's required positive control: a walk that silently returns
  // nothing satisfies every assertion built on it.
  expect(
    rustSources().map((f) => f.rel),
    "the Rust walk no longer sees the file defining LICENSE_UPDATE_ENDPOINT",
  ).toContain(source.rel);

  // `.code`, NEVER `.text`. `rustSourceDefining` picks the FILE by matching
  // `code` (comments and `#[cfg(test)]` bodies stripped) but hands back both.
  // A first-hit match against `text` prefers a commented-out
  // `const LICENSE_UPDATE_ENDPOINT: &str = "https://…";` sitting above the live
  // one — the exact defeat the helper's own docblock records review having
  // constructed. At flip time that reads "endpoint still empty" while the real
  // const is set, and the biconditional passes on a HALF-FLIP: the single
  // failure this file exists to catch.
  const match = /const\s+LICENSE_UPDATE_ENDPOINT\s*:\s*&'?\w*\s*str\s*=\s*"([^"]*)"\s*;/.exec(
    source.code,
  );
  expect(
    match,
    `${source.rel} no longer declares LICENSE_UPDATE_ENDPOINT as a plain string literal — ` +
      "the pin is disarmed, not passing",
  ).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

/** Every Rust file's comment- and test-stripped code, concatenated. */
function allRustCode(): string {
  return rustSources()
    .map((f) => f.code)
    .join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("the two consts that flip at v1.0 (#1785)", () => {
  it("gate dark ⟺ update endpoint empty, in both directions", () => {
    const gateEnabled = readGateLiteral() === "true";
    const endpointEmpty = readEndpointLiteral() === "";

    expect(
      gateEnabled,
      "LICENSE_GATE_ENABLED and LICENSE_UPDATE_ENDPOINT must flip in the SAME commit " +
        "(docs/licensing-operations.md §4). " +
        (gateEnabled
          ? "The run gate is ARMED while the Tauri crate's LICENSE_UPDATE_ENDPOINT is still " +
            "empty — resolve_update_route returns Public on its first line, so every licensed " +
            "device gets the PUBLIC manifest from tauri.conf.json and the update window gates " +
            "nobody."
          : "LICENSE_UPDATE_ENDPOINT is set while LICENSE_GATE_ENABLED is still false in " +
            "tsup.config.ts — the sidecar reports gate_active: false, so update_route answers " +
            "Public anyway and the endpoint is dead configuration."),
    ).toBe(!endpointEmpty);
  });
});

describe("the update route shape #1785 fixes (#1785)", () => {
  // `app.updater()` is the PUBLIC manifest. It belongs to `build_updater`'s
  // `Public` arm alone. A lazy `NoUpdates(_) => app.updater().map_err(…)` —
  // i.e. the filed bug, unchanged — makes this 2 and passes every cargo case.
  it("app.updater() appears exactly once in the crate", () => {
    expect(
      countOccurrences(allRustCode(), "app.updater()"),
      "app.updater() serves the PUBLIC manifest and belongs to build_updater's Public arm " +
        "only. A second occurrence means some other route — most likely NoUpdates — is " +
        "falling back to public builds, which is #1785 itself.",
    ).toBe(1);
  });

  // Spelled `(app)`, not a bare `show_up_to_date_dialog(`, because the
  // DEFINITION reads `fn show_up_to_date_dialog(app: &tauri::AppHandle)` and
  // would satisfy the looser spelling, making the count non-discriminating.
  it("show_up_to_date_dialog(app) is called exactly once", () => {
    expect(
      countOccurrences(allRustCode(), "show_up_to_date_dialog(app)"),
      '"You\'re running the latest version" is the exact lie #1786 exists to detect. It may ' +
        "be shown only for a real Ok(None) from updater.check() — never on the withheld-manifest " +
        "arm, which serves no manifest and never calls check() at all.",
    ).toBe(1);
  });
});
