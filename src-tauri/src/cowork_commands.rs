//! The Cowork Tauri invoke commands (#433, #1371, #1437, #1438, #1560).
//!
//! **Extracted from `lib.rs` (Unit 11d).** A pure move: the eleven commands,
//! their non-Windows stubs, the pure decision helpers and their four test
//! modules are reproduced verbatim, along with `iso_now`/`is_leap`, whose only
//! callers are in here.
//!
//! **The imports below are where this move can go wrong, and it is not
//! symmetric.** Five of the modules this code calls -- `cowork_atomic_json`,
//! `cowork_workspace_scan`, `cowork_installer`, `firewall` and `cowork_meta` --
//! have `mod` declarations in `lib.rs` that are themselves
//! `#[cfg(target_os = "windows")]`. Off Windows those modules do not exist at
//! all, so an UNGATED `use crate::firewall;` here is an unconditional E0432 on
//! macOS and Linux while compiling clean on a Windows dev box. Unit 11c shipped
//! exactly that bug and only CI caught it. `token_store` is ungated as a module
//! but every call site here is Windows-gated, so importing it ungated would
//! warn rather than break -- it belongs in the gated group regardless.
//! `single_flight` is the one genuine exception: `SUBNET_PROBE_FLIGHT` is a
//! module-level static outside any cfg.
//!
//! The gated `use` block is what lets the 54 bare `cowork_meta::` /
//! `cowork_installer::` / ... call sites stay byte-identical to their `lib.rs`
//! originals. Qualifying each one instead would have destroyed the property
//! that makes a move this size reviewable.
//!
//! `PathBuf` and `Mutex` come in gated for the same reason `lib.rs` gated
//! `PathBuf`: their only users here are the Windows self-heal pass and its test
//! module. `lib.rs`'s own `PathBuf` import narrowed to `#[cfg(test)]` when this
//! cluster left, because this was its only non-test Windows consumer -- an
//! orphaned import that would have warned on a Windows RELEASE build alone,
//! which neither `cargo test` nor the other two CI legs can see.
//!
//! **`#[tauri::command]` names are not module-qualified**, so the wire contract
//! is untouched; the `generate_handler!` entries in `lib.rs` become
//! `cowork_commands::`-qualified, matching `pending_update::`, `context_menu::`
//! and `native_theme::`.

#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use crate::{
    cowork_atomic_json, cowork_installer, cowork_meta, cowork_workspace_scan, firewall, token_store,
};

use crate::single_flight;

// ---------------------------------------------------------------------------
// Cowork Tauri invoke commands
// ---------------------------------------------------------------------------
// Most commands have Windows-native and non-Windows stub variants so that
// tauri::generate_handler![] compiles on all platforms.
//
// `cowork_detect_vethernet_subnet` is the deliberate exception (#1371): it is ONE
// ungated `async fn` whose blocking *body* is what gets cfg-split. Do not
// "restore consistency" by splitting the command itself — the async /
// spawn_blocking / single-flight wiring is the fix for the main-thread freeze,
// and a cfg-gated command would put that wiring back where no non-Windows build
// ever type-checks it.

/// Error string returned by every non-Windows Cowork stub.
#[cfg(not(target_os = "windows"))]
const WINDOWS_ONLY_ERR: &str = "Cowork integration is Windows-only";

/// Scan for Cowork workspace directories.
///
/// Returns an opaque, validated [`cowork_workspace_scan::WorkspaceHandle`] per
/// workspace rather than a bare path. The handle's `token` must be round-tripped
/// to `cowork_install_into_workspace` / `cowork_uninstall_from_workspace`, which
/// resolve it back to the exact canonical path validated here — closing the
/// TOCTOU window between this scan and the install IPC call (issue #433). The
/// `path` field is for display only and is never trusted on the return trip.
#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn cowork_scan_workspaces() -> Result<Vec<cowork_workspace_scan::WorkspaceHandle>, String> {
    Ok(cowork_workspace_scan::scan_workspaces_with_handles())
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn cowork_scan_workspaces() -> Result<Vec<String>, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Outcome of the enable path's final step: persisting `enabled = true` (plus
/// the vEthernet CIDR and scan timestamp) to `cowork-meta.json`.
///
/// By this point the firewall rule and plugin entries are already live —
/// everything upstream of this call succeeded — so a persist failure here is
/// a partial commit, not a clean failure. MUST fail loud, mirroring the
/// disable branch's identical decision at its own `meta_persist` write, whose
/// comment reads: "this write is the disable's CORE contract ... fail loud
/// instead of returning a green toast over a stale state". Before this fix the
/// enable arm was the asymmetric outlier: warn-only, falling through to `Ok`,
/// so `cowork_toggle_integration`
/// could resolve while `cowork_get_status` went on honestly reporting
/// `enabled: false` with nothing to explain the gap — #1437.
///
/// Retrying is the recovery path, not a courtesy: the client's
/// `handleToggleChange` reads `status.enabled` to decide which handler fires,
/// and that reads `false` here, so there is no client path to
/// `cowork_toggle_integration(false)` to undo anything with — enabling again
/// is the only way off this state (safe to repeat: the firewall add and the
/// per-workspace writes above it are both idempotent). The disk state this
/// leaves — `enabled: false` with the firewall rule and plugin entries
/// already live — is exactly what today's silent `Ok` already produces, so
/// returning `Err` here doesn't create a new exposure, only a visible one;
/// and the leftover allow rule is inert under the default 127.0.0.1 bind
/// (the same argument the disable branch's "Firewall removal is ADVISORY"
/// comment makes for its own leftover-rule case; the launcher never sets
/// `TANDEM_BIND_HOST`, see `integrations_probe.rs`).
///
/// About the count the `Err` message does name: it is `workspace_count` from
/// the call site, i.e. `workspaces.len()` — the number of workspaces the
/// enable WALKED, not the number whose plugin entry was actually written. The
/// partial-install branch above this call deliberately tolerates a
/// `success_count` lower than that, so on a partial install this message can
/// name more workspaces than got an entry. Threading `success_count` down
/// here would close that gap at the cost of another parameter on a message
/// this rarely reached; the one case worth being exact about is zero, and
/// that one is special-cased below so the message never claims plugin entries
/// that were never written.
///
/// Pure and free of the Windows-only firewall/workspace-scan types around its
/// call site, so it's testable without them — same reasoning as
/// `parse_netstat_listening_pid` above ("kept out of the cfg(windows) block
/// so its tests run on every CI platform; the allow keeps a non-Windows
/// release build warning-free"). **Caveat that reasoning doesn't cover: this
/// function's own body is close to the assertion it's tested against — the
/// actual defect this fixes is at the call site inside
/// `#[cfg(target_os = "windows")] fn cowork_toggle_integration`, which a
/// non-Windows `cargo test` never compiles. The test below pins this
/// function's Ok/Err mapping; it does NOT prove the call site type-checks or
/// behaves. That's the `windows-latest` leg of `ci.yml`'s `rust-test` job
/// plus manual verification — see the PR body.**
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn enable_persist_outcome(persist: Result<(), String>, workspace_count: usize) -> Result<String, String> {
    match persist {
        Ok(()) => Ok(format!("Cowork enabled: {workspace_count} workspace(s) configured")),
        Err(e) => {
            // Name only what actually happened. The enable arm walks workspaces
            // and installs a plugin entry per workspace, so on a machine with
            // no Cowork workspaces there are no plugin entries to report — and
            // an error message that claims otherwise sends the user looking for
            // files that were never written.
            let installed = if workspace_count == 0 {
                "Cowork's firewall rule was added".to_string()
            } else {
                format!(
                    "Cowork's firewall rule and plugin entries for {workspace_count} workspace(s) were installed"
                )
            };
            Err(format!(
                "{installed}, but Tandem couldn't save that the integration is on ({e}). \
                 It will keep showing as off until you try enabling again."
            ))
        }
    }
}

#[cfg(test)]
mod enable_persist_outcome_tests {
    use super::*;

    #[test]
    fn ok_when_persist_succeeds() {
        assert_eq!(
            enable_persist_outcome(Ok(()), 3),
            Ok("Cowork enabled: 3 workspace(s) configured".to_string())
        );
    }

