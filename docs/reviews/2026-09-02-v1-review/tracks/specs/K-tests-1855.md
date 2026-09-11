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
five-character local username mints nothing"). The issue also names the actual trigger class:
GitHub's `windows-latest` runner authenticates as `runneradmin` (11 characters), which DOES get
shortened to `RUNNER~1`, and `%TEMP%` inherits that in its ancestry — the exact mechanism that
already turned the sibling spec `convert-output-acl-win.test.ts` red on `windows-acl-proof`'s
first CI run (documented in-code at `export-path-canonicalization.test.ts:416-420`, quoted below).
That is the SAME code path (`convertToMarkdown`'s `fs.realpath` call) in the SAME file, already
proven to fail this exact way once — but **that proof does not transfer to these five sites the
way round-0 of this spec claimed.** Verified directly (round-1 review): `check` — the only job
that runs `npm test` — is `runs-on: ubuntu-latest` (`.github/workflows/ci.yml:317`), and
`windows-acl-proof` (`:168`) runs only `scripts/ci/windows-acl-proof.mjs`, whose
`WINDOWS_ACL_PROOF_SPECS` (`:63-81`) is exactly three files: `doc-backup-acl-repair.test.ts`,
`integrations/acl-win.test.ts`, `convert-output-acl-win.test.ts`. Neither
`export-path-canonicalization.test.ts` nor `mcp-tool-integration.test.ts` — the two files holding
all five sites below — is in that list, or run by any other Windows or macOS CI job. The sibling's
proof is real for the sibling; it is not evidence that these five are exercised anywhere in CI.

**Verdict: fix it anyway, using the already-proven pattern — but as unverified hardening, not as
a CI-proven fix.** It is reachable only on a developer machine whose `%TEMP%` ancestry carries a
short-named component (a long username, or a corporate imaging tool that does), or if these two
suites are ever added to a Windows CI job — neither of which is true today or proven by anything
in this repo's CI. The fix is still correct and cheap (both sides of each comparison now derive
from the same `fs.realpath()` call, so they cannot disagree by construction), but the PR body must
say plainly that it lands unverified by any green CI leg, not "proven by the sibling."

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

Apply the same pattern already used by the sibling spec: canonicalize via `fs.realpath()` at the
point the fixture directory is used to build an EXPECTED value, so the comparison's two sides are
derived from the same `fs.realpath()` call the app itself makes — never compare against the raw
`mkdtemp()`/`tmpdir()` string. **Do this additively, not by changing the shared `makeDir()`
helper** (see the round-1 correction below for why: `makeDir()` has 14 call sites in this file, not
3, and two of its other callers — `:326-338` and `:413-450` — depend specifically on the base it
returns being NON-canonical, to pin the opposite direction of the same bug class).

- `export-path-canonicalization.test.ts`: add a second helper next to `makeDir()` (`:57-60`),
  ```ts
  async function makeCanonicalDir(): Promise<string> {
    return fsp.realpath(await makeDir());
  }
  ```
  and use it ONLY in the three affected tests (`:173`, `:181`, `:240` — the two "accepts…" export
  cases and the convert "into a fresh directory" control) in place of the bare `makeDir()` call
  when building the expected/`out` path. `makeDir()` itself is untouched, so every other call site
  — including `:326` and `:413` — keeps depending on an ambiently non-canonical temp base exactly
  as it does today. Mirrors `symlinkedDir()`'s existing `realDir = await fsp.realpath(...)` shape
  three lines above `makeDir()` in the same file.
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

