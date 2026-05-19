# Troubleshooting

Common first-launch and runtime issues, with diagnostic steps.

## Quick diagnostic

If you're running from a source checkout, `npm run doctor` checks the most common setup issues at once:

- Node.js ≥ 22 installed
- `node_modules/` present
- `.mcp.json` valid (both `tandem` and `tandem-channel` entries)
- Claude Code's `mcp_settings.json` registered (when present)
- Ports `3478` (Hocuspocus WebSocket) and `3479` (MCP HTTP) listening
- `/health` endpoint responds
- `/api/events` SSE endpoint responds with `text/event-stream`
- Annotation store readable; schema version, corruption state, lock status

For desktop-app installs, `npm run doctor` isn't available — use `curl http://127.0.0.1:3479/health` instead. A `{"status":"ok",...}` response means the server is up.

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

## Reading server logs

Tandem writes all log output to **stderr**, never stdout. This is intentional: when the server runs in stdio MCP mode, stdout carries the MCP wire protocol — any extra writes corrupt the connection.

When troubleshooting:

- Desktop app: logs appear in the system console (`Console.app` on macOS, Event Viewer on Windows, `journalctl --user` on Linux, depending on how the sidecar was launched).
- npm install: stderr prints to the terminal where you ran `tandem`. Redirect to a file with `tandem 2> tandem.log`.
- Source checkout: `npm run dev:server` prints to the terminal.

If you ever see what looks like a normal log line on stdout, that's a bug — file it.

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
