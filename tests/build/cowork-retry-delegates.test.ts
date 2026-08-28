/**
 * Regression pin for #1560 — `cowork_retry_admin_elevation` must not gate the
 * enable behind a `cowork_meta` write of its own.
 *
 * WHY A TEXT TEST. The command is `#[cfg(target_os = "windows")]`, so a Linux
 * `cargo test` *parses* its module — but the cfg-stripped arm is dropped before
 * type-check, and nothing on any leg executes it. The
 * `windows-latest` `rust-test` leg type-checks the arm and still runs no test
 * over it: `grep -rn cowork_retry_admin_elevation src-tauri/ tests/ src/` finds
 * both arms, the `generate_handler!` registration, two capability JSON
 * descriptions (`capabilities/default.json` and the generated
 * `gen/schemas/capabilities.json`), and two *client* tests that only assert `invoke` was called
 * with the command name. So the exact pre-#1560 body could be restored and
 * every suite would stay green.
 *
 * That is not hypothetical — it is what the first cut of this fix left open.
 * The fix itself lived entirely inside this cfg-gated body while the tests
 * covered a pure helper beside it, so a verbatim revert of the body passed all
 * of them. The positive control below is that revert, quoted from issue #1560.
 *
 * WHAT IS PINNED, and why it is phrased over `cowork_meta` rather than over
 * `?`. The defect was `cowork_meta::update(...)?` running *before* the toggle,
 * so an unwritable `cowork-meta.json` — the canonical reason that update fails,
 * and exactly the state the admin-declined modal is up in — short-circuited the
 * command and the enable was never attempted. Reordering alone would not settle
 * it: the clear is redundant on the toggle's success path (the toggle's own
 * enable arm clears the same two fields immediately before its only `Ok`),
 * undone on its `AdminDeclined` path (which re-sets them deliberately), and
 * actively wrong on its other error paths (it retires the modal after a retry
 * that enabled nothing). So the invariant is the stronger one: this command
 * writes no meta at all. See the command's doc comment for the full argument.
 *
 * This says nothing about `cowork_toggle_integration`, which reads and writes
 * meta freely and must keep doing so.
 */

import { describe, expect, it } from "vitest";
import { rustSourceDefining } from "../docs/rust-sources.js";

/**
 * The module holding the command, **found by the construct rather than named**.
 *
 * This read `src-tauri/src/lib.rs` by path until Unit 11d moved the Cowork
 * commands into `cowork_commands.rs`, and a hardcoded path is exactly the shape
 * that goes quiet rather than red when the Unit 11 split moves its subject: the
 * regex below would simply stop matching, and the `not.toBeNull()` above would
 * be the only thing standing between that and a silent pass. Locating by
 * `cowork_retry_admin_elevation`'s own declaration means the next module move
 * relocates this pin for free, and a second definition of the command anywhere
 * in the crate fails loudly instead of being picked between.
 */
const RETRY = rustSourceDefining(
  /#\[tauri::command\]\s*(?:pub(?:\(crate\))?\s+)?fn cowork_retry_admin_elevation\s*\(/,
  "cowork_retry_admin_elevation",
);

/**
 * The body of the `cfg(target_os = "windows")` arm — braces excluded.
 *
 * Anchored on the attribute pair plus the `fn` line rather than the bare `fn`
 * line, because the `cfg(not(...))` stub two lines below has an identical
 * signature and would otherwise be a candidate match. Terminated by the first
 * column-0 `}`, which is the function's own closing brace under rustfmt.
 *
 * The return type is deliberately left open: it is the `cfg` attribute that
 * distinguishes the two arms, not the type, and #1438 widened `String` to
 * `CoworkToggleReport` without touching anything this file pins.
 *
 * The visibility is left open for the same reason: Unit 11d widened both arms
 * to `pub(crate)` so `generate_handler!` in `lib.rs` can still name them, and a
 * pin anchored on attribute/item adjacency breaks on exactly that kind of edit.
 *
 * **Matched against `code`, not `text`, and that is load-bearing.** Review
 * constructed the defeat and ran it: a `/* … *\/` block holding a column-0,
 * syntactically exact copy of the post-fix Windows arm, with the real arm
 * reverted to the pre-#1560 body, left every spec in this file green. The
 * regex is a first-hit match over the file, so the commented impostor wins.
 * `rustSourceDefining` already matches `code` for the same reason; running the
 * extraction against `text` reopened the hole one level down.
 */