    #[test]
    fn fails_loud_when_persist_fails() {
        // #1437: before this fix, a persist failure here was swallowed into a
        // `log::warn!` and the command still returned `Ok`, so the invoke
        // resolved while `cowork_get_status` went on honestly reporting
        // `enabled: false` with nothing to explain the gap. This test pins
        // only this function's Ok/Err mapping and its message contents — it
        // cannot compile the call site inside `cowork_toggle_integration`
        // (Windows-cfg-gated), so it cannot by itself prove the fix landed
        // correctly there. See the doc comment above and the PR body.
        let result = enable_persist_outcome(Err("disk full".to_string()), 3);
        let msg = result.expect_err("persist failure must surface as Err, not a silent Ok");
        assert!(msg.contains("disk full"));
        assert!(msg.contains("firewall rule"));
        assert!(msg.contains("plugin entries for 3 workspace(s)"));
        assert!(msg.contains("try enabling again"));
    }

    #[test]
    fn persist_failure_with_no_workspaces_does_not_claim_plugin_entries() {
        // The enable arm installs one plugin entry per workspace, so with zero
        // workspaces there are none — claiming otherwise sends the user hunting
        // for files that were never written.
        let result = enable_persist_outcome(Err("disk full".to_string()), 0);
        let msg = result.expect_err("persist failure must surface as Err, not a silent Ok");
        assert!(msg.contains("disk full"));
        assert!(msg.contains("firewall rule"));
        assert!(
            !msg.contains("plugin entries"),
            "message must not claim plugin entries were installed when none were: {msg}"
        );
    }
}

/// Did this workspace's `installed_plugins.json` write actually land?
///
/// **The subtlety this exists to name: an `Ok` does not mean it landed.**
/// Both `install_tandem_plugin_into_workspace` and
/// `uninstall_tandem_plugin_from_workspace` return
/// `Ok(WorkspaceWriteReport { installed_plugins: WriteStatus::Failed(..) })`
/// for a per-file failure -- e.g. a revalidation failure in the uninstall path
/// (`cowork_installer.rs`) -- reserving `Err` for a failure to even reach the
/// file. So `r.is_ok()` counts a workspace that still holds its plugin entry
/// as a success.
///
/// Both arms of `cowork_toggle_integration` decide "did this workspace
/// succeed?" more than once -- for the hard all-failed check and again for the
/// #1438 degraded-success warning -- and the two must not disagree. They did:
/// the disable arm's warning used a bare `is_ok()` while its own all-failed
/// check used the `WriteStatus` test right above it, so a partial uninstall
/// whose failures were all non-`Err` produced no warning at all. That is the
/// commonest failure shape and precisely the case the warning was added for.
/// Routing every such decision through this one predicate is what keeps them
/// in step.
#[cfg(target_os = "windows")]
fn workspace_entry_written(
    report: &Result<cowork_installer::WorkspaceWriteReport, cowork_atomic_json::CoworkError>,
) -> bool {
    matches!(
        report,
        Ok(r) if matches!(
            r.installed_plugins,
            cowork_installer::WriteStatus::Ok | cowork_installer::WriteStatus::AlreadyPresent
        )
    )
}

#[cfg(all(test, target_os = "windows"))]
mod workspace_entry_written_tests {
    use super::workspace_entry_written;
    use crate::cowork_atomic_json::CoworkError;
    use crate::cowork_installer::{WorkspaceWriteReport, WriteStatus};

    fn report(status: WriteStatus) -> Result<WorkspaceWriteReport, CoworkError> {
        Ok(WorkspaceWriteReport {
            workspace_id: "ws".into(),
            vm_id: "vm".into(),
            installed_plugins: status,
            known_marketplaces: WriteStatus::Ok,
            cowork_settings: WriteStatus::Ok,
        })
    }

    #[test]
    fn ok_and_already_present_count_as_written() {
        assert!(workspace_entry_written(&report(WriteStatus::Ok)));
        assert!(workspace_entry_written(&report(WriteStatus::AlreadyPresent)));
    }

    #[test]
    fn an_ok_carrying_a_failed_status_is_not_written() {
        // The whole reason this predicate exists. `is_ok()` says true here, and
        // that is what made the #1438 partial-uninstall warning silent for the
        // commonest failure shape: `uninstall_tandem_plugin_from_workspace`
        // returns Ok(..Failed) on a revalidation failure, not Err.
        assert!(!workspace_entry_written(&report(WriteStatus::Failed(
            "revalidation failed".into()
        ))));
        assert!(!workspace_entry_written(&report(WriteStatus::Locked)));
        assert!(!workspace_entry_written(&report(WriteStatus::SchemaDrift)));
    }

    #[test]
    fn a_hard_error_is_not_written() {
        let err: Result<WorkspaceWriteReport, CoworkError> =
            Err(CoworkError::InsecureAcl {
                path: std::path::PathBuf::from("C:/ws"),
            });
        assert!(!workspace_entry_written(&err));
    }
}

/// The `Ok` payload of `cowork_toggle_integration` (#1438).
///
/// The command has always encoded *degraded success* in its `Ok` arm — a
/// partial multi-workspace install on enable, a leftover firewall rule or a
/// partial uninstall on disable — as English folded into the success string.
/// Every client call site awaited the invoke and threw the string away, so all
/// three rendered as an unqualified green success and the only surviving record
/// was a `log::warn!` on a Tauri log the user has no route to. A user with three
/// workspaces where two failed to install saw "Enabled" and a check badge.
///
/// Splitting the payload rather than teaching the client to read the message is
/// deliberate. Branching on message text would couple the client to Rust string
/// literals, and a reworded warning would then silently stop rendering — the
/// same class of failure, moved one layer out and made harder to see.
///
/// `warnings` empty means clean success. It is never used to report failure:
/// that is still the `Err` arm, and the two must not blur. A warning here means
/// "the operation committed, and here is what is imperfect about the result".
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoworkToggleReport {
    message: String,
    warnings: Vec<String>,
}

/// The user-facing caveat for a firewall rule that could not be removed.
///
/// A `const` rather than an inline literal because the disable arm is the only
/// producer and a test is the only other reader; keeping them on one string
/// stops the test from passing against a copy of the wording rather than the
/// wording. The allow mirrors `partial_workspace_warning`'s: the only non-test
/// reader is inside the `cfg(target_os = "windows")` arm.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const COWORK_LEFTOVER_FIREWALL_WARNING: &str =
    "A leftover firewall rule may remain. It's harmless — Tandem's server only listens on this computer.";

/// The caveat for a workspace pass where some — but not all — workspaces
/// succeeded.
///
/// `None` when there is nothing to say: no workspaces at all, or every one of
/// them succeeded. All-failed is NOT this function's case — both arms of the
/// toggle return `Err` before reaching here, because an operation that landed
/// nowhere is a failure, not a degraded success.
///
/// Kept outside the `cfg(target_os = "windows")` gate so its tests run on every
/// CI leg; the allow keeps a non-Windows release build warning-free. Direct
/// precedent: `parse_netstat_listening_pid` and its siblings above.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn partial_workspace_warning(
    verb: &str,
    success_count: usize,
    total: usize,
    failures: &[String],
) -> Option<String> {
    if total == 0 || success_count >= total {
        return None;
    }
    let failed = total - success_count;
    // The failure detail is included because the alternative is a warning the
    // user cannot act on. It is the same summary the `Err` arm already builds
    // for the all-failed case, so this adds no new disclosure surface.
    let detail = if failures.is_empty() {
        String::new()
    } else {
        format!(" Details: {}", failures.join("; "))
    };
    Some(format!(
        "{failed} of {total} Cowork workspace(s) could not be {verb}.{detail}"
    ))
}

#[cfg(test)]
mod partial_workspace_warning_tests {
    use super::{partial_workspace_warning, COWORK_LEFTOVER_FIREWALL_WARNING};

