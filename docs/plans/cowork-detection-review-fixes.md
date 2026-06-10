# Plan: PR #1110 review-fix batch (Cowork detection airtight)

> **Agent feedback incorporated** (3 adversarial reviews, all APPROVE-WITH-CHANGES):
> - **C1.** `cowork_installer.rs` IS `#![cfg(target_os="windows")]`. The Fix-2 rationale
>   "not windows-gated so tests run on all platforms" was WRONG — moved-helper tests are
>   windows-only, which is fine/consistent with the rest of the module (windows-latest CI
>   leg + local). Keep the move (test home + `TANDEM_PLUGIN_ID`); corrected rationale.
> - **C2.** `lib.rs` has no `use cowork_installer::WriteStatus` — fully-qualify every variant
>   (`cowork_installer::WriteStatus::Ok | ...::AlreadyPresent | ...::Failed(...)`) in the
>   heal loop, matching existing lib.rs style.
> - **C3 (Fix 3).** `check_acl` has NO reparse check at its top — it has a
>   `#[cfg(any(test, feature="cowork-test-hooks"))] TANDEM_COWORK_ROOT_OVERRIDE` block
>   (lines 109-124). RETAIN that block at the top of `check_acl`, above `allowed_roots`;
>   only the candidate-canonicalize + root-loop moves into `check_acl_against`. The reparse
>   guard lives in `check_path_safe` (a different path), not `check_acl`.
> - **Doc.** Update ADR-044 **§6** (not just §5) — the "once-per-process, failing workspaces
>   don't loop" text is now false for retryable outcomes. Draft the `cowork_heal_pass` doc
>   comment + CLAUDE.md gotcha text explicitly (below).
> - **Fix 5.** `claude_desktop_detected_under(packages_dir, roaming_config_dir)` — `packages_dir`
>   must already include the `Packages` suffix (mirror `roots_under`; public fn passes
>   `dirs::data_local_dir().map(|d| d.join("Packages"))`).
> - **Coverage gap (documented, follow-up issue).** The heal *loop orchestration*
>   (find→filter→install→terminal-mark glue) stays untested (keychain + env-paths meta not
>   injectable). `heal_outcome_is_terminal` + `workspace_has_tandem_entry` carry the
>   regression-prone logic and ARE tested. File a follow-up to extract an injectable
>   `heal_pass_inner` for deeper coverage. Add a lessons-learned entry for the
>   "classify-before-marking in background retry guards" pattern.
> - **N3 (pre-existing, out of scope).** Heal classifies terminal/installed from
>   `installed_plugins` only (ignores `known_marketplaces`/`cowork_settings`). Pre-existing,
>   low-harm (installed_plugins is the token-bearing file). Noted, not changed.


Fixes for the findings from the `/pr-review-toolkit:review-pr` pass on PR #1110
(branch `feat/cowork-detection-airtight`). No Critical/High were found; these are
the Important + Suggestion items. Scope is deliberately bounded — extract the
regression-prone logic into testable helpers rather than mocking the keychain /
env-paths meta (same dependency wall that leaves `cowork_rescan` untested).

## Structural facts that constrain the plan
- `cowork_workspace_scan.rs` is `#![cfg(target_os = "windows")]` (whole module) → its
  tests run on the windows-latest CI leg + locally on this Windows box.
- `lib.rs` has NO test module; `cowork_installer.rs` and `cowork_workspace_scan.rs` do.
- `WriteStatus` = { Ok, AlreadyPresent, Locked, SchemaDrift, InsecureAcl, Failed(String) }.
- `cowork_meta::load()` reads env-paths disk with no test override → full
  `cowork_heal_pass` integration tests are out of reach; test the extracted helpers.

---

## Fix 1 — Heal once-per-process guard poisons *transient* failures (Important)

**Problem.** `cowork_heal_pass` (`lib.rs:2322`) pre-marks every `missing` workspace as
attempted (`attempted.insert` inside the `to_attempt` filter). A workspace that fails
*transiently* (file lock, momentary I/O, token-store hiccup) is then never retried until
the process restarts — a silent permanent non-config with only a `log::warn!` breadcrumb.

**Fix.** Classify the install outcome and only mark *terminal* outcomes as attempted:
- terminal = `Ok | AlreadyPresent` (success) and `InsecureAcl` (permanent: redirected/
  synced AppData — the real persistent case the guard exists for).
- retryable = `Locked | SchemaDrift | Failed(_)` and any `Err` (normalized to a transient
  outcome). These remain absent from the set so the next 5-min tick retries them.

