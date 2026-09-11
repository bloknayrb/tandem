# K-tests — #1861 `stripRustComments` is not string-aware

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
Closes #1861. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe: run
`npx vitest run tests/docs/rust-sources.test.ts tests/docs/license-flip-consts.test.ts tests/docs/native-theme-claims.test.ts tests/docs/startup-open-failure-wiring-claims.test.ts tests/docs/tauri-command-registration-claims.test.ts tests/build/cowork-retry-delegates.test.ts tests/build/cowork-subnet-probe-contract.test.ts tests/build/screened-open-path.test.ts`
before and after (the **seven real, current** callers of `rustSources()`/`rustSourceDefining` —
`grep -rl "rust-sources" tests/` returns exactly those seven files, one more than the issue's "six
suites" — plus the new `tests/docs/rust-sources.test.ts` this fix adds, which is the eighth item in
the command above and did not exist before this PR). **`tests/docs/tauri-command-registration-claims.test.ts`
was missing from round-0's probe line** — it is the caller most likely to react to a widened `code`
view (see "Tests" below) and is now included.

## Problem

`stripRustComments` (`tests/docs/rust-sources.ts:106-108`) strips comments with a single regex
BEFORE any brace counting happens elsewhere in the file:

```ts
export function stripRustComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
```

The `[^:]` exception exists only to dodge `://` inside a URL literal (`"https://example.com"`) —
it is not general string-literal awareness. Any OTHER `//` or `/*` inside a Rust string or raw
string literal (not immediately preceded by `:`) is treated as a real comment start and everything
from there to end-of-line (or to the next `*/` for a block comment) is deleted, including the
literal's closing quote. Once the string is corrupted this way, `stripRustTestModules` /
`testItemEnd` / `matchRustBrace` (same file, `:170-270`) desynchronize on unmatched braces and
`matchRustBrace` throws `"unbalanced #[cfg(test)] block: the brace scanner ran off the end of the
input"` — taking down every one of the seven suites built on `rustSources()`, none of them near the
line that triggered it.

**The real instance** (already worked around, `src-tauri/src/sidecar.rs:3912-3920`): a
`#[cfg(test)]` guard added in #1847 needed to assert a `log::warn!` call is not commented out, and
originally spelled the marker as a literal Rust string `"//"`. That broke exactly as above. The
workaround in place today is `concat!("/", "/")`, so the two-character sequence never appears as a
string literal in source, with a comment naming `tests/docs/rust-sources.ts` and the mechanism.

**The wave-table's named twin is a DIFFERENT bug, not the same one.** #1968 (`f328d7cf`) added a
second workaround in the same file's `crash_restart_tests` helper (`sidecar.rs:2916-2919`):
`.filter(|l| !l.trim_start().starts_with('/'))` instead of `.starts_with("//")`. Its own comment
says why: `"//"` there was a false positive for `tests/shared/unc-check-duplication.test.ts`'s
`RAW_PREFIX` regex (`/\.starts_?[wW]ith\(\s*r?"(?:\\\\|\/\/)/`), which matches the raw SOURCE TEXT
of `unc-check-duplication.test.ts` directly via `readFileSync` (`walkSource`, that file's
`:170-172`) — it never calls `stripRustComments` or `rustSources()` at all. **Verified: this
workaround is NOT removable by fixing `stripRustComments`.** `unc-check-duplication.test.ts` is a
spelling-detector for hand-rolled UNC prefix checks (`.starts_with("//` / `.starts_with("\\\\`) and
would still flag a literal `.starts_with("//")` in `sidecar.rs` regardless of how
`tests/docs/rust-sources.ts` strips comments — the two mechanisms scan different things for
different reasons. `sidecar.rs:2916-2919`'s comment already states this correctly; it stays as-is.
This is `src-tauri/src/` (Rust production/test source), which this group's flags mark `rust=false`
and which K-tests does not own — no code change there either way.

## Fix

