# I-release — #1832 `npm ci` runs lifecycle scripts in the same job as the signing secrets

Branch `fix/release-and-ci-hygiene-1856`. **`Closes #1832` is CONDITIONAL and the condition is
mechanical: a numbered issue for the toolchain-and-build residual must exist before the PR body is
written.** See "The Closes/Refs split" below — the ledger
(`docs/plans/2026-09-06-open-issues-sweep.md:54`) records #1832 as having a Bryan half, and wave 6
shipped a `Closes` over exactly that shape. Ledger: `tracks/I-supply-chain.md` §"Three exposures".
Probe: the dependency-tree walk below.

## The Closes/Refs split — decided here, not left to the ship stage

`--ignore-scripts` closes the **install-time** entrypoint and nothing else. The same dependency
tree still executes in the signing job at **build** time (below), and three non-npm toolchain
installs are untouched. That residual is one open decision — *isolate the toolchain installs and
the npm build into a secret-free job and pass artifacts forward, or accept the exposure* — and a
decision living only in a PR body is not a tracked home once #1832 is closed.

So, in order, and the ship stage must not improvise here:

1. **File the residual as its own issue before writing the PR body.** Title it for the decision,
   e.g. *"Decide: isolate `cargo build.rs` / `cargo install tauri-driver` / `dotnet tool install`
   and the npm build out of the secret-holding signing job, or accept the exposure"*. Filing is
   **unconditional** — not contingent on Bryan replying, not "say the word and I will file it".
2. Cite that number in the PR body's For-Bryan list, stated as a decision he owns.
3. **Only then** may the PR body carry `Closes #1832`. If for any reason the issue was not filed,
   #1832 moves to `## Refs (partial — issue stays open)` naming the `npm ci` half as done and the
   toolchain-plus-build class as remaining.

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
  **The `.npmrc` warning must also name the env form**, because that is the one a test on the file
  cannot see: `NPM_CONFIG_IGNORE_SCRIPTS: "1"` at workflow, job or step level has the identical
  effect on `npm publish`, and in `publish.yml` it would ship whatever `dist/` was on the runner
  with a green provenance attestation. Test 2 below sweeps for it.

**Two more edits, and neither is optional:**

- **`tests/scripts/typecheck-tests-wiring.test.ts:167` — widen the `npm ci` finder.** Today it is
  `stepIndex(job, "\`npm ci\`", (s) => s.run?.trim() === "npm ci")`, **exact equality**, and
  `stepIndex` (`:104-110`) **throws** when nothing matches. Adding `--ignore-scripts` to
  `ci.yml:344` makes that finder return -1, the throw fires with
  `".github/workflows/ci.yml: the typecheck job has no step \`npm ci\`"`, and `check` — required,
  `strict: true`, `enforce_admins: true` — goes **red**. Change the predicate to
  `(s) => /^npm ci\b/.test(s.run?.trim() ?? "")`, **in the same commit**. This is a deliberate
  guard change, not a repair improvised to get green: it adopts the shape the two sibling wiring
  tests already use (`acceptance-harness-wiring.test.ts:264`,
  `windows-acl-proof-wiring.test.ts:161`, both `/^npm ci\b/`). **`:167` is the only exact-equality
  `npm ci` finder in the tree — widen that one and nothing else.** The prefix anchor is what keeps
  it from matching `echo npm ci`.
- **`tests/scripts/workflow-action-pin.test.ts:36-38` — the docblock is a security claim this PR
  falsifies.** It states as live fact: "**`npm ci` runs in the same jobs**, before the signing
  steps, with no `--ignore-scripts`. Compromising one transitive dependency is a cheaper attack
  than moving a tag, and pinning actions does nothing about it." That file is the repo's canonical
  ADR-051 pin test and is what a future reviewer reads to learn what the pin does and does not buy.
  Rewrite those three lines to say the install-time vector was closed by #1832's `--ignore-scripts`
  and that `tests/scripts/release-ci-hygiene.test.ts` is what pins it now — **keeping the residual
  named**: the same dependency code still runs at build time in that job, plus `cargo build.rs`,
  `cargo install tauri-driver` and `dotnet tool install`.

