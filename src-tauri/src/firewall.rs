//! Windows Firewall management for the Cowork VM subnet allow/deny rules.
//!
//! All `netsh` invocations use `Command::new("netsh").args([...])` — never
//! `cmd.exe`, never string concatenation, never `--%` wrappers (security §4).
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
/// Variants are designed to give the PR-f Settings UI distinct recovery hints
/// (security invariant §13).
#[derive(Debug)]
pub enum FirewallError {
    /// The user declined the UAC elevation prompt. The install is fail-closed:
    /// a deny rule is written instead.
    AdminDeclined,
    /// `netsh.exe` was not found on PATH.
    NetshNotFound,
    /// `netsh.exe` ran but returned a non-zero exit code.
    NetshFailure { exit_code: i32, stderr_tail: String },
    /// The vEthernet subnet could not be determined (e.g. adapter absent, prefix
    /// too broad, or PowerShell returned unexpected output).
    SubnetDetectionFailed,
    /// Hyper-V adapter enumeration via PowerShell failed.
    AdapterEnumerationFailed,
}

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
            } => write!(
                f,
                "netsh.exe failed (exit {exit_code}): {stderr_tail}"
            ),
            FirewallError::SubnetDetectionFailed => write!(
                f,
                "Could not detect Hyper-V vEthernet subnet — is Cowork set up on this machine?"
            ),
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
/// Queries Hyper-V virtual adapters via PowerShell:
///   `Get-NetAdapter | Where InterfaceDescription -like "*Hyper-V Virtual Ethernet*" |
///    Get-NetIPAddress -AddressFamily IPv4 | Select IPAddress, PrefixLength`
///
/// # Security invariants
/// - Rejects any result where prefix length < 20 (too permissive).
/// - Returns `SubnetDetectionFailed` on zero Hyper-V adapter matches.
/// - Never falls back to a hardcoded CIDR like `172.16.0.0/12`.
///
/// # Returns
/// The detected CIDR string (e.g. `"172.20.0.0/20"`) on success.
pub fn detect_vethernet_subnet() -> Result<String, FirewallError> {
    let ps_script = r#"
$adapters = Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceDescription -like '*Hyper-V Virtual Ethernet*' }
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

    if !output.status.success() || stdout.is_empty() {
        return Err(FirewallError::SubnetDetectionFailed);
    }

    // Parse lines like "172.20.0.1/20" — take the first valid result.
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(cidr) = parse_cidr_from_line(line) {
            return Ok(cidr);
        }
    }

    Err(FirewallError::SubnetDetectionFailed)
}

/// Parse an `IPAddress/PrefixLength` string into a proper CIDR network address.
///
/// Rejects prefix length < 20 per security invariant §5.
fn parse_cidr_from_line(line: &str) -> Option<String> {
    let (ip_str, prefix_str) = line.split_once('/')?;
    let prefix: u8 = prefix_str.trim().parse().ok()?;

    // Security invariant §5: reject too-broad prefixes.
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

/// Add an inbound deny rule — written when UAC elevation is refused so that
/// port 3479 is definitively blocked from the VM, not in an ambiguous open state.
///
/// Rule: `dir=in, action=block, protocol=TCP, localport=3479, remoteip=<cidr>`.
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
        // "No rules match" is not an error — the user may never have had a rule.
        match e {
            FirewallError::NetshFailure { exit_code: 1, .. } => {
                log::debug!("[firewall] no Tandem Cowork rules to remove");
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
        FirewallError::NetshFailure { exit_code: 1, .. } => Ok(()),
        other => Err(other),
    })
}

/// Scan for orphan "Tandem Cowork*" firewall rules and return their names.
///
/// Used by install-time orphan reconciliation (security invariant §12) to detect
/// stale rules from a previous failed uninstall.
pub fn scan_orphan_rules() -> Vec<String> {
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
        Err(e) => {
            log::warn!("[firewall] scan_orphan_rules spawn failed: {e}");
            return vec![];
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();

    log::debug!(
        "[firewall] scan_orphan_rules: exit={}, elapsed={:.2}s",
        output.status.code().unwrap_or(-1),
        elapsed.as_secs_f64()
    );

    // Parse "Rule Name: ..." lines from netsh output.
    stdout
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
        .collect()
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
        // Detect UAC-declined pattern: exit code 1 + "The requested operation
        // requires elevation" in stdout (netsh writes errors to stdout on Windows).
        let combined = format!("{stdout}{stderr}");
        if combined.contains("requires elevation") || combined.contains("access is denied") {
            log::warn!("[firewall] UAC elevation declined");
            return Err(FirewallError::AdminDeclined);
        }

        return Err(FirewallError::NetshFailure {
            exit_code,
            stderr_tail: truncate_tail(stderr.trim(), 400).to_string(),
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
}