Rewrite `stripRustComments` to be literal-aware by reusing `skipRustLiteral` — the same-file
helper (`tests/docs/rust-sources.ts:280-313`) already used by `matchRustBrace` and `testItemEnd`,
which correctly finds the end of a plain string (`"…"`, backslash-escaped), a char literal (`'x'`,
with lifetime disambiguation), a raw string (`r"…"`, `r#"…"#`) and a byte/raw-byte string
(`b"…"`, `br"…"`, `br#"…"#`) by looking backward from the opening quote for `r`/`#` prefixes. It
requires no changes itself beyond one docblock sentence (see below) — this fix adds a **third**
caller, not a second: `testItemEnd` and `matchRustBrace` already call it.

`skipRustLiteral`'s own docblock (`:274-277`) currently states a precondition this fix breaks for
its new caller: "Comments are already gone — `stripRustComments` runs first — so only literals can
hide a brace." After this fix, `stripRustComments` itself calls `skipRustLiteral` on raw source
that STILL contains comments. The resulting behaviour is safe — inside `stripRustComments`'s own
loop the `//`/`/*` branches are checked and fire before any quote reached inside an actual comment
is ever examined, so a comment is never misread as containing a literal — but the docblock's
stated invariant no longer holds for this caller and must say so, or the next reader trusts a
precondition one of the two callers doesn't meet. Add one sentence to `skipRustLiteral`'s docblock
in the same diff: it has two callers now; for `stripRustComments`, comments are NOT yet gone when
it runs — safety comes from the `//`/`/*` branches firing first in that caller's own loop, not from
this function's input already being comment-free.

New `stripRustComments`, character-by-character instead of regex-based:

```ts
export function stripRustComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const after = skipRustLiteral(src, i);
      if (after > i) {
        out += src.slice(i, after);
        i = after;
        continue;
      }
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
```

Behaviour preserved exactly where the old version was already correct: a line comment strips to
(not including) the newline; a block comment strips including any newlines inside it (matching
`[\s\S]*?` — no attempt at nested-comment awareness, same limitation as before, not requested by
this issue). Behaviour that changes: any `"…"`/`'…'`/`r"…"`/`r#"…"#`/`b"…"` literal is now copied
verbatim regardless of what it contains, so the ad hoc `[^:]` URL exception is no longer needed —
delete it; a literal genuinely containing `://` is now handled correctly as a byproduct of general
literal-awareness rather than a special case for that one shape. `skipRustLiteral`'s lifetime
disambiguation (`'a` vs `'x'`) means a bare lifetime after a real comment marker (e.g.
`//! some 'lifetime note`) is unaffected — only reached once the `//`/`/*` branch has already fired
first in the loop, same order as before.

No change to `stripRustTestModules`, `nextTestCfg`, `testItemEnd`, `matchRustBrace`,
`skipRustLiteral`, or `rustSourceDefining` — this issue's fix is scoped to `stripRustComments`
alone, per the issue body ("Make `stripRustComments` string-literal aware").

## Tests

New file `tests/docs/rust-sources.test.ts` (first standalone test for this shared module —
today it has zero direct tests, only indirect coverage through the seven callers).

1. `does not treat // inside a string literal as a comment` — `'let s = "not // a comment";
   // real comment\nlet t = 1;\n'` → output contains the string verbatim, does NOT contain "real
   comment", still contains `let t = 1;`. Kills the old `[^:]`-only guard (fires because the `//`
   here is NOT preceded by `:`).