    /// The regression #1438 is about: a partial install used to be visible only
    /// in a `log::warn!`, so this asserts something is produced at all — and
    /// that it names both halves of the ratio, since "some failed" without a
    /// count is not actionable.
    #[test]
    fn a_partial_pass_produces_a_warning_naming_the_ratio() {
        let w = partial_workspace_warning(
            "configured",
            1,
            3,
            &["ws-a/vm-1: Locked".into(), "ws-b/vm-2: SchemaDrift".into()],
        )
        .expect("a partial pass must produce a warning");
        assert!(w.contains("2 of 3"), "{w}");
        assert!(w.contains("configured"), "{w}");
        // The detail is what makes it actionable — a user cannot act on
        // "2 of 3 failed" alone.
        assert!(w.contains("ws-a/vm-1: Locked"), "{w}");
        assert!(w.contains("ws-b/vm-2: SchemaDrift"), "{w}");
    }

    #[test]
    fn a_clean_pass_produces_nothing() {
        assert_eq!(partial_workspace_warning("configured", 3, 3, &[]), None);
    }

    /// Zero workspaces is a clean outcome, not a degraded one. Warning there
    /// would put a caveat on every enable on a machine that has no Cowork
    /// workspaces at all — the common case for a new install.
    #[test]
    fn no_workspaces_at_all_produces_nothing() {
        assert_eq!(partial_workspace_warning("configured", 0, 0, &[]), None);
    }

    /// Defensive: a count above the total is a caller bug, and the honest
    /// answer is silence rather than a warning claiming a negative failure
    /// count. `total - success_count` would panic in debug builds.
    #[test]
    fn a_success_count_above_the_total_produces_nothing_rather_than_panicking() {
        assert_eq!(partial_workspace_warning("configured", 4, 3, &[]), None);
    }

    /// All-failed is deliberately NOT this function's case — both toggle arms
    /// return `Err` before reaching it. Pinned so a future refactor that routes
    /// all-failed through here has to make that decision on purpose: it would
    /// otherwise turn a hard failure into a green toast with a caveat.
    #[test]
    fn all_failed_still_produces_a_warning_because_the_caller_never_asks() {
        let w = partial_workspace_warning("configured", 0, 2, &["a".into(), "b".into()]);
        assert!(w.is_some(), "the shape is unconditional; the CALLER is the gate");
    }

    /// Empty failure detail is a degenerate but reachable shape (a caller that
    /// knows the ratio but not the reasons). It must not emit a dangling
    /// "Details:" with nothing after it.
    #[test]
    fn no_failure_detail_means_no_details_clause() {
        let w = partial_workspace_warning("cleaned up", 1, 2, &[]).expect("still a warning");
        assert!(!w.contains("Details"), "{w}");
        assert!(w.contains("1 of 2"), "{w}");
    }

    /// The firewall caveat is advisory, and the wording carries the reason it
    /// is advisory. A rewrite that drops the "only listens on this computer"
    /// half turns a reassurance into an alarm.
    #[test]
    fn the_leftover_firewall_warning_says_why_it_is_harmless() {
        assert!(COWORK_LEFTOVER_FIREWALL_WARNING.contains("harmless"));
        assert!(COWORK_LEFTOVER_FIREWALL_WARNING.contains("only listens on this computer"));
    }
}

