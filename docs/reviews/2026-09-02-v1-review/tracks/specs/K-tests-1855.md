# K-tests — #1855 Five path assertions latent-fragile under an 8.3 short-name temp dir

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
**Refs #1855, NOT Closes. No code change — recommend closing with the evidence below.** Ledger:
`docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe: none — no code is touched.

## Establishing reachability first (per the issue's own instruction)

Measured directly on this machine:

- `$env:USERNAME` = `blokn` (5 chars) — too short to ever mint an 8.3 alias.
- `$env:TEMP` = `C:\Users\blokn\AppData\Local\Temp` — no ancestor carries a short-named component.
- `mktemp`-created leaf directories do get their own 8.3 aliases (e.g. `TA83D2~1`), but no fixture
  in the affected tests ever builds a path from that alias — every fixture path comes from
  `os.tmpdir()` / the raw `mkdtemp()` return value, both long-form here.

**Not reachable on this machine**, matching the issue's own hypothesis. The issue names the actual
trigger class: GitHub's `windows-latest` runner authenticates as `runneradmin` (11 chars, shortened
to `RUNNER~1`), which already turned the sibling spec `convert-output-acl-win.test.ts` red once
(`export-path-canonicalization.test.ts:416-420`). **That proof does not transfer to the five sites
below**, verified directly: `check` (the only job running `npm test`) is `runs-on: ubuntu-latest`
(`.github/workflows/ci.yml:317`), and `windows-acl-proof` (`:168`) runs only the three files listed
in `WINDOWS_ACL_PROOF_SPECS` (`scripts/ci/windows-acl-proof.mjs:63-81`):
`doc-backup-acl-repair.test.ts`, `integrations/acl-win.test.ts`, `convert-output-acl-win.test.ts`.
Neither `export-path-canonicalization.test.ts` nor `mcp-tool-integration.test.ts` — the two files
holding all five sites — is in that list or run by any other Windows/macOS CI job.

## Problem

Five assertions compare a value the app computed via `fs.realpath()` against a raw, non-canonical
path the test built itself (`src/server/mcp/annotations.ts:834-880`, `convert.ts:187-191`;
three sites in `export-path-canonicalization.test.ts:173,181,240`, two in
`mcp-tool-integration.test.ts`'s `#314` describe block). Wherever an ancestor of the fixture path
carries a short alias, the two sides read different strings for the identical file. The mechanism
is real and already proven once — but only for a **different** spec in the same file
(`convert-output-acl-win.test.ts`), which *is* on `windows-acl-proof`. These five are not.

## Decision: recommend closing, not fixing

The issue's own menu is: establish reachability first, and "if it is genuinely unreachable,
recommend closing with the evidence rather than hardening five assertions against a ghost." Both
reachability paths are now closed: not reachable on this dev machine (5-char username), and not
exercised by any CI leg that runs either affected file. A fix here would be defensive code with no
environment, on this machine or in this repo's CI, that could ever exercise it — hardening against
a ghost, exactly what the issue warns against.

**No code change in this PR.** `bryan`: recommend closing #1855 with this evidence — reachability
requires a `%TEMP%`-ancestor short name (a long Windows username, or an imaging tool that mints
one), which does not occur here or in CI. If these two files are ever added to a Windows CI job,
that changes the calculus and the fix (additive `fs.realpath()` at the three-plus-two comparison
sites, without touching the shared `makeDir()` helper — two sibling assertions in the same file,
`:326-338` and `:413-450`, depend on `makeDir()` staying non-canonical) becomes worth doing then.

## Done when

The PR body states the reachability evidence above and the recommendation to close; no test or
source file is touched; `bryan` note is filed recommending closure with the evidence.

## Not in scope

Any fix to `export-path-canonicalization.test.ts` or `mcp-tool-integration.test.ts` — deliberately
not applied, per the decision above. Adding these files to `WINDOWS_ACL_PROOF_SPECS` or any new
Windows CI job — a real gate for this class of bug is a separate, unrequested decision.

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
