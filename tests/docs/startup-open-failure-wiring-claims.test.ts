import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the parts of #1416's fix that **nothing else can fail on**.
 *
 * Two constructs in `src-tauri/src/lib.rs` are load-bearing for the user-facing
 * half of the fix and are invisible to every other gate:
 *
 *  1. **The Close-branch latch.** `show_server_error_dialog`'s `!retry` arm is
 *     the only place the cold-start path learns that the user declined the
 *     retry. Deleting the `report_pending_opens_with(..., true, ...)` call there
 *     leaves the whole Rust suite green — verified by mutation — while
 *     reinstating the bug its own comment describes: file 1 gets a dialog, and
 *     every later double-click queues into a queue with no consumer, logging at
 *     `info`, below the release `LevelFilter::Warn` floor.
 *
 *  2. **The gave-up arm in the macOS Apple-Event handler.**
 *     `OpenRoute::ServerUnavailable => rejected.record(...)` is the entire
 *     user-facing half of "an open arriving after the app gave up says so".
 *     `handle_opened_urls` is `#[cfg(target_os = "macos")]`, so CI's macOS
 *     `rust-test` leg **compiles** it and nothing anywhere **executes** it —
 *     replacing the arm with `{}` is green on every platform.
 *
 * Plus the cross-language half: every `CODE_*` wire constant must have an
 * explicit `case` in `messageForStartupRejection`. The client is total over
 * `string`, so a Rust-side typo renders as the `default` message and no
 * assertion on either side notices. The set is DERIVED FROM THE RUST SOURCE,
 * never from a list kept here — a test seeded with the codes the client already
 * handles would only confirm the client against itself.
 *
 * Same idiom as `loopback-gate-claims.test.ts`: assert against source text,
 * with comments stripped so a construct merely DESCRIBED in prose is not
 * mistaken for one that is present.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const LIB_RS = join(REPO_ROOT, "src-tauri", "src", "lib.rs");
const CLIENT_MAP = join(REPO_ROOT, "src", "client", "utils", "startup-rejection.ts");

/** Drop `//` and `/* *\/` comments, so prose about a call is not read as the call. */
function stripRustComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("#1416 open-failure wiring that only source-scanning can pin", () => {
  const lib = stripRustComments(readFileSync(LIB_RS, "utf8"));

  it("latches the give-up when the user declines the retry dialog", () => {
    // The `!retry` arm, through to its `return`. Anchored on `if !retry` so a
    // `report_pending_opens_with` elsewhere in the file cannot satisfy it.
    const declineArm = lib.match(/if !retry \{[\s\S]{0,900}?\n\s*\}/);
    expect(declineArm, "show_server_error_dialog's `if !retry` arm not found").not.toBeNull();
    const arm = declineArm?.[0] ?? "";
    expect(
      /report_pending_opens_with\(/.test(arm),
      "Declining the retry is the only signal that the cold-start failure is terminal. " +
        "Without a report here the latch never fires on that path, and every open after " +
        "the first is silent — the #1416 bug, one file later.",
    ).toBe(true);
    expect(
      /\btrue\b/.test(arm),
      "the decline report must pass terminal = true, or it warns without latching",
    ).toBe(true);
    expect(
      /surface_startup_rejection\(/.test(arm),
      "the decline arm must pass a real sink — this is the cold-start path's only toast",
    ).toBe(true);
  });

  it("records a gave-up open into the Apple-Event batch", () => {
    // macOS-only code: compiled by one CI leg, executed by none.
    expect(
      /OpenRoute::ServerUnavailable\s*=>\s*rejected\.record\(/.test(lib),
      "handle_opened_urls must record ServerUnavailable into the batch, or an open " +
        "arriving after the app gave up is refused silently — no tab, no toast.",
    ).toBe(true);
  });

  it("gives every Rust wire code an explicit case in the client's message map", () => {
    const declared = [...lib.matchAll(/const (CODE_[A-Z_]+): &str = "([a-z-]+)";/g)].map((m) => ({
      name: m[1],
      value: m[2],
    }));
    // `lib.rs` also declares wire codes for OTHER surfaces — #1118's
    // pending-update hint has its own client reader and never reaches
    // `messageForStartupRejection`. Each exclusion has to EARN it below by
    // being passed to that surface, and the default is inclusion: a code added
    // tomorrow and routed nowhere obvious is still required to have a case.
    const ROUTED_ELSEWHERE = ["CODE_UPDATE_MAY_NOT_HAVE_COMPLETED"];
    for (const name of ROUTED_ELSEWHERE) {
      expect(
        new RegExp(`surface_pending_update_hint\\w*\\([^)]*${name}`).test(lib),
        `${name} is excluded from the message-map parity check, so it must be ` +
          "demonstrably routed to the pending-update surface instead. It is not.",
      ).toBe(true);
    }
    const codes = declared
      .filter(({ name }) => !ROUTED_ELSEWHERE.includes(name))
      .map(({ value }) => value);
    // Sanity: the scan must actually find the constants, or this test passes vacuously.
    expect(codes.length).toBeGreaterThanOrEqual(4);
    expect(codes).toContain("open-failed");
    // ...and the exclusion must actually exclude, or it is a no-op that would
    // let a genuinely unrouted code through unnoticed.
    expect(declared.map((d) => d.value)).toContain("update-may-not-have-completed");
    expect(codes).not.toContain("update-may-not-have-completed");

    const client = stripTsComments(readFileSync(CLIENT_MAP, "utf8"));
    for (const code of codes) {
      expect(
        client.includes(`case "${code}":`),
        `messageForStartupRejection has no explicit case for "${code}". The map is total ` +
          `over string, so this renders as the default message and nothing fails — which ` +
          `is exactly how a rename or a typo desyncs the two sides silently.`,
      ).toBe(true);
    }
  });
});