/// Enable or disable the Cowork integration.
///
/// On enable: fetches auth token, detects vEthernet subnet, adds allow firewall
/// rule, walks workspaces, installs plugin entries. When the firewall rule needs
/// elevation Tandem doesn't have: fail-closed — does NOT write plugin entries at
/// all. On disable: uninstalls plugin entries, removes firewall rules.
#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn cowork_toggle_integration(enabled: bool) -> Result<CoworkToggleReport, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, uninstall_tandem_plugin_from_workspace};
    use cowork_workspace_scan::find_cowork_workspaces;

    if enabled {
        // Fetch token.
        let token = token_store::get_or_create_token()?;

        // Detect vEthernet subnet.
        // The generous budget, not the advisory one: a false timeout HERE aborts
        // an enable that would have succeeded, where a false timeout on the
        // advisory probe costs only a re-check.
        let cidr = firewall::detect_vethernet_subnet(firewall::SUBNET_PROBE_TIMEOUT_ENABLE)
            .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))?;

        // Scan workspaces up-front (read-only) — reused for both reconcile and install.
        let workspaces = find_cowork_workspaces();

        // Orphan firewall reconciliation BEFORE the add (issue #1163): remove stale
        // "Tandem Cowork*" rules from a previous failed uninstall first. The orphan
        // scan matches by name prefix (identical to the allow rule's own name), so
        // reconciling AFTER the add would scan the just-added rule as an orphan and
        // delete it — leaving every enable with no allow rule. Trade-off: on an
        // elevated run where cleanup succeeds but the add then errors, a leftover
        // rule is dropped without replacement; for the VM-scoped allow rule that's
        // strictly more restrictive, and a retired deny rule is inert under the
        // 127.0.0.1 loopback bind (same rationale as the disable path below).
        let removed_firewall_rules = cowork_installer::reconcile_orphan_firewall_rules();
        // Log removals here, before the add — a fail-closed add bails below, so
        // folding this into the post-add log would silently drop the audit trail
        // for "removed an allow rule but then failed to replace it".
        if !removed_firewall_rules.is_empty() {
            log::info!(
                "[cowork] orphan reconcile: removed {} firewall rule(s)",
                removed_firewall_rules.len()
            );
        }

        // Add allow firewall rule.
        let firewall_result = firewall::add_cowork_allow_rule(&cidr);
        if let Err(ref e) = firewall_result {
            // Fail-closed: if the firewall rule can't be written, bail — do NOT
            // walk workspaces. Under the shipped default the server binds
            // 127.0.0.1, so the rule buys nothing; but with a routable
            // TANDEM_BIND_HOST an install missing it is one the VM cannot
            // reach, advertised as working. Bailing is correct for both.
            if let firewall::FirewallError::AdminDeclined = e {
                // The firewall rule needs elevation Tandem does not have (it never
                // runs elevated, so no UAC prompt ever appears). Do NOT attempt a
                // deny rule — it needs the same elevation and always fails, and the
                // server binds 127.0.0.1 so port 3479 was never network-exposed.
                // Record the outcome and surface the structured error for the UI's
                // honest copy. No plugin entries are written.
                log::warn!("[cowork] firewall rule needs elevation (none available); no plugin entries written");
                if let Err(meta_err) = cowork_meta::update(|m| {
                    m.uac_declined_last_attempt = true;
                    m.uac_declined_at = Some(iso_now());
                    m.vethernet_cidr_detected = Some(cidr.clone());
                    m.enabled = false;
                }) {
                    log::warn!("[cowork] failed to persist firewall-declined meta: {meta_err}");
                }
                return Err(serde_json::to_string(e).unwrap_or_else(|_| e.to_string()));
            }
            return Err(serde_json::to_string(e).unwrap_or_else(|_| e.to_string()));
        }

        // Resolve TANDEM_URL (host.docker.internal by default; LAN-IP if override set).
        let tandem_url = cowork_installer::resolve_tandem_url(&cowork_meta::load().map_err(|e| e.to_string())?);

        // Stale-token reconciliation — rewrites entries still carrying a previous
        // auth token. Deliberately AFTER the successful add: a fail-closed firewall
        // add must never be followed by any workspace write.
        let rewritten_stale_entries =
            cowork_installer::reconcile_stale_workspace_tokens(&workspaces, &token);
        if !rewritten_stale_entries.is_empty() {
            log::info!(
                "[cowork] reconcile: rewrote {} stale token entry(s)",
                rewritten_stale_entries.len()
            );
        }

        let workspace_count = workspaces.len();
        // Degraded-success caveats, surfaced on the Ok payload (#1438).
        let mut warnings: Vec<String> = Vec::new();

        let reports: Vec<_> = workspaces
            .iter()
            .map(|ws| install_tandem_plugin_into_workspace(ws, &token, &tandem_url))
            .collect();

        let errors: Vec<_> = reports
            .iter()
            .filter_map(|r| r.as_ref().err())
            .collect();

        if !errors.is_empty() {
            log::warn!("[cowork] {} install error(s): {:?}", errors.len(), errors);
        }

        // Count workspaces where installed_plugins was written successfully.
        // A workspace is "successful" if its installed_plugins status is Ok or
        // AlreadyPresent — anything else (Locked, SchemaDrift, InsecureAcl, Failed)
        // counts as a failure.
        if !workspaces.is_empty() {
            let success_count = reports.iter().filter(|r| workspace_entry_written(r)).count();

            if success_count == 0 {
                let failure_summary: Vec<String> = reports.iter().map(|r| match r {
                    Ok(report) => format!("{}/{}: {:?}", report.workspace_id, report.vm_id, report.installed_plugins),
                    Err(e) => e.to_string(),
                }).collect();
                return Err(format!(
                    "Cowork enable failed: all {} workspace(s) failed to install. Failures: {}",
                    workspaces.len(),
                    failure_summary.join("; ")
                ));
            }

            if success_count < workspaces.len() {
                log::warn!(
                    "[cowork] partial install: {}/{} workspace(s) succeeded",
                    success_count,
                    workspaces.len()
                );
                // #1438: the log is not a route the user has. Carry the caveat
                // out on the Ok payload so the panel can say so.
                let failure_summary: Vec<String> = reports
                    .iter()
                    .filter(|r| !workspace_entry_written(r))
                    .map(|r| match r {
                        Ok(report) => format!(
                            "{}/{}: {:?}",
                            report.workspace_id, report.vm_id, report.installed_plugins
                        ),
                        Err(e) => e.to_string(),
                    })
                    .collect();
                warnings.extend(partial_workspace_warning(
                    "configured",
                    success_count,
                    workspaces.len(),
                    &failure_summary,
                ));
            }
        }

        let persist = cowork_meta::update(|m| {
            m.enabled = true;
            m.vethernet_cidr_detected = Some(cidr.clone());
            m.workspaces_last_scanned_at = Some(iso_now());
            m.uac_declined_last_attempt = false;
            m.uac_declined_at = None;
        });
        if let Err(e) = &persist {
            log::warn!("[cowork] failed to persist meta after enable: {e}");
        }
        // Both halves survive the #1437 + #1438 merge, and the order matters.
        // `enable_persist_outcome` owns the FAILURE decision (#1437: a persist
        // failure after the firewall rule and plugin entries are live is a
        // partial commit and must fail loud, not resolve green over a stale
        // state). `warnings` carries DEGRADED SUCCESS (#1438). They compose in
        // exactly one direction: a persist failure discards the warnings,
        // because the operation did not succeed and a caveat list beside an
        // error would imply it did. Warnings ride only on the Ok arm.
        enable_persist_outcome(persist, workspace_count)
            .map(|message| CoworkToggleReport { message, warnings })
    } else {
        // Disable: uninstall from all workspaces and remove firewall rules.
        let workspaces = find_cowork_workspaces();

        let reports: Vec<_> = workspaces
            .iter()
            .map(|ws| uninstall_tandem_plugin_from_workspace(ws))
            .collect();

        let errors: Vec<_> = reports.iter().filter_map(|r| r.as_ref().err()).collect();
        if !errors.is_empty() {
            log::warn!("[cowork] disable: {} uninstall error(s): {:?}", errors.len(), errors);
        }

        let workspace_all_failed = if !workspaces.is_empty() {
            let success_count = reports.iter().filter(|r| workspace_entry_written(r)).count();

            if success_count > 0 && success_count < workspaces.len() {
                log::warn!(
                    "[cowork] disable partial: {}/{} workspace(s) uninstalled cleanly",
                    success_count, workspaces.len()
                );
            }
            success_count == 0
        } else {
            false // No workspaces = nothing to uninstall = success (firewall still needs removing).
        };

        // Firewall removal is ADVISORY, not fatal. Tandem never runs elevated, so a
        // `netsh delete` on a rule a past elevated run wrote fails with "requires
        // elevation" — surfacing as NetshFailure (run_netsh only classifies AdminDeclined
        // for `add`), indistinguishable from other delete failures. Failing disable here
        // traps exactly the non-admin user who needs the escape hatch. Leaving a rule is
        // safe: the deny rule is retired, the allow rule is scoped to the VM subnet, and
        // the server binds 127.0.0.1 only, so a leftover rule is inert. This aligns with
        // reconcile_orphan_firewall_rules (cowork_installer.rs), which already treats remove
        // failures as non-fatal. (Caveat: leaving the rule is inert only under the default
        // loopback bind; a future TANDEM_BIND_HOST=routable + stale VM-CIDR rule is an
        // untested composition. A later enable *may* clear it via reconcile_orphan_firewall_rules, but
        // that's best-effort — reconcile returns early if its scan fails — and the leftover
        // is an inert allow rule, not a missing protection.)
        let firewall_failed = match firewall::remove_cowork_rules() {
            Ok(()) => false,
            Err(fe) => {
                log::warn!("[cowork] disable: firewall rule removal failed (non-fatal): {fe}");
                true
            }
        };

        // Persist meta regardless of workspace/firewall outcome. Clearing the UAC-declined
        // flag is what makes the "Admin permission required" modal disappear: the user has
        // resolved the blocked state by turning the feature off. Unlike the advisory
        // firewall removal above, this write is the disable's CORE contract — if it fails,
        // the on-disk state stays `enabled = true` with the UAC flag set, so the modal
        // never goes away and the integration still reads as on. We therefore fail loud
        // (Err in the success-path tail below) instead of returning a green toast over a
        // stale state. Borrow in the warn so the Result survives for the later check.
        let meta_persist = cowork_meta::update(|m| {
            m.enabled = false;
            m.uac_declined_last_attempt = false;
            m.uac_declined_at = None;
        });
        if let Err(e) = &meta_persist {
            log::warn!("[cowork] failed to persist meta after disable: {e}");
        }

        if workspace_all_failed {
            let failure_summary: Vec<String> = reports.iter().map(|r| match r {
                Ok(report) => format!("{}/{}: {:?}", report.workspace_id, report.vm_id, report.installed_plugins),
                Err(e) => e.to_string(),
            }).collect();
            return Err(format!(
                "Cowork disable failed: all {} workspace(s) failed to uninstall. Failures: {}",
                workspaces.len(),
                failure_summary.join("; ")
            ));
        }

        // Workspace uninstall + firewall removal already ran (idempotent / inert), and the
        // disable branch re-drives this whole path on a repeat call, so failing here strands
        // nothing — a retry safely re-attempts the persist. Surface it so the user knows the
        // disable didn't stick rather than discovering the modal is still up.
        if let Err(e) = meta_persist {
            return Err(format!(
                "Cowork was turned off, but saving that state failed ({e}). Cowork is still \
                 marked enabled and the admin-permission notice stays open. Try disabling \
                 again; if it persists, restart Tandem."
            ));
        }

        let mut warnings: Vec<String> = Vec::new();
        if firewall_failed {
            warnings.push(COWORK_LEFTOVER_FIREWALL_WARNING.to_string());
        }
        // A partial uninstall is the same defect as the partial install above:
        // it was `log::warn!`-only, so a user with three workspaces where two
        // still hold plugin entries saw an unqualified "Cowork disabled".
        //
        // The predicate must be the SAME one `workspace_all_failed` uses above,
        // not a bare `is_ok()`. `uninstall_tandem_plugin_from_workspace` returns
        // `Ok(WorkspaceWriteReport { installed_plugins: WriteStatus::Failed(..) })`
        // on a revalidation failure (`cowork_installer.rs`) -- an `Ok` that means
        // the entry is still there. Counting that as a success made this warning
        // silent for the commonest failure shape, i.e. for exactly the case the
        // bullet above describes, while `workspace_all_failed` right above was
        // already treating it as a failure. The enable arm's `failure_summary`
        // uses the WriteStatus predicate; this one is now symmetric with it.
        let uninstall_failures: Vec<String> = reports
            .iter()
            .filter(|r| !workspace_entry_written(r))
            .map(|r| match r {
                Ok(report) => format!(
                    "{}/{}: {:?}",
                    report.workspace_id, report.vm_id, report.installed_plugins
                ),
                Err(e) => e.to_string(),
            })
            .collect();
        warnings.extend(partial_workspace_warning(
            "cleaned up",
            workspaces.len().saturating_sub(uninstall_failures.len()),
            workspaces.len(),
            &uninstall_failures,
        ));
        Ok(CoworkToggleReport { message: "Cowork disabled".to_string(), warnings })
    }
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn cowork_toggle_integration(_enabled: bool) -> Result<CoworkToggleReport, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Re-scan workspaces and install into any new ones.
#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn cowork_rescan() -> Result<String, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, resolve_tandem_url};
    use cowork_workspace_scan::find_cowork_workspaces;

    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    if !meta.enabled {
        return Ok("Cowork not enabled — rescan skipped".to_string());
    }

    let token = token_store::get_or_create_token()?;
    let tandem_url = resolve_tandem_url(&meta);

    let workspaces = find_cowork_workspaces();

    let reports: Vec<_> = workspaces
        .iter()
        .map(|ws| install_tandem_plugin_into_workspace(ws, &token, &tandem_url))
        .collect();

    let errors: Vec<_> = reports.iter().filter_map(|r| r.as_ref().err()).collect();
    if !errors.is_empty() {
        log::warn!("[cowork] rescan: {} install error(s): {:?}", errors.len(), errors);
    }

    if !workspaces.is_empty() {
        let success_count = reports.iter().filter(|r| {
            match r {
                Ok(report) => matches!(
                    report.installed_plugins,
                    cowork_installer::WriteStatus::Ok | cowork_installer::WriteStatus::AlreadyPresent
                ),
                Err(_) => false,
            }
        }).count();

        if success_count == 0 {
            let failure_summary: Vec<String> = reports.iter().map(|r| match r {
                Ok(report) => format!("{}/{}: {:?}", report.workspace_id, report.vm_id, report.installed_plugins),
                Err(e) => e.to_string(),
            }).collect();
            return Err(format!(
                "Cowork rescan failed: all {} workspace(s) failed. Failures: {}",
                workspaces.len(),
                failure_summary.join("; ")
            ));
        }

        if success_count < workspaces.len() {
            log::warn!("[cowork] rescan partial: {}/{} workspace(s) succeeded", success_count, workspaces.len());
        }
    }

    if let Err(e) = cowork_meta::update(|m| {
        m.workspaces_last_scanned_at = Some(iso_now());
    }) {
        log::warn!("[cowork] rescan: failed to persist meta: {e}");
    }

    Ok(format!("Rescan complete: {} workspace(s)", workspaces.len()))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn cowork_rescan() -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// One self-heal pass: when the Cowork integration is enabled, install the
