# I-release — #1832 `npm ci` runs lifecycle scripts in the same job as the signing secrets

Branch `fix/release-and-ci-hygiene-1856`. **`Closes #1832` is conditional and the condition is
mechanical: the residual issue below must exist before the PR body is written.** Track home:
`tracks/I-supply-chain.md` §"Three exposures".

## The Closes/Refs split

`--ignore-scripts` closes the **install-time** entrypoint and nothing else; the same dependency tree
still runs at **build** time in the signing job, and three non-npm toolchain installs are untouched.
That residual is one open decision — isolate the toolchain installs and the npm build into a
secret-free job and pass artifacts forward, or accept the exposure.

1. **File it as its own issue before writing the PR body**, e.g. *"Decide: isolate `cargo build.rs` /
   `cargo install tauri-driver` / `dotnet tool install` and the npm build out of the secret-holding
   signing job, or accept the exposure"*. Filing is **unconditional** — never "say the word and I
   will file it".
2. Cite that number in the PR body's For-Bryan list as a decision Bryan owns.
3. **Only then** may the body carry `Closes #1832`, with this sentence: *"#1832's finding — `npm ci`
   runs lifecycle scripts in the same job as the signing secrets — is fixed in code at all six sites;
   the isolate-or-accept decision that remains is a different question and is tracked as #\<new\>."*
   Without the issue, #1832 moves to `## Refs (partial — issue stays open)`.

**Not precedent for `I-release-1831.md`, which does not close.** #1832's fix resolves the stated
finding completely in code with the residual getting its own number; #1831's disposition *is* the
Bryan decision.

## Problem

Six jobs run `npm ci` with no `--ignore-scripts`, two of which later do privileged things:
`tauri-release.yml:210` (signs and uploads) and `publish.yml:113` (mints a provenance attestation).
Bryan's 2026-09-08 triage comment corrects the framing and this spec adopts it: **the signing secrets
are not in `npm ci`'s environment** — Azure login and the Apple/updater steps come later with
explicit `env:`. What survives is that untrusted install-time code runs earlier in the same writable
job and can alter files, executables, `$GITHUB_ENV` and `$GITHUB_PATH` before signing.

