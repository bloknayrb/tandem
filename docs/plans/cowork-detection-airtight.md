# Plan v2: Airtight Cowork Detection (first-run, zero manual steps)

Agent feedback incorporated — v1 was reviewed by three adversarial agents (security: REJECT, design: REJECT, windows-platform: APPROVE-WITH-CHANGES). This revision resolves every blocker/major. Key reversals from v1: self-heal moves from a client-poll fingerprint to a Rust background interval; the `noWorkspaces` pre-arm enable is dropped (vEthernet adapter doesn't exist before first Cowork run → `detect_vethernet_subnet` hard-fails); `contains("Claude")` is dropped for a publisher-anchored match; `check_acl` interaction is now explicitly owned.

## Problem

The integration wizard shows "Cowork — Not detected on this computer" even with Cowork actively running. `cowork_roots()` (`src-tauri/src/cowork_workspace_scan.rs:286-353`) scans only the MSIX layout `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\local-agent-mode-sessions`. The direct-download Claude Desktop (the common case) puts sessions at `%APPDATA%\Claude\local-agent-mode-sessions`. Verified live on Bryan's machine.

Gaps:
- G1: Workspaces only exist after Cowork has run once → wizard dead-ends with no honest guidance.
- G2: Nothing installs into workspaces that appear after enable; `cowork_rescan` is a manual button. (v1's client-poll heal was falsified in review: the poll only runs while a settings surface is mounted.)
- G3: The Roaming root contains non-workspace siblings (`skills-plugin\<uuid>\<uuid>`) that the naive walk would write plugin files into.
- G4: [Inference, unverified] MSIX Store package dirs are named `<Publisher>.<App>_<hash>` (e.g. `AnthropicPBC.Claude_…`), which `Claude_*` misses.
- G5 (new, security review): `check_acl` (`cowork_installer.rs:99-155`) rejects anything outside `%LOCALAPPDATA%` → every Roaming-root install would return `InsecureAcl`; enable would fail on exactly the machines this plan targets.
- G6 (new, security review): `cowork_rescan` / `cowork_toggle_integration` write via `find_cowork_workspaces` + install directly, bypassing the `revalidate_resolved_path` TOCTOU defense that the handle-based install path has (#433).

## Changes

### 1. Rust — `cowork_workspace_scan.rs` (detection)

**1a. Refactor root discovery** into `fn roots_under(packages_dir: Option<&Path>, roaming_config_dir: Option<&Path>) -> Vec<PathBuf>` (base-dir-injectable, testable without env). `cowork_roots()` becomes a thin wrapper passing `dirs::data_local_dir().join("Packages")` and `dirs::config_dir()`; the `TANDEM_COWORK_ROOT_OVERRIDE` test hook is unchanged.

**1b. Add the Roaming root:** `roaming_config_dir\Claude\local-agent-mode-sessions` when `is_dir()`. Dedup by canonical path — explicitly *exact-alias only*; MSIX-virtualized and real Roaming are distinct real dirs and a dual install legitimately yields two roots (documented in ADR).

**1c. Publisher-anchored MSIX match** (replaces v1's `contains("Claude")`, rejected in security review — a foreign package named `EvilCorp.TotallyClaude_x` owns its container and could receive the token): accept package dir names where `name == "Claude"` is a prefix segment — concretely `starts_with("Claude_")` (existing) OR `starts_with("AnthropicPBC.Claude")`. Inner `LocalCache\Roaming\Claude\local-agent-mode-sessions` must still exist. G4 stays flagged unverified; the publisher anchor is recorded in ADR for correction if the real family name differs.

**1d. Workspace shape guard — UUID OR marker union** (windows review: marker-only deadlocks on fresh workspaces since our own installer creates `cowork_plugins`; UUID-only silently zeroes detection if Claude renames): accept a vm dir when (`is_uuid_like(ws_name) && is_uuid_like(vm_name)`) OR `vm_path.join("cowork_plugins").is_dir()`. `is_uuid_like`: exactly 36 chars, hyphens at 8/13/18/23, ASCII hex elsewhere, case-insensitive; no `uuid` crate. Explicit test: `local_<uuid>` rejected. Per-dir rejections at `debug`; one aggregate `info` per scan ("N candidates rejected by shape guard") so a layout change is diagnosable from one log line. Shape filter runs BEFORE `check_path_safe`; the four-layer guard is untouched and still narrows after.

**1e. Per-root workspace cap:** change `break 'root` at `MAX_WORKSPACES` to a per-root cap (continue to next root) so an accumulating first root can't starve the second.

**1f. Scan stats:** add `fn find_cowork_workspaces_with_stats() -> (Vec<PathBuf>, ScanStats)` where `ScanStats { rejected_by_guard: usize, rejected_by_shape: usize }`. `find_cowork_workspaces()` stays as a wrapper. Rate-limit guard-rejection WARNs (windows review: redirected-AppData users get WARN-per-candidate-per-poll) — log at `warn` only on first occurrence per scan, rest at `debug`.

### 2. Rust — `cowork_installer.rs` (write-path)

**2a. `check_acl` narrow Roaming allowance (resolves G5).** Accept canonical paths under `%LOCALAPPDATA%` (existing) OR under `dirs::config_dir()\Claude\local-agent-mode-sessions` specifically — NOT all of Roaming. Token-confidentiality call, made explicitly: Tandem already writes the same bearer token into Roaming via `claude_desktop_config.json` (`src/server/integrations/apply.ts:225,363`), so this adds no new exposure class; roaming-profile sync of the token is pre-existing, documented behavior. Add `warn_if_roaming` one-time log mirroring `warn_if_onedrive`. UNC paths still rejected (write-time revalidation, 2b, runs the four-layer guard which rejects UNC).

**2b. Write-time revalidation (resolves G6).** At the top of `install_tandem_plugin_into_workspace` AND `uninstall_tandem_plugin_from_workspace`, call `cowork_workspace_scan::revalidate_resolved_path(ws_path)` and use the returned re-canonicalized path; on `Err` return `CoworkError` → `WriteStatus::Failed` with the rejection reason as `failureDetail`. This closes the #433 TOCTOU for ALL write paths (manual enable, manual rescan, background heal, handle-based install — double revalidation there is harmless). Installer unit tests must set `TANDEM_COWORK_ROOT_OVERRIDE` + hold `COWORK_ENV_LOCK` (audit existing tests; update those that construct paths directly).

### 3. Rust — `lib.rs` status + background heal

**3a. `cowork_get_status` additions (read-only preserved):**
- `claudeDesktopDetected: bool` — true when ANY of: `dirs::config_dir()\Claude\claude_desktop_config.json` exists (existence check only, never read/parsed), any MSIX package dir matching 1c contains `LocalCache\Roaming\Claude\claude_desktop_config.json`, or any scan root exists. (Windows review: Store installs that never ran Cowork have only the virtualized config.)
- `workspacesBlocked: number` — `ScanStats.rejected_by_guard` (UNC/reparse/containment rejections), so the UI can distinguish "redirected/synced AppData we can't safely configure" from "no workspace yet". Shape rejections are NOT counted (they're expected noise).
- Non-Windows stub: both fields present (`false` / `0`).

**3b. Background heal task (replaces v1 §4 client fingerprint, resolves G2 headlessly).** Factor the body of `cowork_rescan` into `fn cowork_heal_pass() -> Result<String, String>` shared by the command and the task. In `.setup()`, alongside the existing periodic update-check task, spawn an interval task (every 5 minutes; first tick discarded):
- Skip unless `cowork_meta::load().enabled`.
- Read-only precheck: scan; collect workspaces whose `installed_plugins.json` lacks a tandem entry. If none → no writes at all.
- Once-per-process attempt guard: `static HEAL_ATTEMPTED: Mutex<HashSet<PathBuf>>` — each missing workspace is attempted once per app run (new paths attempt immediately; a persistently failing workspace doesn't loop). Cross-surface, cross-mount memory — the property v1's per-component fingerprint couldn't provide.
- No firewall work, no UAC, ever (rescan body already has none).
- End-to-end G2 flow: enable (≥1 workspace, UAC granted) → later a NEW workspace appears → within ≤5 min the heal installs into it headlessly. G1 flow: see §4 — enable stays a user action because the vEthernet adapter + UAC prompt only exist/make sense after Cowork has run once.

**3c. Pre-arm enable is DROPPED** (design review blocker): `cowork_toggle_integration` unconditionally calls `firewall::detect_vethernet_subnet()` (`lib.rs:2008`), which fails with `SubnetDetectionFailed` when no Hyper-V vEthernet adapter exists — i.e. on every machine that hasn't run Cowork yet. The `noWorkspaces` state is informational only. No `shouldShowCoworkOnboarding` change.

### 4. Client — honest copy, no new variant

**4a. `types.ts`:** `claudeDesktopDetected?: boolean`, `workspacesBlocked?: number` on `CoworkStatus` (optional; helpers default false/0 so a stale sidecar during update overlap can't break the UI).

**4b. `cowork-helpers.ts`:** variant set UNCHANGED (design review: a third variant bought copy, not behavior). Add a pure helper:
```ts
export type UndetectedDetail = "noClaude" | "noWorkspacesYet" | "blocked";
export function undetectedDetail(status: CoworkStatus): UndetectedDetail
```
`blocked` when `claudeDesktopDetected && (workspacesBlocked ?? 0) > 0`; `noWorkspacesYet` when `claudeDesktopDetected`; else `noClaude`.

**4c. Copy (both surfaces — `CoworkSettings.svelte` undetected branch, `IntegrationWizardModal.svelte` `coworkRowDetail` line ~140):**
- `noClaude`: "Claude Desktop not detected. Install Claude Desktop to use Cowork." (wizard row keeps "Not detected on this computer" headline)
- `noWorkspacesYet`: "Claude Desktop detected. Run a Cowork session once, then enable the integration here."
- `blocked`: "Cowork sessions were found in a network-redirected or cloud-synced location that Tandem can't safely configure."
- New testids: `cowork-settings-undetected` keeps its id, gains `data-detail={detail}`; wizard row detail unchanged id-wise.

**4d. Wizard "Check again" fix (design review finding 7):** `retryDetection()` (`IntegrationWizardModal.svelte:174-179`) additionally calls `coworkStatus.refetch()`.

### 5. Docs

- CLAUDE.md: gotcha entry (dual scan roots; shape guard; `check_acl` Roaming allowance; heal task).
- `docs/decisions.md`: new ADR — dual roots + publisher anchor (G4 caveat), UUID-or-marker shape guard, write-time revalidation on all installer entry points, Roaming token-exposure rationale (no worse than `claude_desktop_config.json`), Rust-interval heal vs notify-watcher vs client-poll, redirected/OneDrive AppData = unsupported-but-honestly-messaged, `%APPDATA%` env-var vs Known-Folder divergence note.

## Files touched

`src-tauri/src/cowork_workspace_scan.rs`, `src-tauri/src/cowork_installer.rs`, `src-tauri/src/lib.rs`, `src/client/types.ts`, `src/client/cowork/cowork-helpers.ts`, `src/client/components/CoworkSettings.svelte`, `src/client/components/IntegrationWizardModal.svelte`, `tests/client/cowork-settings.test.ts`, `CLAUDE.md`, `docs/decisions.md`.

## Verification

- `npm run typecheck`, `npm test`.
- `cargo test` runs in CI on the windows-latest matrix leg (`.github/workflows/ci.yml`) — new Rust tests are NOT merge-blind. Local cargo run on Bryan's machine still valuable for the live-machine smoke.
- Test discipline (windows review): every Rust test that transitively reaches `cowork_roots()` holds `COWORK_ENV_LOCK` (read or write of the override); pure `roots_under` tests use unique temp-dir names; pin `is_uuid_like` edge cases.
- Manual (Bryan): rebuild → wizard shows Cowork detected → enable → verify tandem entry in the live workspace's `installed_plugins.json` → delete the entry → within ≤5 min the heal task restores it (or restart app for immediate-tick verification).

## Risks

- Claude renames session dirs → UUID branch misses, marker branch (`cowork_plugins`) catches existing workspaces; brand-new dirs missed until Cowork creates the marker. Aggregate info log + `workspacesBlocked`-style honesty limits silent failure.
- 5-min heal cadence: a workspace created mid-session waits ≤5 min for plugin injection. Acceptable; Cowork reads the registry at session start anyway, and the manual Re-scan button remains.
- `AnthropicPBC.Claude` prefix is unverified — if wrong, Store installs stay exactly as broken as today (no regression), fixed by a one-line prefix addition.