function windowsRetryBody(): string {
  const src = RETRY.code;
  const match =
    /#\[cfg\(target_os = "windows"\)\]\n#\[tauri::command\]\n(?:pub(?:\(crate\))?\s+)?fn cowork_retry_admin_elevation\(\) -> [^{\n]+\{\n([\s\S]*?)\n\}/.exec(
      src,
    );
  expect(
    match,
    "cowork_retry_admin_elevation's Windows arm not found — signature, attribute order or formatting changed",
  ).not.toBeNull();
  return match?.[1] ?? "";
}

/** The defect shape: this command performing its own `cowork_meta` write. */
function writesMetaItself(body: string): boolean {
  return /cowork_meta\s*::/.test(body);
}

describe("regression pin (#1560): the Retry command delegates, it does not bookkeep", () => {
  it("scans a real Rust module, found by search rather than named here", () => {
    // The control on the locator. `rustSourceDefining` already fails loudly on
    // zero or two matches, but that only says the pattern resolved — not that
    // it resolved onto the pair of arms every assertion below reads. Renaming
    // the module this lives in must stay GREEN (that is the point of finding it
    // by construct); losing either arm must not.
    //
    // Asserted as the cfg attribute IMMEDIATELY ABOVE each declaration, not as
    // a file-wide `toContain`. Review ran the difference: `cowork_commands.rs`
    // holds 23 `#[cfg(target_os = "windows")]` and 12 of its negation, so a
    // file-wide check for either string cannot fail until the module loses
    // every one of them — it reads like a second assertion while doing no work.
    const arms = [...RETRY.code.matchAll(/fn cowork_retry_admin_elevation\s*\(/g)].map((m) =>
      RETRY.code.slice(Math.max(0, (m.index ?? 0) - 120), m.index),
    );
    expect(
      arms,
      "expected exactly two arms — the Windows command and its non-Windows stub",
    ).toHaveLength(2);
    for (const cfg of ['#[cfg(target_os = "windows")]', '#[cfg(not(target_os = "windows"))]']) {
      expect(
        arms.some((preamble) => preamble.includes(cfg)),
        `no cowork_retry_admin_elevation declaration is preceded by ${cfg} — the two arms ` +
          "this file pins are the Windows command and its stub, and it just found neither",
      ).toBe(true);
    }
  });

  it("the Windows arm calls the toggle", () => {
    expect(windowsRetryBody()).toContain("cowork_toggle_integration(true)");
  });

  it("the Windows arm performs no cowork_meta write of its own", () => {
    const body = windowsRetryBody();
    expect(
      writesMetaItself(body),
      `cowork_retry_admin_elevation's body touches cowork_meta:\n${body}`,
    ).toBe(false);
  });

  it("positive control: the pre-#1560 body fails the check", () => {
    // Verbatim from issue #1560's description of the defect. If the detector
    // ever stops matching this, the two tests above are passing for the wrong
    // reason.
    const preFix = `    cowork_meta::update(|m| {
        m.uac_declined_last_attempt = false;
        m.uac_declined_at = None;
    })
    .map_err(|e| e.to_string())?;
    cowork_toggle_integration(true)`;
    expect(writesMetaItself(preFix)).toBe(true);
    // And note it would satisfy the first test — delegation alone was never
    // the missing half.
    expect(preFix).toContain("cowork_toggle_integration(true)");
  });
});
