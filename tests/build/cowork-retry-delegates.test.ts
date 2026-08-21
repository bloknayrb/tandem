/**
 * Regression pin for #1560 — `cowork_retry_admin_elevation` must not gate the
 * enable behind a `cowork_meta` write of its own.
 *
 * WHY A TEXT TEST. The command is `#[cfg(target_os = "windows")]`. `lib.rs` is
 * the crate root, so a Linux `cargo test` *parses* it — but the cfg-stripped
 * arm is dropped before type-check, and nothing on any leg executes it. The
 * `windows-latest` `rust-test` leg type-checks the arm and still runs no test
 * over it: `grep -rn cowork_retry_admin_elevation src-tauri/ tests/ src/` finds
 * the definition, the `invoke_handler!` registration, two capability JSON
 * descriptions, and two *client* tests that only assert `invoke` was called
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

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

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
 */
function windowsRetryBody(): string {
  const src = readFileSync(path.join(repoRoot, "src-tauri/src/lib.rs"), "utf8");
  const match =
    /#\[cfg\(target_os = "windows"\)\]\n#\[tauri::command\]\nfn cowork_retry_admin_elevation\(\) -> [^{\n]+\{\n([\s\S]*?)\n\}/.exec(
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
