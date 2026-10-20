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
| `launcher-settings.json` | How Tandem's own Claude starts and how long it runs (Settings → AI Assistant → Tandem's Claude, #2195). Deleting it restores the defaults: start automatically, keep running. |
| `v1-walkthrough.json` | Whether you have been through the setup wizard on v1.0 (#2198): written once, when you click **Keep this setup** or an Apply succeeds. Until it exists, every launch of a v1.0 release opens the wizard and holds Tandem's Claude until you confirm. Deleting it brings the walkthrough back on the next launch; an unreadable one is treated as done. |
| `first-run-greeting.json` | Whether Tandem's own Claude still owes you its one-time hello in the chat panel (#2197): written `owed` on a first install and on the first run of v1.0, `done` once the hello arrives. Deleting it does not bring the hello back on its own; it is armed again only on a first install or the first run of v1.0. |
| `launcher-session.json` | The conversation Tandem's own Claude resumes, and the folder it was started in. Deleting it makes the next start a fresh conversation. |
| `owner.json` | Which install claimed this directory (`{"version", "flavor"}`). Delete it only to hand the directory to the other flavor deliberately; doing so does not re-run the one-time npm import. |
| `npm-migration-complete` | **Desktop location only.** The record that the one-time copy from the npm directory already happened. Deleting it makes the next desktop launch re-import that directory, so leave it alone. |
| `auth-token` | **npm location only.** Its path is derived from the `env-paths` root directly and deliberately ignores `TANDEM_APP_DATA_DIR`, so it never appears in the desktop directory. The desktop keeps its token in the OS keychain and passes it to the sidecar, but it also uses this npm-location file as its fallback: it reads the file when the keychain has no entry (adopting a token an npm install already minted), and writes it when the keychain is unavailable (for example Linux without Secret Service). So the file can exist on a machine with no npm install at all. The auto-generated Bearer token (mode `0o600` on POSIX; the desktop fallback writer narrows it to that just after writing) that non-loopback callers must present. Deleting it makes Tandem mint a new one on next launch, which invalidates any config still carrying the old value — run `tandem rotate-token` instead of deleting it by hand. |
| `license.json` | **Your activated license.** Contains the signed blob, which carries your name and email address — the only identity information Tandem writes to disk. Deleting it means re-activating from the key you were emailed. |
| `trial.json` | The trial clock's start timestamp. Deleting it restarts the trial (the clock is deliberately soft — see [ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license)). This file and `license.json` both live under `TANDEM_APP_DATA_DIR`, so pointing that variable at a new directory presents a fresh trial and an apparently-unlicensed device. |
| `.backups/` | Backups of `~/.claude.json` and the Claude Desktop config, taken before Tandem rewrote an entry you had customized. Named `claude-json-<YYYYMMDD-HHMMSS>-<id>.json`; the three most recent are kept |
| `.broken-backups/` | Quarantined copies of Tandem's own malformed config files (user-only permissions): `integrations.json` (named `integrations-…`) and the bring-your-own-model store (named `models-…`). Claude's config files are never copied here — a malformed Claude config is refused and left untouched |
| `last-seen-version` | Drives the "what's new" changelog on upgrade |
| `autostart-seen` | Linux only, and only with start-at-login enabled — marks that a login launch has happened |
| `update-pending.json` | **Desktop location only.** Marks an in-app update that was in flight, so the next launch can tell whether it landed. Removed once that is settled |
| `sample/` | **Desktop location only.** The sample documents, including the welcome tutorial, copied in on first run |
| `models.json` | The bring-your-own-model registry. Normally absent: that feature ships dark and no shipped UI writes it |

You may also see `.tandem-tmp-*` files inside `sessions/` and `annotations/`. These are
half-finished atomic writes orphaned when the process was killed between writing and renaming
(a force-quit, a dev restart). Tandem sweeps ones older than an hour at boot, and they are safe to
delete.

Saving a document writes the same kind of temporary file **next to the document**, in its own
folder, then renames it into place. A failed save removes it, but a force-quit at exactly the
wrong moment can leave one behind. Tandem never sweeps your document folders, so it will not
remove that file for you; it is safe to delete.

## Logs

| Distribution | Path |
| --- | --- |
| Desktop app (Windows) | `%LOCALAPPDATA%\com.tandem.editor\logs\tandem.log` |
| Desktop app (macOS) | `~/Library/Logs/com.tandem.editor/tandem.log` |
| Desktop app (Linux) | `~/.local/share/com.tandem.editor/logs/tandem.log` |
| `tandem --uninstall-scrub` (Windows) | `%LOCALAPPDATA%\tandem\Logs\uninstall.log` |
| npm install | stderr only (no log file) |

The uninstall log belongs to the npm CLI's scrub, the command under
[Uninstalling cleanly](#uninstalling-cleanly). The Windows desktop uninstaller's
automatic scrub is a different program: it runs inside the desktop binary
(`src-tauri/src/uninstall_scrub.rs`) and writes **no log file**, only a stderr
that the installer does not keep. The installer's details pane shows its exit
code and nothing else.

The desktop app's **Settings → About → Open Log Folder** button opens the
right directory for you.

## OS keychain

Three service names in the platform keychain (Windows Credential Manager,
macOS Keychain, Linux Secret Service):

- `tandem` — the desktop app's Bearer auth token, under the entry `auth-token`.
  Desktop app only; the npm install keeps its token in the `auth-token` file
  listed above instead. When the keychain is unavailable, the desktop app falls
  back to that same file at the npm location (and reads it first if the keychain
  holds no token), so it can create or adopt that file too.
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

A machine whose credential store fails to initialise is no longer silent about it:
the token store logs the store's own init error before it takes the file fallback,
and a keychain error names why the store is unavailable (both via
`Entry::store_status()`). CI also checks a round-trip across two separate `Entry`
instances on Windows and macOS (it skips on Linux runners without Secret Service, and
on macOS when platform storage is not accessible).

What is still unconfirmed is narrower: nobody has run the full round-trip on real
user machines (write a secret, restart the app, read it back). Treat "these entries
exist" as expected rather than observed. Nothing here is lost if they do not: the
consequence is that a secret has to be re-entered, not that it leaks.

## If you buy a license: what the seller keeps

Nothing on this page so far leaves your computer. Buying a license (from v1.0;
nothing is on sale during the beta) puts your details in three places outside it:

| Where | What | Who holds it |
| --- | --- | --- |
| Paddle | Your customer record, payment, receipts and invoices | Paddle, the merchant of record, under its own privacy policy |
| The seller's issuance ledger (`LEDGER_KV`, on Cloudflare) | Your email and name, copied from Paddle when the license is made, with the Paddle transaction id, the license id, its type, dates, and whether the email was sent or the order refunded | The seller (Bryan Kolb) |
| Resend, the email service | The license email it delivered to you, with your license inside, for as long as Resend's log retention keeps it | Resend, under its own privacy policy |

The ledger, and the seller's private backups of it, are the only places the
seller itself keeps your name and email. The update
service your app talks to sees only the opaque license id, and the seller's
operator alerts carry no ids at all. Your license itself, with your name and
email inside, is on your own machine as `license.json` (above).

**To have the seller's copy erased**, email the support address in your license
email. The seller removes your name and email from the ledger record and keeps
only its ids, so your license and its updates keep working. After that, a lost
license can be reissued only if you send your name and email again. Paddle's own
records are kept under Paddle's terms.

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
- Windows only, and only if you enabled Cowork in v0.28.0 or earlier:
  `Tandem Cowork*` firewall rules and Cowork plugin registration entries (see
  [below](#if-you-enabled-cowork-in-an-earlier-version)).
- The start-at-login registration, **if you turned that setting on**
  (Settings → Network). It lives outside the app-data directory, so deleting
  app data does not remove it, and an orphan makes your OS try to launch a
  binary that isn't there on every login:

  | OS | Location |
  |---|---|
  | Windows | `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, value `Tandem` (plus a matching `Explorer\StartupApproved\Run` value) |
  | macOS | `~/Library/LaunchAgents/Tandem.plist` |
  | Linux | `~/.config/autostart/Tandem.desktop` (always home-relative; `XDG_CONFIG_HOME` is not consulted) |

## If you enabled Cowork in an earlier version

Tandem's Cowork setup is not in this version ([ADR-055](decisions.md#adr-055-cowork-setup-ships-dark)). If you turned it on in
v0.28.0 or earlier, updating leaves what it wrote in place and stops maintaining it:

- A Tandem entry in three files in each Cowork workspace: `installed_plugins.json`,
  `known_marketplaces.json` and `cowork_settings.json`. The first of those carries
  Tandem's auth token.
- `%LOCALAPPDATA%\tandem\Data\cowork-meta.json`, recording that it was enabled. The
  desktop app wrote it, at the npm location in the tables above. (A copy may also sit
  under `%APPDATA%\com.tandem.editor\` from the one-time import; nothing reads that one.)
- A Windows firewall rule named `Tandem Cowork`, only if Tandem was ever run as
  administrator when you enabled it. It admits the Cowork VM's subnet to TCP port 3479
  on every network profile, for whatever program is listening there.

The desktop app's server listens on this computer only, so none of that exposes anything
while you run the desktop app. There is no in-app switch to turn it off any more. To remove it:

- **Uninstall the desktop app.** Its uninstaller removes the workspace entries and
  `%LOCALAPPDATA%\tandem\Data\cowork-meta.json`, wherever Claude Desktop keeps its Cowork
  workspaces. If you are keeping Tandem, install it again afterwards.
- **`tandem --uninstall-scrub` removes the workspace entries too**, from both places
  Claude Desktop keeps them:
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\local-agent-mode-sessions`
  (or an `AnthropicPBC.Claude*` package) and `%APPDATA%\Claude\local-agent-mode-sessions`,
  along with the temporary copy an interrupted Cowork settings write can leave there, which
  may hold the auth token. Its log names each folder it checked and what it removed.
  It looks where the `%APPDATA%` variable points: if that is outside
  your user folder it skips it with a warning, and if you changed it from the Windows
  default it may miss entries the desktop app wrote at the default location. Uninstalling
  the desktop app removes those, unless your profile is redirected to a network share,
  where neither removes them. It also removes Tandem's
  MCP entries and the bundled skill (the skill folder is left if it holds anything Tandem
  did not install), so re-run the integration wizard afterwards (Settings → AI Assistant),
  and it leaves `cowork-meta.json`.
- **The firewall rule can survive the uninstall**, because Tandem never runs elevated and
  deleting a rule needs an administrator. Open `wf.msc` as administrator and delete every
  inbound rule whose name starts with `Tandem Cowork`. From an administrator prompt,
  `netsh advfirewall firewall delete rule name="Tandem Cowork"` removes the rule that
  admits traffic.

The token in the workspace entries is the desktop app's own. It is normally kept in the OS
keychain, where `tandem rotate-token` does not reach it, so removing the entries is the way
to retire it.

## Uninstalling cleanly

**Windows desktop app**: the uninstaller runs a scrub automatically, but a
**narrower one than the command below**. What it removes is the Cowork plugin
entries, `cowork-meta.json` and the start-at-login registration, and it attempts
the `Tandem Cowork*` firewall rules (deleting those needs an administrator, which
the uninstaller is not). The MCP entries in `~/.claude.json` and the Claude Desktop config,
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
the bundled skill, the Cowork registration it can find (see the
[section above](#if-you-enabled-cowork-in-an-earlier-version)), on macOS and Linux the
start-at-login registration (on Windows the desktop uninstaller removes that), and,
when run as administrator, the firewall rules). It **deliberately
leaves your data**: the app-data directory (your sessions, annotations, and
document backups) and the keychain entries stay until you delete them
yourself — uninstalling must never be the thing that destroys a backup you
need next week. The one exception is `%LOCALAPPDATA%\tandem\Data\cowork-meta.json`,
which the Windows desktop uninstaller's own scrub deletes; this command leaves it.

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
