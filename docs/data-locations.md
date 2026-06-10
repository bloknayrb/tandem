# Where Tandem Keeps Its Data (and How to Remove All of It)

Tandem stores state in three kinds of places: its own app-data directory,
the OS keychain, and — because it registers itself as an MCP server — a few
entries inside *other programs'* config files. This page enumerates all of
them, what the uninstall scrub removes, and how to clean up manually.

Your documents are never moved: Tandem edits files where they live on disk.

## App data directory

| OS | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\tandem\Data\` |
| macOS | `~/Library/Application Support/tandem/` |
| Linux | `$XDG_DATA_HOME/tandem/` (default `~/.local/share/tandem/`) |

Inside it:

| Entry | What it holds |
| --- | --- |
| `sessions/` | Open-document session state (one JSON per document + the control room), used to restore your tabs on launch |
| `annotations/` | The durable annotation store (one JSON per document hash) and its `store.lock` |
| `doc-backups/` | Pre-overwrite snapshots of your documents — verbatim byte copies taken before Tandem's first write to a file each run, restorable with any file manager (see [troubleshooting → Recovering a previous version](troubleshooting.md#recovering-a-previous-version-of-a-document)) |
| `integrations.json` | Integration config; secrets are keychain references, not plaintext |
| `tandem_backups/` | Backups of `~/.claude.json` taken before Tandem rewrote a customized entry |
| `.broken-backups/` | Quarantined copies of malformed config files (user-only permissions) |
| `last-seen-version` | Drives the "what's new" changelog on upgrade |

## Logs

| Distribution | Path |
| --- | --- |
| Desktop app (Windows) | `%LOCALAPPDATA%\com.tandem.editor\logs\tandem.log` |
| Desktop app (macOS) | `~/Library/Logs/com.tandem.editor/tandem.log` |
| Desktop app (Linux) | `~/.local/share/com.tandem.editor/logs/tandem.log` |
| Uninstall scrub (Windows) | `%LOCALAPPDATA%\tandem\Logs\uninstall.log` |
| npm install | stderr only (no log file) |

The desktop app's **Settings → About → Open Log Folder** button opens the
right directory for you.

## OS keychain

Two service names in the platform keychain (Windows Credential Manager,
macOS Keychain, Linux Secret Service):

- `tandem-integrations` — Tandem's own auth tokens
- `tandem-models` — API keys you added in Settings → Models

## Entries Tandem writes into other programs' config

These are what go stale if you delete Tandem without cleaning up:

- `~/.claude.json` — `mcpServers.tandem` (and `mcpServers["tandem-channel"]`
  on legacy shim setups). An orphaned entry makes Claude Code retry a dead
  server on every session (see [troubleshooting → MCP shows connected but
  Tandem tools fail](troubleshooting.md#mcp-shows-connected-but-tandem-tools-fail)).
- Claude Desktop config — same two keys in `claude_desktop_config.json`
  (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/`
  on macOS, `~/.config/claude/` on Linux, plus the MSIX package location for
  Microsoft Store installs).
- `~/.claude/skills/tandem/SKILL.md` — the bundled skill Claude Code
  auto-discovers.
- Windows only: `Tandem Cowork*` firewall rules and Cowork plugin
  registration entries.

## Uninstalling cleanly

**Windows desktop app**: the uninstaller runs the scrub automatically —
nothing to do.

**Everywhere else** (macOS/Linux desktop, npm install): run the scrub
*before* removing the app, while the `tandem` binary still exists:

```bash
tandem --uninstall-scrub        # or: npx tandem-editor --uninstall-scrub
```

Then delete the app / `npm uninstall -g tandem-editor`.

The scrub removes the cross-program entries listed above (MCP config keys,
the bundled skill, Cowork registration, firewall rules). It **deliberately
leaves your data**: the app-data directory (your sessions, annotations, and
document backups) and the keychain entries stay until you delete them
yourself — uninstalling must never be the thing that destroys a backup you
need next week.

### Full manual cleanup

If the binary is already gone, or you want zero traces:

1. Delete the app-data directory for your OS (table above).
2. Delete the log directory (table above).
3. Open `~/.claude.json` in an editor and delete the `"tandem"` (and
   `"tandem-channel"`, if present) keys under `"mcpServers"`. Do the same in
   `claude_desktop_config.json` if you use Claude Desktop.
4. Delete `~/.claude/skills/tandem/`.
5. Remove the two keychain services (`tandem-integrations`, `tandem-models`)
   with your OS's credential manager.