Accepted trade-off: a *genuinely* persistent non-ACL failure (e.g. a corrupt file Claude
never rewrites → repeated `SchemaDrift`) re-attempts every 5 min and logs each time. This
is low-harm (5-min cadence, idempotent write) and arguably correct (a persistent real
problem should keep surfacing). The dominant persistent case (ACL) is terminal-marked and
does NOT loop. If review wants it bounded, add a per-workspace attempt counter — noted as
the fallback, not built by default (avoid speculative machinery).

**Extract for testability** (into `cowork_installer.rs`, alongside `WriteStatus`):
```rust
/// Whether a heal install outcome is terminal — i.e. the background heal pass
/// should NOT retry this workspace on the next tick. Success and InsecureAcl
/// (a structurally redirected/synced path that won't become writable) are
/// terminal; Locked / SchemaDrift / Failed / errors are transient and retried.
pub(crate) fn heal_outcome_is_terminal(status: &WriteStatus) -> bool {
    matches!(
        status,
        WriteStatus::Ok | WriteStatus::AlreadyPresent | WriteStatus::InsecureAcl
    )
}
```

**Restructured loop** (`lib.rs`):
```rust
let to_attempt: Vec<PathBuf> = {
    let attempted = HEAL_ATTEMPTED.lock().unwrap_or_else(|p| p.into_inner());
    missing.into_iter().filter(|ws| !attempted.contains(ws)).collect()
};
if to_attempt.is_empty() { return Ok(0); }

let token = token_store::get_or_create_token()?;
let tandem_url = resolve_tandem_url(&meta);

let mut installed = 0usize;
let mut terminal: Vec<PathBuf> = Vec::new();
for ws in &to_attempt {
    let status = match install_tandem_plugin_into_workspace(ws, &token, &tandem_url) {
        Ok(report) => report.installed_plugins,
        Err(e) => {
            log::warn!("[cowork] heal: install into {} errored: {e}", ws.display());
            cowork_installer::WriteStatus::Failed(e.to_string()) // transient → retry
        }
    };
    match &status {
        WriteStatus::Ok | WriteStatus::AlreadyPresent => installed += 1,
        other => log::warn!("[cowork] heal: install into {} not successful: {other:?}", ws.display()),
    }
    if cowork_installer::heal_outcome_is_terminal(&status) {
        terminal.push(ws.clone());
    }
}
{
    let mut attempted = HEAL_ATTEMPTED.lock().unwrap_or_else(|p| p.into_inner());
    attempted.extend(terminal);
}
```
Note: heal runs on a single serialized interval task — no concurrent passes — so the
read-then-write across the two short lock scopes is race-free (manual rescan never touches
`HEAL_ATTEMPTED`). Update the fn doc comment's "once per app run" wording to
"once per app run unless the failure is transient".

**Tests** (`cowork_installer.rs`): `heal_outcome_is_terminal` for all six `WriteStatus`
variants (Ok/AlreadyPresent/InsecureAcl → true; Locked/SchemaDrift/Failed → false).

