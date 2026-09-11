# K-tests — #1855 Five path assertions latent-fragile under an 8.3 short-name temp dir

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
Closes #1855. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe:
`npx vitest run tests/server/export-path-canonicalization.test.ts tests/server/mcp-tool-integration.test.ts`
before and after (unchanged pass locally — see "Establishing reachability" below for why).

## Establishing reachability first (per the issue's own instruction)

Measured directly on this machine before designing anything:

- `whoami` → `desktop-qb8f1uo\blokn`; `$env:USERNAME` = `blokn` (5 characters).
- `$env:TEMP` = `C:\Users\blokn\AppData\Local\Temp` — no `~` segment anywhere in the path. A
  Windows 8.3 alias is only minted for a path COMPONENT whose long name does not already fit the
  8.3 shape (roughly: >8 chars before a `.`, or certain character classes); a 5-character username
  never triggers it, so `%TEMP%`'s own ancestry never gets short-named here.
- `cmd /c "dir /x $env:TEMP"` (lists both long and short names side by side): individual
  `mktemp`-created leaf directories DO get their own 8.3 aliases minted (e.g.
  `tandem-02cufjcu` ↔ `TA83D2~1`), but nothing in the affected test code ever constructs a path
  using that alias — every fixture path is built from `os.tmpdir()` / the raw `mkdtemp()` return
  value, both long-form here, so those unused aliases are inert for this bug.

