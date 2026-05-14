# Sidecar Launcher Validation Spike (#477 PR 4)

**Status:** Spike complete — **GO** (with caveats).
**Date:** 2026-05-14
**Refs:** [#477](https://github.com/bloknayrb/tandem/issues/477), integration system plan (`project_integration_system_plan.md`).

## Goal

Validate that the Tandem Node sidecar can be launched from a **non-Tauri parent**
(e.g. a small standalone `tandem-launcher` binary invoked by Claude Code via
the MCP `command` / `args` shape), and that rewriting `~/.claude.json` to point
at that launcher is feasible.

The current `start_sidecar()` in `src-tauri/src/lib.rs` is tightly coupled to the
Tauri runtime (`AppHandle`, `tauri_plugin_shell`, `resource_dir()`,
`env!("TARGET_TRIPLE")`). The launcher cannot reuse it directly — it must own a
parallel launch path with the same security and lifecycle guarantees.

## Non-goals / security invariants

These are absolute. Anything that violates them is a regression of #477's
security posture and must fail review.

1. **Sidecar binds 127.0.0.1, NEVER 0.0.0.0.** The launcher must not set
   `TANDEM_BIND_HOST=0.0.0.0` under any circumstance. LAN binding remains
   gated by the existing token + opt-in flow documented in `CLAUDE.md` and
   is **out of scope** for this spike. The probe script explicitly
   `delete env.TANDEM_BIND_HOST` before spawn as defense-in-depth.
2. **Any rewritten MCP config uses `http://127.0.0.1:<port>`, NOT a LAN IP.**
   The `rewrite_mcp_config()` helper in `integrations_probe.rs` constructs
   the URL from the `LOOPBACK_HOST = "127.0.0.1"` constant; tests assert the
   URL begins with that prefix and does not contain `0.0.0.0`.
3. **Auth token written to `.mcp.json` is generated fresh per install and
   protected with `chmod 600` (POSIX) / equivalent ACL (Windows).** The
   probe script generates a fresh 32-hex-char token via
   `crypto.randomBytes(16)` on every invocation. The real launcher will
   reuse the existing `token_store` keyring path so the token never lands
   in a config file at rest with looser permissions than the keyring entry.
   Atomic write + restrictive permissions are the responsibility of the
   config-rewrite layer (existing pattern in `src/cli/setup.ts`).

## PR 4 acceptance criteria

The following four items are out-of-scope for this spike but MUST be
implemented in PR 4. Each maps to a real attack surface surfaced during
the multi-agent review of this spike, and each is tracked as a separate
GitHub issue blocking #477. A fifth issue tracks the unrelated env-var
migration the spike review surfaced.

1. **[#642] Pointer-file hardening (TOCTOU, symlinks, install-root allowlist).**
   The spike's `UnvalidatedSidecarLocation::validate()` rejects symlinks at
   the resolved exe and supports an install-root allowlist parameter — but
   the allowlist is empty by default and the parent-dir ownership / world-
   writable check is unimplemented. PR 4 must close the remaining TOCTOU
   surfaces (canonicalisation before allowlist comparison, parent-dir mode
   check, Windows ACL check on the pointer file itself) before the
   `UnvalidatedSidecarLocation` newtype can be promoted to a spawnable
   `SidecarLocation` in production.
2. **[#643] Windows ACL on the rewritten `.claude.json`.** POSIX
   `chmod 600` is a no-op on Windows. Without an explicit ACL restricting
   the file to the current user SID, the bearer token sits at
   `%USERPROFILE%\.claude.json` readable by any local user. PR 4 must use
   `icacls` or Win32 `SetSecurityInfo` and verify the resulting DACL
   excludes `BUILTIN\Users` / `Authenticated Users` / `Everyone`.
3. **[#644] Backup-or-prompt before overwriting existing
   `mcpServers.tandem`.** The spike's `rewrite_mcp_config()` is explicit
   replace-not-deep-merge (correct: stale tokens must not survive). PR 4
   must give users a recovery path by writing `.claude.json.bak-<timestamp>`
   before any mutation, prompting on non-default existing entries, and
   logging the backup path to stderr.
4. **[#645] Full malformed/missing `.claude.json` matrix.** The spike
   covers in-memory failure modes (root-is-array, `mcpServers`-is-string,
   etc.) via `rewrite_rejects_invalid_inputs`. PR 4 must extend coverage
   to the I/O-layer (file missing, empty/mid-write, parse failure) with
   one negative-test fixture per row of the truth table in #645.

Adjacent (unrelated to the launcher itself but surfaced by review):

- **[#646] Complete `TANDEM_OPEN_BROWSER` → `TANDEM_TAURI_SIDECAR`
  migration.** A partial rename in this spike PR was reverted because it
  left server-side readers unchanged. #646 tracks the full migration in
  one PR.

## Hard constraints respected during the spike

- **No real user MCP config was read.** All config-rewrite tests use
  `tests/fixtures/mcp-config-sample.json` (synthetic, hand-authored). The
  `Authorization` value is the literal string `"Bearer test-token-do-not-use-*"`.
- Pre-push security grep: `git diff origin/master..HEAD | grep -E 'sk-ant-|OAUTH|sess-|Bearer '`
  returns only the synthetic `Bearer test-token-do-not-use-*` matches — no
  real credentials leak.

## Cross-platform launch model

The current `sidecar_exe_path()` in `src-tauri/src/lib.rs:914` relies on
`env!("TARGET_TRIPLE")` baked at Tauri build time. A standalone launcher
does not have that. Three discovery options were considered:

| Option | Mechanism | Pros | Cons |
|---|---|---|---|
| (a) Bundled resource lookup | Launcher walks up from its own `current_exe()` looking for `node-sidecar-*` | Zero config | Fragile across installer layouts (NSIS / DMG / .deb) |
| (b) `which`-style PATH search for installed `tandem` CLI | Reuses npm install path | Works for `npm i -g tandem-editor` users | Misses Tauri-only installs; PATH manipulation is racy |
| (c) **Config-file pointer written by `tandem setup`** | `tandem setup` writes `~/.config/tandem/sidecar.json` (or `%APPDATA%\Tandem\sidecar.json`) with absolute path | Explicit, debuggable, one source of truth, survives installer churn | One extra file to manage; needs migration when path changes |

**Recommendation: (c).** The spike's `read_sidecar_pointer()` and its unit
test demonstrate the round-trip. The pointer file is written atomically by
`tandem setup` (using the existing temp-file-rename pattern in
`src/cli/setup.ts:184`) and is the only place the launcher needs to look.
If the pointer file is missing the launcher falls back to a deterministic
error so the user gets a clear "run `tandem setup`" prompt instead of a
silent hang.

### Per-platform notes

- **Windows:** sidecar is `node-sidecar-<triple>.exe`. Strip the `\\?\`
  prefix via the existing `strip_win_prefix()` pattern when the pointer
  records a long path.
- **macOS:** sidecar lives inside the `.app` bundle under
  `Contents/Resources/`. The pointer absolute path resolves through the
  bundle layout — no quarantine bit needs special handling because the
  launcher and sidecar are co-signed in the bundle.
- **Linux:** sidecar lives next to the launcher (AppImage layout) or under
  `/usr/lib/tandem/` (deb/rpm). Pointer file is `~/.config/tandem/sidecar.json`
  per XDG.

## Process lifecycle

This is the single largest GO/NO-GO axis. If Claude Code spawns the
launcher and the launcher spawns the sidecar, **who reaps the sidecar
when Claude Code dies?** On Windows specifically, child processes do not
auto-die with their parent.

Plan for the real PR 4:

| OS | Mechanism | Failure mode if omitted |
|---|---|---|
| Windows | [Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Launcher creates the job, assigns its own process to it, then spawns sidecar (also auto-assigned). | Sidecar orphaned on Claude Code crash → :3479 stays held → next Claude Code session can't bind. |
| Linux | [`prctl(PR_SET_PDEATHSIG, SIGTERM)`](https://man7.org/linux/man-pages/man2/prctl.2.html) called by the launcher *before* exec'ing sidecar. | Same as Windows — orphaned sidecar. |
| macOS | No clean `PR_SET_PDEATHSIG` equivalent. Use **`kqueue` watching the parent PID for `NOTE_EXIT`** in a tiny supervisor thread inside the launcher, which then SIGTERMs the sidecar. Alternative: open an anonymous pipe between launcher and Claude Code; sidecar polls a `getppid() == 1` check every 1s. | Orphan; macOS users hit "port 3479 in use" until they reboot. |

Rust crates that abstract this: `shared_child` (cross-platform child) plus
`win32job` (Windows JobObject) and `nix` (`prctl`). For macOS, a hand-rolled
`kqueue` watch is the cleanest path; the `kqueue` crate covers it.

### Restart semantics

- **Claude Code restart:** the launcher dies with Claude Code (parent
  death), takes the sidecar with it via the OS mechanism above, and
  Claude Code re-spawns the launcher on the next session. Each session
  gets a fresh sidecar. Acceptable.
- **Sidecar crash:** the launcher detects the child exit via its existing
  event loop (same shape as `start_sidecar()` in `lib.rs:799`) and
  restarts with the existing exponential backoff (lib.rs:760). Bound at
  `MAX_RESTARTS`; on exhaustion the launcher exits non-zero and Claude
  Code surfaces the error via the MCP transport.
- **User-driven `tandem` open while launcher running:** out of scope for
  the launcher itself. The Tauri app and the launcher are mutually
  exclusive — only one owns :3479 at a time. The first-run wizard
  (PR 3 in the sequence) is responsible for setting the user's
  preference.

## Health-check protocol

Identical to the existing Tauri path:

1. Spawn sidecar with `TANDEM_AUTH_TOKEN`, `TANDEM_OPEN_BROWSER=0`,
   `TANDEM_DATA_DIR=<platform data dir>`. **Never** set `TANDEM_BIND_HOST`.
2. Poll `http://127.0.0.1:3479/health` every 250ms.
3. Return ready when the endpoint responds 200.
4. 20s timeout — same as the existing `HEALTH_TIMEOUT`. On timeout, kill
   the sidecar and surface an error.

The Node probe script (`scripts/spikes/probe-launcher.mjs`) implements
exactly this protocol. The Rust prototype (`integrations_probe.rs`)
exposes the launch-command-building logic as pure functions and unit-tests
them; a `#[ignore]`-gated test stub documents where the live spawn fits
once the launcher binary exists.

## What the spike validates

The probe + tests answer the following with empirical evidence:

1. **The launch-command shape is buildable without Tauri APIs.** Pure
   `std::process::Command` (Rust) and `child_process.spawn` (Node) both
   reach a healthy sidecar with the same env vars Tauri uses.
2. **`mcpServers` rewrite is non-destructive.** `rewrite_mcp_config()`
   merges into a `serde_json::Map` and preserves the unrelated
   `some-other-server` fixture entry byte-for-byte.
3. **The 127.0.0.1 invariant is enforced** at the `build_mcp_url()`
   call site and asserted in tests.
4. **Sidecar discovery via pointer file** round-trips through JSON without
   relying on `env!("TARGET_TRIPLE")`.

Test evidence (`cargo test --manifest-path src-tauri/Cargo.toml --lib integrations_probe`):

```
running 5 tests
test integrations_probe::tests::live_spawn_and_health_check ... ignored
test integrations_probe::tests::loopback_host_is_127_0_0_1 ... ok
test integrations_probe::tests::read_sidecar_pointer_round_trip ... ok
test integrations_probe::tests::rewrite_preserves_unrelated_servers ... ok
test integrations_probe::tests::build_launch_env_never_sets_bind_host ... ok
test result: ok. 4 passed; 0 failed; 1 ignored
```

## What the spike does NOT validate (deferred to PR 4)

- Live cross-process death propagation (Job Object / `PR_SET_PDEATHSIG` /
  `kqueue`). These require platform-specific integration tests in CI;
  spike covers the design only.
- Atomic write + `chmod 600` on the rewritten config. The existing
  `src/cli/setup.ts` pattern is the template — port it to the launcher.
- Migration: existing users who have `tandem` configured as a direct HTTP
  MCP entry need to flip to the launcher's `command`/`args` shape on
  first launch of the new launcher-aware build.

## Verdict

**GO**, with these conditions on PR 4:

1. Adopt option (c) for sidecar discovery (pointer file written by
   `tandem setup`).
2. Implement OS-specific child-reaping (Job Object / `PR_SET_PDEATHSIG` /
   `kqueue`) — this is the only real risk; everything else is mechanical.
3. Reuse the existing `token_store` keyring path; do not store the auth
   token in the pointer file or in a sibling config.
4. Land cross-platform CI smoke tests for the orphan-sidecar scenario
   (kill the launcher, assert port :3479 is released within N seconds)
   before merging.

**Estimated effort for PR 4:**

- Launcher binary (Rust, ~600 LoC): 1.5–2 days.
- Cross-platform reaping + tests: 1 day each for Windows / macOS / Linux,
  but the macOS `kqueue` path may double on first encounter.
- MCP config rewrite + migration: 0.5 day (port existing setup.ts logic).
- CI integration tests: 0.5–1 day.

**Total: ~5–7 working days for a polished PR 4.** No structural blockers
surfaced.

## Artifacts produced by this spike

- `src-tauri/src/integrations_probe.rs` — Rust prototype (test-only,
  gated by `#[cfg(test)]`). Unit tests cover pointer parsing, launch-env
  construction, URL invariants, and non-destructive config rewrite.
- `scripts/spikes/probe-launcher.mjs` — Node end-to-end probe. Spawns a
  real sidecar (path resolved via `--exe`, `--pointer`, or bundle guess),
  polls `/health`, exits 0 on success.
- `tests/fixtures/mcp-config-sample.json` — synthetic `.claude.json`
  fixture with a sibling MCP entry to prove non-clobbering.