**Measured 2026-09-10.** The installed tree carries **one non-optional install script** —
`esbuild@0.28.2 → postinstall: node install.js` — plus three `fsevents` copies (`2.3.2` root, `2.3.3`
under `tsx` and `vite`), each `"os": ["darwin"]` and `optional: true`. `tauri-release.yml:210` runs
on `macos-latest`, so there `--ignore-scripts` leaves `fsevents` unbuilt and watchers fall back to
polling — benign for a one-shot build, but a second behaviour change. State it as *"one non-optional
install script (`esbuild`) plus darwin-only optional `fsevents`, which affects file watching, not the
build"* — never as "exactly one script". esbuild works without it: `npm install --ignore-scripts
esbuild@0.28.2` in a clean dir, then `require("esbuild").transform("let x=1")` → `let x = 1;`; since
≥0.16 it resolves its platform binary from the `@esbuild/*` optional dependency at require time. The
two-stage install the issue offers as a fallback is not needed.

## Fix

Add `--ignore-scripts` to **all six** `npm ci` sites: `ci.yml:177` (`windows-acl-proof`), `:253`
(`coverage`), `:344` (`check`), `publish.yml:113`, `tauri-release.yml:210`, `tauri-webdriver.yml:88`.

**Widening to `ci.yml` is the point, not scope creep.** The two release workflows run only at a tag,
so a regression there is discovered by a broken release; `check` runs `npm run build` plus the full
suite on every PR and `windows-acl-proof` runs on Windows, so the flag there is what gives this edit
real PR-time evidence on two platforms. Say that in the PR body; do not claim the release legs were
verified.

Two more edits, neither optional:

- **`tests/scripts/typecheck-tests-wiring.test.ts:167` — widen the `npm ci` finder, same commit.**
  It is `stepIndex(job, "\`npm ci\`", (s) => s.run?.trim() === "npm ci")` and `stepIndex`
  (`:104-110`) **throws** on no match, so flagging `ci.yml:344` turns required `check` red. Change
  the predicate to `(s) => /^npm ci\b/.test(s.run?.trim() ?? "")`, the shape both siblings already
  use (`acceptance-harness-wiring.test.ts:264`, `windows-acl-proof-wiring.test.ts:161`). **`:167` is
  the only exact-equality `npm ci` finder in the tree — widen that one and nothing else.**
- **`tests/scripts/workflow-action-pin.test.ts:36-38` — a security claim this PR falsifies.** It
  states as live fact that "`npm ci` runs in the same jobs, before the signing steps, with no
  `--ignore-scripts`". Rewrite those three lines to credit #1832's flag and
  `tests/scripts/release-ci-hygiene.test.ts`, **keeping the residual named** (the same dependency
  code still runs at build time, plus `cargo build.rs`, `cargo install tauri-driver`, `dotnet tool
  install`).

**Never move this into an `.npmrc` or `NPM_CONFIG_IGNORE_SCRIPTS`.** As npm *config* it applies to
every npm command including `npm publish`, and `package.json` has `prepublishOnly: npm run build` —
so config-level would skip the build and publish whatever `dist/` was on the runner, green. Put that
warning as a comment at `tauri-release.yml:210`; the CLI flag on `npm ci` cannot reach `npm publish`.

## Tests

**One describe**, in the group's shared new file `tests/scripts/release-ci-hygiene.test.ts` (ADR-051
— four of the six sites live in workflows no required check reads). This spec lands that file; #1830
and #1748 add describes to it.

**Every `npm ci` in every workflow carries `--ignore-scripts`.** Walk all workflow files with
`yaml`'s `parse` (parse, never substring-match — `tauri-release.yml` is dense with prose comments and
heredocs), collect every step whose `run` contains `npm ci`, assert the **count equals 6** and each
step's `run.trim()` **equals `"npm ci --ignore-scripts"` exactly**. Exact equality, not a regex:
`/\bnpm ci\b[^\n]*--ignore-scripts/` is satisfied by `npm ci --ignore-scripts || true` and by
`npm ci # --ignore-scripts`, and `typecheck-tests-wiring.test.ts:134-138` states the rule — exact
equality "subsumes the whole exit-code-masking family in one assertion". All six are the identical
string today. Keep the count pin, or deleting five sites passes. *Kills:* the flag added to only the
two jobs the issue named, a seventh site arriving unflagged, and the `|| true` family.

No unit test — there is no new code, only a flag. No experiment in
`docs/reviews/2026-09-02-v1-review/experiments/` covers this issue.

## Done when

Six sites flagged; `typecheck-tests-wiring.test.ts:167` widened in the same commit (**without it
`check` throws red** — a deliberate guard change, not a repair improvised for green);
`workflow-action-pin.test.ts:36-38` rewritten; the describe green; a full `check` run green (the
actual evidence that `--ignore-scripts` does not break the build); the measurement in the PR body in
the *one non-optional script plus darwin-only optional `fsevents`* phrasing, with the
`.npmrc`/`prepublishOnly` interaction.

**The PR body must state the boundary, because "untrusted code no longer runs before signing in that
job" is the wrong claim and the easy one to make.** The flag closes the install-time entrypoint only;
the build that follows in `build-tauri` (vite plugins, tsup/esbuild, `tauri-action`'s
`beforeBuildCommand`) runs the same dependency tree with the same privileges, still before the Azure
OIDC login (`:226-241`). The hardening is real; the trust boundary is unchanged.

## Not in scope

The same-class exposures the flag cannot touch — **four, not three**: Cargo `build.rs`,
`cargo install tauri-driver`, the Windows job's `dotnet tool install`, and the npm build itself in
`build-tauri`. They are not deferred with no home: per the split above they become one numbered
issue, filed before the PR body is written. Also out: any change to what a release *does*.

## Review corrections (scope cut)

**Removed.** Test 2 (`.npmrc` existence plus a parsed sweep for `NPM_CONFIG_IGNORE_SCRIPTS` at
workflow/job/step level) and test 3 (`prepublishOnly` exact-equality pin) — drift guards against a
hypothetical future "simplification" the issue did not ask about; the prose warning survives at the
call site, where a reader meets the hazard. Test 4 (parse `docs/decisions.md`'s ADR-051 Instances
table, map its number word to an integer, assert the row count and a row naming this file) — a
frozen-list drift guard on a doc; the row and count bump still happen as ordinary doc upkeep,
unpinned. The round-1/round-2 logs, folded into the body.

**Kept, with reasons.** All six sites (the two the issue names never run on a PR, so the `ci.yml`
sites are the only verification this change can have); the `typecheck-tests-wiring.test.ts:167`
widening (without it the required check throws); the `workflow-action-pin.test.ts:36-38` rewrite (our
change makes that docblock false).

**File set:** `.github/workflows/{ci,publish,tauri-release,tauri-webdriver}.yml`,
`tests/scripts/typecheck-tests-wiring.test.ts`, `tests/scripts/workflow-action-pin.test.ts`,
`docs/decisions.md` (one row + count word), new `tests/scripts/release-ci-hygiene.test.ts`.
