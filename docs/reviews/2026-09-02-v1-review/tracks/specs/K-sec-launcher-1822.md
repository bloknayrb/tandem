# K-sec-launcher — #1822 items 4, 5, 6: confined launcher cwd, no Tandem secrets in the launched env, no `keychain_get`, `NODE_ENV=production` at sidecar spawn

**Refs #1822, never Closes.** Items 1-3 shipped in #1987 and item 7 needs no change. Item 8 still carries two recommendations awaiting Bryan (comment of 2026-09-11). Anchors were re-read on `f8979bc0`. The issue body's line numbers are stale.

## Problem

- **4a, cwd.** `resolveCwd` (`src/server/launcher/supervisor.ts:1008`) → `safeCwd` → `resolveSafeCwd` does not confine to home. The route resolvers do (`resolveRouteCwd` `:2077`, `homeConfines` `:2056`). So a `workingDirectory` written through `POST /api/integrations`, which any `127.0.0.1`-origin page can reach, points the next spawn anywhere.
- **4b, env.** `childEnv` (`:611`) strips only `DESKTOP_ONLY_ENV_KEYS`. `TANDEM_AUTH_TOKEN` and `TANDEM_SENTRY_DSN` (the name `src/server/sentry.ts` reads) therefore reach the launched Claude and every shell it runs.
- **5.** `keychain_get` (`src-tauri/src/keychain.rs:60`, registered at `lib.rs:1696`) returns plaintext to the WebView. **It has no consumer.** `keychainGet` (`src/client/keychain/keychain-invoke.ts:50`) is imported nowhere. No capability file names it. The only other references are tests: `src-tauri/tests/keychain.rs:13-17` and `tests/docs/tauri-command-registration-claims.test.ts:121`.
- **6.** `start_sidecar` never sets `NODE_ENV`, so Express and `finalhandler` default to `development` and put `err.stack` in HTML error pages.

## Fix

**4a. `supervisor.ts`: `safeCwd` and `resolveCwd` only.** G1 owns the rest of this file.
- `safeCwd(candidate)` returns `resolveRouteCwd(candidate, { homeOverride: opts.homeOverride })`.
- Add `homeOverride?: string` to `SupervisorOpts` as a test-only seam; `index.ts` does not pass it.
- The fallback is `opts.homeOverride ? (resolveSafeCwd(opts.homeOverride) ?? opts.homeOverride) : homeCwd()`, so tests can observe it.
- **Log only when `override === undefined`**, just before the fallback, and only when a string candidate failed:
  ``console.error(`[Launcher] workingDirectory ${sanitizeForLog(candidate)} is not a directory inside home — spawning in ${cwd}`)``
  An override fallback is already logged by `persistRequestedCwd` (`:998-1000`). Gating keeps one event to one line, and keeps that persist test able to fail. The launch never fails.
- **This narrows the symlink-swap window; it does not close it.** The check is a realpath in `buildPlan`, while `spawn` `chdir`s by path string later. Never write "closes" about it.
- Reword the `persistRequestedCwd` "Home-confining here would move an HTTP-boundary policy…" paragraph (`:974-981`), and any `resolveSafeCwd`/`resolveRouteCwd` docblock that says the integration-file path is unconfined. Keep the residual-TOCTOU note.

**4b. `childEnv`: a denylist, never an allowlist.** An allowlist silently drops `PATH`, `HOME`/`USERPROFILE`, proxies, `ANTHROPIC_*` and `CLAUDE_*`.
- `const TANDEM_SECRET_ENV_KEYS = ["TANDEM_AUTH_TOKEN", "CLAUDE_PLUGIN_OPTION_AUTH_TOKEN", "TANDEM_SENTRY_DSN"]`, deleted next to `DESKTOP_ONLY_ENV_KEYS`.
  - The plugin-option key is Tandem's own token.
  - `resolveAuthTokenCandidate` (`src/shared/cli-runtime.ts:66-78`) ranks it above `TANDEM_AUTH_TOKEN`.
