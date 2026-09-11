# K-tests — #1855 Five path assertions latent-fragile under an 8.3 short-name temp dir

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
**Closes #1855.** Additive fix at five comparison sites. Ledger:
`docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe:
`npx vitest run tests/server/export-path-canonicalization.test.ts tests/server/mcp-tool-integration.test.ts`
before and after.

## Establishing reachability first (per the issue's own instruction)

Measured directly on this machine, plus a second axis read from the affected file's own header
and confirmed against current source:

- `$env:USERNAME` = `blokn` (5 chars) — too short to ever mint an 8.3 alias.
- `$env:TEMP` = `C:\Users\blokn\AppData\Local\Temp` — no ancestor carries a short-named component.
- `mktemp`-created leaf directories do get their own 8.3 aliases (e.g. `TA83D2~1`), but no fixture
  in the affected tests ever builds a path from that alias — every fixture path comes from
  `os.tmpdir()` / the raw `mkdtemp()` return value, both long-form here.
- **A second, independent axis is live today on macOS — nothing to do with 8.3 short names.**
  `export-path-canonicalization.test.ts:42-46`'s own header names it: "on macOS `/var/folders` is
  itself a symlink, so the uncanonicalized and canonicalized values would coincide" against the
  *unfixed* code — i.e. they diverge against the current, fixed-nowhere code. `makeDir()`
  (`:57-61`) returns the raw, non-canonical `mkdtemp()` result; the app output it is compared
  against is realpath'd (`src/server/mcp/annotations.ts:876-879`'s
  `path.join(realParent, path.basename(sidecarPath))` on the ENOENT-leaf branch these fixtures
  take, and `convert.ts:189-191`'s `realDir = await fs.realpath(resolvedOutput)`, both confirmed at
  those line numbers against current source). On any macOS `npm test`, `os.tmpdir()` returns
  `/var/folders/…` while `fs.realpath` returns `/private/var/folders/…`, so the divergence is
  live there regardless of username length.

**Corrected (ship-stage verification): the 8.3 axis IS reachable on this machine, contradicting the
draft below.** `$env:USERNAME` being short does not stop `mktemp`'s randomized leaf directory name
from itself minting an 8.3 alias for a long-named ancestor — measured directly with a COM
`Scripting.FileSystemObject` short-path lookup against a freshly created long-named temp dir:
`C:\Users\blokn\AppData\Local\Temp\tandem-shortname-probe-longdirectoryname` aliases to
`C:\Users\blokn\AppData\Local\Temp\TA3E70~2`. Reproduced end to end: with `TEMP` pointed at that
8.3 alias, `origin/master`'s test files fail exactly the five named sites (5 failed | 98 passed);
the fixed files pass (2 files / 103 passed | 8 skipped) under the identical `TEMP`. **This
supersedes both the "not reachable on THIS machine" framing directly below and commit `2411d9a2`'s
message, which repeated that same wrong claim** ("The 8.3-short-name axis the issue names is not
reachable on this machine or in any CI leg that runs either file... this fix targets the macOS
axis only"). The fix is correct and sufficient on both axes regardless — this corrects only the
scope claim, not the code.

**Originally assessed not reachable on THIS machine, on either axis** (5-char username; not
macOS) — but "not reachable here" is not "not reachable at all," and only the 8.3 axis matches the
issue's own hypothesis. The
issue names the Windows trigger class: GitHub's `windows-latest` runner authenticates as
`runneradmin` (11 chars, shortened to `RUNNER~1`), which already turned the sibling spec
`convert-output-acl-win.test.ts` red once (`export-path-canonicalization.test.ts:416-420`). **That
Windows proof does not transfer to the five sites below**, verified directly: `check` (the only
ubuntu job running `npm test`) is `runs-on: ubuntu-latest` (`.github/workflows/ci.yml:317`), and
`windows-acl-proof` (`:168`) runs only the three files listed in `WINDOWS_ACL_PROOF_SPECS`
(`scripts/ci/windows-acl-proof.mjs:63-81`): `doc-backup-acl-repair.test.ts`,
`integrations/acl-win.test.ts`, `convert-output-acl-win.test.ts`. Neither
`export-path-canonicalization.test.ts` nor `mcp-tool-integration.test.ts` is in that list or run by
any other Windows job. `coverage` (`.github/workflows/ci.yml:243`) is also ubuntu-latest and runs
`npm run test:coverage` — the full vitest suite — so it doesn't reach the divergence either. **But
this repo's CI runs no macOS job at all**, so the macOS axis is untested by CI in either direction:
not proven red by any CI run, but not guarded against either. Live-but-unguarded is not the same
finding as unreachable, and the issue's own decision tree treats them differently.

## Problem

Five assertions compare a value the app computed via `fs.realpath()` against a raw, non-canonical
path the test built itself (`src/server/mcp/annotations.ts:834-880`, `convert.ts:187-191`;
three sites in `export-path-canonicalization.test.ts:173,181,240`, two in
`mcp-tool-integration.test.ts`'s `#314` describe block). Wherever an ancestor of the fixture path
carries a short alias, the two sides read different strings for the identical file. The mechanism
is real and already proven once — but only for a **different** spec in the same file
(`convert-output-acl-win.test.ts`), which *is* on `windows-acl-proof`. These five are not.

## Decision: fix it — the macOS axis is live, not a ghost

The issue's own menu was: establish reachability first, and only "if it is genuinely unreachable,
recommend closing with the evidence rather than hardening five assertions against a ghost." The
8.3-short-name axis IS genuinely unreachable — here and in every CI leg that runs either affected
file — and hardening for it alone would be exactly the ghost the issue warns against. But the
macOS realpath-symlink axis is not that: it is a live divergence on any Mac running `npm test`,
named by the affected file's own header, and this repo currently runs no macOS test job to catch
it. That is under-tested, not unreachable, and the issue's own decision tree lands on the fix for
that case, not on closure.

