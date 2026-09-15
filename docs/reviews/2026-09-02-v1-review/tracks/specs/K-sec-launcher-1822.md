# K-sec-launcher — #1822 items 4, 5, 6: launcher cwd confinement, no Tandem secrets in the launched env, no `keychain_get`, `NODE_ENV=production` at sidecar spawn

Branch `fix/security-lows-launcher-half-confined-launcher-cwd-no-tandem-secrets-in-the-launched-env-no-plaintext-keychain-read-production-sidecar-and-a-locked-cowork-scrub-1822`. **Refs #1822 only, never Closes.** Items 1-3 shipped in #1987, item 7 needs no change, and item 8 still carries two recommendations awaiting Bryan (comment of 2026-09-11). Ledger: `docs/reviews/2026-09-02-v1-review/areas/security.md:22-24`. Probe: source read, re-verified on `f8979bc0`. Every line number in the issue body is stale.

## Problem

- **4a, cwd.** `resolveCwd` (`src/server/launcher/supervisor.ts:1008`) resolves `override ?? integration.workingDirectory` through `safeCwd` → `resolveSafeCwd`, which does not confine to home. The two route resolvers do confine (`resolveRouteCwd`/`resolveRouteCwdAsync`, `:2078-2107`, via `homeConfines` `:2056`). `POST /api/integrations` (`src/server/integrations/api-routes.ts` `makePostIntegrationsHandler`) writes the whole file after a schema parse only (`workingDirectory: AbsolutePath`, `schema.ts:127`). Its gates are `assertOriginAllowlisted` (any `http://127.0.0.1:<port>` origin, `LOCALHOST_ORIGIN_RE`) and loopback. So a page on any local port can point the next spawn at `C:\Windows` or `/etc`. The `persistRequestedCwd` docblock (`:974-981`) already names the symlink-swap escape this leaves.
- **4b, env.** `spawnOnce` passes `env: childEnv()` (`:1121`). `childEnv` (`:611`) strips only `DESKTOP_ONLY_ENV_KEYS`, so `TANDEM_AUTH_TOKEN` (set by `sidecar.rs:1947`) and `TANDEM_SENTRY_DSN` (`:1967`; the real name, read by `src/server/sentry.ts:30`) reach the launched Claude and every shell it runs. `docs/security.md:165` still says `env: process.env` at `supervisor.ts:912`, which is stale twice over.
- **5.** `keychain_get` (`src-tauri/src/keychain.rs:59-67`) returns `Option<String>` plaintext to the WebView and is registered at `lib.rs:1696`. Since #1761 closed (`keyring = "4"`), that is a real OS-store secret. **It has no consumer.** `keychainGet` (`src/client/keychain/keychain-invoke.ts:50`) is imported nowhere: `keychain-backend.ts:28` takes only `keychainDelete`, `keychainSet` and `loadInvoke`. No `invoke("keychain_get")` exists in `src/client`. No capability file names it (`src-tauri/capabilities/*`; `build.rs` declares no app manifest). The dark BYO path (`useModels.svelte.ts`) uses only `set`/`delete`. The only other references are two tests: `src-tauri/tests/keychain.rs:16-19` and `tests/docs/tauri-command-registration-claims.test.ts:121`.
- **6.** `start_sidecar` never sets `NODE_ENV`. Express's `defaultConfiguration` and `finalhandler` default to `development`, which puts `err.stack` in HTML error pages.

## Fix

