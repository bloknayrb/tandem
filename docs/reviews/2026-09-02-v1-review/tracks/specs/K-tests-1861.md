# K-tests — #1861 `stripRustComments` is not string-aware

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
Closes #1861. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe: run
`npx vitest run tests/docs/rust-sources.test.ts tests/docs/license-flip-consts.test.ts tests/docs/native-theme-claims.test.ts tests/docs/startup-open-failure-wiring-claims.test.ts tests/docs/tauri-command-registration-claims.test.ts tests/build/cowork-retry-delegates.test.ts tests/build/cowork-subnet-probe-contract.test.ts tests/build/screened-open-path.test.ts`
before and after — the seven real callers of `rustSources()`/`rustSourceDefining`
(`grep -rl "rust-sources" tests/`) plus the new test file this fix adds.

## Problem

`stripRustComments` (`tests/docs/rust-sources.ts:106-108`) strips comments with one regex, with a
narrow `[^:]` exception only for `://` in URLs — not general string-literal awareness. Any other
`//`/`/*` inside a Rust string/raw-string/char literal is treated as a real comment, corrupting the
literal's closing quote; `matchRustBrace` then desyncs and throws `"unbalanced #[cfg(test)] block"`.
The real instance is already worked around in `src-tauri/src/sidecar.rs:3912-3920`
(`concat!("/", "/")` instead of a literal `"//"`).

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

Nested block-comment awareness. Any change to `src-tauri/src/sidecar.rs` (out of `rust=false`
scope for this group — the `concat!("/", "/")` workaround remains correct and is left as-is; a
future Rust-touching PR could simplify it, noted for `bryan` as a one-line, non-blocking heads-up,
not a tracked deferral).

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
