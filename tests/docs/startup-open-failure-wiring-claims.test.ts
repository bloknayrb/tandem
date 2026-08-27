import { readdirSync, readFileSync } from "node:fs";
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
const RUST_SRC = join(REPO_ROOT, "src-tauri", "src");
const LIB_RS = join(RUST_SRC, "lib.rs");
const CLIENT_MAP = join(REPO_ROOT, "src", "client", "utils", "startup-rejection.ts");

/**
 * Every Rust source file, **derived from disk rather than named here**.
 *
 * The wire-code half of this test used to read `lib.rs` alone. That was correct
 * only while every `CODE_*` constant lived there, and it stopped being correct
 * the moment one was extracted into a module (Unit 11a moved
 * `CODE_UPDATE_MAY_NOT_HAVE_COMPLETED` into `pending_update.rs`). A hardcoded
 * scope does not follow the code: the constant simply left the scan, and the
 * parity check would have gone quiet about it.
 *
 * Re-pointing at a fixed pair of files would have reproduced the same bug one
 * extraction later — `lib.rs` is mid-way through being split into six modules.
 * Deriving the set is what makes this survive the rest of that split, and
 * `scans every Rust source file` below is the positive control on the set
 * itself, because a walk that silently returns nothing satisfies every
 * assertion built on it.
 */
function rustSources(): Array<{ rel: string; text: string }> {
  return readdirSync(RUST_SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".rs"))
    .map((e) => {
      const abs = join(e.parentPath, e.name);
      return {
        rel: abs.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"),
        text: readFileSync(abs, "utf8"),
      };
    });
}

/**
 * Drop `#[cfg(test)] mod ... { ... }` blocks.
 *
 * **A test satisfied this file's production-routing claim.** The exclusion
 * check asks whether `CODE_UPDATE_MAY_NOT_HAVE_COMPLETED` is genuinely passed
 * to the pending-update surface -- and `pending_update_tests` calls
 * `surface_pending_update_hint_with(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED, ...)`,
 * which matched. Rewriting the real call site to pass a literal instead left
 * this file green; found by mutation, not by reading. The hole predates the
 * Unit 11a extraction -- the test module was previously in `lib.rs` and equally
 * in scope -- but the widened scan is what made it worth closing here.
 *
 * Brace-counted rather than regex-bounded, and "strips test modules without
 * eating production code" is the control on it: a stripper that removed too
 * much would make every assertion below pass by finding nothing.
 *
 * **Braces are counted outside string and char literals**, because a naive
 * counter is defeated by text this very file already scans:
 * `pending_update.rs`'s test module contains `b"{ not json"`, an unbalanced
 * brace in a byte-string literal. A counter that sees it never reaches depth 0
 * and runs off the end of the input — today indistinguishable from a correct
 * match only because that test module is the last thing in the file. The next
 * constant appended after it would vanish from the parity scan silently. Found
 * by review, not by reading. Hence both halves: literals are skipped, and an
 * unbalanced block **throws** rather than truncating, because a stripper that
 * fails loud cannot hollow the scan it feeds.
 */
function stripRustTestModules(src: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = src.indexOf("#[cfg(test)]", i);
    if (at === -1) return out + src.slice(i);
    const open = src.indexOf("{", at);
    if (open === -1) return out + src.slice(i);
    out += src.slice(i, at);
    i = matchRustBrace(src, open) + 1;
  }
}

/** Index of the `}` closing the `{` at `open`. Throws if the block never closes. */
function matchRustBrace(src: string, open: number): number {
  let depth = 0;
  let j = open;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      const after = skipRustLiteral(src, j);
      if (after > j) {
        j = after;
        continue;
      }
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j;
    j++;
  }
  throw new Error(
    "unbalanced `#[cfg(test)]` block: the brace scanner ran off the end of the " +
      "input. Truncating here would silently drop every Rust item after it from " +
      "the wire-code scan, so this fails instead.",
  );
}

/**
 * Index just past the string or char literal starting at `i`, or `i` if what is
 * there is not a literal (a lifetime `'a`, most commonly).
 *
 * Comments are already gone — `stripRustComments` runs first — so only literals
 * can hide a brace.
 */
function skipRustLiteral(src: string, i: number): number {
  if (src[i] === "'") {
    // `'\n'` / `'{'` are literals; `'a` is a lifetime and must not be skipped.
    if (src[i + 1] === "\\") {
      const end = src.indexOf("'", i + 2);
      return end === -1 ? i : end + 1;
    }
    return src[i + 2] === "'" ? i + 3 : i;
  }
  // Raw-ness is decided by looking back over `#`s to an `r` (`r"`, `r#"`, `br#"`).
  let k = i - 1;
  let hashes = 0;
  while (src[k] === "#") {
    hashes++;
    k--;
  }
  if (src[k] === "r") {
    const terminator = `"${"#".repeat(hashes)}`;
    const end = src.indexOf(terminator, i + 1);
    return end === -1 ? i : end + terminator.length;
  }
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === '"') return j + 1;
  }
  return i;
}

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

  it("scans every Rust source file, not a list written here", () => {
    // The control on the scan itself. `rustSources()` feeding the parity check
    // means an empty or truncated walk satisfies it silently: zero declared
    // codes is zero unhandled codes. This is what makes the walk falsifiable.
    const rel = rustSources().map((f) => f.rel);
    expect(rel.length, "the Rust source walk found almost nothing").toBeGreaterThan(10);
    expect(rel).toContain("src-tauri/src/lib.rs");
    expect(
      rel,
      "the module holding the excluded wire code must be in scope, or its " +
        "exclusion is asserted against text the scan never read",
    ).toContain("src-tauri/src/pending_update.rs");
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

    // ...and a block that genuinely never closes fails loud rather than truncating.
    expect(
      () => stripRustTestModules("#[cfg(test)]\nmod t {\n    fn f() {\n"),
      "an unbalanced block must throw, not silently drop the rest of the file",
    ).toThrow(/ran off the end/);
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
    // `lib.rs` also declares wire codes for OTHER surfaces — #1118's
    // pending-update hint has its own client reader and never reaches
    // `messageForStartupRejection`. Each exclusion has to EARN it below by
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
