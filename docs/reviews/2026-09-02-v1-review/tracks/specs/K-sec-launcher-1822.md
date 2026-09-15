# K-sec-launcher — #1822 items 4, 5, 6: launcher cwd confinement, no Tandem secrets in the launched env, no `keychain_get`, `NODE_ENV=production` at sidecar spawn

Branch `fix/security-lows-launcher-half-confined-launcher-cwd-no-tandem-secrets-in-the-launched-env-no-plaintext-keychain-read-production-sidecar-and-a-locked-cowork-scrub-1822`. **Refs #1822 only, never Closes.** Items 1-3 shipped in #1987, item 7 needs no change, and item 8 still carries two recommendations awaiting Bryan (comment of 2026-09-11). Ledger: `docs/reviews/2026-09-02-v1-review/areas/security.md:22-24`. Probe: source read, re-verified on `f8979bc0`. Every line number in the issue body is stale.

**Files:** `src/server/launcher/supervisor.ts` (`resolveCwd`, `safeCwd`, `childEnv`, `SupervisorOpts`, three docblocks), `src/server/platform.ts` (docblock only), `src-tauri/src/keychain.rs`, `src-tauri/src/lib.rs`, `src/client/keychain/keychain-invoke.ts`, `src-tauri/src/sidecar.rs`, `docs/security.md`, and the tests: `tests/server/launcher/supervisor.test.ts`, `tests/server/launcher/stream-json-protocol.test.ts`, `tests/server/launcher/supervisor-turn-delivery.test.ts`, `tests/docs/tauri-command-registration-claims.test.ts`, `tests/client/keychain-backend.test.ts`, `src-tauri/tests/keychain.rs`.

## Problem

- **4a, cwd.** `resolveCwd` (`src/server/launcher/supervisor.ts:1008`) resolves `override ?? integration.workingDirectory` through `safeCwd` → `resolveSafeCwd`, which does not confine to home. The two route resolvers do confine (`resolveRouteCwd`/`resolveRouteCwdAsync`, `:2078-2107`, via `homeConfines` `:2056`). `POST /api/integrations` (`src/server/integrations/api-routes.ts` `makePostIntegrationsHandler`) writes the whole file after a schema parse only (`workingDirectory: AbsolutePath`, `schema.ts:127`). Its gates are `assertOriginAllowlisted` (any `http://127.0.0.1:<port>` origin, `LOCALHOST_ORIGIN_RE`) and loopback. So a page on any local port can point the next spawn at `C:\Windows` or `/etc`. The `persistRequestedCwd` docblock (`:974-981`) already names the symlink-swap escape this leaves.
- **4b, env.** `spawnOnce` passes `env: childEnv()` (`:1121`). `childEnv` (`:611`) strips only `DESKTOP_ONLY_ENV_KEYS`, so `TANDEM_AUTH_TOKEN` (set by `sidecar.rs:1947`) and `TANDEM_SENTRY_DSN` (`:1967`; the real name, read by `src/server/sentry.ts:30`) reach the launched Claude and every shell it runs. Two prose sites still say the supervisor passes `env: process.env`: `docs/security.md:165` (citing `supervisor.ts:912`, stale twice over) and the `isTauriSidecar` docblock at `src/server/platform.ts:219-222`.
- **5.** `keychain_get` (`src-tauri/src/keychain.rs:59-67`) returns `Option<String>` plaintext to the WebView and is registered at `lib.rs:1696`. Since #1761 closed (`keyring = "4"`), that is a real OS-store secret. **It has no consumer.** `keychainGet` (`src/client/keychain/keychain-invoke.ts:50`) is imported nowhere: `keychain-backend.ts:28` takes only `keychainDelete`, `keychainSet` and `loadInvoke`. No `invoke("keychain_get")` exists in `src/client`. No capability file names it (`src-tauri/capabilities/*`; `build.rs` declares no app manifest). The dark BYO path (`useModels.svelte.ts`) uses only `set`/`delete`. The remaining references are three tests: `src-tauri/tests/keychain.rs:16-19`, `tests/docs/tauri-command-registration-claims.test.ts:121`, and `tests/client/keychain-backend.test.ts:111`, which feeds a `set()` test a `keychain-get:`-prefixed rejection.
- **6.** `start_sidecar` never sets `NODE_ENV`. Express's `defaultConfiguration` (`express/lib/application.js:91`) and `finalhandler` (`finalhandler/index.js:73`) default to `development`, which puts `err.stack` in HTML error pages.

