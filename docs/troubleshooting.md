# Troubleshooting

Common first-launch and runtime issues, with diagnostic steps.

## Quick diagnostic

If you're running from a source checkout, `npm run doctor` checks the most common setup issues at once:

- Node.js ≥ 22 installed
- `node_modules/` present
- `.mcp.json` valid (both `tandem` and `tandem-channel` entries)
- `~/.claude.json` MCP registration (when present)
- Ports `3478` (Hocuspocus WebSocket) and `3479` (MCP HTTP) listening
- `/health` endpoint responds
- `/api/events` SSE endpoint responds with `text/event-stream`
- Annotation store readable; schema version, corruption state, lock status

For desktop-app installs, use **Settings → About → Copy Diagnostics** to run the same checks in-app, minus the two source-checkout-only items (`node_modules/`, `.mcp.json`) — see [Sharing diagnostics](#sharing-diagnostics). Or `curl http://127.0.0.1:3479/health` — a `{"status":"ok",...}` response means the server is up.

## Windows SmartScreen warning

The Tandem installer is signed via Azure Trusted Signing ([ADR-030](decisions.md)), but Windows SmartScreen also gates new signing certificates on a reputation system that takes time to accumulate. Until reputation builds, first launch may show a *"Windows protected your PC"* dialog with the verified publisher name displayed.

To proceed: click **More info**, then **Run anyway**. The warning stops appearing once SmartScreen reputation accrues for the signing certificate (typically several weeks of installs across Windows machines).

This is a SmartScreen-side delay, not a code-signing failure — the installer is signed and the publisher name will be shown in the dialog. If the publisher reads as *"Unknown publisher"* instead of the Tandem signing-cert identity, that's a real signature problem; please [file an issue](https://github.com/bloknayrb/tandem/issues).

## Claude Code says "MCP failed to connect"

The server must be running before Claude Code probes the MCP URL. Start it first:

- Desktop app: launch Tandem.
- npm global install: run `tandem`.
- From source: run `npm run dev:standalone`.

If you restart the server while Claude Code is open, run `/mcp` inside Claude Code to reconnect.

## MCP shows connected but Tandem tools fail

`/mcp` showing `tandem ✔ connected` proves the config entry resolved at session start — a tool call is the first *real* round-trip, so it's the call that surfaces a dead or stale server. In likelihood order:

1. **The server isn't running anymore.** The connection state is cached from session start. Launch Tandem (or `tandem` in a terminal), then `/mcp` to reconnect.
2. **Stale URL or port.** If you've set `TANDEM_MCP_PORT` (or an old install used a different port), `~/.claude.json`'s `mcpServers.tandem.url` points at the wrong place. Re-run the in-app integration wizard or `tandem setup --apply`.
3. **Stale auth token.** A rotated token with an old `Authorization` header in a non-Claude client config rejects every call (Claude configs are updated automatically by `tandem rotate-token`).
4. **Orphaned entry from an old install.** You uninstalled (or reinstalled differently) and the old `mcpServers.tandem` entry survived. Re-run the wizard, or remove the entry — see [data-locations.md](data-locations.md) for every place Tandem writes config and the `tandem --uninstall-scrub` command that cleans them.

`tandem doctor` (or **Settings → About → Copy Diagnostics**) distinguishes 1 from 2–4: if the health checks pass but tool calls still fail, the problem is on the config side.

## Port already in use

Tandem kills stale processes on `:3478` / `:3479` at startup. If another application owns those ports and won't yield, set alternate ports:

```bash
export TANDEM_PORT=4478
export TANDEM_MCP_PORT=4479
export TANDEM_URL=http://127.0.0.1:4479
tandem
```

All three need to match — `TANDEM_URL` is what the channel shim and MCP clients connect to.

If bind still fails after the timeout, the server logs `port {port} still not available after {timeoutMs}ms` and exits. Identify the holding process with `lsof -i :3479` (macOS/Linux) or `netstat -ano | findstr :3479` (Windows).

## Channel shim fails to start

The `tandem-channel` entry spawns a subprocess. Most failures fall into two buckets:

- **`MODULE_NOT_FOUND`** with a production config (`node dist/channel/index.js`): the bundled channel shim is missing. For global installs, re-run `tandem setup` after upgrading; absolute paths get rewritten to the current install. For source checkouts using a production-style config, run `npm run build`. The default dev config uses `npx tsx` and skips the build step entirely.
- **Timeouts** in the shim output:
  - `/api/events timed out after 10000ms` — initial SSE handshake never completed.
  - `SSE inactivity timeout` — connection accepted, then the server stopped sending events.
  - `/api/channel-reply timed out after 5000ms` — reply path stalled.

  All three mean the server accepted the connection but stopped responding on that path. Restart Tandem; the shim reports the timeout instead of hanging silently.

## Editor shows "Cannot reach the Tandem server"

The editor connects to the Hocuspocus WebSocket on `:3478`. If the message appears, the server isn't running or isn't reachable:

- Desktop app: relaunch (the sidecar may have crashed; check the system tray or activity monitor).
- npm install: run `tandem` in a terminal and watch for startup errors on stderr.
- Source checkout: `npm run dev:standalone` (or `npm run dev:server` if you want backend only).

The banner appears after 3 seconds of failed connection, so it's a real failure — not a transient retry.

## Empty editor with no document

On first run, `sample/welcome.md` auto-opens. On upgrades, `CHANGELOG.md` opens (read-only). If you've cleared session state, deleted the sample file, or set `TANDEM_NO_SAMPLE=1`, the editor starts empty.

Click the **+** in the tab bar, drop a file onto the editor, or ask your AI to open one (`"open notes.md in tandem"`).

## Reset session state

Sessions live in `{APP_DATA_DIR}/sessions/`, with one file per opened document plus a `CTRL_ROOM.json` for cross-document state (chat history, Solo/Tandem mode). To find the directory per OS:

| OS | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\tandem\Data\sessions\` |
| macOS | `~/Library/Application Support/tandem/sessions/` |
| Linux | `$XDG_DATA_HOME/tandem/sessions/` (defaults to `~/.local/share/tandem/sessions/`) |

To reset all session state cleanly:

1. Quit Tandem (close the desktop app or stop the `tandem` process).
2. Delete the `sessions/` directory.
3. Restart Tandem.

To reset only chat history without losing per-document state, delete just `CTRL_ROOM.json`.

Durable annotations live in a separate `annotations/` directory alongside `sessions/`. Corrupted annotation files are quarantined automatically (renamed to `.corrupt.json`) instead of being deleted, so you can recover them by hand if needed.

## Recovering a previous version of a document

Before Tandem's **first** write to a `.md`/`.txt`/`.docx` file in a server run, it copies the file's current on-disk bytes to a backup folder (for `.docx` this is a verbatim, byte-identical copy of the ZIP). If a save ever mangles your file — especially a `.docx`, where exporting can drop Word features Tandem doesn't model — or you just want yesterday's version back, there are three ways to restore:

- **In the app:** open the command palette (Ctrl+Shift+P) and run "Restore a backup of this document…" — it lists the available snapshots and restores the most recent one. The document reloads in place; annotations are preserved.
- **Ask Claude:** the `tandem_restoreBackup` MCP tool lists a document's snapshots (call it without `backup`) and restores any of them by name — including older snapshots the palette action doesn't reach.
- **By hand:** with any file manager, no Tandem needed — see below.

Backups live in `{APP_DATA_DIR}/doc-backups/` (sibling of `sessions/` — same per-OS table as above). Each document gets a subfolder named by a hash of its path, containing:

- up to 3 timestamped copies, e.g. `thesis-20260609-141500-ab12cd34.md` (newest wins), and
- a `source.txt` recording the original file's full path.

To restore by hand: find the right subfolder (check `source.txt`, or sort by date and look at the filenames), then copy the snapshot over your document. Quit Tandem first — or close the document's tab — so the restored bytes aren't overwritten by an autosave of the old in-memory content. (The in-product paths above handle this for you: they reload the open document from the restored bytes, so no quit is needed.)

Notes:

- Backups are taken once per document per server run, and skipped when nothing changed since the newest backup — so the folder stays small.
- Snapshots older than 30 days are cleaned up automatically at startup, and the whole folder is capped at 500 MB (backups pause with a notification if it fills).
- `.docx` files get the same pre-overwrite snapshots as text (verbatim byte-identical copies of the ZIP) and are additionally never auto-saved — only explicit saves overwrite them. `tandem_applyChanges` also writes a `.backup.docx` sidecar next to the original, used as a fallback when no snapshot exists yet.

## Reading server logs

Tandem writes all log output to **stderr**, never stdout. This is intentional: when the server runs in stdio MCP mode, stdout carries the MCP wire protocol — any extra writes corrupt the connection.

When troubleshooting:

- Desktop app: logs are written to a rotating `tandem.log` file — **Settings → About → Open Log Folder** opens it directly. On disk it lives under the bundle identifier: `%LOCALAPPDATA%\com.tandem.editor\logs\` (Windows), `~/Library/Logs/com.tandem.editor/` (macOS), `~/.local/share/com.tandem.editor/logs/` (Linux).
- npm install: stderr prints to the terminal where you ran `tandem`. Redirect to a file with `tandem 2> tandem.log`. (No log file exists in this mode, so the Open Log Folder button doesn't appear.)
- Source checkout: `npm run dev:server` prints to the terminal.

If you ever see what looks like a normal log line on stdout, that's a bug — file it.

## Sharing diagnostics

When [filing an issue](https://github.com/bloknayrb/tandem/issues), attach a diagnostics report:

- **In the app:** **Settings → About → Copy Diagnostics** puts a plain-text report on the clipboard — version, platform, and the result of every health check (ports, `/health`, SSE, annotation store). The endpoint behind it only answers loopback callers.
- **From a terminal:** `tandem doctor` prints the same checks (plus two dev-repo-only checks the button omits); `tandem doctor --json` emits a machine-readable report.

> **Privacy note:** the copied text contains local absolute paths (which include your username) and process IDs. Skim it before pasting into a public issue. It never contains auth tokens or document content.

## Auth rejection on LAN bind

When `TANDEM_BIND_HOST=0.0.0.0`, every non-loopback request needs a valid Bearer token. Rejections log as:

```
[tandem] auth: rejected request from <addr> (no/bad token header)
```

Check that:

1. Your client is sending `Authorization: Bearer <token>`.
2. The token matches the value in `{APP_DATA_DIR}/tandem_auth_token`.
3. You haven't rotated the token without updating the client config — `tandem rotate-token` updates Claude's configs automatically but won't touch other MCP clients.

For trusted networks during development, `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` disables the token requirement. See [security.md](security.md) for the full model.

> **Note:** Tandem writes the Bearer token into your `.mcp.json` headers. On Claude Code CLI **≥ 2.1.141**, `claude mcp get`/`list` no longer prints that token to the terminal (credential headers and URL secrets are redacted, and `${VAR}` references are no longer expanded) — so inspecting the Tandem entry is safe to share. On older CLI versions the token is echoed in plain text; redact it before pasting output anywhere.