- `childEnv(base = process.env, argv = process.argv)` also deletes `NODE_ENV` when `isTauriSidecar(argv)` (`src/server/platform.ts:230`, argv-based). Only item 6 puts it there, and `NODE_ENV=production` inherited by the launched Claude would make `npm install` skip devDependencies. The npm path is unchanged.
- Keep the call-site string `env: childEnv(),` byte-identical; `supervisor.test.ts:1170` pins it.
- **Measured: nothing the launched session starts on the desktop's loopback bind needs the env copy.**
  - Loopback auth calls `next()` (`auth/middleware.ts:165-166`), and the sidecar binds `127.0.0.1`.
  - Config-spawned bridges and shims get the token from their own config `env`, written by `integrations/apply.ts:489-521`.
  - `.claude-plugin/plugin.json` sets only `TANDEM_URL`. The monitor reads only the URL, and the reaper reads argv.
  - **Implementer check:** confirm that every `apply.ts` / `cowork_installer.rs` entry for a non-loopback bind carries its token in its own `env`. If one relies on inheritance, stop and raise it under `bryan`. Claim nothing beyond loopback.
- For the PR body: `tandem rotate-token` inside a desktop-launched session no longer sees an env token. It falls to the npm token file (`src/cli/rotate-token.ts:40`). With no file it exits 1 before writing. With a file, the sidecar answers 409 and the CLI restores it.

**5. Remove the getter.**
- Delete `keychain_get` (`keychain.rs`), its `generate_handler!` entry (`lib.rs:1696`) and `keychainGet` (`keychain-invoke.ts`).
- Fix the "three commands" header docblocks in both files.
- In `src-tauri/tests/keychain.rs`, delete `keychain_get_rejects_empty_account` and drop `keychain_get` from the `use`.
- `keychain_set`, `keychain_delete` and the `tandem-integrations` service are untouched, so #1761's persistence stands.

**6. `src-tauri/src/sidecar.rs`.**
- `sidecar_env_pairs(app_data_dir: &str, release_build: bool)` pushes `("NODE_ENV", "production")` only when `release_build`.
- The call site (`:1942`) passes `!cfg!(debug_assertions)`.
- Debug and `cargo tauri dev` builds get no `NODE_ENV` from Rust, so `reaperPath()`'s dev fallbacks keep working.
- For the PR body, what flips for a packaged sidecar, by grep and not proof:
  - Express `env`: no stack in error pages;
  - `supervisor.ts:1051`: the `reaper/target/release` fallback is off (`:1034` is already inert under the sidecar).
- Other sidecar children that pass no explicit `env` inherit `NODE_ENV` and the token. `install-claude-cli.ts` is the measured exception (`minimalEnv`). Note it; change nothing.

**Docs.** Reword two statements that become false:
- `docs/security.md:165` says the supervisor spawns with `env: process.env`. It becomes: the launched session inherits Tandem's environment minus the three secrets, the desktop-only keys and the sidecar's `NODE_ENV`, and a shell command can still read the rest.
- The `isTauriSidecar` docblock's `env: process.env` clause (`platform.ts:221`). The argv rationale stands, because `TANDEM_TAURI_SIDECAR` is still inherited.

## Tests

1. **`supervisor.test.ts`, `childEnv`:**
   - The base holds the three secrets plus `PATH`, `HTTPS_PROXY` and `SOME_USER_TOOL_CONFIG`. The secrets are gone and the other three survive, which kills an allowlist.
   - Argv includes `--tauri-sidecar` and the base is `{ NODE_ENV: "production" }`: the key is absent.
   - Argv lacks the flag and the base is `{ NODE_ENV: "production", TANDEM_TAURI_SIDECAR: "1" }`: the key survives, which kills an env-var-keyed strip.
