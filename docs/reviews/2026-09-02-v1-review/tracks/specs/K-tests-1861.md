# K-tests — #1861 `stripRustComments` is not string-aware

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
Refs #1861 (partial — issue stays open: this fix also files #1970 for a stale comment
it leaves behind, see below, so per wave-7 lesson 1 #1861 itself cannot go under
`## Closes`). Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe: run
`npx vitest run tests/docs/rust-sources.test.ts tests/docs/license-flip-consts.test.ts tests/docs/native-theme-claims.test.ts tests/docs/startup-open-failure-wiring-claims.test.ts tests/docs/tauri-command-registration-claims.test.ts tests/build/cowork-retry-delegates.test.ts tests/build/cowork-subnet-probe-contract.test.ts tests/build/screened-open-path.test.ts`
before and after — the seven real callers of `rustSources()`/`rustSourceDefining`
(`grep -rl "rust-sources" tests/`) plus the new test file this fix adds.

## Problem

`stripRustComments` (`tests/docs/rust-sources.ts:106-108`) strips comments with one regex, with a
narrow `[^:]` exception only for `://` in URLs — not general string-literal awareness. Any other
`//`/`/*` inside a Rust string/raw-string/char literal is treated as a real comment, corrupting the
literal's closing quote, and the damage downstream splits into **two directions depending on where
in the file the corrupted quote lands**, not one:

1. **Throws**, when a dangling quote leaves `matchRustBrace` running off the end of the input —
   `"unbalanced #[cfg(test)] block"`. This is the direction the code comment at
   `src-tauri/src/sidecar.rs:3912-3920` names, and it is real for some inputs.
2. **Silently truncates**, when the corrupted region is followed by enough further text for the
   brace/terminator scanners to accidentally re-synchronize on *something* before end-of-file —
   whatever sits between the corruption and that accidental resync point vanishes from the `code`
   view with no error. **This is the live instance today, not a hypothetical**: measured directly
   against `src-tauri/src/autostart.rs` on current `master` (`rustSources()`'s
   `code = stripRustTestModules(stripRustComments(text))`), the OLD `stripRustComments` yields a
   5334-character `code` view; the fixed version below yields 6562. The 1228-character gap is
   `use crate::has_argv_flag;`, `AUTOSTART_FLAG`, `AUTOSTART_DISABLE_ENV`, `is_autostart_launch`,
   `resolve_autostart_launch`, `should_start_hidden`, `AUTOSTART_SEEN_MARKER` and
   `autostart_seen_and_mark` — all absent from every `rustSources()`-based guard today, silently,
   with no test failure pointing at it. The trigger is the literal string
   `"//fileserver/tools/Tandem/tandem.exe"` inside `mod tests` (`autostart.rs:456`): the regex
   treats the `//` after the opening quote as a comment start, and `stripRustTestModules`'s
   terminator search (already literal-aware via `skipRustLiteral`, independent of this bug)
   resynchronizes on the *next* module's closing brace instead of throwing.

The real instance the sidecar.rs comment names is already worked around there
(`concat!("/", "/")` instead of a literal `"//"`) — but that comment's own claim that this "fails
loudly rather than silently, so this is a landmine and not a hole" is the direction-1-only framing;
`autostart.rs` above is a live counterexample already on `master`. The comment is addressed as a
separate, filed issue rather than edited in this PR — see Not in scope.

**Not the same bug as #1968's `sidecar.rs:2916-2919` workaround** (`.starts_with('/')` instead of
`"//"`) — that one exists because `tests/shared/unc-check-duplication.test.ts` matches raw source
text directly (never calls `rustSources()`), so it is unaffected by this fix and stays as-is. Out
of scope either way (`src-tauri/`, `rust=false` for this group).

## Fix

Rewrite `stripRustComments` to be literal-aware by reusing `skipRustLiteral`
(`tests/docs/rust-sources.ts:280-313`, already used by `matchRustBrace`/`testItemEnd`), scanning
character-by-character instead of with one regex:

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

The ad hoc `[^:]` URL exception is deleted — general literal-awareness supersedes it. Update
`skipRustLiteral`'s docblock (`:274-277`): it now has a **second caller for which comments are not
yet gone when it runs** (`stripRustComments` itself) — safety there comes from the `//`/`/*`
branches firing first in the loop, not from the stated precondition. No other function changes.

## Tests

New `tests/docs/rust-sources.test.ts`:

1. `//` inside a plain string literal is not treated as a comment.
2. `//` inside a raw string literal (`r"…"`, `r#"…"#`, including an embedded `"`) is not treated
   as a comment.
3. `/*` inside a string literal does not open a block comment.
4. Positive control — real line and block comments still strip.
5. **The regression itself.** The fixture must place a string literal on a top-level item *after*
   the malformed `#[cfg(test)]` module, or the dangling quote has nothing later to consume and the
   old code silently returns a value instead of throwing:
   ```ts
   const src =
     "#[cfg(test)]\nmod tests {\n" +
     '  const V: [&str; 2] = ["//x", "y"];\n' +
     '}\npub const AFTER_FLAG: &str = "value";\nfn after() {}\n';
   ```
   Verified: before the fix this throws `"unbalanced #[cfg(test)] block…"`; after the fix,
   `stripRustTestModules(stripRustComments(src))` contains `AFTER_FLAG` and `fn after()`, not
   `mod tests`.

**Mutation check** (per wave-7 lesson 5, inverted since this bug fails loudly): revert
`stripRustComments` from a saved file copy, confirm tests 1-3 and 5 go red, restore. Then confirm
the seven existing callers still pass — `autostart.rs` and `lib.rs` are the two files in the corpus
holding this shape (a literal `"//"` inside a `#[cfg(test)]` module followed by more production
code), so their `rustSourceDefining` `code` view legitimately widens; no *existing* caller's
assertion result flips, verified directly.