/// plugin entry into any workspace that lacks one. Runs from a background
/// interval task (see `setup`) so a workspace created AFTER enable — e.g. the
/// user's first Cowork session — gets configured headlessly, without the user
/// reopening settings or clicking Re-scan.
///
/// Guards:
/// - No-op unless `cowork_meta.enabled` (never arms anything by itself; no
///   firewall work, no UAC, ever).
/// - Read-only precheck first — zero writes and zero keychain access when every
///   workspace already has its entry (the steady state). The credential fetch is
///   forced lazily, from inside the injected installer, so a pass with nothing
///   to install stays side-effect-free and infallible.
/// - Attempt set keyed on *terminal* outcomes only: a workspace is recorded
///   (and not retried this run) once its install succeeds OR fails terminally
///   (`InsecureAcl` — a redirected/synced path that will never become safe).
///   A *transient* failure (`Locked` / `SchemaDrift` / `Failed` / error) is left
///   OUT of the set so the next tick self-heals a momentary glitch. New paths
///   are attempted as they appear. The manual "Re-scan workspaces" button
///   deliberately bypasses this guard (it force-reinstalls everything).
///
/// Returns the number of workspaces successfully installed this pass.
///
/// The loop itself lives in `heal_pass_inner` — this is the shell that loads
/// meta, scans, delegates (handing the loop a closure that lazily resolves the
/// credential and writes), and persists meta. Everything below the shell's disk
/// and keychain dependencies is unit-tested there (#1112).
#[cfg(target_os = "windows")]
pub(crate) fn cowork_heal_pass() -> Result<usize, String> {
    use std::cell::OnceCell;
    use std::collections::BTreeSet;
    use std::path::Path;

    use cowork_installer::{install_tandem_plugin_into_workspace, resolve_tandem_url, WriteStatus};
    use cowork_workspace_scan::find_cowork_workspaces;

    static HEAL_ATTEMPTED: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    if !meta.enabled {
        return Ok(0);
    }

    // Read-only snapshot of the attempt set; the heal pass is a single serialized
    // interval task, so no concurrent pass races this — and manual rescan never
    // touches HEAL_ATTEMPTED.
    let attempted: BTreeSet<PathBuf> = {
        let guard = HEAL_ATTEMPTED.lock().unwrap_or_else(|p| p.into_inner());
        guard.clone()
    };

    // Credentials are resolved LAZILY, inside the installer closure, and only
    // once per pass. This PRESERVES a property the pre-refactor shell already
    // had for free — there, the token fetch sat physically below both early
    // returns, so an enabled-but-idle tick never reached it. Moving the
    // precheck into `heal_pass_inner` removes that positional guarantee, and
    // the `OnceCell` is what puts it back; this is not repairing a live bug.
    //
    // It matters because `get_or_create_token` is NOT a pure keychain read:
    // with no token stored it mints one and persists it (keyring
    // `set_password`, or the env-paths file), and it can fail outright on a
    // broken keyring. Forcing it up here would make the idle steady state both
    // a potential write and a fallible operation, turning a silent `Ok(0)`
    // into a "[cowork] heal pass failed" log on every 5-minute tick.
    // A failure is therefore scoped to the workspace that needed it, as a
    // transient `Failed` (left out of the attempt set, retried next tick).
    let credentials: OnceCell<Result<(String, String), String>> = OnceCell::new();

    let (installed, terminal) =
        heal_pass_inner(find_cowork_workspaces(), &attempted, |ws: &Path| {
            let creds = match credentials.get_or_init(|| {
                token_store::get_or_create_token().map(|t| (t, resolve_tandem_url(&meta)))
            }) {
                Ok(creds) => creds,
                Err(e) => {
                    log::warn!(
                        "[cowork] heal: no token available, skipping {}: {e}",
                        ws.display()
                    );
                    return WriteStatus::Failed(e.clone());
                }
            };
            match install_tandem_plugin_into_workspace(ws, &creds.0, &creds.1) {
                Ok(report) => report.installed_plugins,
                Err(e) => {
                    log::warn!("[cowork] heal: install into {} errored: {e}", ws.display());
                    // Treat an error as a transient Failed so it retries next tick.
                    WriteStatus::Failed(e.to_string())
                }
            }
        });

    // Record only terminal outcomes — transient failures stay retryable.
    if !terminal.is_empty() {
        let mut attempted = HEAL_ATTEMPTED.lock().unwrap_or_else(|p| p.into_inner());
        attempted.extend(terminal);
    }

    if installed > 0 {
        if let Err(e) = cowork_meta::update(|m| {
            m.workspaces_last_scanned_at = Some(iso_now());
        }) {
            log::warn!("[cowork] heal: failed to persist meta: {e}");
        }
    }

    Ok(installed)
}