**4a. `supervisor.ts`: `safeCwd` and `resolveCwd` only, plus one opts field.**
- `safeCwd(candidate)` becomes `resolveRouteCwd(candidate, { homeOverride: opts.homeOverride })`. That is one predicate for the route and the spawn, and it closes the swap escape.
- In `resolveCwd`, when `candidate` is a string that does not resolve, log once before the `homeCwd()` fallback and keep that fallback: ``console.error(`[Launcher] workingDirectory ${sanitizeForLog(candidate)} is not a directory inside home — spawning in ${cwd}`)``. `sanitizeForLog` is from `src/server/log-sanitize.ts` (#1987), because the value comes from a file an HTTP caller can write. The launch never fails.
- Add `homeOverride?: string` to `SupervisorOpts` as a test-only seam, mirroring `resolveRouteCwd`'s. `index.ts` does not pass it.
- Rewrite the three docblocks that now state the opposite, and no other code: `resolveSafeCwd` ("the permissive resolver used by integration-file reads"), `resolveRouteCwd` ("the integration-file path bypasses this"), and the "Residual TOCTOU … Home-confining here would move an HTTP-boundary policy" paragraph in `persistRequestedCwd`.
- `fromOverride` semantics do not change. Overrides are already route-confined, so the stricter predicate only turns a TOCTOU into a home fallback, which `persistRequestedCwd` already logs.
- **G1 owns the rest of this file.** Touch nothing in turn delivery.
- **Assumption, and a policy reversal for Bryan.** An out-of-home `workingDirectory` hand-edited into `integrations.json` (e.g. `D:\code` on Windows) now falls back to home with a log line. Today it is honoured.

**4b. `childEnv`: a denylist, never an allowlist.** An allowlist drops `PATH`, `HOME`/`USERPROFILE`, proxies, `ANTHROPIC_*` and `CLAUDE_*` in ways no Tandem test sees.
- Add `export const TANDEM_SECRET_ENV_KEYS = ["TANDEM_AUTH_TOKEN", "TANDEM_SENTRY_DSN"] as const` and delete those keys alongside `DESKTOP_ONLY_ENV_KEYS`. Leave that list and its pin test alone; they are #1787's.
- Keep the `env: childEnv(),` call-site string byte-identical, because `supervisor.test.ts:1170` pins it.

Measured before stripping: nothing the launched session starts needs the env copy.
- **Auth is not needed on loopback.** `createAuthMiddleware` (`auth/middleware.ts`) calls `next()` for `isLoopback`. The sidecar binds `SIDECAR_BIND_HOST = "127.0.0.1"` (`sidecar.rs:327`).
- **The stdio bridge** (`src/cli/mcp-stdio.ts:346`) and **the channel shim** (`src/channel/run.ts`) resolve the token through `resolveAuthTokenCandidate`. They are spawned by Claude Code from config entries, and `apply.ts:489-521` writes `env.TANDEM_AUTH_TOKEN` into those entries explicitly when a token is in play. **The plugin monitor** (`src/monitor/run.ts`) reads only the URL. `skills/tandem/SKILL.md` names no token.
- **Implementer check before merging:** confirm in `apply.ts` and `cowork_installer.rs` that every entry written for a non-loopback bind carries its token in the entry's own `env`. If one relies on inheritance, stop and put it in `bryan`.
- **`tandem rotate-token` inside a desktop-launched session** changes where it is refused. The CLI's env-source refusal (`src/cli/rotate-token.ts:24-37`) no longer fires. It then writes the npm app-data token file (the desktop root is already stripped by #1787) and POSTs to the sidecar. `routes/rotate-token.ts:55` answers 409, because the sidecar's own env still holds the token, and the CLI's `serverRejected` branch restores the old file. State this in the PR body.
- The Sentry DSN opt-in belongs to the process the user opted in. A `tandem` started inside the session does not inherit it.

**5. Remove the getter. No handle design is needed.**
- Delete `keychain_get` from `keychain.rs`, its `generate_handler!` entry at `lib.rs:1696`, and `keychainGet` from `keychain-invoke.ts`.
- Fix the docblocks that count three commands: the `keychain.rs` header ("three Tauri commands", and the list of error prefixes, where `keychain-get` goes) and the `keychain-invoke.ts` header. In `src-tauri/tests/keychain.rs`, delete `keychain_get_rejects_empty_account` (the empty-account branch stays covered by the `set`/`delete` tests), drop `keychain_get` from its `use`, and correct "set/get/delete" in its header.
- `keychain_set`, `keychain_delete` and the `tandem-integrations` service are untouched, so #1761's Credential Manager persistence stands.

**6. `src-tauri/src/sidecar.rs`.**
- Change the signature to `sidecar_env_pairs(app_data_dir: &str, release_build: bool)`, pushing `("NODE_ENV", "production")` only when `release_build`. The call site becomes `sidecar_env_pairs(app_data_dir_str.as_str(), !cfg!(debug_assertions))`.
- **Debug and `cargo tauri dev` builds get no `NODE_ENV`**, so `reaperPath()`'s dev-only fallbacks (`supervisor.ts:1033-1051`) keep working.
- What flips for a packaged sidecar is the complete `NODE_ENV` read set:
  - Express `app.get("env")`, which makes `finalhandler` omit stacks and enables `view cache` (Tandem has no views);
  - `supervisor.ts:1034` (already inert under `TANDEM_TAURI_SIDECAR=1`);
  - `supervisor.ts:1051`, where the `reaper/target/release` fallback is disabled, while the packaged `binaries/` path is unaffected.
  - Hocuspocus reads only `'testing'`. `server.ts:361` and `integrations/api-routes.ts:212` are comments. Nothing in `src/shared` reads it.
- **The inheritance hazard.** `NODE_ENV=production` would reach the launched Claude, and `npm install` in the user's project would then silently skip devDependencies. So `childEnv` gains an `argv` parameter defaulting to `process.argv` and also deletes `NODE_ENV` when `isTauriSidecar(argv)` (`src/server/platform.ts:230`, argv-based, no import cycle). The npm path is unchanged, and a user's own `NODE_ENV` still reaches an npm-launched session.

**Docs.**
- `docs/security.md:165`: the launched session inherits Tandem's environment minus `TANDEM_AUTH_TOKEN`, `TANDEM_SENTRY_DSN` and the desktop-only keys. Everything else, the user's own variables included, still reaches it.
- `docs/security.md`: record the new confinement wherever launcher cwd is described.
- Run `tests/docs/security-findings-claims.test.ts` and `tests/docs/loopback-gate-claims.test.ts`.

## Tests

1. `tests/server/launcher/supervisor.test.ts`, `childEnv`:
   - `TANDEM_AUTH_TOKEN` and `TANDEM_SENTRY_DSN` are stripped while `PATH`, `ANTHROPIC_API_KEY` and `HTTPS_PROXY` survive. This kills an allowlist and a missing key.
   - `NODE_ENV` is stripped with `--tauri-sidecar` in argv and kept without it. This kills an unconditional strip and a missing strip.
2. The same file, cwd, using `createSupervisor({ integrationsBase, homeOverride: fakeHome, … })`, `TANDEM_REAPER_PATH=process.execPath` (the `:727` pattern), and `sup.start()` then `status().cwd`:
   - A `workingDirectory` in a sibling tmpdir outside `fakeHome` gives a cwd equal to `homeCwd()`, plus the warn line. This kills the missing confinement.
   - A `workingDirectory` inside `fakeHome` is honoured, realpath'd. This kills over-confinement and unresolved-path comparison.
3. `tests/server/launcher/stream-json-protocol.test.ts` (its `extra` spread at `:112` and the bare `createSupervisor` calls) and `supervisor-turn-delivery.test.ts` pass `homeOverride: fs.realpathSync(os.tmpdir())`. On ubuntu `/tmp` is outside `$HOME`, so without the seam these specs go red. That redness is itself proof the confinement applies.
4. `tests/docs/tauri-command-registration-claims.test.ts:121`: `toContain("keychain_get")` becomes `toContain("keychain_set")`. Add `expect(registered).not.toContain("keychain_get")`, because re-registering compiles and passes everything else.
5. `sidecar.rs`:
   - `sidecar_env_pairs_exports_both_data_dir_variables` passes `true` and asserts `NODE_ENV == Some("production")`.
   - A new case with `false` asserts `NODE_ENV` is absent. This kills setting it in dev.
   - `start_sidecar_folds_the_env_pairs_onto_the_command` also asserts the body contains `!cfg!(debug_assertions)`. This kills a hard-coded `true`.
6. Mutation-test each case by reverting `safeCwd`, the two key deletes, the `NODE_ENV` delete, the registration removal and the `release_build` guard. Watch the named test go red, and restore from a file copy.

## Done when

The cases above are green. `npm run typecheck`, `npm run typecheck:tests`, vitest and `cargo test` pass. The PR body lists the `NODE_ENV` flip set, the rotate-token path and the CI legs: vitest on ubuntu; `cargo test` sidecar and keychain cases on the three `rust-test` legs. `#1822` stays Refs.

## Not in scope

- Items 1-3 and 7-8.
- The `reaperPath` belt-and-braces check.
- `TANDEM_TAURI_SIDECAR` inheritance (#1787 kept it deliberately).
- `docs/roadmap.md:478`, a historical row that still names `keychain_get`.
- Any handle or proxy design for keychain reads.
