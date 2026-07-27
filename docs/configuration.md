# Configuration

Tandem is configured via environment variables. Defaults work for local single-user use; you only need to override these for non-default ports, LAN exposure, or alternate app-data locations.

A copy-paste template lives at [.env.example](../.env.example) in the repo root.

## Environment variables

### Ports and transport

| Variable | Default | Description |
|---|---|---|
| `TANDEM_PORT` | `3478` | Hocuspocus WebSocket port (editor ↔ server). |
| `TANDEM_MCP_PORT` | `3479` | MCP HTTP + REST API port (AI client ↔ server). |
| `TANDEM_URL` | `http://127.0.0.1:3479` | URL the channel shim and other clients use to reach the MCP HTTP endpoint. Must match `TANDEM_MCP_PORT` if you override it. |
| `TANDEM_TRANSPORT` | `http` | Transport mode. Either `http` (default; recommended) or `stdio` (the server speaks MCP over stdin/stdout — used only by the plugin-bridge subcommands). |
| `TANDEM_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout (ms) for the stdio bridge. Increase if your environment has slow loopback. |

### Startup behavior

| Variable | Default | Description |
|---|---|---|
| `TANDEM_NO_SAMPLE` | unset | Set to `1` to skip auto-opening `sample/welcome.md` on first run. |
| `TANDEM_CLAUDE_CMD` | `claude` | The Claude Code executable name, used by `tandem setup` to detect Claude Code on `PATH`. Set if you have Claude Code installed under a non-standard name. |
| `TANDEM_DISABLE_LAUNCHER` | unset | Set to `1` to disable the auto-launcher, which otherwise spawns and supervises Claude Code as a managed child process (HTTP mode only, when a `claude-code` integration is configured). Useful for running the server in isolation. |
| `TANDEM_DISABLE_FIRST_RUN_WIZARD` | unset | Set to `1` to suppress the integration setup wizard's first-run auto-open. Useful for scripted/CI setups where the wizard would otherwise appear on a fresh profile. |
| `TANDEM_OPEN_FILE` | unset | Absolute path to a file the server should open on startup. Set by the Tauri runtime when Tandem is launched via an OS file association; not intended for manual use. |
| `TANDEM_TAURI_SIDECAR` | unset | Set to `1` by the Tauri runtime when the server is running as a sidecar process. Suppresses noisy stderr logs in production builds. Not intended for manual use. |
| `TANDEM_DEFER_LAUNCHER` | unset | Set to `1` by the Tauri runtime on a start-at-login launch, so the auto-launcher holds off until you open the window. **Not the same as `TANDEM_DISABLE_LAUNCHER`:** this one is temporary and self-releasing, and it is ignored unless `TANDEM_TAURI_SIDECAR=1` (otherwise an exported var would permanently disable the launcher on the npm install, which has no way to release it). `TANDEM_DISABLE_LAUNCHER=1` outranks it. Not intended for manual use. |
| `TANDEM_DISABLE_AUTOSTART` | unset | Set to `1` to make a start-at-login launch behave like an ordinary one — the window shows and the AI launcher is not deferred. Debugging escape hatch; does not remove the OS registration (turn the setting off in Settings → Network for that). Desktop app only. |

### LAN exposure and authentication

| Variable | Default | Description |
|---|---|---|
| `TANDEM_BIND_HOST` | `127.0.0.1` | Address the server binds to. Use `0.0.0.0` to listen on all interfaces, or a specific LAN IP to bind to one interface. **See LAN exposure below.** |
| `TANDEM_AUTH_TOKEN` | auto-generated | Override the auth token. Tandem auto-generates a 32-byte base64url token on first run and stores it at `{APP_DATA_DIR}/tandem_auth_token`; this variable lets you supply an explicit value (set by Tauri; manual use is rare). |
| `TANDEM_ALLOW_UNAUTHENTICATED_LAN` | unset | Set to `1` to disable the token requirement for non-loopback requests. **Insecure** — intended for trusted-network development only. |
| `TANDEM_LAN_IP` | auto-detected | Explicit LAN IP for the welcome banner's "share this URL" message. Useful on multi-homed machines where auto-detection picks the wrong interface. |

### App-data and storage

| Variable | Default | Description |
|---|---|---|
| `TANDEM_APP_DATA_DIR` | platform default (see below) | Override the app-data root that holds sessions, the auth token, and durable annotations. |
| `TANDEM_DATA_DIR` | repo-relative | Override the project-relative data dir used to locate `sample/welcome.md`. Distinct from `TANDEM_APP_DATA_DIR`; most users don't need this. |
| `TANDEM_ANNOTATION_STORE` | unset | Set to `off` to disable durable annotation persistence (annotations then live only in session files). |

## LAN exposure

By default the server binds to `127.0.0.1` and is unreachable from other machines. To share a Tandem session on a LAN:

```bash
export TANDEM_BIND_HOST=0.0.0.0
tandem
```

On first launch in this mode, Tandem generates an auth token if one doesn't already exist and prints a connection URL like `http://192.168.1.10:3479?token=...` to stderr. Every non-loopback request must carry that token as `Authorization: Bearer <token>`.