/// The heal pass's find -> filter -> classify -> terminal-mark loop, with the
/// keychain and the registry write injected as `install`.
///
/// Split out of `cowork_heal_pass` so the orchestration is unit-testable (#1112):
/// the shell's `cowork_meta::load()` reads env-paths disk and its `install`
/// closure resolves `token_store::get_or_create_token()` against the OS keychain,
/// neither of which is overridable. Because the credential lives behind `install`
/// (lazily, via a `OnceCell` the shell only forces from inside it), a pass that
/// installs nothing never reaches the keychain: the two early returns below are
/// what keep the steady state a pure read. `attempted` is taken as a borrowed set
/// rather than read from the caller's process-wide static, so tests need no
/// ordering lock.
///
/// Returns `(installed_count, newly_terminal_workspaces)`. The caller — and only
/// the caller — folds the returned paths into its attempt set: marking inside
/// the loop is what poisoned transient failures in #1110 (see lessons-learned
/// lesson 81), so a `Locked` / `SchemaDrift` / `Failed` workspace must come back
/// out of here unmarked and be retried on the next tick.
#[cfg(target_os = "windows")]
fn heal_pass_inner(
    workspaces: Vec<PathBuf>,
    attempted: &std::collections::BTreeSet<PathBuf>,
    install: impl Fn(&std::path::Path) -> cowork_installer::WriteStatus,
) -> (usize, Vec<PathBuf>) {
    use cowork_installer::{heal_outcome_is_terminal, workspace_has_tandem_entry, WriteStatus};

    // Read-only precheck: which workspaces lack a tandem entry?
    let missing: Vec<PathBuf> = workspaces
        .into_iter()
        .filter(|ws| !workspace_has_tandem_entry(ws))
        .collect();
    if missing.is_empty() {
        return (0, Vec::new());
    }

    // Skip workspaces already terminally attempted this run.
    let to_attempt: Vec<PathBuf> = missing
        .into_iter()
        .filter(|ws| !attempted.contains(ws))
        .collect();
    if to_attempt.is_empty() {
        return (0, Vec::new());
    }

    let mut installed = 0usize;
    let mut terminal: Vec<PathBuf> = Vec::new();
    for ws in &to_attempt {
        let status = install(ws.as_path());
        match &status {
            WriteStatus::Ok | WriteStatus::AlreadyPresent => installed += 1,
            other => log::warn!(
                "[cowork] heal: install into {} not successful: {other:?}",
                ws.display()
            ),
        }
        if heal_outcome_is_terminal(&status) {
            terminal.push(ws.clone());
        }
    }

    (installed, terminal)
}

/// Tests for the Cowork heal-pass loop orchestration (#1112): no-op when there
/// is nothing to scan, no-op when every workspace is already configured (or was
/// already attempted), install-on-missing, and terminal-only attempt marking.
///
/// Windows-gated, like everything they exercise (`cowork_installer` is
/// `#![cfg(target_os = "windows")]`), so they compile — and run — only on the
/// windows-latest leg of ci.yml's `rust-test` matrix. A green `cargo test` on
/// Linux does not mean these ran; it means they did not exist.
///
/// No env lock is needed: `heal_pass_inner` reads only the paths it is handed
/// and the borrowed attempt set, never `HEAL_ATTEMPTED` or the scan roots.
#[cfg(all(test, target_os = "windows"))]
mod cowork_heal_pass_tests {
    use super::*;
    use crate::cowork_installer::WriteStatus;
    use std::cell::RefCell;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    /// Create a workspace dir under `root`; when `configured`, give it the
    /// `installed_plugins.json` entry `workspace_has_tandem_entry` looks for.
    fn make_ws(root: &Path, name: &str, configured: bool) -> PathBuf {
        let ws = root.join(name);
        let plugins = ws.join("cowork_plugins");
        fs::create_dir_all(&plugins).unwrap();
        if configured {
            fs::write(
                plugins.join("installed_plugins.json"),
                r#"{"mcpServers":{"tandem":{"type":"stdio"}}}"#,
            )
            .unwrap();
        }
        ws
    }

    #[test]
    fn inner_no_ops_when_there_is_nothing_to_scan() {
        // The `!meta.enabled` guard itself lives in the shell (it needs
        // `cowork_meta::load`), and a disabled pass never reaches a scan — so the
        // delegated shape is an empty workspace list. Nothing installed, nothing
        // marked, and the injected install is never called: no keychain, no writes.
        let calls = RefCell::new(Vec::new());
        let attempted = BTreeSet::new();
        let (installed, terminal) = heal_pass_inner(Vec::new(), &attempted, |ws: &Path| {
            calls.borrow_mut().push(ws.to_path_buf());
            WriteStatus::Ok
        });

        assert_eq!(installed, 0);
        assert!(terminal.is_empty());
        assert!(
            calls.borrow().is_empty(),
            "install must not run with no workspaces"
        );
    }

    #[test]
    fn inner_no_ops_when_every_workspace_is_already_configured() {
        // The steady state: the read-only precheck finds nothing missing, so the
        // pass stays a pure read. `install` never being called is the whole
        // invariant — the shell resolves the token lazily from inside it, so an
        // uncalled `install` means no keychain access and no token minted either.
        let dir = TempDir::new().unwrap();
        let a = make_ws(dir.path(), "a", true);
        let b = make_ws(dir.path(), "b", true);

        let calls = RefCell::new(Vec::new());
        let attempted = BTreeSet::new();
        let (installed, terminal) = heal_pass_inner(vec![a, b], &attempted, |ws: &Path| {
            calls.borrow_mut().push(ws.to_path_buf());
            WriteStatus::Ok
        });

        assert_eq!(installed, 0);
        assert!(terminal.is_empty());
        assert!(
            calls.borrow().is_empty(),
            "steady state must not write anything"
        );
    }

    #[test]
    fn inner_no_ops_when_every_missing_workspace_was_already_attempted() {
        // Second early return: the workspace lacks its entry but was terminally
        // attempted this run, so it is not retried.
        let dir = TempDir::new().unwrap();
        let missing = make_ws(dir.path(), "attempted", false);

        let mut attempted = BTreeSet::new();
        attempted.insert(missing.clone());

        let calls = RefCell::new(Vec::new());
        let (installed, terminal) = heal_pass_inner(vec![missing], &attempted, |ws: &Path| {
            calls.borrow_mut().push(ws.to_path_buf());
            WriteStatus::Ok
        });

        assert_eq!(installed, 0);
        assert!(terminal.is_empty());
        assert!(
            calls.borrow().is_empty(),
            "a terminally attempted workspace must not be reinstalled"
        );
    }

    #[test]
    fn inner_installs_only_into_unconfigured_unattempted_workspaces() {
        let dir = TempDir::new().unwrap();
        let configured = make_ws(dir.path(), "configured", true);
        let already_tried = make_ws(dir.path(), "already-tried", false);
        let fresh = make_ws(dir.path(), "fresh", false);

        let mut attempted = BTreeSet::new();
        attempted.insert(already_tried.clone());

        let calls = RefCell::new(Vec::new());
        let (installed, terminal) = heal_pass_inner(
            vec![configured, already_tried, fresh.clone()],
            &attempted,
            |ws: &Path| {
                calls.borrow_mut().push(ws.to_path_buf());
                WriteStatus::Ok
            },
        );

        assert_eq!(installed, 1);
        assert_eq!(terminal, vec![fresh.clone()]);
        assert_eq!(*calls.borrow(), vec![fresh]);
    }

    #[test]
    fn inner_marks_only_terminal_outcomes_so_transient_failures_retry() {
        // The #1110 regression (lessons-learned lesson 81): marking every touched
        // workspace instead of gating on `heal_outcome_is_terminal` poisons a
        // momentary Locked/SchemaDrift/Failed, so the next tick never retries it.
        // Terminal = Ok | AlreadyPresent | InsecureAcl, and nothing else.
        fn outcome(ws: &Path) -> WriteStatus {
            match ws.file_name().unwrap().to_str().unwrap() {
                "ok" => WriteStatus::Ok,
                "present" => WriteStatus::AlreadyPresent,
                "acl" => WriteStatus::InsecureAcl,
                "locked" => WriteStatus::Locked,
                "drift" => WriteStatus::SchemaDrift,
                _ => WriteStatus::Failed("io".into()),
            }
        }

        let dir = TempDir::new().unwrap();
        let ok = make_ws(dir.path(), "ok", false);
        let present = make_ws(dir.path(), "present", false);
        let acl = make_ws(dir.path(), "acl", false);
        let locked = make_ws(dir.path(), "locked", false);
        let drift = make_ws(dir.path(), "drift", false);
        let failed = make_ws(dir.path(), "failed", false);
        let all = vec![
            ok.clone(),
            present.clone(),
            acl.clone(),
            locked.clone(),
            drift.clone(),
            failed.clone(),
        ];

        let attempted = BTreeSet::new();
        let (installed, terminal) = heal_pass_inner(all.clone(), &attempted, outcome);

        // Only the two successes count as installed — InsecureAcl is terminal but
        // is not an install.
        assert_eq!(installed, 2);
        assert_eq!(terminal, vec![ok, present, acl]);
        for retryable in [&locked, &drift, &failed] {
            assert!(
                !terminal.contains(retryable),
                "{} is a transient failure and must stay retryable",
                retryable.display()
            );
        }

        // Next tick: fold the returned terminal set in (what the shell does) and
        // re-run. Exactly the three transient workspaces are attempted again.
        let attempted: BTreeSet<PathBuf> = terminal.into_iter().collect();
        let calls = RefCell::new(Vec::new());
        let (installed, terminal) = heal_pass_inner(all, &attempted, |ws: &Path| {
            calls.borrow_mut().push(ws.to_path_buf());
            outcome(ws)
        });

        assert_eq!(installed, 0);
        assert!(terminal.is_empty());
        assert_eq!(*calls.borrow(), vec![locked, drift, failed]);
    }
}