2. **`stream-json-protocol.test.ts`, asserting `spawnRec.cwd`.** Not `status().cwd`, which races. `fakeHome = realpath(mkdtemp)` holds a copy of the stub.
   - *Out of home:* `writeClaudeIntegration(outsideDir)` (a sibling tmpdir holding the stub) with `homeOverride: fakeHome`, then `startFresh()`. Expect `spawnRec.cwd === fakeHome` and exactly one `console.error` containing `not a directory inside home`.
   - *Inside home:* a subdirectory of `fakeHome`. Expect `spawnRec.cwd === realpath(insideDir)` and no such line.
   - *The existing persist case (`:1086-1095`):* tighten `includes(gone)` to a call containing both `gone` and `could not be resolved`, and assert that no call contains `not a directory inside home`.
3. The shared `createSupervisor` helpers in `stream-json-protocol.test.ts` and `supervisor-turn-delivery.test.ts` pass `homeOverride: fs.realpathSync(os.tmpdir())`. Without it, only ubuntu `check` goes red: `/tmp` is outside `$HOME` there, while the Windows temp dir is inside home.
4. `tauri-command-registration-claims.test.ts:121`: change `toContain("keychain_get")` to `toContain("keychain_set")`, and add `not.toContain("keychain_get")`.
5. `sidecar.rs`:
   - `sidecar_env_pairs_exports_both_data_dir_variables` passes `true` and asserts `NODE_ENV == Some("production")`.
   - A new case passing `false` asserts the key is absent.
   - `start_sidecar_folds_the_env_pairs_onto_the_command` asserts `sidecar_env_pairs(app_data_dir_str.as_str(), !cfg!(debug_assertions))`.
6. **Mutation-test** each change and restore from a file copy, never `git checkout`:

   | Mutation | Test that must go red |
   |---|---|
   | `safeCwd` → `resolveSafeCwd` | 2 out-of-home |
   | fallback → `homeCwd()` | 2 out-of-home |
   | the new log line deleted | 2 out-of-home |
   | the `override === undefined` gate removed | 2 persist case |
   | persist's `console.error` deleted | 2 persist case |
   | each secret key, and the `NODE_ENV` delete | 1 |
   | the registration kept | 4 |
   | the `release_build` guard | 5 `false` case |
   | the call expression | 5 fold |

## Done when

- Everything above is green.
- `npm run typecheck`, `typecheck:tests`, vitest, `cargo test`, `security-findings-claims` and `loopback-gate-claims` pass.
- The PR body states the CI legs: vitest on ubuntu `check` (the only leg where test 3's seam matters), and the Rust cases on all three `rust-test` legs.
- `bryan`: **a cwd policy reversal.** A hand-edited out-of-home `workingDirectory` (e.g. `D:\code`) now falls back to home with a log line. Settings cannot produce such a value: its picker saves through the home-confined `POST /api/launcher/working-directory` (`launcher/api-routes.ts:367`).
- #1822 stays Refs.

## Not in scope

Items 1-3, 7 and 8. A keychain handle design. Env filtering for sidecar children other than the launched Claude. `TANDEM_TAURI_SIDECAR` inheritance (#1787). The `reaperPath` belt-and-braces check.

## Review corrections (scope cut)

- **Removed: the value-keyed `NODE_ENV` strip** (`=== "production"`) and its third, dev-value test. The strip now keys on sidecar argv alone. The dev case it protected (a developer's own `NODE_ENV` in `cargo tauri dev`) is not what the issue is about.
- **Removed:** the `keychain-backend.test.ts` prefix edit, which is cosmetic and asserts nothing about the fix; the "record cwd confinement wherever described" sweep; the `env: process.env` grep step; the expanded dependency `NODE_ENV` survey (Sentry Spotlight, Hocuspocus); the `setup`/`doctor` token analysis. Only the two statements the fix makes false are edited.
- **Kept: blocking finding 1** (the log made the persist test non-discriminating). It is fixed directly: the log is gated on `override === undefined`, the persist assertion is tightened to `could not be resolved`, and there is a no-double-log assertion. All three are in the mutation table.