## Done when

`tests/docs/rust-sources.test.ts` exists and passes; the mutation check is performed; the seven
existing callers (including `tauri-command-registration-claims.test.ts`, missing from an earlier
probe draft) still pass unchanged; `npm run typecheck:tests` green.

## Not in scope

Nested block-comment awareness. Any change to `src-tauri/src/sidecar.rs` — out of `rust=false`
scope for this group, and out of a `docs(specs)`-only planning pass either way.

**Corrected (code review, general-purpose-4): the `concat!("/", "/")` workaround is removable,
and the "stays necessary regardless" claim above was wrong.** It named the wrong site as the
reason to keep it. `tests/shared/unc-check-duplication.test.ts`'s `RAW_PREFIX` is
`/\.starts_?[wW]ith\(\s*r?"(?:\\\\|\/\/)/` — it only matches a `.starts_with(`/`.startWith(` call
whose literal argument opens with `\\` or `//`. The `concat!` site
(`sidecar.rs:3920`, used at `:3922` as `!src[..].contains(LINE_COMMENT)`) is a `.contains(...)`
call, not `.starts_with(...)` — rewriting `LINE_COMMENT` to a plain `"//"` literal would not match
`RAW_PREFIX` under any reading, so it is not "the same detector, different site" as #1968's real
`.starts_with('/')` workaround at `sidecar.rs:2919`; those two are unrelated hazards that happen
to sit near each other in the same test module. Grepped `tests/` for every other reference to
`sidecar.rs`: `supervisor.test.ts` and `platform.test.ts` both cite it only in doc comments,
neither reads its raw text. So once `stripRustComments` is string-aware (this fix), nothing left
in the repo would corrupt on a plain `"//"` at that site — the workaround's entire stated purpose
(protecting `rustSources()`'s scan of `sidecar.rs` itself, which the `concat!` comment names
explicitly) is gone, with no second reason standing behind it. **What is stale is therefore not
just the comment's own claim** ("fails loudly rather than silently... a landmine and not a hole"
— falsified in both halves by this fix, as before) **but the workaround's own necessity.** Filed as
**#1970** rather than left as an in-PR heads-up, per wave-7 lesson 3 (no unfiled deferrals); #1970
is corrected with this same evidence (see its follow-up comment) so a future Rust-touching PR
reads the right answer there too.

## Review corrections (scope cut)

- Removed the round-1 "Test 6" real-crate positive control on `autostart.rs` (asserting exact
  before/after character counts) — not requested by #1861, which scopes the fix to
  `stripRustComments` itself. The seven existing callers already exercise the widened `code` view;
  no new pin is needed to catch a regression there.
- Removed the multi-paragraph mutation-test essay (exact byte deltas, per-file breakdown) in favor
  of the single Mutation check paragraph above — the discriminating tests already prove the fix.
- Kept the probe-command correction (added `tauri-command-registration-claims.test.ts`) and the
  correction to the false "byte-identical" prediction — both are direct fixes to the spec's own
  probe line, not new machinery.
- Findings about the probe list and Test 5's fixture are fixed directly above, not via added
  scaffolding.

## Review corrections (post-cut)

- **Problem statement corrected from one-directional to two-directional, with the live direction
  verified rather than asserted.** The prior text described only the throw: a corrupted quote
  desyncs `matchRustBrace` and raises `"unbalanced #[cfg(test)] block"`. Verified directly in this
  worktree (`stripRustTestModules(stripRustComments(text))` run against
  `src-tauri/src/autostart.rs` on current `master`, both with the old regex-based
  `stripRustComments` and with the fixed character-scanning version above): the OLD code view is
  5334 characters and silently drops eight production symbols
  (`has_argv_flag`/`AUTOSTART_FLAG`/`AUTOSTART_DISABLE_ENV`/`is_autostart_launch`/
  `resolve_autostart_launch`/`should_start_hidden`/`AUTOSTART_SEEN_MARKER`/`autostart_seen_and_mark`)
  with no error raised; the fixed code view is 6562 characters and contains all eight. This is the
  silent-truncation direction, not the throw, and it is live on `master` today — not a hypothetical
  third case. The Problem section above now states both directions and carries these measured
  numbers.
- **The `src-tauri/src/sidecar.rs:3912-3920` comment is stale in both of its own claims once this
  fix lands** ("that regex is not string-aware" — the fix isn't a regex at all; "fails loudly
  rather than silently... a landmine and not a hole" — already false pre-fix per the measurement
  above). Rather than leave it as an unfiled in-PR heads-up (which the round-1/scope-cut spec did,
  and which wave-7 lesson 3 forbids), filed **#1970** to track the comment rewrite as a separate,
  comment-only `src-tauri/` change — out of both this group's `rust=false` budget and this pass's
  `docs(specs)`-only scope. Per wave-7 lesson 1 (mechanical, not a judgement call), filing a
  carve-out from #1861 means #1861 itself moves from `## Closes` to
  `## Refs (partial — issue stays open)`. The header and Not-in-scope section above are updated to
  match.
- Verified the fix's own no-flip claim directly rather than carrying it forward: `autostart.rs`'s
  restored region (between its two `#[cfg(test)]` modules, where the eight symbols above surface)
  contains no `#[tauri::command]` (the file's only two occurrences are both above line 339, well
  before the test module that trips the bug) and no `const CODE_[A-Z_]+: &str = "…"` pattern, so
  `tauri-command-registration-claims.test.ts` and `startup-open-failure-wiring-claims.test.ts` are
  unaffected by the widened `code` view — consistent with all seven existing-caller probe files
  passing unchanged against current `master` before this fix is applied.