/// Get the current Cowork integration status.
#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn cowork_get_status() -> Result<serde_json::Value, String> {
    use cowork_workspace_scan::{claude_desktop_detected, find_cowork_workspaces_with_stats};

    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    let (workspace_paths, scan_stats) = find_cowork_workspaces_with_stats();
    let cowork_detected = !workspace_paths.is_empty();
    // Claude Desktop install signal, independent of workspace existence —
    // lets the UI distinguish "no Claude at all" from "Claude present, Cowork
    // never run yet" and from "sessions found but blocked by the path guard"
    // (redirected/synced AppData). Existence checks only; read-only.
    let claude_detected = claude_desktop_detected();

    // Build a workspace status array compatible with the TypeScript WorkspaceStatus[]
    // type declared in PR f.  This is a read-only status check — no writes, no ACL
    // checks, no firewall operations.
    // When the integration is not enabled, an absent entry is the expected
    // "not yet set up" state — not a failure. Reporting "failed" for writes that
    // were never attempted is misleading (the enable flow aborts before any
    // plugin write when the firewall step can't run). Only call a missing entry
    // "failed" once the user has actually enabled the integration.
    let absent_status = if meta.enabled { "failed" } else { "notConfigured" };

    let workspaces: Vec<serde_json::Value> = workspace_paths
        .iter()
        .map(|ws_path| {
            // Extract workspace_id (grandparent leaf) and vm_id (leaf).
            let vm_id = ws_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let workspace_id = ws_path
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();

            // Read-only check: does installed_plugins.json contain a tandem entry?
            let installed_status = if cowork_installer::workspace_has_tandem_entry(ws_path) {
                "ok"
            } else {
                absent_status
            };

            // Read-only check: does known_marketplaces.json exist?
            let marketplaces_file = ws_path.join("cowork_plugins").join("known_marketplaces.json");
            let marketplaces_status = if marketplaces_file.exists() {
                match std::fs::read_to_string(&marketplaces_file)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                {
                    Some(_) => "ok",
                    _ => "failed",
                }
            } else {
                absent_status
            };

            // Read-only check: does cowork_settings.json exist?
            let settings_file = ws_path.join("cowork_plugins").join("cowork_settings.json");
            let cowork_settings_status = if settings_file.exists() {
                match std::fs::read_to_string(&settings_file)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                {
                    Some(_) => "ok",
                    _ => "failed",
                }
            } else {
                absent_status
            };

            serde_json::json!({
                "workspaceId": workspace_id,
                "vmId": vm_id,
                "path": ws_path.to_string_lossy(),
                "installedPlugins": installed_status,
                "knownMarketplaces": marketplaces_status,
                "coworkSettings": cowork_settings_status,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "enabled": meta.enabled,
        "vethernetCidr": meta.vethernet_cidr_detected,
        "lanIpFallback": meta.lan_ip_fallback,
        "useLanIpOverride": meta.use_lan_ip_override,
        "workspacesLastScannedAt": meta.workspaces_last_scanned_at,
        "uacDeclined": meta.uac_declined_last_attempt,
        "uacDeclinedAt": meta.uac_declined_at,
        "workspaces": workspaces,
        "coworkDetected": cowork_detected,
        "claudeDesktopDetected": claude_detected,
        "workspacesBlocked": scan_stats.rejected_by_guard,
        "osSupported": true,
    }))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn cowork_get_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "osSupported": false,
        "enabled": false,
        "coworkDetected": false,
        "claudeDesktopDetected": false,
        "workspacesBlocked": 0,
        "workspaces": [],
        "vethernetCidr": null,
        "lanIpFallback": null,
        "useLanIpOverride": false,
        "uacDeclined": false,
        "uacDeclinedAt": null,
    }))
}

/// Read the Cowork metadata file.
#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn cowork_get_meta() -> Result<cowork_meta::CoworkMeta, String> {
    cowork_meta::load()
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn cowork_get_meta() -> Result<serde_json::Value, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Coalesces concurrent advisory subnet probes (#1371).
///
/// Moving the command off the main thread removes an accidental mutex — Tauri
/// dispatches sync commands inline on the UI thread, so two could never overlap.
/// "Check again" is user-repeatable, so without this a burst of clicks would
/// become a burst of `powershell.exe` processes.
///
/// **What this deliberately does NOT cover.** `cowork_toggle_integration` runs
/// its own detection (`detect_vethernet_subnet`, below) and does not join this
/// flight. Joining would mean either handing Enable a coalesced advisory answer —
/// which `cowork-invoke.ts` forbids outright, because "the VM can stop between
/// the two" — or making Enable wait out an advisory probe, and since Enable is
/// still a sync command that wait would land on the main thread, adding freeze to
/// fix freeze. The honest bound is therefore at most TWO concurrent probes: one
/// coalesced advisory, plus at most one from Enable (whose handler blocks the UI
/// thread, so it cannot double-fire). The repeatable button is fully coalesced.
static SUBNET_PROBE_FLIGHT: single_flight::SingleFlight<Result<String, String>> =
    single_flight::SingleFlight::new();

/// Detect the Hyper-V vEthernet subnet (advisory pre-flight).
///
/// ONE ungated `async fn` with a cfg-split body, on purpose — see the section
/// comment above. `async fn` + `spawn_blocking` is the fix, and the pair is not
/// interchangeable with `#[tauri::command(async)]` on a sync fn: `tauri-macros`
/// labels that shape `"sync_threadpool"`, but the string is only a tracing span
/// field — `body_async` calls the sync fn *inside* the future and
/// `respond_async_serialized_inner` hands it to `async_runtime::spawn`, i.e.
/// tokio's WORKER pool, where a blocking process wait also stalls every other
/// `respond_async` command.
#[tauri::command]
pub(crate) async fn cowork_detect_vethernet_subnet() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        SUBNET_PROBE_FLIGHT
            .run(detect_subnet_advisory_blocking)
            // `None` means the flight was abandoned, which can only happen if the
            // leader panicked. Unparseable by `parseFirewallErrorVariant`, so it
            // surfaces as `status: "unknown"` and a console.error — the right
            // destination for a genuine bug, and never a blocked Enable button.
            .unwrap_or_else(|| Err("subnet probe was abandoned".to_string()))
    })
    .await
    .map_err(|e| format!("subnet probe task failed: {e}"))?
}

#[cfg(target_os = "windows")]
fn detect_subnet_advisory_blocking() -> Result<String, String> {
    firewall::detect_vethernet_subnet(firewall::SUBNET_PROBE_TIMEOUT_ADVISORY)
        .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))
}
#[cfg(not(target_os = "windows"))]
fn detect_subnet_advisory_blocking() -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Re-walk all workspaces with a new auth token (called after `tandem rotate-token`).
///
/// Token is never logged — passed through to `apply_token_to_all_workspaces`
/// which also never logs it.
#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn cowork_apply_token(token: String) -> Result<String, String> {
    let reports = cowork_installer::apply_token_to_all_workspaces(&token);
    let total = reports.len();
    let success = reports.iter().filter(|r| matches!(
        r.installed_plugins,
        cowork_installer::WriteStatus::Ok | cowork_installer::WriteStatus::AlreadyPresent
    )).count();

    if total > 0 && success == 0 {
        let failure_summary: Vec<String> = reports.iter().map(|r| {
            format!("{}/{}: {:?}", r.workspace_id, r.vm_id, r.installed_plugins)
        }).collect();
        return Err(format!(
            "Cowork apply-token failed: all {total} workspace(s) failed. Failures: {}",
            failure_summary.join("; ")
        ));
    }
    if success < total {
        log::warn!("[cowork] apply-token partial: {success}/{total} workspace(s) succeeded");
    }
    Ok(format!("Cowork: {success} workspace(s) re-walked with new token"))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn cowork_apply_token(_token: String) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Resolve a snapshot handle token to its validated canonical workspace path.
