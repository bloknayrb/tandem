//! Windows Firewall management for the Cowork VM subnet allow/deny rules.
//!
//! All `netsh` invocations use `Command::new("netsh").args([...])` — never
//! `cmd.exe`, never string concatenation, never `--%` wrappers: no shell is
//! interposed, so nothing in an argument value — including the detected CIDR
//! in `remoteip={cidr}` — can be re-read as a second command.
//!
//! Every invocation is logged with: argv, exit code, a stdout+stderr excerpt,
//! and wall-clock duration — at DEBUG when it succeeded, at WARN when it did
//! not (#1372: DEBUG is filtered out of release desktop builds, so the only
//! runs anyone ever wants the diagnostics for were the runs that logged
//! nothing). For the subnet query the level follows the CLASSIFICATION, not the
//! exit status: a zero exit whose stdout carries no marker is still a failure.
//!
//! Two rules govern every captured stream that leaves this module, and both
//! fail silently when broken:
//!
//! 1. **Redact, then truncate.** `redact_home` matches the home directory as a
//!    substring, so truncating first can slice through that prefix and leave a
//!    fragment that still spells the username while no longer matching. The
//!    redaction would then be active only where truncation was not.
//! 2. **Log the redacted excerpt, not the raw one.** The wire copy is a toast
//!    the user chooses whether to paste; the log copy is 25 MB of `LogDir` that
//!    users attach to bug reports. Logging raw makes the durable copy the
//!    unredacted one, which is the opposite of what raising these lines from
//!    DEBUG to WARN was for.

#![cfg(target_os = "windows")]

use std::fmt;
use std::process::Command;
use std::time::{Duration, Instant};

use crate::bounded_command::{output_with_timeout, BoundedOutcome};

use crate::sentry_reporting::{home_dir_string, redact_home};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors that can arise from Windows Firewall operations.
///
/// Each variant must drive its own distinct recovery hint in the Settings UI,
/// not share a generic one — see `FirewallErrorVariant` in
/// `src/client/types.ts` and the `firewallErrorHint` switch in
/// `src/client/cowork/cowork-helpers.ts`. That switch ends in a runtime
/// `default` arm (TypeScript can't prove exhaustiveness across the Rust/TS
/// boundary), so a variant added here with no arm there would otherwise
/// degrade silently to the generic fallback — which is why
/// `tests/build/firewall-contract-alignment.test.ts` pins all three lists
/// together: the variants here, the union members in `types.ts`, and the
/// `case` arms of that switch.
///
/// `Serialize`/`Deserialize` enable structured JSON errors over the Tauri IPC:
/// `{"kind": "adminDeclined"}` etc., matching the TypeScript discriminant in
/// the Settings UI firewall hint handler.
/// `rename_all_fields` is NOT redundant with `rename_all` (#1372). Container
/// `rename_all` renames the VARIANTS only — a struct variant's fields keep
/// their Rust spelling — so `NetshFailure` went onto the wire as
/// `{"exit_code":1,"stderr_tail":…}` while `FirewallErrorVariant` in
/// `src/client/types.ts` declared `exitCode`/`stderrTail`. Every read was
/// `undefined`, and `truncateStderr(undefined)` throws, so the hint fell
/// through `formatCoworkError`'s catch to the raw JSON. Nothing caught it:
/// the client tests hand-build variants in the TypeScript spelling and never
/// see a Rust-serialized one. `netsh_failure_fields_use_the_wire_spelling`
/// pins it now.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FirewallError {
    /// The user declined the UAC elevation prompt. The install is fail-closed:
    /// a deny rule is written instead.
    AdminDeclined,
    /// `netsh.exe` was not found on PATH.
    NetshNotFound,
    /// `netsh.exe` ran but returned a non-zero exit code.
    NetshFailure { exit_code: i32, stderr_tail: String, stdout_tail: String },
    /// The vEthernet subnet could not be determined. `reason` says which of the
    /// several very different situations produced it — see
    /// [`SubnetDetectionReason`]. Issue #1298: this used to be one opaque
    /// variant whose single message blamed the user's Cowork install, in a
    /// dialog whose own title said Cowork had been detected.
    ///
    /// `exit_code` and `stderr_tail` are the diagnostics the query already
    /// captured and used to throw away (#1372). They are populated for
    /// [`SubnetDetectionReason::QueryFailed`] and **only** for it: the other
    /// three reasons come from a process that exited zero with output we
    /// understood, so an exit code of 0 and an empty stderr would be noise
    /// dressed as evidence. Sibling fields rather than a payload on the reason
    /// itself, because `SubnetDetectionReason` has to stay fieldless — serde
    /// spells a fieldless variant as a bare string, which is what the
    /// hand-written TypeScript union and its `SUBNET_REASON_HINT` lookup are
    /// keyed on, and what `tests/build/firewall-reason-alignment.test.ts`
    /// parses.
    SubnetDetectionFailed {
        reason: SubnetDetectionReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        stderr_tail: String,
    },
    /// PowerShell could not be started, so Hyper-V adapter enumeration never
    /// ran. `reason` says which of the three (#1372) — see
    /// [`AdapterEnumerationReason`].
    ///
    /// Note what this variant does NOT mean: a PowerShell that started and then
    /// failed is a `SubnetDetectionFailed { reason: QueryFailed }`. This one is
    /// only ever the spawn.
    AdapterEnumerationFailed { reason: AdapterEnumerationReason },
}

/// Why `powershell.exe` could not be started (#1372).
///
/// The three arms exist because their remedies differ, which is the whole test
/// for splitting a variant: a missing interpreter is a PATH or Windows-edition
/// problem, a refused one is an execution-policy or application-control
/// problem, and anything else is neither. The old single variant told all three
/// to "run Tandem as administrator or reboot to refresh the adapter list" —
/// advice that cannot work when the interpreter never launched, in a sentence
/// asserting an enumeration was attempted.
///
/// **This is a closed set derived from `io::ErrorKind`, never the `io::Error`
/// itself.** `firewall.rs` deliberately keeps `{e}` in `log::warn!` and off the
/// wire: a failed `Command::new("powershell")` spawn error carries the resolved
/// executable path, and widening this variant to hold it would turn the
/// client-side logging in `cowork-invoke.ts` into a host-path leak into pasted
/// bug reports. An `ErrorKind` is a bare discriminant with no such payload —
/// and mapping it to our own closed enum, rather than forwarding it, also keeps
/// the wire contract exhaustively coverable in TypeScript, which
/// `#[non_exhaustive] ErrorKind` is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdapterEnumerationReason {
    /// `powershell.exe` was not on PATH: PATH damage, a Windows edition that
    /// ships no Windows PowerShell, or a stripped install.
    NotFound,
    /// The OS refused to start it — AppLocker / WDAC / Software Restriction
    /// Policies, or ACLs on the interpreter itself.
    PermissionDenied,
    /// Any other spawn failure. The least-blaming bucket, and deliberately the
    /// fallback.
    SpawnFailed,
}

/// Why `detect_vethernet_subnet` could not produce a CIDR.
///
/// A payload rather than four sibling `FirewallError` variants, so the wire
/// discriminant stays `"subnetDetectionFailed"` and the four stay visibly one
/// family. This mirrors `UndetectedDetail` on the TypeScript side, which splits
/// a blanket "Cowork not detected" the same way and for the same reason.
///
/// None of these mean "Cowork isn't installed" — the workspace scan has already
/// succeeded by the time this runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubnetDetectionReason {
    /// The adapter query returned zero Hyper-V vEthernet matches. Usually the
    /// VM simply isn't running (these adapters appear on VM start and are torn
    /// down on shutdown). Also covers WSL mirrored networking, where no adapter
    /// is ever created, and a locale whose adapter descriptions don't match our
    /// English `*Hyper-V Virtual Ethernet*` filter. We cannot tell these apart,
    /// so the copy must not claim the adapter is absent — only that we didn't
    /// find one.
    NoAdapter,
    /// Adapters matched, but none carried an IPv4 address.
    NoIpv4,
    /// At least one candidate line was present and none survived
    /// `parse_cidr_from_line` — in practice the `/20` floor: prefixes wider
    /// than /20 are rejected so the firewall rule can never span more of the
    /// network than Cowork's VM subnet needs.
    PrefixTooBroad,
    /// PowerShell ran but exited non-zero, or its output was not in the shape
    /// we asked for. The least-blaming bucket, and deliberately the fallback.
    QueryFailed,
    /// The adapter query outlived its deadline and was killed (#1371).
    ///
    /// `Get-NetAdapter` goes through WMI, and a wedged `winmgmt` does not return
    /// — before this variant existed the call simply never came back, so no
    /// reason was ever produced at all.
    ///
    /// Appended last so the four existing wire spellings are untouched. It stays
    /// FIELDLESS on purpose: `tests/build/subnet-reason-alignment.test.ts` parses
    /// this enum with `/^\s{4}([A-Z]\w*),\s*$/gm`, so a variant carrying the
    /// elapsed seconds would make that alignment test unfixably red. The seconds
    /// live in the log line instead, which is also why the user-facing copy names
    /// the wait without quoting a number — the two call sites use different
    /// budgets, so no single string could be honest about both.
    Timeout,
}

/// Marker line the detection script prints before any address lines, carrying
/// the adapter match count. Without it, empty output is ambiguous between "no
/// adapter" and "adapter with no address" — the two conditions with the most
/// different user-facing advice.
const ADAPTER_COUNT_MARKER: &str = "TANDEM_ADAPTERS ";