## Tests

One describe in the group's shared new file `tests/scripts/release-ci-hygiene.test.ts` (ADR-051 —
four of the six sites live in workflows no required check reads):

1. **Every `npm ci` in every workflow carries `--ignore-scripts`.** Walk all workflow files with
   `yaml`'s `parse` (rule 2: parse, do not substring-match — `tauri-release.yml` is dense with
   prose comments and heredocs), collect every step whose `run` contains `npm ci`, assert the
   **count equals 6** and that each step's `run.trim()` **equals `"npm ci --ignore-scripts"`
   exactly**. Not a regex: `/\bnpm ci\b[^\n]*--ignore-scripts/` is satisfied by
   `npm ci --ignore-scripts || true`, by `npm ci --ignore-scripts; true`, and by
   `npm ci # --ignore-scripts`, and `typecheck-tests-wiring.test.ts:134-138` states the rule this
   departs from — exact equality "subsumes the whole exit-code-masking family in one assertion …
   which a denylist only ever covers partly". All six sites are the identical string today, so
   exact equality costs nothing. Keep the count pin (rule 3: without it, deleting five sites
   passes). *Kills:* the flag added to only the two jobs the issue named, a seventh site arriving
   unflagged, and the whole `|| true` family.
2. **Nothing sets `ignore-scripts` as npm *config*, in either of its two forms.** (a) Assert no
   `.npmrc` exists in the repo, or if one does, that it carries no `ignore-scripts` key. (b) Sweep
   the **parsed** workflow tree for an `env` key named `NPM_CONFIG_IGNORE_SCRIPTS` (any casing) at
   workflow, job **or** step level and assert there is none — the env form has the identical effect
   and is invisible to a test that only stats `.npmrc`. *Kills:* the "simplification" that moves the
   flag to config and takes `prepublishOnly` down with it — the failure this test exists for is
   invisible in a workflow diff because the workflows get *shorter*.
3. **`package.json`'s `prepublishOnly` is still `npm run build`.** One line, exact equality. It is
   the thing test 2 is protecting; without it, test 2 guards a property nobody can see is needed.

No unit test — there is no new code, only a flag. **No experiment in
`docs/reviews/2026-09-02-v1-review/experiments/` covers this issue**; there is no still-broken-when
output to convert into an assertion.

**This spec lands `tests/scripts/release-ci-hygiene.test.ts`, the group's shared new file and the
ninth ADR-051 instance.** So this spec also owns the enumeration edit: `docs/decisions.md:1916`
reads "The pattern, now used **eight** times" above an eight-row `Instances` table. Bump it to
**nine** and add the `release-ci-hygiene.test.ts` row (naming what it anchors: the six
`--ignore-scripts` sites, #1830's updater-signature step, #1748's `prerelease` derivation and its
post-Build required step). No test pins that table, so it drifts silently if skipped.

## Done when

Six sites flagged; `typecheck-tests-wiring.test.ts:167` widened in the same commit (**without it
`check` throws and goes red** — this is expected and is a guard change, not a repair);
`workflow-action-pin.test.ts:36-38`'s now-false claim rewritten; ADR-051's count bumped to nine and
the new row added; the three assertions green; a full `check` run green (which is the actual
evidence that `--ignore-scripts` does not break the build); the measured one-script finding and the
`.npmrc`/`NPM_CONFIG_IGNORE_SCRIPTS`/`prepublishOnly` interaction written into the PR body.

**The PR body must state the boundary precisely, because "untrusted code no longer runs before
signing in that job" is the wrong claim and the easy one to make.** `--ignore-scripts` closes the
**install-time** entrypoint only. `tauri-release.yml:210` runs `npm ci` inside `build-tauri`, and
the build that follows — vite plugins, tsup/esbuild, `tauri-action`'s `beforeBuildCommand` —
executes the same dependency tree's code with the same job privileges, still before the Azure OIDC
login (`:226-241`) and the Apple steps. The hardening is real (fewer entrypoints, and the
`check`/`windows-acl-proof` evidence is genuine); the trust boundary is unchanged.

