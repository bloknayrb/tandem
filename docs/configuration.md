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
| `TANDEM_OPEN_FILE` | unset | Absolute path to a file the server should open on startup. Set by the Tauri runtime when Tandem is launched via an OS file association; not intended for manual use. |
| `TANDEM_TAURI_SIDECAR` | unset | Set to `1` by the Tauri runtime when the server is running as a sidecar process. Suppresses noisy stderr logs in production builds. Not intended for manual use. |

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

To override the root entirely:

```bash
export TANDEM_APP_DATA_DIR=/path/to/your/data
tandem
```

To clear state, quit Tandem first, then delete the relevant subdirectory. See [troubleshooting.md](troubleshooting.md#reset-session-state) for the procedure.