impl fmt::Display for FirewallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FirewallError::AdminDeclined => {
                write!(f, "UAC elevation declined — Cowork firewall rule not added")
            }
            FirewallError::NetshNotFound => {
                write!(f, "netsh.exe not found — Windows Firewall management unavailable")
            }
            FirewallError::NetshFailure {
                exit_code,
                stderr_tail,
                stdout_tail,
            } => write!(
                f,
                "netsh.exe failed (exit {exit_code}): stdout={stdout_tail:?} stderr={stderr_tail:?}"
            ),
            FirewallError::SubnetDetectionFailed {
                reason,
                exit_code,
                stderr_tail,
            } => match reason {
                SubnetDetectionReason::NoAdapter => write!(
                    f,
                    "No Hyper-V vEthernet adapter matched — VM not running, WSL mirrored networking, or a localized adapter description"
                ),
                SubnetDetectionReason::NoIpv4 => write!(
                    f,
                    "Hyper-V vEthernet adapter present but carries no IPv4 address"
                ),
                SubnetDetectionReason::PrefixTooBroad => write!(
                    f,
                    "Detected Hyper-V vEthernet subnet is wider than /20 — refused"
                ),
                SubnetDetectionReason::QueryFailed => write!(
                    f,
                    "Hyper-V adapter query returned an error or unexpected output (exit {}): stderr={stderr_tail:?}",
                    exit_code.map_or_else(|| "?".to_string(), |c| c.to_string())
                ),
                SubnetDetectionReason::Timeout => write!(
                    f,
                    "Hyper-V adapter query exceeded its deadline and was killed"
                ),
            },
            FirewallError::AdapterEnumerationFailed { reason } => match reason {
                AdapterEnumerationReason::NotFound => {
                    write!(f, "powershell.exe not found — Hyper-V adapter enumeration never ran")
                }
                AdapterEnumerationReason::PermissionDenied => write!(
                    f,
                    "Windows refused to start powershell.exe — Hyper-V adapter enumeration never ran"
                ),
                AdapterEnumerationReason::SpawnFailed => {
                    write!(f, "powershell.exe could not be started — Hyper-V adapter enumeration never ran")
                }
            },
        }
    }
}

impl std::error::Error for FirewallError {}

// ---------------------------------------------------------------------------
// Firewall rule names
// ---------------------------------------------------------------------------

/// Advisory pre-flight budget (#1371).
///
/// Timing out here is nearly free: the pre-flight is advisory and never replaces
/// the enable path's own check, so failing fast is strictly better than making
/// the user watch a spinner. Matches `PORT_HOLDER_LOOKUP_TIMEOUT` in `lib.rs`,
/// this crate's other bounded external-process lookup.
pub const SUBNET_PROBE_TIMEOUT_ADVISORY: Duration = Duration::from_secs(5);

/// Enable-path budget (#1371).
///
/// Deliberately more generous than the advisory one, because the asymmetry runs
/// the other way here: a false timeout ABORTS an enable that would have
/// succeeded. Both numbers are estimates, not measurements — `detect_vethernet_
/// subnet` logs its real `elapsed` at DEBUG, so `tandem.log` from a real Windows
/// host is what should settle them.
pub const SUBNET_PROBE_TIMEOUT_ENABLE: Duration = Duration::from_secs(15);

/// Budget for a single `netsh` invocation (#1371).
///
/// `netsh advfirewall` is normally sub-second, but it is still an unbounded
/// external process on the main thread: `cowork_toggle_integration` reaches
/// `scan_orphan_rules` once and `run_netsh` three more times AFTER the subnet
/// probe, so bounding only the probe would leave the reported symptom
/// reproducible on the same panel.
///
/// Much tighter than the subnet budgets, and the asymmetry is deliberate: a
/// false timeout here is reported honestly as a netsh failure, whereas a
/// truncated subnet query can be *misclassified* as a fact about the user's
/// adapters. Cheap to be strict where being wrong is loud.
///
/// **Two numbers worth stating rather than deriving**, because this is a fix for
/// a window freeze:
///
/// 1. A single bounded call can overshoot its budget by up to
///    `3 x KILL_GRACE` (6s). `kill_and_report` runs a bounded reap and then two
///    sequential `recv_timeout(KILL_GRACE)` drains, which only stack in the
///    surviving-grandchild case. So the ceiling per call is `budget + 6s`.
/// 2. `cowork_toggle_integration` is still a SYNC command, so it stacks five
///    such calls inline on the UI thread: the probe plus `scan_orphan_rules`
///    plus `run_netsh` three times. Designed ceiling
///    `15 + 4 x 5 = 35s`; pathological ceiling
///    `(15 + 6) + 4 x (5 + 6) = 65s`.
///
/// That is a strict improvement on the unbounded hang it replaces, and making
/// Enable async is tracked separately — it needs its own in-flight guard before
/// its meta, firewall and workspace writes can safely overlap.
const NETSH_TIMEOUT: Duration = Duration::from_secs(5);

const RULE_NAME_ALLOW: &str = "Tandem Cowork";
const RULE_NAME_DENY: &str = "Tandem Cowork \u{2014} Deny (elevation refused)";
const RULE_NAME_PREFIX: &str = "Tandem Cowork";

// ---------------------------------------------------------------------------
// Subnet detection
// ---------------------------------------------------------------------------

/// Detect the Hyper-V vEthernet IPv4 CIDR for the Cowork VM subnet.
///
/// Queries Hyper-V virtual adapters via PowerShell. The script emits a
/// `TANDEM_ADAPTERS <n>` marker line first — the adapter count, whether or not
/// any of them yields an address — followed by one `<ip>/<prefix>` line per
/// adapter that has an IPv4 address. The marker is what separates "no adapter"
/// from "adapter with no address"; `classify_subnet_output` reads both.
///
/// # Security invariants
/// - Rejects any result where prefix length < 20 (too permissive).
/// - Returns `SubnetDetectionFailed { reason: NoAdapter }` on zero Hyper-V
///   adapter matches.
/// - Never falls back to a hardcoded CIDR like `172.16.0.0/12`.
///
/// # Returns
/// The detected CIDR string (e.g. `"172.20.0.0/20"`) on success.
///
/// `budget` bounds the whole PowerShell round-trip; on expiry the process is
/// killed and `SubnetDetectionReason::Timeout` is returned. The two call sites
/// pass different budgets on purpose — see `SUBNET_PROBE_TIMEOUT_ADVISORY` and
/// `SUBNET_PROBE_TIMEOUT_ENABLE`.
pub fn detect_vethernet_subnet(budget: Duration) -> Result<String, FirewallError> {
    // `@(...)` is load-bearing, not style: it guarantees an array, so `.Count`
    // is the match count for 0, 1 and n alike — without it a zero-match
    // pipeline yields `$null` and a single match yields a bare object. Zero
    // matches is exactly the NoAdapter case, the classification this whole
    // marker exists to make possible, so that count has to be trustworthy.
    let ps_script = r#"
$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceDescription -like '*Hyper-V Virtual Ethernet*' })
Write-Output "TANDEM_ADAPTERS $($adapters.Count)"
foreach ($adapter in $adapters) {
    $ip = $adapter | Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue
    if ($ip) {
        Write-Output "$($ip.IPAddress)/$($ip.PrefixLength)"
    }
}
"#;

    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", ps_script]);

    let start = Instant::now();
    let bounded = output_with_timeout(command, budget);
    let elapsed = start.elapsed();

    let output = match bounded {
        Ok(BoundedOutcome::Completed(o)) => o,
        Ok(BoundedOutcome::TimedOut {
            pid,
            partial_stdout_len,
            partial_stderr_len,
        }) => {
            // The seconds live here rather than in the user-facing copy: the two
            // call sites pass different budgets, so the hint names the wait
            // without quoting a number. The partial lengths separate "process
            // start hung" (0) from "the CIM query hung after the marker line".
            log::warn!(
                "[firewall] vEthernet query exceeded {}s and was killed (pid {pid}, partial \
                 stdout {partial_stdout_len}B, stderr {partial_stderr_len}B) after {:.2}s",
                budget.as_secs(),
                elapsed.as_secs_f64()
            );
            // No diagnostics (#1372): a killed process has no exit code we can
            // report and its stderr is by definition incomplete. The same rule
            // `with_query_diagnostics` follows — evidence only where there is
            // evidence — and `skip_serializing_if` keeps both off the wire.
            return Err(FirewallError::SubnetDetectionFailed {
                reason: SubnetDetectionReason::Timeout,
                exit_code: None,
                stderr_tail: String::new(),
            });
        }
        Err(e) => {
            // `{e}` stays in the log and off the wire: a spawn error's message
            // carries the resolved executable path. The wire gets the kind
            // only, mapped to our own closed enum.
            log::warn!(
                "[firewall] PowerShell spawn failed after {:.2}s: {e}",
                elapsed.as_secs_f64()
            );
            return Err(FirewallError::AdapterEnumerationFailed {
                reason: adapter_enumeration_reason(&e),
            });
        }
    };

    // Everything after the spawn is `finish_subnet_query`, which is a pure
    // function and therefore testable. The spawn is the only part that is not,
    // and it is now the only part left here — the redaction, the tail limit,
    // the choice of stream, the log level and the diagnostics gate were all
    // previously stranded in this untestable body.
    let home = home_dir_string();
    let outcome = finish_subnet_query(
        output.status.success(),
        output.status.code(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
        home.as_deref(),
        elapsed.as_secs_f64(),
    );
    log::log!(outcome.level, "{}", outcome.log_line);
    outcome.result
}

