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

Diagnoses setup issues: Node version and toolchain, MCP registration in `.mcp.json` / `~/.claude.json` / the Claude Desktop config, the Claude CLI and the Tandem plugin, a stale global install, ports, `/health`, the SSE event stream, and annotation-store health. Exits `1` when any check fails. `--json` emits a single machine-readable report on stdout instead of the human-readable list.

```bash
tandem doctor
tandem doctor --json
```

The desktop app's **Settings → About → Copy Diagnostics** button runs the same checks, minus the five source-checkout-only items (`node-modules`, `dev-repo`, `npm-staleness`, `mcp-json`, `orphaned-vite`) -- they read `process.cwd()`, which is arbitrary for a desktop or npm-global install. See [troubleshooting.md → Sharing diagnostics](troubleshooting.md#sharing-diagnostics).

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

Since v0.22.1 the generated `tandem` MCP entry prefers the bundled `dist/stdio-bridge/index.js` with an absolute Node path (`src/server/integrations/apply.ts`), because a bare `npx` resolves against the PATH a GUI-launched client inherits, which on macOS often contains no Node. `tandem mcp-stdio` remains the runtime behind both that path and the `npx` fallback.

### `tandem channel`

Runs the Tandem channel shim as a stdio MCP server. Subscribes to `/api/events` on Tandem's behalf and re-emits the events as MCP notifications. Activated by Claude Code's `--dangerously-load-development-channels server:tandem-channel` flag.

```bash
tandem channel
```

Not intended for direct user invocation — the `tandem-channel` MCP entry (written by `tandem setup --with-channel-shim`) wires it up.

### `tandem monitor`

