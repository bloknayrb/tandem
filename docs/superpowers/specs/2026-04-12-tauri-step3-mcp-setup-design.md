# Design: Tauri Step 3 — MCP Setup on Every Launch

## Context

Tandem's Tauri desktop app (Steps 1-2 done) spawns a Node.js sidecar server. For Claude to use Tandem's MCP tools, the MCP config files (`~/.claude.json`, Claude Desktop config) must contain absolute paths to the bundled Node binary and channel JS file. These paths change on app updates, relocations (macOS drag to /Applications), and OS updates — so they must be validated and rewritten on every launch, not just first run.

## Scope

- Validate/rewrite MCP config paths on every launch
- Install Claude Code skill
- Show informational dialog if no Claude installations found
- **Cut from original plan:** No "Launch Claude" button (YAGNI — users click their own Claude icon)

## Architecture

```
Tauri Rust shell
  │
  ├── start_sidecar() → health check passes
  │
  └── run_setup() → POST http://localhost:3479/api/setup
        │              { nodeBinary, channelPath }
        │
        ▼
      Express server (api-routes.ts)
        │
        ├── validate nodeBinary basename (/^node(\.exe)?$/)
        ├── detectTargets()
        ├── buildMcpEntries(channelPath, nodeBinary)
        ├── applyConfig() for each target
        ├── installSkill()
        │
        └── return { targets, configured, errors, skillInstalled }
              │
              ▼
        Rust inspects response
          └── if targets.length === 0 → non-blocking dialog
```

## Server Side: `POST /api/setup`

Added to `src/server/mcp/api-routes.ts`, following the existing route pattern.

**Request:**
```json
{
  "nodeBinary": "/path/to/node-sidecar.exe",
  "channelPath": "/path/to/dist/channel/index.js"
}
```

**Validation:**
- `nodeBinary` required, string, basename must match `/^node(-sidecar)?(\.exe)?$/` — rejects arbitrary executables (security: prevents MCP config command injection by malicious localhost process)
- `channelPath` required, string

**Logic:**
1. `detectTargets()` — find Claude Code and/or Claude Desktop config paths
2. `buildMcpEntries(channelPath, nodeBinary)` — construct MCP server entries
3. `applyConfig(target.configPath, entries)` for each target — atomic JSON write
4. `installSkill()` — write `~/.claude/skills/tandem/SKILL.md`

**Response (200):**
```json
{
  "data": {
    "targets": [
      { "label": "Claude Code", "configPath": "~/.claude.json" },
      { "label": "Claude Desktop", "configPath": "..." }
    ],
    "configured": ["Claude Code"],
    "errors": [],
    "skillInstalled": true
  }
}
```

**Error cases:**
- 400 if `nodeBinary` or `channelPath` missing/invalid
- 200 with empty `targets` if no Claude installations found (not an error — informational)

## Rust Side: `run_setup()`

New async function in `src-tauri/src/lib.rs`, called after health check succeeds.

**Critical fix from review:** Must fire in BOTH sidecar paths — "just spawned" AND "already running" (dev mode early-exit). The current `start_sidecar()` returns early at the health check shortcut; setup must not be skipped.

**Path resolution:**
- **Release mode** (`!cfg!(debug_assertions)`):
  - `nodeBinary`: sidecar binary path from Tauri's resolved externalBin path
  - `channelPath`: `resource_dir().join("dist/channel/index.js")`
- **Debug mode** (`cfg!(debug_assertions)`):
  - `nodeBinary`: `"node"` (relies on PATH — acceptable for dev only)
  - `channelPath`: repo-relative `dist/channel/index.js` (from existing build output)

**Response handling:**
- Log configured targets
- If `targets` is empty: show non-blocking dialog via `tauri_plugin_dialog` — "Claude not found. Tandem works as an editor, but AI features require Claude Desktop or Claude Code. Visit anthropic.com/claude to download."
- Claude download URL hardcoded as a constant in `lib.rs`

**Failure handling:**
- If the POST fails (network error, 4xx, 5xx): log warning, do not block app startup. Setup is best-effort — the editor works fine without MCP config.

## Capability Changes

`src-tauri/capabilities/default.json`: add `"dialog:allow-message"` for the informational dialog.

## Files Touched

| File | Change |
|------|--------|
| `src/server/mcp/api-routes.ts` | New `POST /api/setup` route with validation |
| `src-tauri/src/lib.rs` | New `run_setup()` fn, call after health in both paths |
| `src-tauri/capabilities/default.json` | Add `dialog:allow-message` permission |
| `docs/tauri-plan.md` | Update Step 3 status, add sample/welcome.md copy note to Step 5 |

## Deferred to Step 5

The `sample/welcome.md` file lives in the app bundle (read-only in production). It needs to be copied to the user data dir before the server opens it. This is a build-pipeline concern — the server's existing welcome.md auto-open logic works in dev mode where the file is writable. Step 5 must handle the read-only bundle case.