The fix to the three named `export-path-canonicalization.test.ts` sites and the two
`mcp-tool-integration.test.ts` sites is the fix to existing assertions — no new test bodies for
those five, matching the issue's own framing ("hardening five assertions" is the wrong shape;
canonicalizing the comparison is the right one). What changes is provable by inspection (the
comparison now derives both sides from the same `fs.realpath()` call, so they cannot disagree on
an ancestor's casing/short-name/symlink form regardless of platform) and by the existing sibling
spec's own proof (`:416-420`) for the MECHANISM — not, per the corrected reachability finding
above, by any CI leg that actually runs these two files, which none does. State that plainly in
the PR body: **this lands as unverified hardening, correct by construction, not proven by a green
leg** — neither this machine nor any Windows/macOS CI job can manufacture the 8.3 condition.

**One new regression pin, so the fix is not entirely unexercised anywhere `check` runs (round-1
addition):** add one POSIX-gated test to `export-path-canonicalization.test.ts` that manufactures a
non-canonical ancestor deliberately, using the file's own existing precedent
(`symlinkedDir()`, `:48-55`, which already builds a symlinked base for a different test) — assert
that a path built through `makeCanonicalDir()` equals `fsp.realpath()` of the same directory built
through the raw, non-canonical `symlinkedDir()`-style base. This runs on `check` (ubuntu) today and
fails if `makeCanonicalDir()` is ever reverted to returning its argument unchanged, giving the fix
one real, CI-exercised discriminator even though it cannot reproduce the Windows 8.3 mechanism
itself. Windows CI running an `icacls`-based equivalent is a separate, out-of-scope addition (it
would require adding these files to `WINDOWS_ACL_PROOF_SPECS` — a new gate, not requested by #1855).

**What IS verifiable locally:** run `npx vitest run tests/server/export-path-canonicalization.test.ts
tests/server/mcp-tool-integration.test.ts` before and after — all tests in both files, including
`:326` and `:413` (which must NOT start passing vacuously — see the round-1 correction below), must
stay fully green (the fix must not change behavior where the fragility does not manifest, which is
every environment this group can reach). Also confirm `makeCanonicalDir()`'s `fsp.realpath()` call
does not change the value it returns on THIS machine (it shouldn't — `fsp.realpath` on an
already-canonical path is a no-op) by diffing the built path before/after in one of the three
affected tests via a scratch `console.error` during development, removed before commit.

## Done when

`makeCanonicalDir()` exists alongside the untouched `makeDir()` and is used at the three named
sites; the two `mcp-tool-integration.test.ts` sites use a realpath'd tmpdir; the new POSIX-gated
regression pin exists and passes on `check`; `:326` and `:413` are confirmed to still build from a
NON-realpath'd base (i.e. still discriminate against a `convert.ts` that stops realpathing) after
the change; both files stay green locally; the PR body states the corrected reachability finding —
unreachable on this dev machine, and not exercised by ANY Windows or macOS CI leg today either (the
sibling's proof does not transfer to these five sites) — instead of claiming CI verification;
`npm run typecheck:tests` green.

## Not in scope

The two already-realpath'd sibling assertions (`:214`, `:276`) — already correct, untouched. The
other sidecar tests in the `#314` block that never hit the realpath branch — untouched, per above.
Any change to `annotations.ts` / `convert.ts` (this is a test-only fragility, not a source defect —
the app's own realpath call is correct; the TEST's comparison was the bug). Adding these two spec
files to `WINDOWS_ACL_PROOF_SPECS` or any other new Windows CI job — a real gate for this class of
bug is worth having but is a new-gate decision outside this issue's smallest-change budget.

## Review corrections (round 1)

**Adopted:**
- Editing the shared `makeDir()` directly would have silently destroyed the discriminating power
  of two sibling tests in the same file (`:326-338`, `:413-450`), which depend on `makeDir()`
  returning a NON-canonical base to pin the opposite direction of this same bug class (that
  `convert.ts` still names the raw/canonical path correctly). `makeDir()` has 14 call sites, not
  the 3 this spec originally targeted. Fixed by adding a separate `makeCanonicalDir()` helper used
  only at the three affected sites, leaving `makeDir()` and its other 11 call sites untouched.
- The reachability section overstated CI coverage: neither affected file runs on any Windows or
  macOS CI leg (`check` is ubuntu-only; `windows-acl-proof` runs exactly three other files). Fixed
  by rewriting "reachable on windows-latest, proven once already by the sibling" to state plainly
  that this lands as unverified hardening on every leg this repo runs, correct by construction
  rather than by a green CI leg.
- The fix shipped with no discriminating test of any kind, verifiable on no leg at all. Added one
  POSIX-gated regression pin using the file's own `symlinkedDir()` precedent, so `check` (ubuntu)
  gets one real red→green discriminator even though it cannot reproduce the Windows 8.3 mechanism.
- Added explicit "Done when" and "Tests" lines confirming `:326` and `:413` still build from a
  non-realpath'd base after the change, so the fix's own regression tests are pinned alongside the
  fix rather than assumed safe.

**Not adopted:** none — all findings touching this spec were adopted as described above.