## Fix

Add `await fsp.realpath(...)` around the expected side of the comparison at the five sites where a
raw, non-canonical fixture path is checked against app output that IS realpath'd — three in
`export-path-canonicalization.test.ts` (`:173`, `:181` — both `expect(body.writtenPath).toBe(out)`
against an `out` built from `makeDir()`'s raw base; `:240` —
`expect(result.outputPath).toBe(path.join(base, "real", ...))` against the same raw base) and two
in `mcp-tool-integration.test.ts`'s `#314` describe block (`:1179` —
`expect(parsed.data.writtenPath).toBe(customPath)`, the "honors a custom outputPath" test, where
`customPath`'s parent directory takes the tool's ENOENT-leaf `fs.realpath` branch; `:1266` —
`expect(parsed.data.writtenPath).toBe(expectedFile)`, the "appends default sidecar
filename when outputPath is an existing directory" test, where `targetDir` itself gets realpath'd
before the tool appends the default filename). Leave `makeDir()` itself non-canonical: two sibling
assertions in the same file (`:326-338`, `:413-450`) exercise the raw-vs-canonical mismatch
deliberately (the non-directory and permission-denied error-message cases) and depend on it staying
raw.

**The two writeToDisk-with-no-`outputPath` sites in `mcp-tool-integration.test.ts` (`:1117`,
`:1149`) are NOT part of this fix** — confirmed by reading `annotations.ts:813-843`: the
`fs.realpath` branch there is gated on `if (outputPath)`, and neither of those two tests passes an
`outputPath`, so `sidecarPath = path.resolve(${filePath}.annotations.json)` never calls
`fs.realpath` on either side of the comparison. There is nothing for the macOS axis to diverge on
at those two sites.

## Done when

The five sites above wrap the expected-path side of their comparison in `fsp.realpath(...)`;
`makeDir()` is untouched; `npx vitest run tests/server/export-path-canonicalization.test.ts
tests/server/mcp-tool-integration.test.ts` passes on this machine; `npm run typecheck:tests` green.
Mutation check (wave-7 lesson 5): revert the five `realpath()` wraps from a saved file copy,
confirm all five assertions go red under an 8.3-aliased `TEMP` (they do — see the reachability
correction above) and pass again once restored.

## Not in scope

Adding `export-path-canonicalization.test.ts` or `mcp-tool-integration.test.ts` to
`WINDOWS_ACL_PROOF_SPECS` or any new Windows/macOS CI job — a real gate for either axis of this
class of bug is a separate, unrequested decision. Changing `makeDir()` itself.

## Review corrections (scope cut)

- The round-1 spec applied an additive `makeCanonicalDir()` fix plus a new POSIX-gated regression
  pin despite establishing the condition is unreachable both locally and (per the corrected
  finding) in every CI leg that runs these files. With reachability refuted on both axes, the
  issue's own "recommend closing" branch applies — removed the fix and the new test entirely
  rather than repair them, which moots the two findings raised against that fix (the shared
  `makeDir()` helper is now untouched, and the "no discriminating test" gap is moot because no fix
  ships to discriminate for).
- Removed the elaborate "verdict: fix it anyway, unverified hardening" framing — replaced with a
  direct recommendation to close, matching the issue's own decision tree.

## Review corrections (post-cut)

- **The "recommend closing" verdict tested only the 8.3-short-name axis, on one Windows machine,
  and did not check whether the same `realpath(computed) != raw(test-built)` shape has a second,
  live trigger.** It does: `export-path-canonicalization.test.ts`'s own header (`:42-46`) states
  that on macOS `/var/folders` is itself a symlink, so `os.tmpdir()` and `fs.realpath()` diverge
  there independent of any username length, and `makeDir()` (`:57-61`) is non-canonical by
  construction. Confirmed directly against current source (not carried forward from the finding):
  the five comparison sites compare a raw `makeDir()`/`uniqueDocPath()`-derived path against app
  output built from `fs.realpath` at `src/server/mcp/annotations.ts:876-879` and
  `src/server/mcp/convert.ts:189-191`, and both `check` and `coverage` are ubuntu-only — so nothing
  in this repo's CI exercises the macOS axis in either direction. Re-derived the verdict: the issue's
  own decision tree fixes a live-but-untested divergence rather than closing it as unreachable, so
  #1855 moves from `Refs, NOT Closes` to **`Closes`**, with the additive `fs.realpath()` fix
  reinstated at the five sites (Fix section above), leaving the shared `makeDir()` helper untouched.
- **Corrected the site list for the two `mcp-tool-integration.test.ts` comparisons.** The
  divergence requires the app code to actually call `fs.realpath`, which
  `src/server/mcp/annotations.ts:813-843` gates on `if (outputPath)` being present. Read the file
  directly rather than trusting the earlier "`:1096` builds, `:1117`/`:1149` assert" pairing: the
  two tests at `:1117` and `:1149` (`writeToDisk: true` with no `outputPath`) never enter that
  branch and cannot diverge on either axis — verified by reading `annotations.ts:826` (`raw =
  outputPath ?? ...`) and the two tests' `arguments` objects directly. The two sites that DO pass
  `outputPath`, and DO take the `fs.realpath` branch, are `:1179` ("honors a custom outputPath") and
  `:1266` ("appends default sidecar filename when outputPath is an existing directory") — both
  confirmed by reading their `arguments: { ..., outputPath: ... }` calls and tracing them into the
  ENOENT-leaf and existing-directory arms of `annotations.ts:841-880`. The Fix section above uses
  the corrected pair.
