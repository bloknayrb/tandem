# Where Tandem Keeps Its Data (and How to Remove All of It)

Tandem stores state in three kinds of places: its own app-data directory,
the OS keychain, and — because it registers itself as an MCP server — a few
entries inside *other programs'* config files. This page enumerates all of
them, what the uninstall scrub removes, and how to clean up manually.

Your documents are never moved: Tandem edits files where they live on disk.

## App data directory

**The desktop app and the npm install use SEPARATE directories** (#1787). They ship
on independent schedules, so sharing one root meant every downgrade hazard was
reachable with no downgrade.

npm install (`env-paths`):

| OS | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\tandem\Data\` |
| macOS | `~/Library/Application Support/tandem/` |
| Linux | `$XDG_DATA_HOME/tandem/` (default `~/.local/share/tandem/`) |

Desktop app (Tauri `app_data_dir()`, under the `com.tandem.editor` identifier):

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\com.tandem.editor\` |
| macOS | `~/Library/Application Support/com.tandem.editor/` |
| Linux | `$XDG_DATA_HOME/com.tandem.editor/` (default `~/.local/share/com.tandem.editor/`) |

Each root carries an `owner.json` stamping which install claimed it; a directory one
flavor owns is **refused** by the other rather than shared. The first desktop launch
after this version **copies** the npm directory across, once, leaving the original
intact. "Once" is recorded in its own file, `npm-migration-complete` — not in
`owner.json` — so deleting the stamp hands the directory over without re-importing
anything. The copy excludes five things: `owner.json` itself (so an interrupted copy
retries instead of leaving a foreign stamp), `npm-migration-complete` (so a
half-finished copy can never read as finished), `annotations/store.lock` (a copied live
lock would make the new directory read-only for annotations forever), in-flight
`.tandem-tmp-*` atomic-write temporaries, and `auth-token` (whose only reader derives
the npm path directly — see the note under its row).

Two consequences worth knowing. The annotation-store lock is **per-flavor** now, so
running both flavors against the same document on different ports lets each write its
own durable envelope and neither sees the other's. And unsaved **scratchpad recovery
drafts** live in browser localStorage keyed by an install id derived from the app-data
root, so they do not survive the move — a one-time loss, bounded to drafts that were
never saved to disk.

Inside either directory:

| Entry | What it holds |
| --- | --- |
| `sessions/` | Open-document session state (one JSON per document + the control room), used to restore your tabs on launch |
| `annotations/` | The durable annotation store (one JSON per document hash) and its `store.lock` |
| `doc-backups/` | Pre-overwrite snapshots of your documents — verbatim byte copies taken before Tandem's first write to a file each run, restorable with any file manager (see [troubleshooting → Recovering a previous version](troubleshooting.md#recovering-a-previous-version-of-a-document)) |
| `integrations.json` | Integration config; secrets are keychain references, not plaintext |
| `owner.json` | Which install claimed this directory (`{"version", "flavor"}`). Delete it only to hand the directory to the other flavor deliberately; doing so does not re-run the one-time npm import. |
| `npm-migration-complete` | **Desktop location only.** The record that the one-time copy from the npm directory already happened. Deleting it makes the next desktop launch re-import that directory, so leave it alone. |
| `auth-token` | **npm location only.** Its path is derived from the `env-paths` root directly and deliberately ignores `TANDEM_APP_DATA_DIR`, so it never appears in the desktop directory — the desktop keeps its token in the OS keychain and passes it to the sidecar. The auto-generated Bearer token (mode `0o600`) that non-loopback callers must present. Deleting it makes Tandem mint a new one on next launch, which invalidates any config still carrying the old value — run `tandem rotate-token` instead of deleting it by hand. |
| `license.json` | **Your activated license.** Contains the signed blob, which carries your name and email address — the only identity information Tandem writes to disk. Deleting it means re-activating from the key you were emailed. |
| `trial.json` | The trial clock's start timestamp. Deleting it restarts the trial (the clock is deliberately soft — see [ADR-040](decisions.md)). |
| `.backups/` | Backups of `~/.claude.json` and the Claude Desktop config, taken before Tandem rewrote an entry you had customized. Named `claude-json-<YYYYMMDD-HHMMSS>-<id>.json`; the three most recent are kept |
| `.broken-backups/` | Quarantined copies of malformed config files (user-only permissions) |
| `last-seen-version` | Drives the "what's new" changelog on upgrade |
| `autostart-seen` | Linux only, and only with start-at-login enabled — marks that a login launch has happened |

You may also see `.tandem-tmp-*` files inside `sessions/` and `annotations/`. These are
half-finished atomic writes orphaned when the process was killed between writing and renaming
(a force-quit, a dev restart). Tandem sweeps ones older than an hour at boot; they are safe to
delete, and never appear in your own document folders.

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

Three service names in the platform keychain (Windows Credential Manager,
macOS Keychain, Linux Secret Service):

- `tandem` — the desktop app's Bearer auth token, under the entry `auth-token`.
  Desktop app only; the npm install keeps its token in the `auth-token` file
  listed above instead.
- `tandem-integrations` — Tandem's own integration auth tokens.
- `tandem-models` — API keys for the bring-your-own-model integration, when that
  feature is enabled. Present only if you have added a key.

Whether these entries actually reach your OS keychain on the desktop app is
tracked in **#1761**, and the bound is now narrower than that issue's title
suggested. The issue was filed against `keyring` 3.x, which shipped no default
backend, so every "stored" secret went to an in-memory stand-in. The dependency
is now `keyring = "4"` (4.2.0), whose default `v1` feature pulls in the Apple,
Windows and Secret-Service stores and whose `Entry::new` selects the platform
store on first use — and which has **no mock to fall through to**: on a platform
it cannot serve, `Entry::new` returns an error rather than silently succeeding.
So the in-memory stand-in is gone by construction.

What is still unconfirmed is narrower: nobody has run the round-trip on any
platform (write a secret, restart, read it back), and Tandem never calls
`Entry::store_status()`, so a machine whose credential store fails to initialise
takes the file fallback with no diagnostic. Treat "these entries exist" as
expected rather than observed. Nothing here is lost if they do not: the
consequence is that a secret has to be re-entered, not that it leaks.

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
- The start-at-login registration, **if you turned that setting on**
  (Settings → Network). It lives outside the app-data directory, so deleting
  app data does not remove it, and an orphan makes your OS try to launch a
  binary that isn't there on every login:

  | OS | Location |
  |---|---|
  | Windows | `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, value `Tandem` (plus a matching `Explorer\StartupApproved\Run` value) |
  | macOS | `~/Library/LaunchAgents/Tandem.plist` |
  | Linux | `~/.config/autostart/Tandem.desktop` (always home-relative; `XDG_CONFIG_HOME` is not consulted) |

## Uninstalling cleanly

**Windows desktop app**: the uninstaller runs a scrub automatically, but a
**narrower one than the command below**. What it removes is the Cowork plugin
entries, the `Tandem Cowork*` firewall rules, and the start-at-login
registration. The MCP entries in `~/.claude.json` and the Claude Desktop config,
and the bundled skill at `~/.claude/skills/tandem/`, are **not** touched — that
half lives in the npm CLI, whose bundle the desktop app does not ship. So run
the command below yourself as well if you want no traces. The automatic scrub is
also skipped during an *upgrade* (the installer runs the old uninstaller to
replace files, and wiping your configuration on every release would not be a
favor), so your settings survive updates.

**Everywhere, including after a Windows uninstall**: run the full scrub
*before* removing the app, while the `tandem` binary still exists:

```bash
tandem --uninstall-scrub        # or: npx tandem-editor --uninstall-scrub
```

Then delete the app / `npm uninstall -g tandem-editor`.

The scrub removes the cross-program entries listed above (MCP config keys,
the bundled skill, Cowork registration, firewall rules, and the start-at-login
registration). It **deliberately
leaves your data**: the app-data directory (your sessions, annotations, and
document backups) and the keychain entries stay until you delete them
yourself — uninstalling must never be the thing that destroys a backup you
need next week.

### Full manual cleanup

If the binary is already gone, or you want zero traces:

> **Before step 1: save your license.** The app-data directory contains
> `license.json`. Deleting it destroys the activated copy of a license you paid
> for. The signed key you were emailed is the real credential and can always be
> re-activated — so keep that email (or copy `license.json` somewhere first) if
> you intend to reinstall.

1. Delete the app-data directories for your OS — **both tables above** if you ran the
   desktop app and the npm install.
2. Delete the log directory (table above).
3. Open `~/.claude.json` in an editor and delete the `"tandem"` (and
   `"tandem-channel"`, if present) keys under `"mcpServers"`. Do the same in
   `claude_desktop_config.json` if you use Claude Desktop.
4. Delete `~/.claude/skills/tandem/`.
5. Remove the three keychain services (`tandem`, `tandem-integrations`,
   `tandem-models`) with your OS's credential manager. Any of them may simply
   not be there — see the note above.
