# I-release — #1832 `npm ci` runs lifecycle scripts in the same job as the signing secrets

Branch `fix/release-and-ci-hygiene-1856`. **Closes #1832 (fix half); the residual class named in
its own "Same class" paragraph goes to Bryan and is named in the PR body.** Ledger:
`tracks/I-supply-chain.md` §"Three exposures". Probe: the dependency-tree walk below.

## Problem

`npm ci` runs with no `--ignore-scripts` in six jobs, two of which later do privileged things:
`tauri-release.yml:210` (the job that signs and uploads), `publish.yml:113` (the job that mints a
provenance attestation). Bryan's 2026-09-08 triage comment corrects the framing and this spec
adopts his version, not the issue body's: **the signing secrets are not in `npm ci`'s environment**
— Azure login and the Apple/updater steps come later with explicit `env:`. What survives is that
untrusted install-time code runs *earlier in the same writable job* and can alter files,
executables, `$GITHUB_ENV` and `$GITHUB_PATH` before signing.

**The measurement the issue asks for, run on 2026-09-10.** Walking the installed tree for
`preinstall` / `install` / `postinstall` (not `prepare` — npm does not run a dependency's
`prepare`) returns **exactly one** script in ~1200 packages:

```
esbuild @0.28.2 -> postinstall: node install.js
```

And esbuild works without it: `npm install --ignore-scripts esbuild@0.28.2` in a clean directory,
then `require("esbuild").transform("let x=1")` → `let x = 1;`, `version 0.28.2`. esbuild ≥0.16
resolves its platform binary from the `@esbuild/*` optional dependency at require time; the
postinstall is a path-repair for installers that do not place it. So the two-stage install the
issue offers as a fallback is not needed — the flag is enough.

## Fix

Add `--ignore-scripts` to **all six** `npm ci` sites, not only the two the issue names:
`ci.yml:177` (`windows-acl-proof`), `:253` (`coverage`), `:344` (`check`), `publish.yml:113`,
`tauri-release.yml:210`, `tauri-webdriver.yml:88`.

**Widening to `ci.yml` is the point, not scope creep.** `tauri-release.yml` and `publish.yml` run
only on a tag and a published release, so a `--ignore-scripts` regression there is discovered by a
broken *release*. `check` runs `npm run build` (vite + tsup, both esbuild) plus the full suite and
E2E on every PR, and `windows-acl-proof` runs on Windows — so putting the flag there is what
converts an unverifiable release-only edit into one with real PR-time evidence on two platforms.
Say exactly that in the PR body; do not claim the release legs themselves were verified.

**Two things that would silently undo this, both worth a comment at `tauri-release.yml:210`:**

- **Never move this into an `.npmrc`.** There is no `.npmrc` in the repo today. `ignore-scripts` as
  npm *config* applies to every npm command, including `npm publish` — and
  `package.json` has `prepublishOnly: npm run build`. A config-level flag would skip that and
  publish whatever `dist/` happened to be on disk, with a green run. The CLI flag on `npm ci`
  cannot reach `npm publish`.
- `npm ci --ignore-scripts` also skips the **root** package's `prepare: husky`. That is correct in
  CI (git hooks are meaningless on a runner) and is not a behaviour change worth compensating for.

## Tests

One describe in the group's shared new file `tests/scripts/release-ci-hygiene.test.ts` (ADR-051 —
four of the six sites live in workflows no required check reads):

1. **Every `npm ci` in every workflow carries `--ignore-scripts`.** Walk all workflow files with
   `yaml`'s `parse` (rule 2: parse, do not substring-match — `tauri-release.yml` is dense with
   prose comments and heredocs), collect every step whose `run` contains `npm ci`, assert the
   **count equals 6** and each matches `/\bnpm ci\b[^\n]*--ignore-scripts/`. The count pin is
   rule 3: without it, deleting five sites passes. *Kills:* the flag added to only the two jobs the
   issue named, and a seventh site arriving unflagged.
2. **No `.npmrc` anywhere in the repo sets `ignore-scripts`.** Assert the file does not exist, or
   if it does, that it carries no `ignore-scripts` key. *Kills:* the "simplification" that moves the
   flag to config and takes `prepublishOnly` down with it — the failure this test exists for is
   invisible in a workflow diff because the workflows get *shorter*.
3. **`package.json`'s `prepublishOnly` is still `npm run build`.** One line, exact equality. It is
   the thing test 2 is protecting; without it, test 2 guards a property nobody can see is needed.

No unit test — there is no new code, only a flag.

## Done when

Six sites flagged; the three assertions green; a full `check` run green (which is the actual
evidence that `--ignore-scripts` does not break the build); the measured one-script finding and the
`.npmrc`/`prepublishOnly` interaction both written into the PR body.

## Not in scope

The same-class exposures the issue lists and this flag cannot touch: `src-tauri`'s Cargo
`build.rs`, `cargo install tauri-driver`, and the `dotnet tool install` in the Windows signing job.
The issue itself lists them "so the scope is honest rather than to imply all of it is fixable
together", so closing #1832 on the `npm ci` half is faithful to it. They are **not** deferred work
with no home: they are one open decision — isolate the toolchain installs into a secret-free job
and pass artifacts forward, or accept the exposure — and that decision goes in the PR body's
For-Bryan list, stated as a decision, never as "tracked separately". If Bryan wants it as work
rather than a decision, he says so and the ship stage files it with a number before the PR merges.

Also out: the `enforceLoopbackMutation` / `NON_LOOPBACK_ALLOWED` surface (untouched), and any
change to what a release *does* — this PR only changes what CI installs.
