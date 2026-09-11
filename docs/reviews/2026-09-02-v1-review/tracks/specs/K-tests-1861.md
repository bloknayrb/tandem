# K-tests — #1861 `stripRustComments` is not string-aware

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
Closes #1861. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe: run
`npx vitest run tests/docs/rust-sources.test.ts tests/docs/license-flip-consts.test.ts tests/docs/native-theme-claims.test.ts tests/docs/startup-open-failure-wiring-claims.test.ts tests/build/cowork-retry-delegates.test.ts tests/build/cowork-subnet-probe-contract.test.ts tests/build/screened-open-path.test.ts`
before and after (the seven current callers of `rustSources()`/`rustSourceDefining` — one more
than the issue's "six suites", confirmed by `grep -rl "rust-sources" tests/`).

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
requires no changes itself — this fix only adds a second caller.

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
   failure by combining `stripRustComments` with `stripRustTestModules` (both already exported):
   a `#[cfg(test)] mod tests { … const LINE_COMMENT: &str = "//"; … }` fixture followed by
   `fn after() {}`. Before the fix this throws `"unbalanced #[cfg(test)] block: the brace scanner
   ran off the end of the input"` (the exact error the issue quotes) because
   `stripRustComments` deletes the module's own closing `}` along with the rest of that line.
   After the fix, `stripRustTestModules(stripRustComments(src))` returns a string containing
   `fn after() {}` and not containing `mod tests`.

**Mutation test (per the group's wave-7 lesson — inverted, since this bug fails loudly rather
than silently):** revert `stripRustComments` to the pre-fix regex body from a saved file copy
(never `git checkout`), re-run `tests/docs/rust-sources.test.ts` — tests 1, 2, 3 and 5 must go
red (2 does not throw the module-level error the old regex form did, since raw strings aren't
matched by `(^|[^:])\/\/`'s `://`-exception logic at all — verify test 2's own failure mode
matches "corrupted string content", not necessarily a thrown error); restore from the saved copy.
Then re-run the seven caller suites named in the probe line — confirm they are unaffected (no
suite in the repo currently contains the specific `//`-inside-a-string-not-preceded-by-`:` shape
outside the new fixtures, so their `.code` output should be byte-identical before and after; if
any differs, that is new information to record in the PR body, not a reason to revert).

## Done when

`tests/docs/rust-sources.test.ts` exists and passes; the mutation above is performed and both
directions recorded in the PR body; the seven existing callers of `rustSources()` /
`rustSourceDefining` still pass unchanged; `npm run typecheck:tests` green; the PR body states,
with the evidence above, that the `f328d7cf` workaround (`sidecar.rs:2916-2919`,
`starts_with('/')`) is NOT removable by this fix and why (different detector, different file, no
call to `stripRustComments`) — and that the `concat!("/", "/")` workaround
(`sidecar.rs:3912-3920`) is the issue's own "real instance" and — while it now WOULD be safe to
revert to a literal `"//"` — that revert is left undone because it touches
`src-tauri/src/sidecar.rs` (Rust source, `rust=false` for this group, not owned by K-tests); flag
it in `bryan` as a trivial legibility cleanup for a Rust-touching PR to pick up, not a defect.

## Not in scope

Nested block-comment awareness (not requested, and the old regex never had it either). Any change
to `sidecar.rs` (Rust source — see above). Widening `stripRustComments`'s callers or promoting
`tests/docs/rust-sources.ts` out of `tests/docs/`.