2. `does not treat // inside a raw string literal as a comment` — same shape with `r"…"` and
   `r#"…"#`, including one with an embedded `"` (`r#"nor "// this" one"#`). Kills a fix that only
   special-cased plain `"…"` and forgot raw strings (the issue's own explicit ask).
3. `does not treat /* inside a string literal as a block-comment opener` — `'let s = "look /* not
   a comment */ end"; h();\n'` → string preserved, `h();` survives. Kills a fix that only handled
   `//` and not `/*`.
4. `still strips real line and block comments` — positive control: `"// header\nfn f() {/* block
   */ g(); }\n"` → neither "header" nor "block" survive, `fn f() {` and `g();` do. Without this,
   a stripper that copies EVERYTHING (never strips) would pass tests 1-3 vacuously.
5. **The regression itself, run through the full pipeline** — reproduces the issue's own reported
   failure by combining `stripRustComments` with `stripRustTestModules` (both already exported).
   **The fixture must place a string literal AFTER the malformed module, not only inside it** —
   verified directly (round-1 review): a fixture that ends with the corrupted-comment module
   itself (e.g. `mod tests { const LINE_COMMENT: &str = "//"; fn t() { assert!(true); } }` packed
   onto one physical line, immediately followed by `fn after() {}`) throws under the *old*
   stripper only when the module body is single-line; written the way a real Rust fixture is
   normally formatted — multi-line — the dangling open quote left by the old regex's line-comment
   strip has no later `"` in the file to consume, `matchRustBrace`'s own `skipRustLiteral` call
   sees a non-literal (`after === i`) and falls through as an ordinary character, and the brace
   count for `mod tests { … }` closes cleanly — **no throw, and the already-broken pipeline
   silently returns a value**, which is a worse failure to build a "kills the regression" test on
   than the one the issue reported (measured directly: `stripRustTestModules(stripRustComments(
   multilineFixture))` on the old code returns `"\nfn after() {}\n"` with no error). Use a fixture
   where the corrupting `"//"` sits inside an array of strings *inside* the module and a
   **second, top-level item follows the module**, so the swallowed quote necessarily eats the
   module's own closing brace regardless of line layout:
   ```ts
   const src =
     "#[cfg(test)]\n" +
     "mod tests {\n" +
     '  const V: [&str; 2] = ["//x", "y"];\n' +
     "}\n" +
     'pub const AFTER_FLAG: &str = "value";\n' +
     "fn after() {}\n";
   ```
   Before the fix this throws `"unbalanced #[cfg(test)] block: the brace scanner ran off the end
   of the input"` (the exact error the issue quotes) — verified directly, reliably regardless of
   line-wrapping, because the trailing top-level item's own string literal is what the corrupted
   scan consumes. After the fix, `stripRustTestModules(stripRustComments(src))` returns
   `"\npub const AFTER_FLAG: &str = \"value\";\nfn after() {}\n"` — verified directly — containing
   `AFTER_FLAG` and `fn after()`, not containing `mod tests`.
6. **Real-crate positive control — the silent-hollowing direction, not the loud-throw one.**
   `rustSourceDefining(/pub\(crate\)\s+fn\s+is_autostart_launch\s*\(/, "is_autostart_launch").rel`
   must equal `"src-tauri/src/autostart.rs"`. Verified directly (round-1 review) this is **red on
   `origin/master` today** — the old stripper's `code` view for `autostart.rs` is 5334 chars and
   is missing `is_autostart_launch`, `resolve_autostart_launch`, `should_start_hidden`,
   `autostart_seen_and_mark`, `AUTOSTART_FLAG`, `AUTOSTART_DISABLE_ENV` and `use
   crate::has_argv_flag;` entirely (all of `autostart.rs:591-671`, between its two `#[cfg(test)]`
   blocks at `:339` and `:671`) — and **green after the fix** (6562 chars, +1228). This is the
   only test in the set that pins the direction that actually matters in production: tests 1-5 all
   pin the *loud* failure (a thrown error); this pins the *silent* one (a hollowed `code` view that
   satisfies every assertion built on it by finding nothing), which is the failure mode
   `rustSourceDefining`'s own docblock calls "worse than finding nothing because it still reports
   a pass."

**Mutation test (per the group's wave-7 lesson — inverted, since this bug fails loudly rather
than silently):** revert `stripRustComments` to the pre-fix regex body from a saved file copy
(never `git checkout`), re-run `tests/docs/rust-sources.test.ts` — tests 1, 2, 3, 5 and 6 must go
red (2 does not throw the module-level error the old regex form did, since raw strings aren't
matched by `(^|[^:])\/\/`'s `://`-exception logic at all — verify test 2's own failure mode
matches "corrupted string content", not necessarily a thrown error; test 6 goes red because it
asserts the real-crate `autostart.rs` result the fixed code produces, which the reverted code
cannot); restore from the saved copy. Then re-run the eight probe-line suites — confirm the six
that never read `autostart.rs`/`lib.rs` are unaffected, and record in the PR body the measured,
non-hypothetical delta for the two that do: `autostart.rs`'s `code` view grows from 5334 to 6562
chars (the seven items named above reappear) and `lib.rs`'s grows by 2 chars; `#[tauri::command]`-
tagged function names are unchanged old-vs-new crate-wide (verified directly), so no *existing*
caller's assertion result flips — but `tauri-command-registration-claims.test.ts` is the caller
whose mechanism (a full-crate `code` scan for `#[tauri::command]`) is exercised by this widening
even though its result does not change today, which is why it belongs in the probe line
regardless of whether it flips.

## Done when

`tests/docs/rust-sources.test.ts` exists (six fixture-based tests plus the real-crate positive
control) and passes; the mutation above is performed and both directions recorded in the PR body;
the seven *existing* callers of `rustSources()`/`rustSourceDefining` — including
`tauri-command-registration-claims.test.ts` — still pass unchanged; `npm run typecheck:tests`
green; the PR body states, with the evidence above, that the `f328d7cf` workaround
(`sidecar.rs:2916-2919`, `starts_with('/')`) is NOT removable by this fix and why (different
detector, different file, no call to `stripRustComments`); and that the `concat!("/", "/")`
workaround (`sidecar.rs:3912-3920`) is the issue's own "real instance" and — while it now WOULD be
safe to revert to a literal `"//"` — that revert is left undone because it touches
`src-tauri/src/sidecar.rs` (Rust source, `rust=false` for this group, not owned by K-tests).

**This is a cosmetic suggestion, not remaining work against #1861**: #1861's own scope is making
`stripRustComments` string-literal aware, which this PR completes in full (verified: the fix is
implemented, tested, and mutation-checked). Reverting `concat!("/", "/")` to a literal `"//"` in
`sidecar.rs` is optional legibility polish that this fix *enables* but does not *require* — nothing
about `stripRustComments`'s correctness or #1861's own acceptance criteria depends on it. Per the
group's derived-`Closes` rule, that distinction is what keeps `Closes #1861` valid: flag the
revert in `bryan` as a one-line note for a future Rust-touching PR to pick up opportunistically,
not as a tracked deferral or a carve-out issue — there is no follow-up work item here to file.

## Not in scope

Nested block-comment awareness (not requested, and the old regex never had it either). Any change
to `sidecar.rs` (Rust source — see above). Widening `stripRustComments`'s callers or promoting
`tests/docs/rust-sources.ts` out of `tests/docs/`.

## Review corrections (round 1)

**Adopted:**
- Test 5's fixture was non-discriminating as originally specified when written the way a real
  fixture is normally formatted (multi-line): verified directly — the old stripper does NOT throw
  on a multi-line `mod tests { … "//" … }` + `fn after() {}` fixture, silently returning a value
  instead. Replaced with a fixture carrying a string literal on a top-level item AFTER the
  malformed module, verified to throw before the fix and produce the expected output after,
  regardless of line-wrapping.
- Added test 6, a real-crate positive control (`rustSourceDefining` resolving `is_autostart_launch`
  to `autostart.rs`) — verified red on `origin/master` today and green after the fix, with the
  exact measured delta (5334 → 6562 chars, +1228, seven named production items). This is the only
  test that pins the silent-hollowing direction rather than the loud-throw direction.
- The probe/"seven callers" list was missing `tests/docs/tauri-command-registration-claims.test.ts`
  — added to the probe command and to "Done when". Verified: `grep -rl "rust-sources" tests/`
  returns exactly seven files, that one included.
- The "byte-identical before and after" prediction was measurably false — corrected to the measured
  delta above, with `lib.rs` (+2 chars) also noted.
- `skipRustLiteral` gains a third caller, not a second (`testItemEnd` and `matchRustBrace` already
  call it) — fixed the count and added the one-sentence docblock update recording that, for
  `stripRustComments`, comments are not yet gone when it runs (safety comes from branch order, not
  from the precondition the docblock previously stated unconditionally).
- The `sidecar.rs` `concat!("/", "/")` revert, deferred to a `bryan` note with no issue number, is
  now explicitly stated as cosmetic polish carrying no work item against #1861 — not an unfiled
  deferral — so `Closes #1861` stays correct under the group's derived-`Closes` rule.

**Not adopted:** none — all findings touching this spec were adopted as described above.