/// What the subnet query produced, as data rather than as side effects.
struct SubnetQueryOutcome {
    level: log::Level,
    log_line: String,
    result: Result<String, FirewallError>,
}

/// Redact, then truncate — in that order, which is the control and not a style
/// choice.
///
/// The other order looks equivalent and is not. Truncation cuts a fixed number
/// of bytes off one end, and either end can slice through the home-directory
/// prefix `redact_home` matches on; after that `input.contains(home)` is false,
/// the redaction silently no-ops, and the surviving fragment still spells the
/// username in full. Redaction would then be active only in the cases where
/// truncation was not — i.e. never in the long outputs that most need it.
fn redact_and_truncate(s: &str, home: Option<&str>, limit: usize) -> String {
    let trimmed = s.trim();
    let redacted = match home {
        Some(h) => redact_home(trimmed, h),
        None => std::borrow::Cow::Borrowed(trimmed),
    };
    truncate_head(&redacted, limit).to_string()
}

/// Turn a finished PowerShell run into a classification, a log level and a log
/// line (#1372).
///
/// Three decisions live here that each looked like a detail and each produced a
/// user-visible bug when they were made inline:
///
/// 1. **The log level follows the CLASSIFICATION, not the exit status.** A zero
///    exit whose stdout carries no `TANDEM_ADAPTERS` marker is a failure we
///    could not explain, and it was reaching `log::debug!` — filtered out of
///    release desktop builds. That is precisely the "the one run whose
///    diagnostics anyone would ever want logged nothing durable" complaint
///    #1372 was filed about, still live on the path most likely to hit it.
/// 2. **The log line carries the REDACTED tails**, the same strings that go on
///    the wire. Logging the raw ones made the durable copy the unredacted one:
///    the toast is ephemeral and the user chooses whether to paste it, while
///    `TargetKind::LogDir` keeps 25 MB that users attach to bug reports.
/// 3. **Diagnostics attach when the PROCESS failed**, never merely because the
///    classification came out `QueryFailed`. Keying on the reason put
///    `exit_code: Some(0)` and an empty stderr on the zero-exit path, which the
///    client rendered as "(PowerShell exit 0: (no output))" — self-contradictory,
///    and strictly worse than the undecorated hint it replaced.
fn finish_subnet_query(
    exit_ok: bool,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
    home: Option<&str>,
    elapsed_secs: f64,
) -> SubnetQueryOutcome {
    let stdout_tail = redact_and_truncate(stdout, home, CAPTURED_STREAM_TAIL_LIMIT);
    let stderr_tail = redact_and_truncate(stderr, home, CAPTURED_STREAM_TAIL_LIMIT);

    let classified = classify_subnet_output(exit_ok, stdout.trim());
    let level = if classified.is_err() {
        log::Level::Warn
    } else {
        log::Level::Debug
    };
    let log_line = format!(
        "[firewall] powershell vEthernet query: exit={}, elapsed={elapsed_secs:.2}s, stdout={stdout_tail:?}, stderr={stderr_tail:?}",
        exit_code.map_or_else(|| "?".to_string(), |c| c.to_string()),
    );

    let result = if exit_ok {
        classified
    } else {
        with_query_diagnostics(classified, exit_code, &stderr_tail)
    };
    SubnetQueryOutcome {
        level,
        log_line,
        result,
    }
}

/// How many bytes of a captured child-process stream survive into a log line
/// and onto the wire.
///
/// One constant for every such stream, so the excerpt a user reports and the
/// excerpt we logged cannot drift apart — and so a single number bounds the
/// exposure. It supersedes the 400 `run_netsh` used to put on `NetshFailure`:
/// the client re-truncates to 200 before rendering, so the extra 200 bytes were
/// never read by anyone and only widened what crossed the wire. That surplus
/// stopped being theoretical with #1372, which is what made those tails render
/// at all — before it, `stderrTail` arrived `undefined` and the client fell
/// back to raw JSON.
///
/// Bytes, not characters: the cap exists to bound what leaves the process, and
/// a byte count is the thing that bounds it. Localized (CJK) output therefore
/// yields fewer characters than an ASCII one, deliberately.
const CAPTURED_STREAM_TAIL_LIMIT: usize = 200;

/// Windows error codes that mean "you are not allowed to start this", but that
/// Rust's `decode_error_kind` does not map to `PermissionDenied`.
///
/// This is the arm's whole reason for existing. The split is justified by "a
/// refused spawn is an execution-policy or application-control problem", and
/// the mechanisms that actually refuse one — AppLocker, WDAC, SRP — report
/// `ERROR_ACCESS_DISABLED_BY_POLICY` (1260), not `ERROR_ACCESS_DENIED` (5).
/// Rust has no `ErrorKind` for 1260, so it arrives as `Uncategorized` and would
/// otherwise fall to `SpawnFailed`, whose hint never mentions policy. 740 is
/// `ERROR_ELEVATION_REQUIRED`, the same class of refusal.
///
/// Checked before `kind()` because the raw code is the more specific signal;
/// it is `None` on platforms that do not produce one, so the check is inert
/// rather than wrong off Windows.
const SPAWN_REFUSED_OS_ERRORS: [i32; 2] = [1260, 740];

/// Map a spawn error to the closed wire enum.
///
/// Pure and total, so the mapping is unit-testable without a process. Note the
/// direction of the fallback: an `ErrorKind` this build does not recognise
/// becomes `SpawnFailed`, the least-blaming arm — `ErrorKind` is
/// `#[non_exhaustive]` and grows between Rust releases, so a match that had to
/// be exhaustive over it would either fail to compile on the next toolchain or
/// force a guess about what a new kind means.
fn adapter_enumeration_reason(err: &std::io::Error) -> AdapterEnumerationReason {
    if err
        .raw_os_error()
        .is_some_and(|code| SPAWN_REFUSED_OS_ERRORS.contains(&code))
    {
        return AdapterEnumerationReason::PermissionDenied;
    }
    match err.kind() {
        std::io::ErrorKind::NotFound => AdapterEnumerationReason::NotFound,
        std::io::ErrorKind::PermissionDenied => AdapterEnumerationReason::PermissionDenied,
        _ => AdapterEnumerationReason::SpawnFailed,
    }
}

/// Attach the run's diagnostics to a `QueryFailed` classification (#1372).
///
/// Split out from `classify_subnet_output`, which must stay a pure function of
/// the output shape — the entire point of #1298's split. Everything except
/// `QueryFailed` passes through untouched.
///
/// **The reason is the second gate, not the first.** `finish_subnet_query` only
/// calls this when the process actually failed, and that ordering is what the
/// design depends on: `classify_subnet_output` returns `QueryFailed` on two
/// paths, and the zero-exit/unparseable-stdout path has no evidence to offer.
/// Keying on the reason alone gave it `exit_code: Some(0)` and an empty stderr,
/// which the client rendered as "(PowerShell exit 0: (no output))" — exactly
/// the "we looked and found nothing wrong" reading this comment used to claim
/// was impossible.
fn with_query_diagnostics(
    classified: Result<String, FirewallError>,
    exit_code: Option<i32>,
    stderr_tail: &str,
) -> Result<String, FirewallError> {
    match classified {
        Err(FirewallError::SubnetDetectionFailed {
            reason: SubnetDetectionReason::QueryFailed,
            ..
        }) => Err(FirewallError::SubnetDetectionFailed {
            reason: SubnetDetectionReason::QueryFailed,
            exit_code,
            stderr_tail: stderr_tail.to_string(),
        }),
        other => other,
    }
}

/// Turn the detection script's output into a CIDR or a classified failure.
///
/// Split out from `detect_vethernet_subnet` so the classification table — the
/// entire point of #1298 — is unit-testable. The PowerShell spawn itself is not,
/// which is why the marker's real-world shape still needs a manual check.
fn classify_subnet_output(exit_ok: bool, stdout: &str) -> Result<String, FirewallError> {
    use SubnetDetectionReason as R;
    // No diagnostics here: this function is a pure function of the output
    // shape, and does not see the exit code or stderr. `with_query_diagnostics`
    // attaches them to the one reason they mean anything for.
    let failed = |reason| {
        Err(FirewallError::SubnetDetectionFailed {
            reason,
            exit_code: None,
            stderr_tail: String::new(),
        })
    };

    // Checked before parsing anything: a failed process's stdout may be garbage,
    // so its shape carries no information about adapters.
    if !exit_ok {
        return failed(R::QueryFailed);
    }

    // `.trim()` on the captured output strips ASCII whitespace but not a UTF-8
    // BOM, which lands at the very start of the captured output — where the
    // marker sits when the stream is clean. If unsolicited output precedes the
    // marker (see the scan loop below), the BOM rides that line instead and the
    // marker is unaffected either way. This only strips at offset zero.
    let stdout = stdout.trim_start_matches('\u{feff}');

    let mut adapter_count: Option<usize> = None;
    let mut saw_candidate_line = false;

    // Scanning every line for the marker, rather than reading it off the first
    // one, is deliberate. Our script emits it first and a flatter formulation
    // would be shorter — but PowerShell can prepend output nobody asked for (a
    // module autoload notice, a progress record landing in the stream), and
    // "the first line is the marker" would then read that instead, fail to
    // parse a count, and report QueryFailed. That collapses NoAdapter into
    // NoIpv4: the one distinction the marker exists to make, lost in exactly
    // the messy environment it was added for. The captured real-hardware
    // fixture shows a clean stream today; this survives the day it isn't.
    //
    // `lines()` strips a trailing `\r`, so CRLF needs no special handling.
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(count) = line.strip_prefix(ADAPTER_COUNT_MARKER) {
            adapter_count = count.trim().parse::<usize>().ok();
            continue;
        }
        if looks_like_ipv4_cidr(line) {
            saw_candidate_line = true;
            if let Some(cidr) = parse_cidr_from_line(line) {
                return Ok(cidr);
            }
        }
    }

    // No marker means the script didn't run the way we asked. Fall to the
    // least-blaming reason rather than inferring a specific one from output we
    // have just established we don't understand.
    let Some(adapter_count) = adapter_count else {
        return failed(R::QueryFailed);
    };

    if adapter_count == 0 {
        return failed(R::NoAdapter);
    }
    // An address-shaped line was present and nothing survived
    // `parse_cidr_from_line`. Because `looks_like_ipv4_cidr` has already
    // validated the four octets and the prefix, the only remaining way to fail
    // is the `prefix < 20` rejection — so this reports what actually happened
    // rather than betting on it.
    if saw_candidate_line {
        return failed(R::PrefixTooBroad);
    }
    failed(R::NoIpv4)
}

