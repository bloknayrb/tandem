# Cowork + shell chrome on non-Windows: ship it, or declare Windows-only?

**Issues:** #316, #317, #552   **Decision needed:** Does v1.0 ship Cowork auto-setup on macOS/Linux (#316+#317 as a paired unit), or ship Windows-only with macOS/Linux documented as unsupported and #316/#317/#552 closed as won't-do-for-v1.0?

## What these are

All three are Windows-only seams in the desktop shell.

- **Cowork is hard-gated to Windows at the module level.** `src-tauri/src/cowork_installer.rs:13`, `firewall.rs:9`, `cowork_workspace_scan.rs:18`, `cowork_meta.rs:12` all carry `#![cfg(target_os = "windows")]`. Every Tauri command has a non-Windows twin returning `WINDOWS_ONLY_ERR` (`lib.rs:2713–2717`, `2973–2977`).
- **The UI already says so.** `cowork-helpers.ts:21` defines a `"unsupported" // non-Windows` variant, and `CoworkSettings.svelte:137` renders "Cowork integration is available on Windows today. macOS/Linux support is tracked in #316 / #317." So "document as unsupported" is ~90% shipped already.
- **Cowork still *works* on macOS/Linux manually** — via the stdio bridge (`npx -y tandem-editor mcp-stdio`), verified end-to-end since v0.7.1 (`docs/roadmap.md:420–422`, ADR-023). #316 is turnkey-ness, not capability.
- **#317 is the security half.** Enabling Cowork binds `0.0.0.0`; Windows scopes that with a `netsh` rule to the detected vEthernet subnet (`firewall.rs`, ADR-044 §7). There is no `pf`/`ufw`/`firewalld` equivalent. Mitigation floor: LAN bind is always token-gated and fails closed without a token, and Hocuspocus stays loopback (`roadmap.md:413`).
- **#552 is broader than KDE.** Tandem draws its own minimize/maximize/close cluster unconditionally at top-right (`TitleBar.svelte:350`, `.title-bar-controls` at `:768`), and `setup_overlay_titlebar` is `#[cfg(target_os = "windows")]` (`lib.rs:2651–2661`) with `decorations: false` globally (`tauri.conf.json:23`). So **macOS shows Windows-style right-side controls and no traffic lights** — the issue body's claim that "decorum handles macOS correctly" is stale.

## Why they stalled

Not effort — evidence. Verification needs Mac and Linux hardware Bryan doesn't have (`feedback_no_hardware_for_release_smoke`). The roadmap is also internally inconsistent: #316 is **Core** (`roadmap.md:513`) while #317 is **paired-defer** (`:688`) — shipping that pair as written means mac/Linux Cowork with unscoped LAN exposure.

Unverified: whether Claude Desktop Cowork on macOS/Linux even uses a VM with LAN-IP host reachability. Nothing in the repo establishes the layout; #316's own body guesses ("likely", "probably").

## Options

1. **Windows-only for v1.0.** Cost: ~1 day — reword `CoworkSettings.svelte:137` to a settled statement (no issue numbers), add a manual stdio-bridge recipe to docs, add a `data-platform` mirror or accept #552, update `roadmap.md:26/513`. Forecloses nothing; #316 can reopen post-v1.0.
2. **Ship #316+#317 together.** Cost: unbounded — an unknown macOS layout, four Linux firewall backends, plus real-hardware probes. Forecloses the v1.0 date.
3. **#316 without #317.** Cheaper, but ships a LAN-exposed port with no scoping. Reject.
4. **Ship #552 blind** (CSS mirror behind a platform flag) with no tester. Small, but unverifiable — the exact class of change that ships unread.

## Recommendation

**Option 1.** Cowork on macOS/Linux is convenience over a path that already works manually; #317 makes the pair a security-gated project, not a polish task; and #552's real defect is macOS, which no one has reported. Close #316/#317/#552 as v1.1, keep the honest in-product statement.

## If yes (Windows-only)

Reword the unsupported banner and `CoworkSettings` copy; document the manual `mcp-stdio` path for mac/Linux; amend `roadmap.md` Wave 5 to drop #316 from Core; Wave 5 then reduces to the install-matrix rows only. Do **not** touch the `#![cfg]` gates.

## If no (ship cross-platform)

#317 becomes a v1.0 blocker and needs its own plan: macOS Cowork network topology probe first (a real Mac), then `pf` anchor design, then Linux backend detection with fail-closed degradation. Budget hardware acquisition before any code.