### Rotating the token

```bash
tandem rotate-token
```

Generates a new 32-byte token, posts it to `/api/rotate-token`, and updates Claude's MCP configs. The old token remains valid for a **60-second grace window** so connected clients can pick up the new value without a disconnect. Tokens are stored with mode `0o600`, written atomically (temp file + rename), and compared in constant time against a SHA-256 hash on each request.

### Disabling auth on LAN (insecure)

```bash
export TANDEM_BIND_HOST=0.0.0.0
export TANDEM_ALLOW_UNAUTHENTICATED_LAN=1
tandem
```

This skips the token requirement entirely. Only use it on trusted networks during development — anyone who can reach the port can read and edit your documents.

See [security.md](security.md) for the full security model.

## App-data directories

Tandem stores sessions, auth tokens, and durable annotations under a per-user app-data root. The location depends on the OS:

| OS | Default |
|---|---|
| Windows | `%LOCALAPPDATA%\tandem\Data\` (e.g. `C:\Users\you\AppData\Local\tandem\Data\`) |
| macOS | `~/Library/Application Support/tandem/` |
| Linux | `$XDG_DATA_HOME/tandem/` (defaults to `~/.local/share/tandem/`) |

The contents:

| Path | Purpose |
|---|---|
| `sessions/` | One file per opened document, named by URL-encoded file path. Holds the Y.Doc snapshot and ephemeral state. |
| `sessions/CTRL_ROOM.json` | Cross-document state — chat history, Solo/Tandem mode, multi-doc UI state. |
| `annotations/` | Durable annotation store. One `.json` file per document. Corrupt files are renamed to `.corrupt.json` and quarantined instead of deleted. |
| `tandem_auth_token` | Auto-generated auth token, mode `0o600`. |
| `store.lock` | PID file for the annotation writer, used for cross-process safety. |
| `last-seen-version` | Tracks the last Tandem version to launch — drives the CHANGELOG auto-open on upgrade. |
| `autostart-seen` | Linux only, and only when start-at-login is on. Marks that at least one login launch has happened, so the first one always shows a window even if the tray icon turns out to be invisible. |

To override the root entirely:

```bash
export TANDEM_APP_DATA_DIR=/path/to/your/data
tandem
```

To clear state, quit Tandem first, then delete the relevant subdirectory. See [troubleshooting.md](troubleshooting.md#reset-session-state) for the procedure.

## Start at login (desktop app)

Settings → Network → **Start Tandem when my computer starts**. Off by default; desktop app only. The npm CLI's `tandem start` is a foreground process with no OS registration to manage.

A login launch starts **hidden in the tray** and does **not** launch your AI assistant. Claude Code is spawned the first time you open the window — [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) §2 grounds auto-launch in the user invoking Tandem, and the OS starting it at login isn't that.

**Autostart means the document server is always listening.** With it on, Tandem restores your open documents into memory at every login, serves them over Hocuspocus on `:3478`, and binds the MCP/API server on `:3479` — for as long as you're signed in, whether or not you have opened the window. Tandem trusts loopback callers: they are exempt from bearer auth, and `GET /api/document/raw` is loopback-only but unauthenticated. That trust now holds around the clock rather than only while you're at the machine. Nothing about the registration itself is privileged — `HKCU\...\Run`, `~/.config/autostart`, and `~/Library/LaunchAgents` are all user-writable.

Where the registration lives:

| OS | Location |
|---|---|
| Windows | `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, value `Tandem` (plus a matching `Explorer\StartupApproved\Run` value) |
| macOS | `~/Library/LaunchAgents/Tandem.plist` |
| Linux | `$XDG_CONFIG_HOME/autostart/Tandem.desktop` (defaults to `~/.config/autostart/`) |

**These are outside the app-data root** — deleting `TANDEM_APP_DATA_DIR` does not remove them. Turn the setting off in Settings, or delete the entry above by hand. On Windows the uninstaller removes it (but deliberately not during an upgrade).

The toggle reads the OS on every Settings open rather than caching a value, so changes you make in Task Manager → Startup, System Settings → Login Items, or `~/.config/autostart` show up correctly. If your system blocks the write, the toggle stays where it was and reports the failure instead of pretending it worked.

**Developer note:** leave this off on a machine where you run Tandem from source. `freePort` *kills* whatever holds `:3478`/`:3479` on every HTTP boot, so `npm run test:e2e`, `tandem start`, and `npm run dev:server` will all terminate an autostarted sidecar mid-edit. Set `TANDEM_DISABLE_AUTOSTART=1` to neutralize a login launch without removing the registration.