/// Does this line carry the `<dotted-quad>/<prefix>` shape our script emits?
///
/// This gates `saw_candidate_line`, and it has to be a real shape test rather
/// than a `contains('/')`: any stray PowerShell line carrying a slash — a URL
/// in a module-autoload notice, a filesystem path in a warning — would
/// otherwise count as a rejected address, and an adapter with no IPv4 yet would
/// be reported as `PrefixTooBroad`. That is a confident claim about a subnet
/// that was never found, and it is the wrong-blame class this classification
/// exists to remove.
///
/// Validating the octets and the prefix here is also what lets the
/// `PrefixTooBroad` branch below mean exactly one thing: a shaped line can now
/// only fail `parse_cidr_from_line` via the `prefix < 20` rejection.
///
/// An IPv6 line (`fe80::1/64`) is deliberately not a candidate. The script's
/// `-AddressFamily IPv4` filter means one should never arrive, but if that
/// filter ever changes, the honest answer for an adapter holding only a v6
/// address is `NoIpv4` — not a /20 complaint about an address we never read.
fn looks_like_ipv4_cidr(line: &str) -> bool {
    let Some((ip, prefix)) = line.split_once('/') else {
        return false;
    };
    if prefix.trim().parse::<u8>().is_err() {
        return false;
    }
    let octets: Vec<&str> = ip.trim().split('.').collect();
    octets.len() == 4 && octets.iter().all(|o| o.parse::<u8>().is_ok())
}

/// Parse an `IPAddress/PrefixLength` string into a proper CIDR network address.
///
/// Rejects prefix length < 20: a wider prefix (e.g. `/12`) would let the
/// firewall rule span far more of the network than Cowork's VM subnet
/// needs, so it's refused rather than silently widening the allowlisted
/// range.
fn parse_cidr_from_line(line: &str) -> Option<String> {
    let (ip_str, prefix_str) = line.split_once('/')?;
    let prefix: u8 = prefix_str.trim().parse().ok()?;

    // Reject prefixes wider than /20 so the firewall rule can never span more
    // than Cowork's VM subnet actually needs.
    if prefix < 20 {
        log::warn!(
            "[firewall] detected vEthernet subnet has prefix /{prefix} — too broad (< /20); rejected"
        );
        return None;
    }

    // Convert host address to network address (mask off host bits).
    let ip_trimmed = ip_str.trim();
    let network_addr = host_to_network(ip_trimmed, prefix)?;
    Some(format!("{network_addr}/{prefix}"))
}

/// Mask off host bits to get the network address.
fn host_to_network(ip: &str, prefix: u8) -> Option<String> {
    let parts: Vec<u8> = ip
        .split('.')
        .map(|p| p.parse::<u8>().ok())
        .collect::<Option<Vec<_>>>()?;
    if parts.len() != 4 {
        return None;
    }
    let ip_u32 = ((parts[0] as u32) << 24)
        | ((parts[1] as u32) << 16)
        | ((parts[2] as u32) << 8)
        | (parts[3] as u32);
    let mask: u32 = if prefix == 0 {
        0
    } else {
        !0u32 << (32 - prefix)
    };
    let network_u32 = ip_u32 & mask;
    Some(format!(
        "{}.{}.{}.{}",
        (network_u32 >> 24) & 0xff,
        (network_u32 >> 16) & 0xff,
        (network_u32 >> 8) & 0xff,
        network_u32 & 0xff,
    ))
}

// ---------------------------------------------------------------------------
// Firewall rule management
// ---------------------------------------------------------------------------

/// Add an inbound allow rule scoped to `cidr` for Tandem's MCP port (3479).
///
/// Rule: `dir=in, action=allow, protocol=TCP, localport=3479, remoteip=<cidr>`.
///
/// Requires elevated privileges. Returns `FirewallError::AdminDeclined` if
/// `netsh` exits with a code indicating UAC denial (exit code 1 with specific
/// error text from Windows).
pub fn add_cowork_allow_rule(cidr: &str) -> Result<(), FirewallError> {
    log::info!("[firewall] adding Cowork allow rule for CIDR {cidr}");
    run_netsh(&[
        "advfirewall",
        "firewall",
        "add",
        "rule",
        &format!("name={RULE_NAME_ALLOW}"),
        "dir=in",
        "action=allow",
        "protocol=TCP",
        "localport=3479",
        &format!("remoteip={cidr}"),
    ])
}

/// Add an inbound deny rule — historically written when firewall elevation was
/// refused so that port 3479 was definitively blocked from the VM.
///
/// Retired from the enable flow: it needs the same elevation the allow rule was
/// just denied, so it always failed too, and the server binds 127.0.0.1 anyway —
/// port 3479 is never network-exposed, so there is nothing to "fail closed" to.
/// Kept (the disable path's `remove_cowork_rules` still cleans up any deny rule a
/// past elevated run may have written) and pending the Cowork-transport matrix
/// outcome; see the cowork-detection plan / forthcoming ADR-045.
///
/// Rule: `dir=in, action=block, protocol=TCP, localport=3479, remoteip=<cidr>`.
#[allow(dead_code)]
pub fn add_cowork_deny_rule(cidr: &str) -> Result<(), FirewallError> {
    log::info!("[firewall] adding Cowork deny rule for CIDR {cidr}");
    run_netsh(&[
        "advfirewall",
        "firewall",
        "add",
        "rule",
        &format!("name={RULE_NAME_DENY}"),
        "dir=in",
        "action=block",
        "protocol=TCP",
        "localport=3479",
        &format!("remoteip={cidr}"),
    ])
}

/// Is this the benign "there was nothing to delete" outcome?
///
/// "No rules match the specified criteria." is written to stdout (not stderr) by
/// netsh on Windows. Only exit code 1 WITH that confirmation counts — every other
/// exit-1 failure propagates.
///
/// Extracted from the two `or_else` arms below so the contract is unit-testable,
/// and because #1371 gave `run_netsh` a timeout arm that reports `exit_code: -1`:
/// a predicate that matched on the message alone, or on any failure, would
/// silently swallow a wedged netsh as "nothing to remove".
fn is_no_rules_match(err: &FirewallError) -> bool {
    matches!(
        err,
        FirewallError::NetshFailure { exit_code: 1, stdout_tail, .. }
            if stdout_tail.contains("No rules match")
    )
}

/// Remove all firewall rules whose name starts with `"Tandem Cowork"`.
/// Covers both the allow rule and the deny-on-decline variant.
pub fn remove_cowork_rules() -> Result<(), FirewallError> {
    log::info!("[firewall] removing all Tandem Cowork firewall rules");
    run_netsh(&[
        "advfirewall",
        "firewall",
        "delete",
        "rule",
        &format!("name={RULE_NAME_PREFIX}"),
    ])
    .or_else(|e| {
        if is_no_rules_match(&e) {
            log::debug!("[firewall] no Tandem Cowork rules to remove (allow rule)");
            Ok(())
        } else {
            Err(e)
        }
    })?;

    // Also try to remove the deny variant (different name string).
    run_netsh(&[
        "advfirewall",
        "firewall",
        "delete",
        "rule",
        &format!("name={RULE_NAME_DENY}"),
    ])
    .or_else(|e| {
        if is_no_rules_match(&e) {
            log::debug!("[firewall] no Tandem Cowork rules to remove (deny rule)");
            Ok(())
        } else {
            Err(e)
        }
    })
}