**Decision (don't build): `last_heal_error` meta field + status + UI banner.** Out of
scope. The transient-retry fix self-heals the common case; a scan-detected workspace that
fails ACL at heal time already shows as a `installedPlugins: "failed"` row in
`cowork_get_status`. A dedicated background-error banner (meta schema + Rust + TS type +
two Svelte surfaces) is disproportionate for a rare case. Flagged here so reviewers can
challenge.

---

## Fix 2 — `workspace_has_tandem_entry` conflates unreadable/corrupt with not-installed (Important)

**Problem.** `lib.rs:2292` `read_to_string(...).ok().and_then(parse).unwrap_or(false)` —
a present-but-unreadable (permissions) or malformed-JSON file returns `false`,
indistinguishable from "no entry", with zero log breadcrumb. The status path mislabels the
cause; the heal path treats it as missing and re-installs (a *merge* over an unparseable
file — actually the desired self-heal per `reconcile_orphans`' precedent at
`cowork_installer.rs:498`, but currently silent).

**Fix.** Move the helper to `cowork_installer.rs` (registry-inspection domain; gives it a
test home; not windows-gated so tests run on all platforms) as
`pub(crate) fn workspace_has_tandem_entry(&Path) -> bool`, and distinguish the three states
by logging (path only — NEVER contents, which hold the bearer token):
```rust
pub(crate) fn workspace_has_tandem_entry(ws_path: &Path) -> bool {
    let path = ws_path.join("cowork_plugins").join("installed_plugins.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false, // absent — expected
        Err(e) => {
            log::warn!("[cowork] cannot read {} ({e}) — treating as not configured", path.display());
            return false;
        }
    };
    match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(json) => json
            .get("mcpServers")
            .and_then(|s| s.get(TANDEM_PLUGIN_ID))
            .is_some(),
        Err(e) => {
            log::warn!("[cowork] malformed JSON in {} ({e}) — treating as not configured", path.display());
            false
        }
    }
}
```
- Use `TANDEM_PLUGIN_ID` (the constant already used by `reconcile_orphans`) instead of the
  literal `"tandem"` — same value, removes a drift seam.
- **Token-safety note for reviewers:** `serde_json::Error` Display is `"... at line L column C"`
  — it does NOT embed the source snippet (unlike V8's `JSON.parse`, cf. the
  `json-parse-leaks-secrets` lesson). Logging `{e}` is wire-safe; logging `content` would
  not be and is never done.
- `lib.rs` `cowork_get_status` and `cowork_heal_pass` call
  `cowork_installer::workspace_has_tandem_entry`; delete the lib.rs copy.

**Behavioral equivalence:** all three non-`Ok` states still yield `false` → identical
`"ok"/"failed"` status outcomes as today; only logging is added. No UI change.

**Tests** (`cowork_installer.rs`, TempDir): present-with-entry → true; absent file → false;
malformed JSON → false; valid JSON without the tandem key → false.

---

## Fix 3 — `check_acl` non-hermetic test + fail-open hardening (Important + Suggestion)

**Problem A (test safety).** `test_check_acl_accepts_roaming_claude_sessions_dir` (and the
reject sibling) write into the developer's REAL `%APPDATA%\Claude\local-agent-mode-sessions`
— a live Claude install on this machine. Cleanup is bounded but it mutates an app-owned tree
and is environment-coupled/flaky.

**Problem B (latent footgun).** `check_acl`'s `any_root_resolved == false → Ok(())`
fail-open is currently dead-gated (every write caller runs `revalidate_resolved_path` first),
but that's undocumented coupling; a future caller that forgets the pre-step inherits a silent
allow.

**Fix.** Extract the root-comparison core into an injectable helper and fail closed:
```rust
fn check_acl(path: &Path) -> Result<(), CoworkError> {
    // ... existing reparse-point check (unchanged) ...
    let allowed_roots: Vec<PathBuf> = [
        dirs::data_local_dir(),
        dirs::config_dir().map(|c| c.join("Claude").join("local-agent-mode-sessions")),
    ].into_iter().flatten().collect();
    check_acl_against(path, &allowed_roots)
}

/// Core ACL containment check against an explicit allowed-root set. Split out so
/// tests inject TempDir roots instead of mutating the dev's real %APPDATA%.
fn check_acl_against(path: &Path, allowed_roots: &[PathBuf]) -> Result<(), CoworkError> {
    let canonical_path = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()), // new ws dir
        Err(e) => return Err(e.into()),
    };
    for root in allowed_roots {
        if let Ok(canonical_root) = std::fs::canonicalize(root) {
            if is_strict_component_child(&canonical_path, &canonical_root) {
                return Ok(());
            }
        }
    }
    log::warn!("[cowork-install] InsecureAcl: {} is outside all allowed roots", path.display());
    Err(CoworkError::InsecureAcl { path: path.to_path_buf() })
}
```
**Fail-closed change:** drop the `any_root_resolved` optimistic allow. In production both
`dirs::data_local_dir()` and `dirs::config_dir()` always resolve (Windows + Linux CI), so
this path was unreachable; making it `Err(InsecureAcl)` removes the footgun with no
real-world behavior change. The candidate-`NotFound` fail-open (new workspace dir not yet on
disk) is preserved — that one is load-bearing.

Verify `test_check_acl_io_error_is_not_insecure_acl` still passes (it triggers a candidate
canonicalize error *before* the root loop → unaffected).

**Rewrite tests hermetic** (use `check_acl_against` with TempDir roots):
- accept: a path strictly under a TempDir root → `Ok`.
- reject: a path outside all TempDir roots → `Err(InsecureAcl)`.
- prefix-sibling reject (the reason `is_strict_component_child` exists): root
  `.../sessions`, candidate `.../sessions-evil/x` → `Err`. (Also add a direct
  `is_strict_component_child` unit test for the sibling-prefix case.)
- Delete the two real-`%APPDATA%`-touching tests.

---

## Fix 4 — Residual #433 TOCTOU on `apply_token_to_all_workspaces` / `reconcile_orphans` (Suggestion → implement)

**Problem.** Both write directly via `with_locked_json` on a freshly-scanned path without
`revalidate_resolved_path` (disclosed in ADR-044 §5). User-gesture-only, sub-ms window, and
both only rewrite an *existing* `installed_plugins.json` — but close it for symmetry.

**Fix.** Add per-workspace revalidation:
- `apply_token_to_all_workspaces` (`:396`): at the top of the `.map(|ws_path| ...)`, after
  computing `workspace_id`/`vm_id`, `let ws_path = match revalidate_resolved_path(ws_path) {
  Ok(p) => p, Err(reason) => { log::warn!(...); return WorkspaceWriteReport { installed_plugins:
  WriteStatus::Failed(format!("revalidation failed: {reason}")), known_marketplaces:
  WriteStatus::AlreadyPresent, cowork_settings: WriteStatus::AlreadyPresent, workspace_id, vm_id }; } };`
  then derive `plugins_dir` from the revalidated path.
- `reconcile_orphans` (`:440`): at the top of `for ws_path in workspaces`, `let ws_path =
  match revalidate_resolved_path(ws_path) { Ok(p) => p, Err(reason) => { log::warn!("[cowork-install]
  reconcile: revalidation failed for {} ({reason}) — skipping", ws_path.display()); continue; } };`
- Import path: reuse `crate::cowork_workspace_scan::revalidate_resolved_path` (as in install).

**Doc:** update ADR-044 §5 to record that all four installer write entry points now
revalidate (no residual non-handle TOCTOU). Update the CLAUDE.md gotcha line accordingly.

**Test:** add `test_apply_token_rejects_unscanned_path` analogous to the install-rejection
test (path outside any root → the report's `installed_plugins` is `Failed`, no file written).

---

## Fix 5 — `claude_desktop_detected` untested OR-signals (Suggestion)

**Fix.** Mirror the `roots_under` refactor: extract
`fn claude_desktop_detected_under(packages_dir: Option<&Path>, roaming_config_dir: Option<&Path>) -> bool`
containing the three-signal OR; `claude_desktop_detected()` keeps the override hook +
`dirs::` resolution and delegates. (`cowork_workspace_scan.rs`, windows-gated.)

**Tests** (TempDir, no env): only `claude_desktop_config.json` present → true; only the MSIX
virtualized config under `AnthropicPBC.Claude_x` → true; only a foreign `EvilCorp.*` package
with that config → false; empty tree → false.

---

## Fix 6 — Symmetric uninstall-rejection test + roots_under dedup debug log (Suggestion)

- `test_uninstall_rejects_unscanned_path` mirroring `test_install_rejects_unscanned_path`:
  path outside any root → `WriteStatus::Failed`, an existing `cowork_plugins` is not mutated.
- `roots_under` dedup (`cowork_workspace_scan.rs:~715`): add `log::debug!` when
  `std::fs::canonicalize(r)` fails in the dedup `retain`, so a dropped-dedup is diagnosable.

---

## Out of scope / not changed (with rationale)
- **`AnthropicPBC.Claude` prefix** unverified — can't verify without the real Store family
  name; fail direction is safe (undetected, no regression). Documented already.
- **`--no-verify` on the prior commit** — already merged into branch history; documented VM
  reason. This fix-batch's own commit will run hooks normally (local machine, not the VM).
- **Full `cowork_heal_pass` integration test** — its deps (`token_store` keychain,
  env-paths `cowork_meta`) aren't injectable; consistent with the untested `cowork_rescan`.
  The extracted helpers (`heal_outcome_is_terminal`, `workspace_has_tandem_entry`) carry the
  regression-prone logic and ARE tested. Manual verification by Bryan per ADR-044 §Verification.

## Verification
- `cargo test` (src-tauri) locally on this Windows box — create sidecar/dist stubs if
  `build.rs` requires them (per CLAUDE.md cargo-test note). Falls back to the windows-latest
  CI leg if local build is infeasible.
- `npm run typecheck` + `npm test` (no client logic changed except none — TS untouched here).
- `/simplify` pass before commit.

## Files touched
`src-tauri/src/cowork_installer.rs`, `src-tauri/src/cowork_workspace_scan.rs`,
`src-tauri/src/lib.rs`, `docs/decisions.md` (ADR-044 §5/§6), `CLAUDE.md` (gotcha line).