///
/// Closes the TOCTOU window (issue #433): instead of re-scanning the filesystem
/// and trusting a caller-supplied string, the token can only name a path that
/// `cowork_scan_workspaces` already validated this session. The resolved path is
/// then re-run through the five-step guard (`revalidate_resolved_path`) to
/// catch a directory swapped *after* the scan. An unknown token — forged, or
/// from a superseded scan — is rejected with no file I/O. The re-validation's
/// specific rejection reason is preserved (single informative message, not
/// re-flattened) for incident triage.
#[cfg(target_os = "windows")]
fn cowork_resolve_validated_handle(handle: &str, op: &str) -> Result<std::path::PathBuf, String> {
    let Some(resolved) = cowork_workspace_scan::resolve_handle(handle) else {
        log::warn!(
            "[cowork] {op}: unknown workspace handle — rejected (no current scan token matches)"
        );
        return Err("Unknown or expired workspace handle — re-scan and try again".to_string());
    };

    // Defense-in-depth: re-run the five-step guard against the stored path to
    // catch a post-scan swap (directory replaced with a junction, moved, etc.).
    cowork_workspace_scan::revalidate_resolved_path(&resolved).map_err(|reason| {
        log::warn!("[cowork] {op}: resolved handle failed re-validation — rejected: {reason}");
        reason
    })
}

/// Install the Tandem plugin into a specific workspace, named by an opaque
/// snapshot handle from `cowork_scan_workspaces`.
///
/// The handle resolves — in-process — to the exact canonical path validated at
/// scan time, which is re-checked against invariant §3 before any file I/O.
/// A caller-supplied path string is never trusted; an unknown handle is rejected.
#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn cowork_install_into_workspace(handle: String) -> Result<String, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, resolve_tandem_url};

    let validated_path = cowork_resolve_validated_handle(&handle, "cowork_install_into_workspace")?;

    let token = token_store::get_or_create_token()?;
    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    let tandem_url = resolve_tandem_url(&meta);

    let report = install_tandem_plugin_into_workspace(&validated_path, &token, &tandem_url)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::to_string(&report).map_err(|e| e.to_string())?)
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn cowork_install_into_workspace(_handle: String) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Uninstall the Tandem plugin from a specific workspace, named by an opaque
/// snapshot handle from `cowork_scan_workspaces`. See
/// [`cowork_install_into_workspace`] for the handle contract.
#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn cowork_uninstall_from_workspace(handle: String) -> Result<String, String> {
    let validated_path =
        cowork_resolve_validated_handle(&handle, "cowork_uninstall_from_workspace")?;

    let report = cowork_installer::uninstall_tandem_plugin_from_workspace(&validated_path)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&report).map_err(|e| e.to_string())?)
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn cowork_uninstall_from_workspace(_handle: String) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Set or unset the LAN-IP override for TANDEM_URL.
#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn cowork_set_lan_ip_override(enabled: bool) -> Result<String, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, resolve_tandem_url};
    use cowork_workspace_scan::find_cowork_workspaces;

    cowork_meta::update(|m| { m.use_lan_ip_override = enabled; })
        .map_err(|e| e.to_string())?;

    // If Cowork is enabled, re-walk to apply the new URL.
    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    if meta.enabled {
        let token = token_store::get_or_create_token()?;
        let tandem_url = resolve_tandem_url(&meta);
        let workspaces = find_cowork_workspaces();

        let reports: Vec<_> = workspaces
            .iter()
            .map(|ws| install_tandem_plugin_into_workspace(ws, &token, &tandem_url))
            .collect();

        let errors: Vec<_> = reports.iter().filter_map(|r| r.as_ref().err()).collect();
        if !errors.is_empty() {
            log::warn!("[cowork] set_lan_ip_override: {} re-walk error(s): {:?}", errors.len(), errors);
        }

        if !workspaces.is_empty() {
            let success_count = reports.iter().filter(|r| workspace_entry_written(r)).count();

            if success_count == 0 {
                let failure_summary: Vec<String> = reports.iter().map(|r| match r {
                    Ok(report) => format!("{}/{}: {:?}", report.workspace_id, report.vm_id, report.installed_plugins),
                    Err(e) => e.to_string(),
                }).collect();
                return Err(format!(
                    "LAN IP override applied to meta but re-walk failed: all {} workspace(s) failed. Failures: {}",
                    workspaces.len(),
                    failure_summary.join("; ")
                ));
            }

            if success_count < workspaces.len() {
                log::warn!("[cowork] set_lan_ip_override partial: {}/{} workspace(s) succeeded", success_count, workspaces.len());
            }
        }
    }

    Ok(format!("LAN IP override {}", if enabled { "enabled" } else { "disabled" }))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn cowork_set_lan_ip_override(_enabled: bool) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Retry the enable flow after an admin-declined attempt (#1560).
///
/// This delegates to `cowork_toggle_integration(true)` and nothing else. It used
/// to clear `uac_declined_*` first, through `cowork_meta::update(...)?` — and the
/// `?` was the bug: the canonical cause of that update failing is an unwritable
/// `cowork-meta.json`, which is precisely when the admin-declined modal is up and
/// Retry is the user's escape hatch. Under that fault the button returned early,
/// every time, and the enable was never attempted at all.
///
/// The separate clear is gone rather than merely reordered, because on every path
/// it was either redundant or wrong:
///
/// - **Toggle succeeds.** Its enable arm's own `cowork_meta::update` sets
///   `uac_declined_last_attempt = false` and `uac_declined_at = None` immediately
///   before the only `Ok(...)` it returns. The flag is cleared by the toggle,
///   through the same code path, so a second write adds nothing.
/// - **Toggle hits `AdminDeclined`.** That arm deliberately *re-sets* the flag
///   with a fresh `uac_declined_at`, which is what re-arms the modal for a decline
///   that just happened. A pre-emptive clear is undone a few lines later.
/// - **Toggle fails any other way** (netsh missing, subnet detection failed, every
///   workspace install failed). Meta is untouched, so the clear was the only
///   writer — and clearing it there is the wrong outcome: it retires the modal
///   after a retry that did not enable anything, leaving the user with a transient
///   inline error and no standing signal that Cowork is still off.
///
/// So there is no clear result to report, and no partial-commit shape to report it
/// as. Whether a *failed* meta persist inside the toggle should itself be fatal is
/// a separate question, tracked by #1559; whatever that decides, this command
/// forwards the toggle's verdict unchanged.
///
/// Note for anyone tracing the UAC wording: Tandem never elevates itself.
/// `firewall::run_netsh` spawns a plain `netsh`, so `AdminDeclined` is *inferred*
/// from netsh's exit code and stderr — no UAC prompt is ever raised on this path,
/// and none can be accepted or declined.
#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn cowork_retry_admin_elevation() -> Result<CoworkToggleReport, String> {
    cowork_toggle_integration(true)
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn cowork_retry_admin_elevation() -> Result<CoworkToggleReport, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Minimal ISO-8601 (UTC) timestamp without pulling in chrono.
///
/// Uses the proleptic Gregorian calendar starting from the Unix epoch
/// (1970-01-01T00:00:00Z). Handles leap years; timezone is always UTC.
#[cfg(target_os = "windows")]
fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs();

    // Compute time of day first.
    let secs = (total_secs % 60) as u32;
    let mins = ((total_secs / 60) % 60) as u32;
    let hours = ((total_secs / 3600) % 24) as u32;

    // Days since Unix epoch.
    let mut days = (total_secs / 86_400) as i64;

    // Walk forward from 1970 accounting for leap years.
    let mut year: i64 = 1970;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }

    // Now walk through months of the current year.
    let months_normal = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let months_leap = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let months = if is_leap(year) { &months_leap } else { &months_normal };
    let mut month: usize = 0;
    for (i, &dim) in months.iter().enumerate() {
        if days < dim {
            month = i;
            break;
        }
        days -= dim;
    }
    let day = days + 1; // 1-indexed.

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        day,
        hours,
        mins,
        secs
    )
}

#[cfg(target_os = "windows")]
fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}