## Fix

**4a. `supervisor.ts`: `safeCwd` and `resolveCwd` only, plus one opts field.**
- `safeCwd(candidate)` becomes `resolveRouteCwd(candidate, { homeOverride: opts.homeOverride })`. The route and the spawn now share one predicate.
- **This narrows the swap escape. It does not close it.** `resolveRouteCwd` realpaths and checks inside `buildPlan`, and `spawn` later `chdir`s by that path string. A directory swapped for a symlink between the realpath and the exec still lands outside home. The window shrinks from "route check to `buildPlan`" to "realpath inside `buildPlan` to spawn", and it now includes `persistRequestedCwd`'s awaited file write. Never write "closes" in code, docs or the PR body.
- The fallback cwd honours the seam: a local `fallbackCwd()` returns `resolveSafeCwd(opts.homeOverride) ?? opts.homeOverride` when the override is set, and `homeCwd()` otherwise. The exported `homeCwd` is unchanged. That keeps "treat this tmpdir as `$HOME`" consistent, and it makes the out-of-home case observable in tests.
- In `resolveCwd`, log **only when `override === undefined`**, i.e. on the integration-file path this item is about. The log fires when a string `workingDirectory` fails to resolve and just before the fallback: ``console.error(`[Launcher] workingDirectory ${sanitizeForLog(candidate)} is not a directory inside home — spawning in ${cwd}`)``. `sanitizeForLog` comes from `src/server/log-sanitize.ts` (#1987), because an HTTP caller can write that file. Override fallbacks keep being reported by `persistRequestedCwd`'s own line (`:998-1000`), so one event never logs twice, and the existing persist test stays discriminating. The launch never fails.
- Add `homeOverride?: string` to `SupervisorOpts` as a test-only seam, mirroring `resolveRouteCwd`'s. `index.ts` does not pass it.
- Rewrite the three docblocks that now say the opposite, and no other code:
  - `resolveSafeCwd`: "the permissive resolver used by integration-file reads".
  - `resolveRouteCwd`: "the integration-file path bypasses this — advanced users who hand-edit `integrations.json` opt into wider scope".
  - The "Residual TOCTOU … Home-confining here would move an HTTP-boundary policy" paragraph in `persistRequestedCwd`. **Keep the residual-TOCTOU note**, reworded as in the second bullet above: the durable write is only as confined as a check made at plan time.
- `fromOverride` semantics do not change. Overrides are already route-confined, so the stricter predicate only turns a TOCTOU into a home fallback, which `persistRequestedCwd` already logs.
- **G1 owns the rest of this file.** Touch nothing in turn delivery.
- **Policy reversal, routed to `bryan` rather than assumed.** An out-of-home `workingDirectory` in `integrations.json` (e.g. `D:\code` on Windows) now falls back to home with a log line; today it is honoured. **The bound on who this affects, measured:** the Settings folder picker saves through `POST /api/launcher/working-directory` (`SettingsClaudeCodeTab.svelte:178`), and that route already home-confines (`launcher/api-routes.ts:367`, `resolveRouteCwd`). So the Settings UI can never produce an out-of-home value. Only a hand-edited `integrations.json` or a raw `POST /api/integrations` can. The justification is #1822's F1: any `127.0.0.1`-origin page can make that raw POST. The PR body's `bryan` section carries the `D:\code` example and this bound.

**4b. `childEnv`: a denylist, never an allowlist.** An allowlist drops `PATH`, `HOME`/`USERPROFILE`, proxies, `ANTHROPIC_*`, `CLAUDE_*` and arbitrary user tool configuration, in ways no Tandem test would see.
- Add `export const TANDEM_SECRET_ENV_KEYS = ["TANDEM_AUTH_TOKEN", "CLAUDE_PLUGIN_OPTION_AUTH_TOKEN", "TANDEM_SENTRY_DSN"] as const` and delete those keys alongside `DESKTOP_ONLY_ENV_KEYS`. Leave that list and its pin test alone; they are #1787's.
- **`CLAUDE_PLUGIN_OPTION_AUTH_TOKEN`, measured.** Nothing in `src/` or `src-tauri/src/` produces it; the only readers are `src/shared/cli-runtime.ts:71` and `src/cli/rotate-token.ts:29`. A supervisor-running server therefore carries it only if an ambient copy reached it, for example a `tandem` started from a plugin-host process. It is stripped anyway, for two reasons. It is the plugin userConfig copy of Tandem's own token. And `resolveAuthTokenCandidate` ranks it above `TANDEM_AUTH_TOKEN`, so an inherited stale copy would outrank everything else a CLI in the session resolves. The plugin host sets this variable on the plugin processes it starts (`cli-runtime.ts:51`), so an inherited copy is not how it is supposed to arrive.
- Keep the `env: childEnv(),` call-site string byte-identical, because `supervisor.test.ts:1170` pins it.

Measured before stripping: on the desktop's loopback bind, nothing the launched session starts needs the env copy.
- **Auth is not needed on loopback.** `createAuthMiddleware` (`auth/middleware.ts:165-166`) calls `next()` for `isLoopback`. The sidecar binds `SIDECAR_BIND_HOST = "127.0.0.1"` (`sidecar.rs:327`).
- **Token resolution is env-only.** `resolveAuthTokenCandidate` (`cli-runtime.ts:66-78`) reads the override, then `CLAUDE_PLUGIN_OPTION_AUTH_TOKEN`, then `TANDEM_AUTH_TOKEN`, and has no token-file fallback, so no stale file can take the stripped variable's place. `.claude-plugin/plugin.json` sets only `TANDEM_URL: http://127.0.0.1:3479`, with no `${TANDEM_AUTH_TOKEN}` expansion. The reaper (`reaper/src/main.rs`) reads argv only.
- **The stdio bridge** (`src/cli/mcp-stdio.ts:346`) and **the channel shim** (`src/channel/run.ts`) go through `resolveAuthTokenCandidate`. Claude Code spawns both from config entries, and `apply.ts:489-521` writes `env.TANDEM_AUTH_TOKEN` into those entries explicitly whenever a token is in play. **The plugin monitor** (`src/monitor/run.ts`) reads only the URL. `skills/tandem/SKILL.md` names no token.
- **Implementer check before merging:** confirm in `apply.ts` and `cowork_installer.rs` that every entry written for a non-loopback bind carries its token in its own `env`. If one relies on inheritance, stop and put it in `bryan`. **Do not claim "nothing needs the env copy" beyond the loopback case.**
- **`tandem rotate-token` inside a desktop-launched session: two measured branches, both stated in the PR body.** The CLI's env-source refusal (`src/cli/rotate-token.ts:26-37`) no longer fires. #1787 already strips `TANDEM_APP_DATA_DIR`, so the CLI then reads the **npm** app-data token file (`:40`).
  - *No npm token file* (a desktop-only machine, the common case): it exits 1 at `:41-45` with "no token file found", before writing anything.
  - *An npm token file exists*: it writes the rotated file and POSTs to the sidecar. `routes/rotate-token.ts:55` answers 409, because the sidecar's own env still holds the token, and the CLI's `serverRejected` branch restores the old file.
- **Other CLI commands.** `src/cli/setup.ts` contains no token reference at all, and `doctor.ts` mentions the token only in log-scrubbing comments. So `setup --apply` and `doctor` are not token-sourced from the environment, and the strip changes nothing for them. Only the rotate-token paths above and the config-spawned bridge and shim resolve a token.
- The Sentry DSN opt-in belongs to the process the user opted in. A `tandem` started inside the session does not inherit it.

**5. Remove the getter. No handle design is needed.**
- Delete `keychain_get` from `keychain.rs`, its `generate_handler!` entry at `lib.rs:1696`, and `keychainGet` from `keychain-invoke.ts`.
- Fix the docblocks that count three commands: the `keychain.rs` header ("three Tauri commands", plus the list of error prefixes, which is where `keychain-get` appears) and the `keychain-invoke.ts` header.
- In `src-tauri/tests/keychain.rs`:
  - delete `keychain_get_rejects_empty_account` (the `set`/`delete` tests still cover the empty-account branch);
  - drop `keychain_get` from the `use`;
  - correct "set/get/delete" in the header.
- `tests/client/keychain-backend.test.ts:111`: change the rejection's prefix from `keychain-get:` to `keychain-set:` and keep the same keyring message. That matches what `keychain_set` can actually return, and the assertion does not depend on the prefix.
- `keychain_set`, `keychain_delete` and the `tandem-integrations` service are untouched, so #1761's Credential Manager persistence stands.

**6. `src-tauri/src/sidecar.rs`.**
- Change the signature to `sidecar_env_pairs(app_data_dir: &str, release_build: bool)`, pushing `("NODE_ENV", "production")` only when `release_build`. The call site becomes `sidecar_env_pairs(app_data_dir_str.as_str(), !cfg!(debug_assertions))`.
- **Debug and `cargo tauri dev` builds get no `NODE_ENV` from Rust**, so `reaperPath()`'s dev-only fallbacks (`supervisor.ts:1033-1051`) keep working.
- **What flips for a packaged sidecar.** I grepped `src/` and the dependency sources that tsup bundles. This is what those greps found, not a proof that no other read exists:
  - Express `app.get("env")` (`express/lib/application.js:91`): `finalhandler` (`finalhandler/index.js:73`) omits stacks, and `view cache` is enabled (Tandem has no views).
  - `@sentry/node-core`'s Spotlight integration (`build/esm/integrations/spotlight.js:13`) warns when `NODE_ENV` is set and is not `development`. That applies only when the integration is enabled, and `src/` contains no `spotlight` reference.
  - `supervisor.ts:1034` (already inert under `TANDEM_TAURI_SIDECAR=1`).
  - `supervisor.ts:1051`: the `reaper/target/release` fallback is disabled, while the packaged `binaries/` path is unaffected.
  - Hocuspocus compares against `'testing'` only. `server.ts:361` and `integrations/api-routes.ts:212` are comments. Nothing in `src/shared` reads it.
- **Other children of the sidecar.** `childEnv` filters only the reaper → Claude spawn (its sole call site is `supervisor.ts:1121`). Any other sidecar child that passes no explicit `env` inherits `NODE_ENV=production` and `TANDEM_AUTH_TOKEN`. **`install-claude-cli.ts` is a measured exception:** it spawns with `minimalEnv` (`:256-263`, an allowlist plus `CI=1`), so the install-claude-code route inherits neither. The PR body names this. No code change, because `claude --version`-style probes are unaffected by `NODE_ENV`.
- **The inheritance hazard.** `NODE_ENV=production` would reach the launched Claude, and `npm install` in the user's project would then silently skip devDependencies. So `childEnv` gains an `argv` parameter defaulting to `process.argv` (`childEnv(base = process.env, argv = process.argv)`). It also deletes `NODE_ENV` **when `isTauriSidecar(argv)` and `base.NODE_ENV === "production"`**. `isTauriSidecar` is `src/server/platform.ts:230`: argv-based, never the inherited `TANDEM_TAURI_SIDECAR`, and no import cycle.
  - Keying on the value, not on the sidecar alone, keeps a developer's own `NODE_ENV=development` reaching a `cargo tauri dev` session, where Rust set nothing.
  - In a packaged build, Rust always sets `production`, so this strips the value Tandem itself put there.
  - The npm path is unchanged, and a user's own `NODE_ENV` still reaches an npm-launched session.
  - The docblock states all three.

**Docs.**
- `docs/security.md:165`: the launched session inherits Tandem's environment minus `TANDEM_AUTH_TOKEN`, `CLAUDE_PLUGIN_OPTION_AUTH_TOKEN`, `TANDEM_SENTRY_DSN`, the desktop-only keys, and (desktop only) the sidecar's own `NODE_ENV=production`. Everything else, the user's own variables included, still reaches it. Keep the honest bound: an ordinary shell command can still read what remains.
- `src/server/platform.ts:219-222` (`isTauriSidecar` docblock): the launched env is `childEnv()`, which still carries `TANDEM_TAURI_SIDECAR`, so the argv rationale stands. Reword only the `env: process.env` clause.
- `docs/security.md`: record the new launcher cwd confinement, with the narrowed-not-closed wording, wherever launcher cwd is described.
- Before finishing, grep `env: process.env` across `src/` and `docs/`. Historical specs under `docs/reviews/**/specs/` are records and stay as written. `src/cli/start.ts:45` is a different spawn and out of scope.
- Run `tests/docs/security-findings-claims.test.ts` and `tests/docs/loopback-gate-claims.test.ts`.

## Tests

1. `tests/server/launcher/supervisor.test.ts`, `childEnv`:
   - **Denylist.** The base carries `TANDEM_AUTH_TOKEN`, `CLAUDE_PLUGIN_OPTION_AUTH_TOKEN`, `TANDEM_SENTRY_DSN`, `PATH`, `ANTHROPIC_API_KEY`, `HTTPS_PROXY` and an arbitrary `SOME_USER_TOOL_CONFIG: "x"`. The three secrets are gone and the other four survive. **Only a denylist passes the arbitrary key.** An allowlist of `PATH|ANTHROPIC_*|*_PROXY` fails it, and a missing secret key fails the first half.
   - **`NODE_ENV`, stripped.** Argv contains `--tauri-sidecar`, and the base is `{ NODE_ENV: "production" }` with **no** `TANDEM_TAURI_SIDECAR`. `NODE_ENV` is absent. This kills a missing strip and an implementation keyed on the env var.
   - **`NODE_ENV`, kept (env var set, flag absent).** Argv lacks the flag, and the base is `{ NODE_ENV: "production", TANDEM_TAURI_SIDECAR: "1" }`. `NODE_ENV` survives. This kills an env-var-keyed or unconditional strip.
   - **`NODE_ENV`, kept (dev value).** Argv contains the flag, and the base is `{ NODE_ENV: "development" }`. It survives. This kills a value-blind strip under the sidecar.
2. **cwd confinement, in `tests/server/launcher/stream-json-protocol.test.ts`, asserting `spawnRec.cwd`.** Not `supervisor.test.ts`'s `status().cwd`: `cwd` exists only on the `running: true` arm (`supervisor.ts:348-355`), and the `:727` reaper pattern exits immediately, so that read races. Set `fakeHome = realpath(mkdtemp)` and copy the stub into it under the pid name, the way `beforeEach` does for `spawnDir`.
   - **Out of home.** `writeClaudeIntegration(outsideDir)`, where `outsideDir` is a sibling tmpdir outside `fakeHome` that also holds the stub, then `createSupervisor({ integrationsBase: tmpDir, homeOverride: fakeHome })` → `startFresh()` with no override. `spawnRec.cwd === fakeHome`. A `console.error` spy sees exactly one line containing `not a directory inside home`. This kills the missing confinement and a dropped log. **This case is also the local (Windows) proof that the seam is honoured**, because `outsideDir` is outside `fakeHome` on every OS.
   - **Inside home.** `writeClaudeIntegration(insideDir)`, where `insideDir` is a subdirectory of `fakeHome` holding the stub. `spawnRec.cwd === fs.realpathSync(insideDir)`, and no `not a directory inside home` line appears. This kills over-confinement and a comparison against the unresolved path.
   - **An override fallback does not emit the new line.** The existing persist case at `:1086-1095` gets one more assertion: no `console.error` argument contains `not a directory inside home`. This kills logging on the override path, which would double-log.
   - **Tighten `:1094`.** The persist case's `includes(gone)` becomes a match on persist's own text: a call containing both `gone` and `could not be resolved`. Otherwise deleting `persistRequestedCwd`'s `console.error` (`:998-1000`) stays green whenever any other line mentions the path.
3. `stream-json-protocol.test.ts` (the `extra` spread at `:112` and the bare `createSupervisor` calls) and `supervisor-turn-delivery.test.ts` pass `homeOverride: fs.realpathSync(os.tmpdir())`. **That redness is observable only on the ubuntu `check` leg**, where `/tmp` is outside `$HOME`. On Windows, `os.tmpdir()` is `%LOCALAPPDATA%\Temp`, inside home, so those specs stay green without the seam. As a local check, point the helper's `homeOverride` at an unrelated tmpdir once and confirm the stub-spawn specs go red, then restore it. Test 2's out-of-home case is the local proof.
4. `tests/docs/tauri-command-registration-claims.test.ts:121`: `toContain("keychain_get")` becomes `toContain("keychain_set")`. Add `expect(registered).not.toContain("keychain_get")`, because re-registering the command compiles and passes everything else.
5. `sidecar.rs`:
   - `sidecar_env_pairs_exports_both_data_dir_variables` passes `true` and asserts `NODE_ENV == Some("production")`.
   - A new case with `false` asserts `NODE_ENV` is absent. This kills setting it in dev.
   - `start_sidecar_folds_the_env_pairs_onto_the_command` asserts the body contains the whole call expression `sidecar_env_pairs(app_data_dir_str.as_str(), !cfg!(debug_assertions))`, not the bare `!cfg!(debug_assertions)`. This kills a hard-coded `true` next to an unrelated negated `cfg!`.
6. Mutation-test each of these. Watch the named test go red, and restore from a file copy, never `git checkout`:

   | Mutation (revert or change) | Must go red |
   |---|---|
   | `safeCwd` back to `resolveSafeCwd` | Test 2, out of home |
   | the `fallbackCwd` seam (use `homeCwd()`) | Test 2, out of home |
   | the `override === undefined` log gate | Test 2, override-fallback case |
   | the new log line deleted | Test 2, out of home |
   | `persistRequestedCwd`'s `console.error` deleted | the tightened `:1094` |
   | each of the three secret-key deletes | Test 1, denylist |
   | the `NODE_ENV` delete, and the `=== "production"` term | Test 1, `NODE_ENV` cases |
   | the registration removal | Test 4 |
   | the `release_build` guard | Test 5, the `false` case |
   | the call expression | Test 5, the fold test |

## Done when

- Every case above is green.
- `npm run typecheck`, `npm run typecheck:tests`, vitest and `cargo test` pass.
- The PR body carries:
  - the `NODE_ENV` flip set, together with the other-children note;
  - the two rotate-token branches;
  - a `bryan` item for the cwd policy reversal (the `D:\code` example and the Settings-UI bound);
  - the CI legs: vitest on ubuntu `check`, where test 3's redness is observable only on that leg, and the `cargo test` sidecar and keychain cases on all three `rust-test` legs.
- `#1822` stays Refs.

## Not in scope

- Items 1-3 and 7-8.
- The `reaperPath` belt-and-braces check.
- `TANDEM_TAURI_SIDECAR` inheritance (#1787 kept it deliberately).
- `docs/roadmap.md:478`, a historical row that still names `keychain_get`.
- Any handle or proxy design for keychain reads.
- Filtering env for sidecar children other than the launched Claude.

## Review corrections (round 1)

**Adopted**
- BLOCKING, the new `resolveCwd` log made the persist test non-discriminating. Adopted both options: the log is gated on `override === undefined`, `:1094` now matches `could not be resolved`, a new assertion says an override fallback does not emit the new line, and all three are in the mutation table.
- "Closes the swap escape" was an overclaim, raised twice. Reworded to narrowed, not closed; the residual-TOCTOU note is kept and reworded.
- The policy reversal moved from Assumption to `bryan`, with the measured Settings-UI bound (`SettingsClaudeCodeTab.svelte:178` → `launcher/api-routes.ts:367`).
- `CLAUDE_PLUGIN_OPTION_AUTH_TOKEN` added to the denylist, with its producer and reader measurement.
- Rotate-token now describes both branches (early exit without an npm token file; write, 409 and restore with one).
- Other sidecar children: stated in the PR body, with the measured `install-claude-cli.ts` `minimalEnv` exception.
- `NODE_ENV` strip under dev: now keyed on `isTauriSidecar(argv) && base.NODE_ENV === "production"`, documented in the docblock.
- "Complete read set" dropped. The grep now covers bundled dependencies: Express, `finalhandler`, Sentry Spotlight and Hocuspocus.
- `keychain-backend.test.ts:111` prefix changed to `keychain-set:` (raised twice).
- Stale `env: process.env` prose: the `platform.ts` docblock was added, plus a grep step.
- Test 1: an arbitrary user key kills an allowlist; the kept case carries `TANDEM_TAURI_SIDECAR: "1"` and the stripped case omits it; a dev-value case was added.
- Test 2 moved to `stream-json-protocol.test.ts` and asserts `spawnRec.cwd` and the log text, avoiding the `status().cwd` race. The fallback honours `homeOverride` so the result is observable.
- Test 3: redness is observable only on ubuntu `check`; the local proof is named.
- Test 5 asserts the whole call expression (raised twice).
- The verified-safe token strip is recorded with its evidence (loopback `next()`, env-only resolution, the plugin manifest, the reaper's argv-only input). No code change.

**Not adopted**
- `setup --apply` and `doctor` "fall back to the npm token file". The claim is not supported by the code. `src/cli/setup.ts` contains no token reference, and `resolveAuthTokenCandidate` (`cli-runtime.ts:66-78`) has no file fallback. Only `rotate-token.ts:40` reads the token file, and its branches are now stated. The spec records that `setup` and `doctor` are not env-token-sourced.
- The install-claude-code route inheriting `NODE_ENV` and the token. Refuted for that route: `install-claude-cli.ts:256-263` spawns with an allowlisted `minimalEnv`. The general "other children inherit" note is adopted.
