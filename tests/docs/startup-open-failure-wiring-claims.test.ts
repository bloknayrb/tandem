import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  matchRustBrace,
  REPO_ROOT,
  RUST_SRC,
  rustSourceDefining,
  rustSources,
  stripRustComments,
  stripRustTestModules,
} from "./rust-sources.js";

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

const CLIENT_MAP = join(REPO_ROOT, "src", "client", "utils", "startup-rejection.ts");

function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("#1416 open-failure wiring that only source-scanning can pin", () => {
  it("latches the give-up when the user declines the retry dialog", () => {
    // Located by the construct, not by a path. Until Unit 11e both arms below
    // were read out of a hardcoded `lib.rs`, which the Unit 11 split turns into
    // a liability: greening a hardcoded path means re-pointing it, and a
    // re-pointed path is armed to break on the next move. Unit 11e replaced the
    // path with the locator; Unit 11f bounded what the locator hands back.
    //
    // **Read `code`, not `text`.** Moving the locator while the scan still read
    // comment-stripped-but-test-module-retaining text would leave the defeat
    // exactly where 11c and 11d each found it: a `#[cfg(test)]` fake of this
    // arm placed earlier in the file satisfies a `text` scan outright.
    const dialog = rustSourceDefining(
      /fn show_server_error_dialog\s*\(/,
      "show_server_error_dialog",
    );
    // ...and sliced to the function's OWN BODY, because the match below is a
    // FIRST-hit search. Two mutants that review executed prove each half is
    // load-bearing, and both left all six specs green:
    //
    //  - Slicing from `indexOf("fn show_server_error_dialog")` is satisfied by
    //    `fn show_server_error_dialog_decline_shim`, whose name has the real
    //    one as a PREFIX. Placed above the real function it moves the slice
    //    onto itself. Anchoring on the locator's own regex — which requires
    //    `(` after the name — is what refuses the longer name.
    //  - Slicing to end-of-file lets any later `if !retry` satisfy a claim that
    //    is specifically about this dialog's decline branch, including one in a
    //    `#[cfg(test)]` fake. `stripRustTestModules` now removes test-gated
    //    items whatever their shape, and brace-matching bounds the rest.
    const SIG = /fn show_server_error_dialog\s*\(/;
    const from = dialog.code.search(SIG);
    const open = dialog.code.indexOf("{", from);
    const body = dialog.code.slice(open, matchRustBrace(dialog.code, open) + 1);
    expect(
      body.length,
      "the body slice reached the end of the file — it is no longer bounding anything",
    ).toBeLessThan(dialog.code.length - from);
    const declineArm = body.match(/if !retry \{[\s\S]{0,900}?\n\s*\}/);
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
    // macOS-only code: compiled by one CI leg, executed by none. The
    // `#[cfg(target_os = "macos")]` gate does not hide it from the locator —
    // only predicates naming `test` are stripped — so the construct is a valid
    // anchor on every platform.
    const opened = rustSourceDefining(/fn handle_opened_urls\s*\(/, "handle_opened_urls");
    expect(
      /OpenRoute::ServerUnavailable\s*=>\s*rejected\.record\(/.test(opened.code),
      "handle_opened_urls must record ServerUnavailable into the batch, or an open " +
        "arriving after the app gave up is refused silently — no tab, no toast.",
    ).toBe(true);
  });

  it("scans every Rust source file, not a list written here", () => {
    // The control on the scan itself. `rustSources()` feeding the parity check
    // means an empty or truncated walk satisfies it silently: zero declared
    // codes is zero unhandled codes. This is what makes the walk falsifiable.
    const files = rustSources();
    const rel = files.map((f) => f.rel);
    expect(rel.length, "the Rust source walk found almost nothing").toBeGreaterThan(10);
    expect(rel).toContain("src-tauri/src/lib.rs");
    expect(
      rel,
      "the module holding the excluded wire code must be in scope, or its " +
        "exclusion is asserted against text the scan never read",
    ).toContain("src-tauri/src/pending_update.rs");
    // Unit 11f moved every wire code this file checks out of `lib.rs`, so the
    // two names above no longer cover the parity check below: if the walk stops
    // reaching their new home it has nothing to compare and passes on an empty
    // set. The control is DERIVED — "the file that declares them is in the
    // walk" — rather than the file's name, because naming it would rebuild the
    // hardcoded path this unit spent its effort removing, and would then fail
    // on a rename that breaks no claim here.
    const declaring = files.filter((f) => /const CODE_OPEN_FAILED: &str/.test(f.code));
    expect(
      declaring.map((f) => f.rel),
      "exactly one scanned Rust file must declare the startup wire codes, or the " +
        "parity check below is comparing against a set the walk never assembled",
    ).toHaveLength(1);
  });

  it("strips test modules without eating production code", () => {
    // The control on the stripper. It runs before every scan below, so one that
    // removed too much would make each of them pass by finding nothing, and one
    // that removed nothing would reinstate the hole it exists to close.
    const pu = readFileSync(join(RUST_SRC, "pending_update.rs"), "utf8");
    const stripped = stripRustTestModules(stripRustComments(pu));
    expect(stripped, "the production declaration must survive stripping").toContain(
      "const CODE_UPDATE_MAY_NOT_HAVE_COMPLETED",
    );
    expect(
      stripped,
      "the test module's own call must not survive, or a test can satisfy a claim " +
        "about production routing",
    ).not.toContain("surface_pending_update_hint_with(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED");
    expect(pu, "the fixture this control relies on has moved").toContain(
      "surface_pending_update_hint_with(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED",
    );

    // The brace counter must survive a brace inside a literal. `pending_update.rs`
    // already carries one (`b"{ not json"`), and only escapes the bug because its
    // test module is last in the file — so assert the property on a fixture that
    // puts a constant AFTER the test module, which is what the real file becomes
    // the moment anyone appends to it.
    const withLiteralBrace = [
      "#[cfg(test)]",
      "mod t {",
      '    fn f() { std::fs::write(&path, b"{ not json").unwrap(); }',
      "    fn g() { let raw = r#\"} still not json\"#; let c = '{'; }",
      "}",
      'const CODE_AFTER_THE_TEST_MODULE: &str = "after";',
    ].join("\n");
    const survivor = stripRustTestModules(withLiteralBrace);
    expect(
      survivor,
      "a brace inside a string or char literal must not desync the counter — " +
        "swallowing everything after a test module is how a widened scan hollows itself",
    ).toContain("CODE_AFTER_THE_TEST_MODULE");
    expect(survivor, "the test module itself must still be stripped").not.toContain("not json");

    // `#[cfg(test)]` is not the only spelling. The crate carries two
    // `#[cfg(all(test, target_os = "windows"))]` modules — in `lib.rs` until
    // Unit 11d moved them to `cowork_commands.rs` — and the substring scan this
    // stripper used until then matched NEITHER, so a scan reading that file saw
    // their bodies as production code. Both directions are asserted,
    // because a stripper that fixed the `all(...)` form by matching any cfg
    // mentioning `test` would eat `#[cfg(not(test))]`, which gates production.
    const cfgForms = [
      '#[cfg(all(test, target_os = "windows"))]',
      '#[cfg(all(test, feature = "x"))]',
      "#[cfg(test)]",
    ];
    for (const attr of cfgForms) {
      const stripped = stripRustTestModules(
        [attr, "mod t {", "    fn f() {}", "}", "const AFTER: u8 = 1;"].join("\n"),
      );
      expect(stripped, `${attr} must be recognised as a test gate`).not.toContain("fn f()");
      expect(stripped, `${attr} must not eat what follows it`).toContain("const AFTER");
    }
    const production = ["#[cfg(not(test))]", "mod real {", "    fn keep_me() {}", "}"].join("\n");
    expect(
      stripRustTestModules(production),
      "#[cfg(not(test))] gates PRODUCTION code — stripping it would hollow the scan silently",
    ).toContain("keep_me");

    // ...and a block that genuinely never closes fails loud rather than truncating.
    expect(
      () => stripRustTestModules("#[cfg(test)]\nmod t {\n    fn f() {\n"),
      "an unbalanced block must throw, not silently drop the rest of the file",
    ).toThrow(/ran off the end/);

    // A test-gated attribute can sit on any item, and until Unit 11f this
    // stripper assumed it always gated a module WITH A BODY. Both assumptions
    // were false in `lib.rs`, and both failures ate production declarations
    // rather than announcing themselves — measured on `origin/master`, the
    // `code` view was missing `pub mod open_candidate;`, 7 of 9 Windows-gated
    // `mod` declarations and 3 crate-root re-exports, so `rustSourceDefining`
    // could not have located a construct there and any claim about that region
    // would have passed by finding nothing. Both shapes, both directions.
    const gatedStatic = [
      "#[cfg(test)]",
      "pub(crate) static LOCK: Mutex<()> = Mutex::new(());",
      "pub mod open_candidate;",
      "pub use open_candidate::{ a, b };",
    ].join("\n");
    const staticStripped = stripRustTestModules(gatedStatic);
    expect(
      staticStripped,
      "a test-gated STATIC has no brace of its own — jumping to the next `{` " +
        "swallows every declaration up to some unrelated group import",
    ).toContain("pub mod open_candidate;");
    expect(
      staticStripped,
      "...and the static itself is test-only, so it must not survive into `code`",
    ).not.toContain("static LOCK");

    const gatedDecl = ["#[cfg(test)]", "mod probe;", "pub mod real;"].join("\n");
    const declStripped = stripRustTestModules(gatedDecl);
    expect(declStripped, "`mod probe;` is a test module and must still go").not.toContain(
      "mod probe;",
    );
    expect(
      declStripped,
      "`mod t;` terminates at its semicolon — brace-matching past it deletes what follows",
    ).toContain("pub mod real;");

    // A test-gated NON-MODULE item must go too, and this is not tidiness: a
    // `#[cfg(test)] fn` shaped like the construct a caller asserts on — placed
    // anywhere, including inside the very function under assertion — otherwise
    // survives into `code` and satisfies the claim outright. Review executed
    // that mutant against the decline-arm spec above and it stayed green.
    const gatedFn = [
      "#[cfg(test)]",
      "fn shim(retry: bool) {",
      "    if !retry { report_pending_opens_with(p, true, surface_startup_rejection); }",
      "}",
      "pub fn real() {}",
    ].join("\n");
    const fnStripped = stripRustTestModules(gatedFn);
    expect(
      fnStripped,
      "a test-gated `fn` is a fake that satisfies production-shaped claims",
    ).not.toContain("report_pending_opens_with");
    expect(fnStripped, "...and it must not eat the item after it").toContain("pub fn real()");

    // ...and the counterweight, which is the whole reason `any(` is refused.
    // `#[cfg(any(target_os = "macos", test))]` gates PRODUCTION code that a
    // macOS build compiles — `lib.rs` carries exactly this on an
    // `open_candidate` re-export. Stripping non-module items without this
    // refusal would delete it and hollow the region these controls guard.
    const anyGated = [
      '#[cfg(any(target_os = "macos", test))]',
      "pub(crate) use open_candidate::{ classify_opened_url };",
      "pub fn after() {}",
    ].join("\n");
    expect(
      stripRustTestModules(anyGated),
      "`any(…, test)` means test is only one way in — the item ships on another platform",
    ).toContain("use open_candidate::{ classify_opened_url }");

    // An item whose terminator never arrives fails loud, like the brace matcher.
    expect(
      () => stripRustTestModules("#[cfg(test)]\nstatic LOOSE: u8 = 1"),
      "an unterminated gated item must throw, not silently drop the rest of the file",
    ).toThrow(/ran off the end/);

    // ...and the strip must still happen for the shapes that DO gate a module,
    // including one behind a second attribute. Without this the fix above could
    // be "never strip anything", which passes every assertion built on it.
    const stacked = ["#[cfg(test)]", "#[allow(dead_code)]", "mod t {", "    fn f() {}", "}"].join(
      "\n",
    );
    expect(
      stripRustTestModules(stacked),
      "attributes stack — a test module behind a second attribute must still be stripped",
    ).not.toContain("fn f()");

    // The measurement on the real file, not on a fixture. Both declarations
    // below sit AFTER `lib.rs`'s test-gated static and its test-gated `mod`
    // declaration, which is exactly why each was absent from `code` before the
    // fix — a declaration ahead of them would have passed with the bug present
    // and been no control at all.
    //
    // They are also both `open_candidate`, deliberately: it predates Unit 11 and
    // is the `ScreenedOpenPath` seam, so it is about as rename-stable as a name
    // in this crate gets. An earlier draft of this control named a module Unit
    // 11f had just created, and a rename probe in that unit's mutation battery
    // reddened it — a guard that fails on a rename breaking no claim here is
    // noise, and this file spent its effort removing exactly that.
    const root = rustSourceDefining(/^pub mod open_candidate;$/m, "the crate root");
    for (const decl of ["pub mod open_candidate;", "pub use open_candidate::{"]) {
      expect(root.code, `the code view of the crate root must reach ${decl}`).toContain(decl);
    }
  });

  it("agrees with the client on the nudge event's name", () => {
    // The wire-code parity check below keys on `const CODE_*`, so the EVENT
    // name sat outside every gate in the repo. Changing the Rust literal is
    // green everywhere — no Rust test asserts it, and the client's own test
    // asserts the client against itself — while every warm-path toast stops
    // arriving: the event is a payload-free nudge, so a listener on the old
    // name simply never fires and the buffered code waits for the next init.
    // Found while moving these constants in Unit 11f.
    const rust = rustSourceDefining(
      /const EVENT_STARTUP_FILE_REJECTED: &str/,
      "EVENT_STARTUP_FILE_REJECTED",
    );
    const declared = rust.code.match(/const EVENT_STARTUP_FILE_REJECTED: &str = "([a-z-]+)";/);
    expect(
      declared,
      "the Rust event constant is not a plain string literal any more",
    ).not.toBeNull();

    const client = stripTsComments(readFileSync(CLIENT_MAP, "utf8"));
    const listened = client.match(/const NUDGE_EVENT = "([a-z-]+)";/);
    expect(
      listened,
      "the client's NUDGE_EVENT binding is not a plain literal any more",
    ).not.toBeNull();

    expect(
      declared?.[1],
      "Rust emits one event name and the client listens for another. Nothing else " +
        "fails on this: the nudge carries no payload, so a mismatch is indistinguishable " +
        "from no rejection having happened.",
    ).toBe(listened?.[1]);
    // ...and the emit site must USE the constant. Pinning the two literals
    // against each other leaves `app.emit("startup-file-rejectd", ())` green on
    // both sides while every warm-path toast dies — review executed exactly
    // that mutant, keeping the `log::warn!` interpolation so the const stays
    // live and `dead_code` never fires.
    expect(
      rust.code,
      "the emit site must pass EVENT_STARTUP_FILE_REJECTED, not a second literal",
    ).toMatch(/app\.emit\(EVENT_STARTUP_FILE_REJECTED/);
  });

  it("gives every Rust wire code an explicit case in the client's message map", () => {
    const sources = rustSources();
    // Stripped once and shared: `routedIn` below asks about the same derived
    // text, and computing it twice invites the two from drifting apart.
    const stripped = sources.map((f) => ({
      rel: f.rel,
      text: stripRustTestModules(stripRustComments(f.text)),
    }));
    const rust = stripped.map((f) => f.text).join("\n");
    const declared = [...rust.matchAll(/const (CODE_[A-Z_]+): &str = "([a-z-]+)";/g)].map((m) => ({
      name: m[1],
      value: m[2],
    }));
    // The crate also declares wire codes for OTHER surfaces — #1118's
    // pending-update hint, in `pending_update.rs` since Unit 11a, has its own
    // client reader and never reaches `messageForStartupRejection`. (Since
    // Unit 11f `lib.rs` declares no `CODE_*` at all.) Each exclusion has to
    // EARN it below by
    // being passed to that surface, and the default is inclusion: a code added
    // tomorrow and routed nowhere obvious is still required to have a case.
    const ROUTED_ELSEWHERE = ["CODE_UPDATE_MAY_NOT_HAVE_COMPLETED"];
    for (const name of ROUTED_ELSEWHERE) {
      expect(
        new RegExp(`surface_pending_update_hint\\w*\\([^)]*${name}`).test(rust),
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
    // ...and it must be earned in a file the scan actually reached. Without
    // this, re-pointing the scan back at `lib.rs` alone after some future move
    // leaves the exclusion asserting nothing about a constant that is no longer
    // there — the exact hollowing this widening exists to prevent.
    const routedIn = stripped.filter(({ text }) =>
      /const CODE_UPDATE_MAY_NOT_HAVE_COMPLETED: &str/.test(text),
    );
    expect(
      routedIn.map((f) => f.rel),
      "the excluded wire code must be declared in exactly one scanned Rust file",
    ).toHaveLength(1);

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