The `Closes #1832` line is gated on the residual issue existing — see the split at the top.

## Not in scope

The same-class exposures this flag cannot touch — **four, not three**: `src-tauri`'s Cargo
`build.rs`, `cargo install tauri-driver`, the `dotnet tool install` in the Windows signing job, and
**the npm build itself** in `build-tauri` (the one the issue does not list, because it is not an
*install* script; see the boundary paragraph under `## Done when`). The issue lists its three "so
the scope is honest rather than to imply all of it is fixable together". They are **not** deferred
work with no home and they are **not** a "say the word and I will file it": per the split at the
top of this spec they become **one numbered issue, filed before the PR body is written**, cited in
the For-Bryan list as a decision Bryan owns, and that filing is what makes `Closes #1832`
defensible.

Also out: the `enforceLoopbackMutation` / `NON_LOOPBACK_ALLOWED` surface (untouched), and any
change to what a release *does* — this PR only changes what CI installs.

## Review corrections (round 1)

**Adopted.**

- **BLOCKING — `Closes #1832` over an untracked Bryan half.** The ledger
  (`docs/plans/2026-09-06-open-issues-sweep.md:54`) puts "#1831/#1832 policy half" in DECIDE, and
  the old text made the residual's filing contingent on a reply ("If Bryan wants it as work … he
  says so"). Replaced with a decided, mechanical split at the top of the spec: file the numbered
  residual issue **before** the PR body is written, cite it in For-Bryan, and only then may
  `Closes` stand; otherwise `Refs (partial)`.
- **BLOCKING — the fix breaks a required check and the cheap repair is to loosen an ADR-051
  guard.** Verified: `tests/scripts/typecheck-tests-wiring.test.ts:167` finds the install step by
  `s.run?.trim() === "npm ci"` and `stepIndex` (`:104-110`) throws on no match, so
  `ci.yml:344` gaining the flag turns `check` red with a throw naming a file the spec never
  mentioned. Added as a **seventh required edit**, framed as a deliberate guard change adopting the
  `/^npm ci\b/` shape the two sibling wiring tests already use — and stated as the *only*
  exact-equality `npm ci` finder in the tree, so nobody widens more than one.
- **Test 1's permissive regex.** `/\bnpm ci\b[^\n]*--ignore-scripts/` passes
  `npm ci --ignore-scripts || true`. Changed to exact equality on `run.trim()` plus the existing
  count pin, per `typecheck-tests-wiring.test.ts:134-138`'s own stated rule.
- **The `.npmrc` guard missed the env form.** Test 2 now also sweeps the parsed workflow tree for
  `NPM_CONFIG_IGNORE_SCRIPTS` at workflow/job/step level, and the `tauri-release.yml:210` warning
  comment names it.
- **The residual list understated the boundary.** The npm **build** in `build-tauri` runs the same
  dependency tree with the same privileges before the OIDC login; `--ignore-scripts` closes the
  install-time entrypoint only. Added to Not-in-scope (four exposures, not three) and made a
  required sentence in the PR body so "untrusted code no longer runs before signing" cannot be
  claimed.
- **`workflow-action-pin.test.ts:36-38` becomes false with this PR.** Added as a Fix bullet:
  rewrite it to credit `release-ci-hygiene.test.ts` and keep the residual named.
- **ADR-051's enumeration.** `docs/decisions.md:1916` says "used eight times" over an eight-row
  table and no test pins it. This spec lands the shared new file, so it owns the bump to nine and
  the new row.
- **No experiment covers this issue** — stated in `## Tests`.

**Not adopted.** None.

**File set changed** — added: `tests/scripts/typecheck-tests-wiring.test.ts`,
`tests/scripts/workflow-action-pin.test.ts`, `docs/decisions.md`. Unchanged: `.github/workflows/`
(six `npm ci` sites across `ci.yml`, `publish.yml`, `tauri-release.yml`, `tauri-webdriver.yml`),
new `tests/scripts/release-ci-hygiene.test.ts`.