Runs the Tandem plugin monitor: subscribes to `/api/events` and writes a payload-free wake line to stdout for Claude Code to surface as a notification (the event's type only — the details come from `tandem_checkInbox`). This is the flagless alternative to the channel shim — it needs no `--dangerously-load-development-channels` — under four conditions.

It **starts on first use of the Tandem skill**, not at session start: the manifest arms it with `on-skill-invoke`, so a session that never mentions Tandem never spawns it (#1354). It requires **Claude Code 2.1.212 or newer** (on older versions the plugin installs fine and the monitor simply never runs, with nothing to say so). And it must be able to resolve Node from the PATH Claude Code itself was started with: monitors are spawned through a non-login shell, so a GUI-launched Claude Code often cannot run it and reports `exit 127`. Start `claude` from a terminal.

The fourth condition is the one nobody can act on: the plugin monitor sits behind the same `tengu_amber_sentinel` remote feature gate as Claude Code's own `Monitor` tool, and that flag **defaults to false**. Both read the identical flag — see [ADR-049](decisions.md) and its 2026-08-09 amendment, plus [docs/spikes/plugin-monitor-tty-activation.md](spikes/plugin-monitor-tty-activation.md). It is not observable from Tandem's source and no `tandem doctor` check can assert it, which is why the plugin monitor cannot cover for a Claude Code that offers no `Monitor` tool. The channel shim is the fallback that can.

Neither this nor the channel shim is involved in a session Tandem auto-launches; those are woken over the supervisor's stdin ([ADR-047](decisions.md#adr-047-claude-code-push-transport-activation)).

```bash
tandem monitor
```

Not intended for direct user invocation — the plugin's `experimental.monitors[]` entry runs it as `npx -y tandem-editor@<version> monitor`. Reads `TANDEM_URL` to find the local server. Do not run this *and* the channel shim: each delivers independently, so a session with both receives every event twice.

Each line it prints is a **wake, not a report**: the event type and an instruction to call `tandem_checkInbox`, never the annotation body, chat text, document slice or filename. That matches [ADR-049](decisions.md) decision 2, which every other push path already follows — a line here becomes an unsolicited model turn, and a model that answers from a payload never polls, so the item is never marked surfaced. The full event is still read inside the monitor process to attribute the "Claude is working" indicator to a document; it just does not reach the model.

### `tandem activate <license|path>`

Activates a signed license, given either the license blob itself or a path to the `.license` file you were emailed. Writes `license.json` into the app-data directory. Verification is offline — an Ed25519 signature checked against a public key baked into the build — so activation works air-gapped.

```bash
tandem activate ~/Downloads/tandem.license
tandem activate "eyJ...blob..."
```

The desktop equivalent is Settings → License. Licensing ships dark until v1.0; activating early is still worth doing, because an unactivated key is easy to lose.

### `tandem license`

Prints the current license or trial status: whether enforcement is on at all (it is off until v1.0), then either the licensee name and type plus the update window, or the days remaining on the trial. An expired update window is called out explicitly, because "Tandem keeps running but new releases are no longer offered" otherwise shows up only as the app saying you are up to date forever.

```bash
tandem license
```

### `tandem start`

Explicit alias for bare `tandem`. Identical behavior; useful in scripts and service units where an explicit verb reads better than a bare command.

```bash
tandem start
```

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
| `npm run build` | Production build: typecheck, Vite client build, font-asset check, then tsup's five bundles — `dist/server`, `dist/cli`, `dist/channel`, `dist/monitor`, `dist/stdio-bridge`. |
| `npm run build:server` | tsup only — bundles server, CLI, channel shim, monitor and the stdio bridge into `dist/`. A missing `dist/stdio-bridge/` is not a build error: the generated `tandem` MCP entry silently falls back to bare `npx` behind a `log::warn!`. |
| `npm run build:reaper` | Builds the `tandem-reaper` sidecar. Both declared `externalBin`s must exist or `cargo tauri dev/build` fails its existence check. |
| `npm run build:tauri` | Tauri production build — produces installers. |
| `npm run check:fonts` | Validates that all referenced font assets are present. |

### Testing

| Script | What it runs |
|---|---|
| `npm test` | Vitest unit tests. |
| `npm run test:e2e` | Playwright E2E tests (auto-starts servers via `webServer` config). |
| `npm run test:e2e:ui` | Playwright UI mode for interactive E2E debugging. |
| `npm run test:tauri-driver` | WebDriver-based Tauri shell tests. |
| `npm run test:acceptance-harness` | First-use arming acceptance harness (#1393). **Not run by `npm test` or the pre-push hook** — this is its only runner. |
| `npm run capture:screenshots` | Re-captures README screenshots via Playwright. |
| `npm run capture:design-baselines` | Re-captures the design-system baseline screenshots. |

### Diagnostics and linting

| Script | What it runs |
|---|---|
| `npm run doctor` | End-to-end setup check (Node version, MCP config, server health, ports). |
| `npm run perf:gate` | Performance gate. |
| `npm run typecheck` | TypeScript + svelte-check across server and client. |
| `npm run lint` | ESLint across the repo. |
| `npm run format` | Biome auto-format. |
| `npm run check:tokens` | Scans `src/client/` for raw hex / rgba violations of the semantic-token system. |
| `npm run check:links` | Resolves every relative Markdown link and `#anchor` in the repo. Run it before and after moving any doc — a moved file with a dangling inbound link is worse than one left where it was. |

### Audits

| Script | What it runs |
|---|---|
| `npm run audit:dead-code` | Knip dead-code report. |
| `npm run audit:origins` | Audits Y.Doc origin tagging (ADR-031) across `src/`. |
| `npm run audit:ymap-keys` | Confirms Y.Map keys come from the `shared/constants.ts` constants. |

### Other

| Script | What it runs |
|---|---|
| `npm run server` | Run the server directly via tsx (no watch mode). |
| `npm run start:server` | Run the bundled server (`node dist/server/index.js`). |
| `npm run channel` | Run the channel shim via tsx. |
| `npm run start:channel` | Run the bundled channel shim. |
| `npm run preview` | Vite preview of the built client. |