**Conclusion: NOT reachable on this machine** — matches the issue's own hypothesis exactly ("a
five-character local username mints nothing"). But the issue also names the actual trigger class:
GitHub's `windows-latest` runner authenticates as `runneradmin` (11 characters), which DOES get
shortened to `RUNNER~1`, and `%TEMP%` inherits that in its ancestry — the exact mechanism that
already turned the sibling spec `convert-output-acl-win.test.ts` red on `windows-acl-proof`'s
first CI run (documented in-code at `export-path-canonicalization.test.ts:416-420`, quoted below).
That is not a hypothetical: it is the SAME code path (`convertToMarkdown`'s `fs.realpath` call) in
the SAME file, already proven to fail this exact way once, with the fix already applied to the
sibling spec and left undone on these five. **Verdict: fix it, using the already-proven pattern —
not a ghost, just not reachable from THIS machine today.**

## Problem

Five assertions compare a value the app computed via `fs.realpath()` against a RAW,
non-canonicalized path the test built itself. `path.resolve()` (what the test side implicitly
uses by just joining strings) does not expand an 8.3 short name; `fs.realpath()` (what the app
calls internally before writing) does. Wherever an ancestor of the fixture path carries a short
alias (only `%TEMP%`'s own ancestry can do that here, per above — never the leaf `mktemp` dirs),
the two sides read different strings for the identical file.

Verified against the current implementation (`src/server/mcp/annotations.ts:834-880`,
`src/server/mcp/convert.ts:187-191`) which of the issue's "five" are actually realpath'd, since
only a realpath'd comparison can exhibit this:

1. `tests/server/export-path-canonicalization.test.ts:173` — "accepts a conforming name in an
   arbitrary directory (the positive control)": `expect(body.writtenPath).toBe(out)`, `out` built
   from `makeDir()`'s raw `mkdtemp()` return. `outputPath` is set (explicit), so
   `annotations.ts:844` realpaths it.
2. `tests/server/export-path-canonicalization.test.ts:181` — "accepts a case variant of the
   suffix": same shape, same file.
3. `tests/server/export-path-canonicalization.test.ts:240` — `tandem_convertToMarkdown`
   "converts into a fresh directory at all (the control)": `expect(result.outputPath).toBe(
   path.join(base, "real", ...))`. `convertToMarkdown` ALWAYS realpaths its output directory
   (`convert.ts:191`, unconditional — `outputPath` is required, not optional, for convert).
4. `tests/server/mcp-tool-integration.test.ts` — "honors a custom outputPath" (`#314` describe
   block): `customPath` is built directly under `tmpdir()`, `outputPath` is set → hits
   `annotations.ts`'s realpath branch (the ENOENT sub-branch, since the leaf does not exist yet:
   `:876-879`, which realpaths `path.dirname(sidecarPath)` — i.e. `tmpdir()` itself).
5. `tests/server/mcp-tool-integration.test.ts` — "appends default sidecar filename when
   outputPath is an existing directory": `targetDir` built under `tmpdir()`, exists → hits the
   main realpath branch (`:849`, `real = await fs.realpath(sidecarPath)` where `sidecarPath ===
   path.resolve(targetDir)`).

That totals five, matching the issue's own count, though this group's own read of the issue's file
attribution ("three… (#314)… in file 1" / "the fifth… in file 2") does not match line-for-line —
verified against current source rather than carried forward: `export-path-canonicalization.test.ts`
holds 3 of the 5 (two export "accepts…" cases + the convert control), `mcp-tool-integration.test.ts`
holds 2 (both inside the `#314` describe block, both requiring an explicit `outputPath`). The two
`writes a JSON/markdown sidecar…` cases in that same `#314` block do NOT hit the realpath branch
(no `outputPath` passed → `annotations.ts:834`'s `if (outputPath)` guard at `:844` never runs) and
are correctly excluded from the five.

The already-fixed sibling in the SAME FILE (`export-path-canonicalization.test.ts:416-420`) states
the mechanism explicitly, unprompted:

> Asserting the RAW path instead would pass here and fail wherever the temp base is not already
> canonical — macOS, where `/var/folders` is a symlink … and Windows CI, where `realpath` expands
> the 8.3 alias `C:\Users\RUNNER~1\…`. That mismatch is what turned the Windows twin of this spec
> red on its first CI run.

## Fix

Apply the same pattern already used there: canonicalize via `fs.realpath()` at the point the
fixture directory is CREATED, so every downstream path built from it is already in the form the
app's own `fs.realpath()` call will produce — never build the comparison from the raw
`mkdtemp()`/`tmpdir()` string.

- `export-path-canonicalization.test.ts`'s `makeDir()` (`:57-60`) currently returns the raw
  `mkdtemp()` `base`. Change it to `return fsp.realpath(base);` — one line. This fixes sites 1-3
  (all three build their `out`/expected path from `makeDir()`'s return value), with no per-test
  edits needed. Mirrors `symlinkedDir()`'s existing `realDir = await fsp.realpath(...)` sibling
  three lines above it in the same file.
- `mcp-tool-integration.test.ts`'s `#314` describe block: add a memoized helper
  `async function realTmpdir(): Promise<string> { return fsp.realpath(tmpdir()); }` (or a
  module-level `const REAL_TMPDIR = await fsp.realpath(tmpdir());` if the file's existing
  top-level `await` shape allows it — check the file's current top-level structure before
  choosing) and use it in place of the bare `tmpdir()` call in exactly the two affected tests
  ("honors a custom outputPath" building `customPath`; "appends default sidecar filename…"
  building `targetDir`/`expectedFile`). Leave the OTHER sidecar tests in the same block
  (JSON/markdown/no-outputPath/relative-path/upload-rejection) using the raw `tmpdir()` — they are
  not realpath'd by the app and changing them would be an unrequested, unrelated edit.

## Tests

The fix IS the fix to existing assertions — no new test bodies are added, matching the issue's own
framing ("hardening five assertions" is the wrong shape; canonicalizing the fixture builder is the
right one). What changes is provable by inspection (the comparison now derives both sides from the
same `fs.realpath()` call, so they cannot disagree on an ancestor's casing/short-name/symlink form
regardless of platform) and by the existing sibling spec's own proof (`:416-420`), not by a new
local red→green transition — this machine cannot manufacture the 8.3 condition (see "Establishing
reachability" above), so a claim of a local mutation-test pass here would be theater. State this
plainly in the PR body rather than fabricating a passing-both-ways narrative.

**What IS verifiable locally:** run `npx vitest run tests/server/export-path-canonicalization.test.ts
tests/server/mcp-tool-integration.test.ts` before and after — both must stay fully green (the fix
must not change behavior where the fragility does not manifest, which is every environment this
group can reach). Also confirm `makeDir()`'s new `fsp.realpath()` call does not change the value it
returns on THIS machine (it shouldn't — `fsp.realpath` on an already-canonical path is a no-op) by
diffing `out` before/after in one of the affected tests via a scratch `console.error` during
development, removed before commit.

## Done when

`makeDir()` returns a realpath'd `base`; the two `mcp-tool-integration.test.ts` sites use a
realpath'd tmpdir; both files stay green locally; the PR body states the reachability finding
(unreachable on this dev machine, reachable on `windows-latest`/`runneradmin`, proven once already
by the sibling spec) instead of claiming a local repro; `npm run typecheck:tests` green.

## Not in scope

The two already-realpath'd sibling assertions (`:214`, `:276`) — already correct, untouched. The
other sidecar tests in the `#314` block that never hit the realpath branch — untouched, per above.
Any change to `annotations.ts` / `convert.ts` (this is a test-only fragility, not a source defect —
the app's own realpath call is correct; the TEST's comparison was the bug).
