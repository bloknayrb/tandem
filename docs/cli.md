# CLI Reference

The `tandem` command is the entry point for the npm-installed Tandem package. It dispatches to a small set of subcommands. All commands log to stderr; stdout is reserved for the MCP wire protocol in stdio mode.

## Subcommands

### `tandem`

Starts the Tandem server (Hocuspocus on `:3478` + MCP HTTP on `:3479`). Browser auto-open was removed in v0.12.0 (#637) — the Tauri desktop app is the primary editor; with the npm package, open `http://127.0.0.1:3479` in your browser once the server is running. This is the command you run day-to-day after installing the npm package.

```bash
tandem
```

The server stays attached to the terminal. Press `Ctrl+C` to stop.

### `tandem setup`

Bare `tandem setup` prints setup guidance and points at the in-app integration wizard (the recommended path). `tandem setup --apply` writes Tandem's MCP entries to the integrations it detects (Claude Code and Claude Desktop) non-interactively, and installs the Claude Code skill at `~/.claude/skills/tandem/SKILL.md` (idempotent — refreshed on every run).

```bash
tandem setup            # guidance only
tandem setup --apply    # write config non-interactively
```

**Flags (with `--apply`):**

| Flag | Effect |
|---|---|
| `--force` | Write entries to default paths regardless of auto-detection. Useful if your AI client config lives at a non-standard location. |
| `--target=claude-code\|claude-desktop` | Restrict the apply to specific client(s). Repeatable. |
| `--with-channel-shim` | Also register the `tandem-channel` stdio entry, which powers Claude Code's `--dangerously-load-development-channels` real-time push. |

### `tandem doctor`

Diagnoses setup issues: Node version, `.mcp.json` / `~/.claude.json` registration, ports, `/health`, the SSE event stream, and annotation-store health. Exits `1` when any check fails. `--json` emits a single machine-readable report on stdout instead of the human-readable list.

```bash
tandem doctor
tandem doctor --json
```

The desktop app's **Settings → About → Copy Diagnostics** button runs the same checks (minus the two source-checkout-only items). See [troubleshooting.md → Sharing diagnostics](troubleshooting.md#sharing-diagnostics).

### `tandem --uninstall-scrub`

Removes every reference Tandem wrote into other programs' config: `mcpServers.tandem` / `mcpServers["tandem-channel"]` from `~/.claude.json` and any detected Claude Desktop config, the bundled skill at `~/.claude/skills/tandem/`, and (Windows) Cowork plugin registration plus the `Tandem Cowork*` firewall rules. The Windows uninstaller runs it automatically; on macOS/Linux/npm, run it yourself **before** removing the app:

```bash
tandem --uninstall-scrub
```

It never deletes your data (sessions, annotations, document backups, keychain entries) — see [data-locations.md](data-locations.md) for what stays and how to remove it manually.

### `tandem rotate-token`

Generates a new 32-byte auth token, posts it to the running server's `/api/rotate-token` endpoint, and updates Claude's MCP configs to the new value. The previous token remains valid for a **60-second grace window**.

```bash
tandem rotate-token
```

Fails if `TANDEM_AUTH_TOKEN` is set in the environment — the rotation routine refuses to overwrite an env-managed token. See [configuration.md](configuration.md#lan-exposure) for the auth token model.

### `tandem mcp-stdio`

Runs Tandem as a stdio MCP server that proxies to a local HTTP Tandem instance. Used by the Cowork plugin bridge so Claude Desktop can speak MCP over stdio to a running Tandem server.

```bash
tandem mcp-stdio
```

Not intended for direct user invocation — the plugin manifest wires it up. Reads `TANDEM_URL` to find the local server.

### `tandem channel`

Runs the Tandem channel shim as a stdio MCP server. Subscribes to `/api/events` on Tandem's behalf and re-emits the events as MCP notifications. Activated by Claude Code's `--dangerously-load-development-channels server:tandem-channel` flag.

```bash
tandem channel
```

Not intended for direct user invocation — the `tandem-channel` MCP entry (written by `tandem setup --with-channel-shim`) wires it up.

### `tandem --version` / `tandem -v`

Prints the installed Tandem version and exits.

### `tandem --help` / `tandem -h`

Prints usage and exits.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Fatal error. Stack trace logged to stderr. |

`tandem rotate-token` may exit `1` with non-fatal warnings if the running server rejected the rotation but the MCP configs were updated anyway. The stderr message describes the recovery path.

## npm run scripts (source checkouts only)

These commands are available when running Tandem from a source checkout (`git clone` + `npm install`). They aren't shipped with the npm package.

### Development

| Script | What it runs |
|---|---|
| `npm run dev:standalone` | **Recommended.** Starts the backend (`:3478` / `:3479`) and frontend (`:5173`) concurrently. |
| `npm run dev:server` | Backend only: Hocuspocus + MCP HTTP. |
| `npm run dev:client` | Frontend only: Vite dev server on `:5173`. |
| `npm run dev` | Alias for `vite` (frontend only). |
| `npm run dev:tauri` | Builds the Node sidecar and starts Tauri in dev mode (Vite hot-reload + Rust rebuild). |

### Build

| Script | What it runs |
|---|---|
| `npm run build` | Production build: typecheck, Vite client build, font-asset check, tsup server/channel/CLI bundle. |
| `npm run build:server` | tsup only — bundles server, channel, CLI to `dist/`. |
| `npm run build:tauri` | Tauri production build — produces installers. |
| `npm run check:fonts` | Validates that all referenced font assets are present. |

### Testing

| Script | What it runs |
|---|---|
| `npm test` | Vitest unit tests. |
| `npm run test:e2e` | Playwright E2E tests (auto-starts servers via `webServer` config). |
| `npm run test:e2e:ui` | Playwright UI mode for interactive E2E debugging. |
| `npm run capture:screenshots` | Re-captures README screenshots via Playwright. |

### Diagnostics and linting

| Script | What it runs |
|---|---|
| `npm run doctor` | End-to-end setup check (Node version, MCP config, server health, ports). |
| `npm run typecheck` | TypeScript + svelte-check across server and client. |
| `npm run lint` | ESLint across the repo. |
| `npm run format` | Biome auto-format. |
| `npm run check:tokens` | Scans `src/client/` for raw hex / rgba violations of the semantic-token system. |

### Audits

| Script | What it runs |
|---|---|
| `npm run audit:dead-code` | Knip dead-code report. |
| `npm run audit:origins` | Audits Y.Doc origin tagging (ADR-031) across `src/`. |
| `npm run audit:ymap-keys` | Confirms Y.Map keys come from the `shared/constants.ts` constants. |
| `npm run kg` | Knowledge-graph CLI (`neighbors`, `rules-for`, etc.). |
| `npm run kg:lint` | Validates the knowledge graph for orphan nodes, broken edges. |

### Other

| Script | What it runs |
|---|---|
| `npm run server` | Run the server directly via tsx (no watch mode). |
| `npm run start:server` | Run the bundled server (`node dist/server/index.js`). |
| `npm run channel` | Run the channel shim via tsx. |
| `npm run start:channel` | Run the bundled channel shim. |
| `npm run preview` | Vite preview of the built client. |