/// Scan for orphan "Tandem Cowork*" firewall rules and return their names.
///
/// Used by install-time orphan reconciliation, which — per the ordering
/// contract on `reconcile_orphan_firewall_rules` in `cowork_installer.rs`
/// (#1163) — MUST run *before* `add_cowork_allow_rule`: this scan matches by
/// the name prefix `"Tandem Cowork"`, identical to the allow rule's own name,
/// so scanning after the add would see the just-added rule as an orphan and
/// delete it, leaving the enable with no allow rule.
///
/// Returns `Err` on spawn failure or unexpected netsh errors so that
/// `reconcile_orphan_firewall_rules` can distinguish "no orphans" from "scan failed".
pub fn scan_orphan_rules() -> Result<Vec<String>, FirewallError> {
    let mut command = Command::new("netsh");
    command.args([
        "advfirewall",
        "firewall",
        "show",
        "rule",
        &format!("name={RULE_NAME_PREFIX}"),
    ]);

    let start = Instant::now();
    let outcome = output_with_timeout(command, NETSH_TIMEOUT);
    let elapsed = start.elapsed();

    let output = match outcome {
        Ok(BoundedOutcome::Completed(o)) => o,
        Ok(BoundedOutcome::TimedOut { pid, .. }) => {
            log::warn!(
                "[firewall] scan_orphan_rules: netsh exceeded {}s and was killed (pid {pid})",
                NETSH_TIMEOUT.as_secs()
            );
            return Err(netsh_timeout_error());
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::warn!("[firewall] scan_orphan_rules: netsh.exe not found");
            return Err(FirewallError::NetshNotFound);
        }
        Err(e) => {
            log::warn!("[firewall] scan_orphan_rules spawn failed: {e}");
            return Err(FirewallError::NetshFailure {
                exit_code: -1,
                stderr_tail: e.to_string(),
                stdout_tail: String::new(),
            });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let exit_code = output.status.code().unwrap_or(-1);
    let home = home_dir_string();

    log::debug!(
        "[firewall] scan_orphan_rules: exit={exit_code}, elapsed={:.2}s",
        elapsed.as_secs_f64()
    );

    // netsh `show rule` exits 1 with "No rules match" when there are no matching
    // rules — treat that as an empty (not an error) result.
    if !output.status.success() {
        let combined = format!("{stdout}{stderr}");
        if combined.contains("No rules match") {
            return Ok(vec![]);
        }
        return Err(FirewallError::NetshFailure {
            exit_code,
            stderr_tail: redact_and_truncate(&stderr, home.as_deref(), CAPTURED_STREAM_TAIL_LIMIT),
            stdout_tail: redact_and_truncate(&stdout, home.as_deref(), CAPTURED_STREAM_TAIL_LIMIT),
        });
    }

    // Parse "Rule Name: ..." lines from netsh output.
    let names = stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            // netsh output uses "Rule Name:" on English locales.
            let stripped = line
                .strip_prefix("Rule Name:")
                .or_else(|| line.strip_prefix("Rule name:"));
            stripped.map(|s| s.trim().to_string())
        })
        .filter(|name| name.starts_with(RULE_NAME_PREFIX))
        .collect();

    Ok(names)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Execute `netsh` with the given argv-form arguments.
///
/// Logs the invocation (argv, exit code, stdout/stderr tail, elapsed time).
/// Never constructs a command string — each argument is passed separately.
fn run_netsh(args: &[&str]) -> Result<(), FirewallError> {
    let mut command = Command::new("netsh");
    command.args(args);

    let start = Instant::now();
    let outcome = output_with_timeout(command, NETSH_TIMEOUT);
    let elapsed = start.elapsed();

    let output = match outcome {
        Ok(BoundedOutcome::Completed(o)) => o,
        Ok(BoundedOutcome::TimedOut { pid, .. }) => {
            log::error!(
                "[firewall] netsh {args:?} exceeded {}s and was killed (pid {pid})",
                NETSH_TIMEOUT.as_secs()
            );
            // Returning HERE is what keeps the two exit-code heuristics below out
            // of the picture: both live inside the `!status.success()` block,
            // which a timeout never reaches. So a wedged netsh can never be
            // mistaken for a UAC decline (`exit_code == 1` + empty stdout) nor
            // swallowed by `is_no_rules_match` (`exit_code == 1`).
            return Err(netsh_timeout_error());
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::error!("[firewall] netsh.exe not found after {:.2}s", elapsed.as_secs_f64());
            return Err(FirewallError::NetshNotFound);
        }
        Err(e) => {
            log::error!("[firewall] netsh spawn error after {:.2}s: {e}", elapsed.as_secs_f64());
            return Err(FirewallError::NetshFailure {
                exit_code: -1,
                stderr_tail: e.to_string(),
                stdout_tail: String::new(),
            });
        }
    };

    let exit_code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    // One lookup for both the log line and the wire, so the two cannot disagree
    // about what was redacted (#1372).
    let home = home_dir_string();

    log::debug!(
        "[firewall] netsh {:?}: exit={exit_code}, elapsed={:.2}s, stdout={:?}, stderr={:?}",
        args,
        elapsed.as_secs_f64(),
        redact_and_truncate(&stdout, home.as_deref(), CAPTURED_STREAM_TAIL_LIMIT),
        redact_and_truncate(&stderr, home.as_deref(), CAPTURED_STREAM_TAIL_LIMIT),
    );

    if !output.status.success() {
        // Detect UAC-declined pattern for `add rule` commands.
        //
        // Strategy: locale-sensitive string match is the primary signal (works on
        // EN-locale Windows). For non-English locales we fall back to exit code 1
        // on an `add` command, BUT only when stdout is empty — a successful partial
        // execution (e.g. "Ok.", "The command was executed") will always produce
        // stdout, so an empty stdout on exit 1 indicates the process never ran the
        // rule-write path (which is what UAC denial looks like).
        //
        // Exit code 1 alone is too broad: malformed args, duplicate rule names,
        // invalid CIDR, and quota errors also return exit 1 — those all produce
        // some stdout. UAC denial exits 1 with no stdout.
        let is_add_command = args.contains(&"add");
        let combined = format!("{stdout}{stderr}");
        let locale_strings_match = combined.contains("requires elevation")
            || combined.contains("access is denied")
            || combined.contains("Access is denied");
        // Locale-independent fallback: exit 1 on add with no stdout output.
        let exit1_no_stdout = is_add_command && exit_code == 1 && stdout.trim().is_empty();

        if is_add_command && (locale_strings_match || exit1_no_stdout) {
            log::warn!(
                "[firewall] UAC elevation declined (exit={exit_code}, locale_match={locale_strings_match}, no_stdout={exit1_no_stdout})"
            );
            return Err(FirewallError::AdminDeclined);
        }

        return Err(FirewallError::NetshFailure {
            exit_code,
            stderr_tail: redact_and_truncate(&stderr, home.as_deref(), CAPTURED_STREAM_TAIL_LIMIT),
            stdout_tail: redact_and_truncate(&stdout, home.as_deref(), CAPTURED_STREAM_TAIL_LIMIT),
        });
    }

    Ok(())
}

/// The error a killed `netsh` reports (#1371).
///
/// `exit_code: -1` is this file's established "the process never completed"
/// marker — the spawn-failure arms in `run_netsh` and `scan_orphan_rules` already
/// use it — so this needs no new wire variant and no new client hint. It also
/// keeps the timeout clear of both exit-code-1 heuristics.
fn netsh_timeout_error() -> FirewallError {
    FirewallError::NetshFailure {
        exit_code: -1,
        stderr_tail: format!("netsh timed out after {}s", NETSH_TIMEOUT.as_secs()),
        stdout_tail: String::new(),
    }
}

/// Return the first `max_bytes` bytes of a string, cut at a UTF-8 char boundary.
///
/// The HEAD, not the tail, and for these streams that is the difference between
/// evidence and boilerplate. A PowerShell `ErrorRecord` leads with the message
/// and ends with the `+ CategoryInfo :` / `+ FullyQualifiedErrorId :` trailer;
/// `netsh` likewise states the failure first. Keeping the last 200 bytes
/// reliably kept the part nobody can act on — for the flagship case #1372
/// exists to serve, the surviving excerpt was routinely pure trailer.
fn truncate_head(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut pos = max_bytes;
    while pos > 0 && !s.is_char_boundary(pos) {
        pos -= 1;
    }
    &s[..pos]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_host_to_network() {
        assert_eq!(
            host_to_network("172.20.0.1", 20),
            Some("172.20.0.0".to_string())
        );
        assert_eq!(
            host_to_network("192.168.1.50", 24),
            Some("192.168.1.0".to_string())
        );
        assert_eq!(
            host_to_network("10.0.0.1", 8),
            Some("10.0.0.0".to_string())
        );
    }

    #[test]
    fn test_parse_cidr_rejects_too_broad() {
        // prefix /12 is too broad → rejected.
        assert!(parse_cidr_from_line("172.16.0.1/12").is_none());
        // prefix /19 → below /20 → rejected.
        assert!(parse_cidr_from_line("172.20.0.1/19").is_none());
    }

    #[test]
    fn test_parse_cidr_accepts_narrow() {
        let result = parse_cidr_from_line("172.20.0.1/20");
        assert_eq!(result, Some("172.20.0.0/20".to_string()));
    }

    #[test]
    fn test_truncate_head() {
        assert_eq!(truncate_head("hello world", 5), "hello");
        assert_eq!(truncate_head("short", 100), "short");
    }

    // -----------------------------------------------------------------------
    // #1298: the classification table. Each of these used to be the same
    // opaque `SubnetDetectionFailed`, and each wants different user advice.
    // -----------------------------------------------------------------------

    /// Every `SubnetDetectionReason`, hand-maintained because Rust has no
    /// built-in enum iteration. A variant added without being listed here is
    /// caught by the length assertion in the wire-shape test, which is the one
    /// place that would otherwise ship an unpinned spelling.
    const ALL_SUBNET_REASONS: [SubnetDetectionReason; 5] = [
        SubnetDetectionReason::NoAdapter,
        SubnetDetectionReason::NoIpv4,
        SubnetDetectionReason::PrefixTooBroad,
        SubnetDetectionReason::QueryFailed,
        SubnetDetectionReason::Timeout,
    ];

    fn reason_of(exit_ok: bool, stdout: &str) -> SubnetDetectionReason {
        match classify_subnet_output(exit_ok, stdout) {
            // `..` because the variant grew diagnostics in #1372.
            // `classify_subnet_output` never fills them — that is
            // `with_query_diagnostics`' job, and
            // `classification_carries_no_diagnostics_on_its_own` asserts it.
            Err(FirewallError::SubnetDetectionFailed { reason, .. }) => reason,
            other => panic!("expected SubnetDetectionFailed, got {other:?}"),
        }
    }

    #[test]
    fn classify_accepts_a_narrow_enough_subnet() {
        assert_eq!(
            classify_subnet_output(true, "TANDEM_ADAPTERS 1\r\n172.20.0.1/20\r\n").unwrap(),
            "172.20.0.0/20"
        );
    }

    #[test]
    fn classify_no_adapter_when_the_count_is_zero() {
        // The VM isn't running, or WSL is in mirrored mode, or the adapter
        // description is localized. Indistinguishable here — hence one reason.
        assert_eq!(reason_of(true, "TANDEM_ADAPTERS 0"), SubnetDetectionReason::NoAdapter);
    }

    #[test]
    fn classify_no_ipv4_when_adapters_exist_but_print_no_addresses() {
        assert_eq!(reason_of(true, "TANDEM_ADAPTERS 2"), SubnetDetectionReason::NoIpv4);
    }

    #[test]
    fn classify_prefix_too_broad_when_every_candidate_is_rejected() {
        assert_eq!(
            reason_of(true, "TANDEM_ADAPTERS 1\n172.16.0.1/12"),
            SubnetDetectionReason::PrefixTooBroad
        );
    }

    #[test]
    fn classify_prefers_the_first_acceptable_line_over_a_rejected_one() {
        // A too-broad adapter must not mask a valid one listed after it.
        assert_eq!(
            classify_subnet_output(true, "TANDEM_ADAPTERS 2\n10.0.0.1/8\n172.20.0.1/20").unwrap(),
            "172.20.0.0/20"
        );
    }

    #[test]
    fn classify_query_failed_on_nonzero_exit_even_with_plausible_output() {
        // Output shape carries no information once the process has failed.
        assert_eq!(
            reason_of(false, "TANDEM_ADAPTERS 1\n172.20.0.1/20"),
            SubnetDetectionReason::QueryFailed
        );
    }

    #[test]
    fn classify_query_failed_when_the_marker_is_missing_or_unparsable() {
        // Falls to the least-blaming reason rather than inferring NoAdapter
        // from output we have just established we don't understand.
        assert_eq!(reason_of(true, ""), SubnetDetectionReason::QueryFailed);
        assert_eq!(reason_of(true, "some unexpected text"), SubnetDetectionReason::QueryFailed);
        assert_eq!(reason_of(true, "TANDEM_ADAPTERS many"), SubnetDetectionReason::QueryFailed);
    }

    #[test]
    fn classify_handles_real_captured_powershell_output() {
        // Captured verbatim from `powershell -NoProfile -NonInteractive
        // -Command <the detection script>` on Windows 11 (2026-08-09), bytes
        // checked with `od -c`: CRLF line endings, and NO byte-order mark —
        // so the BOM handling below is belt-and-braces, not something this
        // machine actually needs. Kept as a fixture because every other test
        // here asserts against output *I* wrote, which cannot reveal a wrong
        // assumption about what PowerShell really emits.
        let real = "TANDEM_ADAPTERS 2\r\n172.18.192.1/20\r\n172.28.80.1/20\r\n";
        assert_eq!(classify_subnet_output(true, real).unwrap(), "172.18.192.0/20");
    }

    #[test]
    fn classify_finds_the_marker_behind_unsolicited_leading_output() {
        // The marker is scanned for, not read off line one. PowerShell can
        // prepend output nobody asked for, and treating the first line as the
        // marker would parse no count and report QueryFailed — collapsing
        // NoAdapter into NoIpv4, the exact distinction the marker adds.
        let noisy = "Loading personal and system profiles took 812ms.\r\nTANDEM_ADAPTERS 0\r\n";
        assert_eq!(
            reason_of(true, noisy),
            SubnetDetectionReason::NoAdapter,
            "a leading noise line must not hide the adapter count behind it"
        );

        // Positive control on the same sample: strip only the marker and the
        // identical noise falls to QueryFailed. Without it, the assertion above
        // would still pass if the marker were ignored entirely and NoAdapter
        // were simply what this input defaults to.
        let noise_only = "Loading personal and system profiles took 812ms.\r\n";
        assert_eq!(reason_of(true, noise_only), SubnetDetectionReason::QueryFailed);
    }

    #[test]
    fn classify_tolerates_a_utf8_bom_at_the_start_of_output() {
        // `.trim()` upstream strips ASCII whitespace, not U+FEFF, and the strip
        // only applies at offset zero. Named for what is covered: a BOM ahead
        // of the marker on a clean stream, not a BOM anywhere else.
        assert_eq!(
            reason_of(true, "\u{feff}TANDEM_ADAPTERS 0"),
            SubnetDetectionReason::NoAdapter
        );
    }

    #[test]
    fn classify_does_not_mistake_stray_output_for_a_rejected_address() {
        // The defect this guards: `saw_candidate_line` used to be set by ANY
        // non-marker line, so one unsolicited PowerShell line on a machine whose
        // adapter has no IPv4 yet produced PrefixTooBroad — a confident claim
        // that a subnet was found and refused, about a subnet never found. Same
        // wrong-blame class #1298 exists to remove.
        let noisy = "Loading personal and system profiles took 812ms.\r\nTANDEM_ADAPTERS 2\r\n";
        assert_eq!(
            reason_of(true, noisy),
            SubnetDetectionReason::NoIpv4,
            "a noise line must not be counted as a rejected address"
        );

        // A slash alone must not qualify either — this is why the guard checks
        // the dotted-quad shape rather than `contains('/')`.
        let slashy = "WARNING: see https://aka.ms/netadapter for details\r\nTANDEM_ADAPTERS 2\r\n";
        assert_eq!(reason_of(true, slashy), SubnetDetectionReason::NoIpv4);

        // Positive control on the same sample: swap the noise for a genuinely
        // address-shaped line that the /20 floor refuses, and the same input
        // shape reports PrefixTooBroad. Without this the assertions above would
        // pass with `saw_candidate_line` deleted outright.
        let too_broad = "10.0.0.1/8\r\nTANDEM_ADAPTERS 2\r\n";
        assert_eq!(
            reason_of(true, too_broad),
            SubnetDetectionReason::PrefixTooBroad
        );
    }

    #[test]
    fn classify_reports_no_ipv4_for_an_adapter_holding_only_ipv6() {
        // Unreachable through our own script, which filters `-AddressFamily
        // IPv4`. Pinned because it is the case a future script change would
        // most plausibly let through, and the honest answer is "no v4 address"
        // rather than a /20 complaint about an address never read.
        let v6 = "fe80::215:5dff:fe01:2/64\r\nTANDEM_ADAPTERS 1\r\n";
        assert_eq!(reason_of(true, v6), SubnetDetectionReason::NoIpv4);
    }

    #[test]
    fn subnet_failure_messages_no_longer_blame_the_install() {
        // The #1298 defect in one assertion: the old copy asked "is Cowork set
        // up on this machine?" inside a dialog titled "Cowork detected".
        let mut messages = Vec::new();
        for reason in ALL_SUBNET_REASONS {
            let msg = FirewallError::SubnetDetectionFailed {
                reason,
                exit_code: None,
                stderr_tail: String::new(),
            }
            .to_string();
            assert!(!msg.is_empty(), "{reason:?} has no message");
            assert!(
                !msg.contains("is Cowork set up on this machine"),
                "{reason:?} still blames the install: {msg}"
            );
            messages.push(msg);
        }

        // Distinctness is the load-bearing half. Without it this test passes
        // when all four arms are collapsed to one string — which would be the
        // original defect exactly, wearing different words.
        let unique: std::collections::HashSet<&String> = messages.iter().collect();
        assert_eq!(
            unique.len(),
            messages.len(),
            "two reasons share a message, so the reason carries no information: {messages:?}"
        );
    }

    // -----------------------------------------------------------------------
    // #1371: a killed netsh must not be mistaken for a benign outcome.
    // -----------------------------------------------------------------------

    #[test]
    fn no_rules_match_is_only_exit_1_with_the_confirming_stdout() {
        assert!(is_no_rules_match(&FirewallError::NetshFailure {
            exit_code: 1,
            stderr_tail: String::new(),
            stdout_tail: "No rules match the specified criteria.".to_string(),
        }));
        // Exit 1 alone is not enough — malformed args and quota errors exit 1 too.
        assert!(!is_no_rules_match(&FirewallError::NetshFailure {
            exit_code: 1,
            stderr_tail: String::new(),
            stdout_tail: "The parameter is incorrect.".to_string(),
        }));
        assert!(!is_no_rules_match(&FirewallError::NetshNotFound));
    }

    #[test]
    fn a_killed_netsh_is_not_swallowed_as_nothing_to_remove() {
        // The regression this guards: laundering the timeout as `exit_code: 1`,
        // or widening `is_no_rules_match` to any failure, would make a wedged
        // netsh look like "there were no rules to delete" — so `remove_cowork_
        // rules` would report success having removed nothing.
        let timeout = netsh_timeout_error();
        assert!(
            matches!(timeout, FirewallError::NetshFailure { exit_code: -1, .. }),
            "the timeout must use this file's -1 'never completed' marker: {timeout:?}"
        );
        assert!(!is_no_rules_match(&timeout));
        // And it must not read as a UAC decline either: that heuristic needs
        // exit_code == 1 with empty stdout, and -1 cannot match it.
        let FirewallError::NetshFailure { exit_code, ref stderr_tail, .. } = timeout else {
            unreachable!()
        };
        assert_ne!(exit_code, 1);
        assert!(
            stderr_tail.contains("timed out"),
            "the tail is rendered to the user; it must say what happened: {stderr_tail:?}"
        );
    }

    #[test]
    fn subnet_reason_rides_along_as_a_sibling_field_on_the_wire() {
        // The client discriminates on `kind` and reads `reason` off the same
        // object; a nested shape would break `firewallErrorHint` silently.
        //
        // All four spellings are pinned, not one. `SUBNET_REASON_HINT` on the
        // client is keyed by these exact strings, and a miss there falls through
        // to the generic hint — silently, in both languages. `noIpv4` is the one
        // that would plausibly drift (`noIPv4`).
        let expected = [
            (
                SubnetDetectionReason::NoAdapter,
                r#"{"kind":"subnetDetectionFailed","reason":"noAdapter"}"#,
            ),
            (
                SubnetDetectionReason::NoIpv4,
                r#"{"kind":"subnetDetectionFailed","reason":"noIpv4"}"#,
            ),
            (
                SubnetDetectionReason::PrefixTooBroad,
                r#"{"kind":"subnetDetectionFailed","reason":"prefixTooBroad"}"#,
            ),
            (
                SubnetDetectionReason::QueryFailed,
                r#"{"kind":"subnetDetectionFailed","reason":"queryFailed"}"#,
            ),
            // #1371. `timeout` and not `timedOut`: the client's
            // `SUBNET_REASON_HINT` is keyed by this exact string and a miss there
            // falls through to the generic hint, silently, in both languages.
            (
                SubnetDetectionReason::Timeout,
                r#"{"kind":"subnetDetectionFailed","reason":"timeout"}"#,
            ),
        ];
        assert_eq!(
            expected.len(),
            ALL_SUBNET_REASONS.len(),
            "a reason was added without pinning its wire spelling"
        );
        for (reason, want) in expected {
            let json = serde_json::to_string(&FirewallError::SubnetDetectionFailed {
                reason,
                exit_code: None,
                stderr_tail: String::new(),
            })
            .unwrap();
            assert_eq!(json, want);
        }
    }

    // -----------------------------------------------------------------------
    // #1372: AdapterEnumerationFailed fused two causes; QueryFailed dropped
    // the diagnostics it had already captured.
    // -----------------------------------------------------------------------

    /// Every `AdapterEnumerationReason`, hand-maintained for the same reason
    /// `ALL_SUBNET_REASONS` is: Rust has no built-in variant enumeration, and a
    /// list that silently stops covering a new arm is worse than no list.
    const ALL_ADAPTER_REASONS: [AdapterEnumerationReason; 3] = [
        AdapterEnumerationReason::NotFound,
        AdapterEnumerationReason::PermissionDenied,
        AdapterEnumerationReason::SpawnFailed,
    ];

    #[test]
    fn spawn_error_kinds_map_to_their_own_reasons() {
        use std::io::Error;
        use std::io::ErrorKind as K;
        assert_eq!(
            adapter_enumeration_reason(&Error::from(K::NotFound)),
            AdapterEnumerationReason::NotFound
        );
        assert_eq!(
            adapter_enumeration_reason(&Error::from(K::PermissionDenied)),
            AdapterEnumerationReason::PermissionDenied
        );
        // Everything else falls to the least-blaming arm rather than being
        // guessed at. `ErrorKind` is `#[non_exhaustive]`, so this arm is what
        // makes the mapping survive a toolchain bump.
        for other in [K::TimedOut, K::Interrupted, K::OutOfMemory, K::Other] {
            assert_eq!(
                adapter_enumeration_reason(&Error::from(other)),
                AdapterEnumerationReason::SpawnFailed,
                "{other:?} should fall to SpawnFailed"
            );
        }
    }

    #[test]
    fn a_policy_refused_spawn_is_permission_denied_not_a_generic_failure() {
        // The whole justification for splitting `permissionDenied` out is that a
        // REFUSED spawn is an execution-policy or application-control problem.
        // The mechanisms that actually refuse one — AppLocker, WDAC, SRP —
        // report ERROR_ACCESS_DISABLED_BY_POLICY (1260), which Rust has no
        // `ErrorKind` for. Matching on `kind()` alone therefore never reached
        // the arm it exists for: 1260 arrives as `Uncategorized` and fell to
        // `SpawnFailed`, whose hint never mentions policy.
        for code in [1260, 740] {
            assert_eq!(
                adapter_enumeration_reason(&std::io::Error::from_raw_os_error(code)),
                AdapterEnumerationReason::PermissionDenied,
                "raw OS error {code} should read as a refusal"
            );
        }
        // And an unrelated raw code still goes through `kind()`, so the raw
        // check is a narrowing rather than a second, looser classifier.
        // `i32::MAX` rather than a small code on purpose: a low number is a
        // real errno on the Linux host this module is cross-checked on (1 is
        // EPERM there and ERROR_INVALID_FUNCTION on Windows), so it would
        // classify differently depending on where the test ran.
        assert_eq!(
            adapter_enumeration_reason(&std::io::Error::from_raw_os_error(i32::MAX)),
            AdapterEnumerationReason::SpawnFailed
        );
    }

    // -----------------------------------------------------------------------
    // #1372 round 2: the wiring between the spawn and the wire. Everything
    // below used to live inside `detect_vethernet_subnet`, which spawns a
    // process and therefore has no test at all — so the redaction, the tail
    // limit, the choice of stream and the log level were each a one-token
    // deletion away from silently regressing.
    // -----------------------------------------------------------------------

    const HOME: &str = r"C:\Users\bryanmartin";

    #[test]
    fn redaction_runs_before_truncation_not_after() {
        // The ordering IS the control. Truncating first cuts a fixed number of
        // bytes off one end, and either end can slice through the prefix
        // `redact_home` matches on; after that `contains(home)` is false, the
        // redaction no-ops, and the username survives in full. Redaction would
        // then be active only where truncation was not — i.e. never in the long
        // outputs that most need it.
        //
        // This input is sized so the cut lands INSIDE the username: truncate
        // first and the window keeps `C:\Users\bryanm`, after which
        // `contains(home)` is false and the redaction no-ops on a fragment that
        // still names the user. Asserting only on the full username would miss
        // that — the fragment is the leak.
        let filler = "x".repeat(CAPTURED_STREAM_TAIL_LIMIT - HOME.len() + 5);
        let raw = format!("{filler}{HOME}\\Documents\\profile.ps1 is not signed");

        let out = redact_and_truncate(&raw, Some(HOME), CAPTURED_STREAM_TAIL_LIMIT);
        assert!(
            !out.contains("Users"),
            "a fragment of the home path survived: {out:?}"
        );
        assert!(!out.contains("bryanm"), "username fragment survived: {out:?}");

        // The literal 200 rather than the constant, deliberately: an assertion
        // written in terms of the cap widens when the cap does, so widening the
        // cap to 100 KB would have stayed green.
        assert!(out.len() <= 200, "excerpt exceeded its cap: {} bytes", out.len());

        // The short case, where truncation never engages, must still redact —
        // otherwise this test would pass on an implementation that only ever
        // truncated.
        let short = redact_and_truncate(
            &format!("{HOME}\\Documents\\a.ps1"),
            Some(HOME),
            CAPTURED_STREAM_TAIL_LIMIT,
        );
        assert_eq!(short, r"~\Documents\a.ps1");
    }

    #[test]
    fn the_excerpt_keeps_the_head_of_the_error_not_its_trailer() {
        // A PowerShell ErrorRecord leads with the message and ends with the
        // `+ CategoryInfo :` trailer. Keeping the LAST 200 bytes reliably kept
        // the half nobody can act on — for the flagship case #1372 exists to
        // serve, the surviving excerpt was routinely pure boilerplate.
        let raw = format!(
            "Get-NetIPAddress : Access is denied.{}\n    + CategoryInfo : PermissionDenied",
            " ".repeat(CAPTURED_STREAM_TAIL_LIMIT)
        );
        let out = redact_and_truncate(&raw, None, CAPTURED_STREAM_TAIL_LIMIT);
        assert!(out.starts_with("Get-NetIPAddress : Access is denied."));
        assert!(!out.contains("CategoryInfo"));
    }

    #[test]
    fn the_logged_excerpt_is_the_redacted_one() {
        // The wire copy is ephemeral — a toast the user chooses whether to
        // paste. The log copy is durable: `TargetKind::LogDir` keeps 25 MB that
        // users attach to bug reports, and raising this branch from DEBUG to
        // WARN is what makes it persist in release builds at all. Logging the
        // raw tails would have made the durable copy the unredacted one.
        let outcome = finish_subnet_query(
            false,
            Some(1),
            "",
            &format!(r"{HOME}\Documents\profile.ps1 is not signed"),
            Some(HOME),
            0.5,
        );
        assert!(
            !outcome.log_line.contains("bryanmartin"),
            "log line leaked the username: {}",
            outcome.log_line
        );
        assert!(outcome.log_line.contains("~"));
    }

    #[test]
    fn an_unexplained_zero_exit_logs_at_warn_and_carries_no_exit_code() {
        // `classify_subnet_output` returns `QueryFailed` on TWO paths: a
        // non-zero exit, and a zero exit whose stdout has no parseable marker.
        // Keying the diagnostics on the reason gave the second path
        // `exit_code: Some(0)` and an empty stderr, which the client rendered as
        // "(PowerShell exit 0: (no output))" — self-contradictory, and worse
        // than the undecorated hint. Keying on whether the PROCESS failed is the
        // property actually wanted.
        let outcome = finish_subnet_query(true, Some(0), "unparseable", "", None, 0.1);
        match outcome.result {
            Err(FirewallError::SubnetDetectionFailed {
                reason: SubnetDetectionReason::QueryFailed,
                exit_code,
                ref stderr_tail,
            }) => {
                assert_eq!(exit_code, None, "a zero exit is not evidence of anything");
                assert!(stderr_tail.is_empty());
            }
            other => panic!("expected an undecorated QueryFailed, got {other:?}"),
        }
        // And it must still be durable: this is the run whose diagnostics
        // anyone would want, and it was reaching `log::debug!` — filtered out
        // of release desktop builds, which is the complaint #1372 was filed
        // about, still live on the path most likely to hit it.
        assert_eq!(outcome.level, log::Level::Warn);
    }

    #[test]
    fn a_real_process_failure_still_carries_its_evidence() {
        // The positive control for the test above: narrowing the gate must not
        // have turned the diagnostics off everywhere.
        let outcome = finish_subnet_query(false, Some(1), "", "Access is denied.", None, 0.1);
        match outcome.result {
            Err(FirewallError::SubnetDetectionFailed {
                reason: SubnetDetectionReason::QueryFailed,
                exit_code,
                ref stderr_tail,
            }) => {
                assert_eq!(exit_code, Some(1));
                assert_eq!(stderr_tail, "Access is denied.");
            }
            other => panic!("expected a decorated QueryFailed, got {other:?}"),
        }
        assert_eq!(outcome.level, log::Level::Warn);
    }

    #[test]
    fn a_successful_query_stays_at_debug_and_returns_the_subnet() {
        let outcome = finish_subnet_query(
            true,
            Some(0),
            "TANDEM_ADAPTERS:1\n172.20.0.1/20",
            "",
            None,
            0.1,
        );
        assert_eq!(outcome.result.unwrap(), "172.20.0.0/20");
        assert_eq!(outcome.level, log::Level::Debug);
    }

    #[test]
    fn the_wire_reads_stderr_and_the_log_reads_both_streams() {
        // Which stream ends up where was untestable while it lived inside the
        // spawning function, and swapping them was a green mutation.
        let outcome = finish_subnet_query(false, Some(1), "STDOUT-MARK", "STDERR-MARK", None, 0.1);
        assert!(outcome.log_line.contains("STDOUT-MARK"));
        assert!(outcome.log_line.contains("STDERR-MARK"));
        match outcome.result {
            Err(FirewallError::SubnetDetectionFailed {
                ref stderr_tail, ..
            }) => {
                assert_eq!(stderr_tail, "STDERR-MARK");
            }
            other => panic!("expected SubnetDetectionFailed, got {other:?}"),
        }
    }

    #[test]
    fn adapter_enumeration_messages_are_distinct_and_name_the_interpreter() {
        // The #1372 defect in one assertion: two causes with opposite remedies
        // shared one sentence, and that sentence claimed an enumeration had
        // been attempted when the interpreter never launched.
        let mut messages = Vec::new();
        for reason in ALL_ADAPTER_REASONS {
            let msg = FirewallError::AdapterEnumerationFailed { reason }.to_string();
            assert!(
                msg.contains("powershell.exe"),
                "{reason:?} does not name the interpreter: {msg}"
            );
            assert!(
                msg.contains("never ran"),
                "{reason:?} still implies the query was attempted: {msg}"
            );
            messages.push(msg);
        }
        let unique: std::collections::HashSet<&String> = messages.iter().collect();
        assert_eq!(
            unique.len(),
            messages.len(),
            "two reasons share a message, so the reason carries no information: {messages:?}"
        );
    }

    #[test]
    fn adapter_reason_rides_along_as_a_sibling_field_on_the_wire() {
        // Same shape and same stakes as the subnet pin above: the client reads
        // `reason` off the same object it discriminates on, and a miss in its
        // hint table degrades silently to the generic fallback.
        let expected = [
            (
                AdapterEnumerationReason::NotFound,
                r#"{"kind":"adapterEnumerationFailed","reason":"notFound"}"#,
            ),
            (
                AdapterEnumerationReason::PermissionDenied,
                r#"{"kind":"adapterEnumerationFailed","reason":"permissionDenied"}"#,
            ),
            (
                AdapterEnumerationReason::SpawnFailed,
                r#"{"kind":"adapterEnumerationFailed","reason":"spawnFailed"}"#,
            ),
        ];
        assert_eq!(
            expected.len(),
            ALL_ADAPTER_REASONS.len(),
            "a reason was added without pinning its wire spelling"
        );
        for (reason, want) in expected {
            let json =
                serde_json::to_string(&FirewallError::AdapterEnumerationFailed { reason }).unwrap();
            assert_eq!(json, want);
        }
    }

    #[test]
    fn netsh_failure_fields_use_the_wire_spelling() {
        // Pre-existing and silent until #1372: container `rename_all` renames
        // variants, not struct-variant fields, so these three went out as
        // `exit_code`/`stderr_tail`/`stdout_tail` while the client read
        // `exitCode`/`stderrTail`/`stdoutTail`. This is the assertion that
        // makes `rename_all_fields` load-bearing rather than decorative.
        let json = serde_json::to_string(&FirewallError::NetshFailure {
            exit_code: 1,
            stderr_tail: "err".to_string(),
            stdout_tail: "out".to_string(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"kind":"netshFailure","exitCode":1,"stderrTail":"err","stdoutTail":"out"}"#
        );
    }

    #[test]
    fn classification_carries_no_diagnostics_on_its_own() {
        // `classify_subnet_output` is a pure function of the output SHAPE and
        // never sees an exit code or a stderr. If it started minting them it
        // would mint `Some(0)` and `""` — evidence-shaped values asserting we
        // looked and found nothing wrong.
        for stdout in ["", "TANDEM_ADAPTERS 0", "TANDEM_ADAPTERS 2", "TANDEM_ADAPTERS many"] {
            match classify_subnet_output(true, stdout) {
                Err(FirewallError::SubnetDetectionFailed {
                    exit_code,
                    stderr_tail,
                    ..
                }) => {
                    assert_eq!(exit_code, None, "for stdout {stdout:?}");
                    assert_eq!(stderr_tail, "", "for stdout {stdout:?}");
                }
                other => panic!("expected SubnetDetectionFailed, got {other:?}"),
            }
        }
    }

    #[test]
    fn diagnostics_attach_to_query_failed_and_to_nothing_else() {
        let attached = with_query_diagnostics(
            classify_subnet_output(false, ""),
            Some(1),
            "Get-NetAdapter : Access is denied.",
        );
        match attached {
            Err(FirewallError::SubnetDetectionFailed {
                reason: SubnetDetectionReason::QueryFailed,
                exit_code,
                stderr_tail,
            }) => {
                assert_eq!(exit_code, Some(1));
                assert_eq!(stderr_tail, "Get-NetAdapter : Access is denied.");
            }
            other => panic!("expected QueryFailed with diagnostics, got {other:?}"),
        }

        // Every other classification passes through untouched — including the
        // success case, which must not be turned into a failure by the wrapper.
        assert_eq!(
            with_query_diagnostics(
                classify_subnet_output(true, "TANDEM_ADAPTERS 1\r\n172.20.0.1/20\r\n"),
                Some(0),
                "noise",
            )
            .unwrap(),
            "172.20.0.0/20"
        );
        for (stdout, want) in [
            ("TANDEM_ADAPTERS 0", SubnetDetectionReason::NoAdapter),
            ("TANDEM_ADAPTERS 2", SubnetDetectionReason::NoIpv4),
            (
                "TANDEM_ADAPTERS 1\r\n10.0.0.1/8\r\n",
                SubnetDetectionReason::PrefixTooBroad,
            ),
        ] {
            match with_query_diagnostics(classify_subnet_output(true, stdout), Some(0), "noise") {
                Err(FirewallError::SubnetDetectionFailed {
                    reason,
                    exit_code,
                    stderr_tail,
                }) => {
                    assert_eq!(reason, want);
                    assert_eq!(exit_code, None, "{want:?} acquired an exit code");
                    assert_eq!(stderr_tail, "", "{want:?} acquired a stderr tail");
                }
                other => panic!("expected {want:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn query_failed_diagnostics_are_omitted_from_the_wire_when_absent() {
        // The client's union declares both fields optional so an older sidecar
        // still parses. `skip_serializing_if` is what keeps that true in the
        // other direction: an unpopulated diagnostic must not serialize as
        // `null`/`""` and render as "exit null: (no output)".
        let bare = serde_json::to_string(&FirewallError::SubnetDetectionFailed {
            reason: SubnetDetectionReason::QueryFailed,
            exit_code: None,
            stderr_tail: String::new(),
        })
        .unwrap();
        assert_eq!(
            bare,
            r#"{"kind":"subnetDetectionFailed","reason":"queryFailed"}"#
        );

        let full = serde_json::to_string(&FirewallError::SubnetDetectionFailed {
            reason: SubnetDetectionReason::QueryFailed,
            exit_code: Some(1),
            stderr_tail: "boom".to_string(),
        })
        .unwrap();
        assert_eq!(
            full,
            r#"{"kind":"subnetDetectionFailed","reason":"queryFailed","exitCode":1,"stderrTail":"boom"}"#
        );
    }
}
