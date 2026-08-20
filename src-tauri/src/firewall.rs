//! Windows Firewall management for the Cowork VM subnet allow/deny rules.
//!
//! All `netsh` invocations use `Command::new("netsh").args([...])` — never
//! `cmd.exe`, never string concatenation, never `--%` wrappers: no shell is
//! interposed, so nothing in an argument value — including the detected CIDR
//! in `remoteip={cidr}` — can be re-read as a second command.
//!
//! Every invocation is logged at DEBUG with: argv, exit code, stdout+stderr tail,
//! and wall-clock duration.

#![cfg(target_os = "windows")]

use std::fmt;
use std::process::Command;
use std::time::Instant;

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
/// `tests/build/firewall-invariant-citations.test.ts` pins all three lists
/// together: the variants here, the union members in `types.ts`, and the
/// `case` arms of that switch.
///
/// `Serialize`/`Deserialize` enable structured JSON errors over the Tauri IPC:
/// `{"kind": "adminDeclined"}` etc., matching the TypeScript discriminant in
/// the Settings UI firewall hint handler.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
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
    SubnetDetectionFailed { reason: SubnetDetectionReason },
    /// Hyper-V adapter enumeration via PowerShell failed.
    AdapterEnumerationFailed,
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
            FirewallError::SubnetDetectionFailed { reason } => match reason {
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
                    "Hyper-V adapter query returned an error or unexpected output"
                ),
            },
            FirewallError::AdapterEnumerationFailed => write!(
                f,
                "Hyper-V adapter enumeration failed — PowerShell query returned an error"
            ),
        }
    }
}

impl std::error::Error for FirewallError {}

// ---------------------------------------------------------------------------
// Firewall rule names
// ---------------------------------------------------------------------------

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
pub fn detect_vethernet_subnet() -> Result<String, FirewallError> {
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

    let start = Instant::now();
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            ps_script,
        ])
        .output();

    let elapsed = start.elapsed();

    let output = match output {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::warn!(
                "[firewall] powershell.exe not found after {:.2}s",
                elapsed.as_secs_f64()
            );
            return Err(FirewallError::AdapterEnumerationFailed);
        }
        Err(e) => {
            log::warn!(
                "[firewall] PowerShell spawn failed after {:.2}s: {e}",
                elapsed.as_secs_f64()
            );
            return Err(FirewallError::AdapterEnumerationFailed);
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    log::debug!(
        "[firewall] powershell vEthernet query: exit={}, elapsed={:.2}s, stdout={:?}, stderr={:?}",
        output.status.code().unwrap_or(-1),
        elapsed.as_secs_f64(),
        truncate_tail(&stdout, 200),
        truncate_tail(&stderr, 200),
    );

    classify_subnet_output(output.status.success(), &stdout)
}

/// Turn the detection script's output into a CIDR or a classified failure.
///
/// Split out from `detect_vethernet_subnet` so the classification table — the
/// entire point of #1298 — is unit-testable. The PowerShell spawn itself is not,
/// which is why the marker's real-world shape still needs a manual check.
fn classify_subnet_output(exit_ok: bool, stdout: &str) -> Result<String, FirewallError> {
    use SubnetDetectionReason as R;
    let failed = |reason| Err(FirewallError::SubnetDetectionFailed { reason });

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
        // "No rules match the specified criteria." is written to stdout (not stderr)
        // by netsh on Windows. Only treat exit_code==1 as "nothing to do" when
        // stdout confirms the "no match" case — all other exit-1 failures propagate.
        match e {
            FirewallError::NetshFailure { exit_code: 1, ref stdout_tail, .. }
                if stdout_tail.contains("No rules match") =>
            {
                log::debug!("[firewall] no Tandem Cowork rules to remove (allow rule)");
                Ok(())
            }
            other => Err(other),
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
    .or_else(|e| match e {
        FirewallError::NetshFailure { exit_code: 1, ref stdout_tail, .. }
            if stdout_tail.contains("No rules match") =>
        {
            log::debug!("[firewall] no Tandem Cowork rules to remove (deny rule)");
            Ok(())
        }
        other => Err(other),
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
    let start = Instant::now();
    let output = Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "show",
            "rule",
            &format!("name={RULE_NAME_PREFIX}"),
        ])
        .output();

    let elapsed = start.elapsed();

    let output = match output {
        Ok(o) => o,
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
            stderr_tail: truncate_tail(stderr.trim(), 400).to_string(),
            stdout_tail: truncate_tail(stdout.trim(), 400).to_string(),
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
    let start = Instant::now();
    let output = Command::new("netsh").args(args).output();
    let elapsed = start.elapsed();

    let output = match output {
        Ok(o) => o,
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

    log::debug!(
        "[firewall] netsh {:?}: exit={exit_code}, elapsed={:.2}s, stdout={:?}, stderr={:?}",
        args,
        elapsed.as_secs_f64(),
        truncate_tail(&stdout, 200),
        truncate_tail(&stderr, 200),
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
            stderr_tail: truncate_tail(stderr.trim(), 400).to_string(),
            stdout_tail: truncate_tail(stdout.trim(), 400).to_string(),
        });
    }

    Ok(())
}

/// Return the last `max_chars` characters of a string (UTF-8 char boundary).
fn truncate_tail(s: &str, max_chars: usize) -> &str {
    if s.len() <= max_chars {
        s
    } else {
        let start = s.len() - max_chars;
        // Find a valid char boundary.
        let mut pos = start;
        while pos < s.len() && !s.is_char_boundary(pos) {
            pos += 1;
        }
        &s[pos..]
    }
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
    fn test_truncate_tail() {
        assert_eq!(truncate_tail("hello world", 5), "world");
        assert_eq!(truncate_tail("short", 100), "short");
    }

    // -----------------------------------------------------------------------
    // #1298: the classification table. Each of these used to be the same
    // opaque `SubnetDetectionFailed`, and each wants different user advice.
    // -----------------------------------------------------------------------

    /// Every `SubnetDetectionReason`, hand-maintained because Rust has no
    /// built-in enum iteration. A variant added without being listed here is
    /// caught by the length assertion in the wire-shape test, which is the one
    /// place that would otherwise ship an unpinned spelling.
    const ALL_SUBNET_REASONS: [SubnetDetectionReason; 4] = [
        SubnetDetectionReason::NoAdapter,
        SubnetDetectionReason::NoIpv4,
        SubnetDetectionReason::PrefixTooBroad,
        SubnetDetectionReason::QueryFailed,
    ];

    fn reason_of(exit_ok: bool, stdout: &str) -> SubnetDetectionReason {
        match classify_subnet_output(exit_ok, stdout) {
            Err(FirewallError::SubnetDetectionFailed { reason }) => reason,
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
            let msg = FirewallError::SubnetDetectionFailed { reason }.to_string();
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
        ];
        assert_eq!(
            expected.len(),
            ALL_SUBNET_REASONS.len(),
            "a reason was added without pinning its wire spelling"
        );
        for (reason, want) in expected {
            let json = serde_json::to_string(&FirewallError::SubnetDetectionFailed { reason })
                .unwrap();
            assert_eq!(json, want);
        }
    }
}
