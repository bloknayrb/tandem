> # ⚠️ SUPERSEDED PLAN — DO NOT EXECUTE
>
> **Superseded by:** [`docs/superpowers/plans/2026-04-16-durable-annotations-cowork.md`](../2026-04-16-durable-annotations-cowork.md)
> **Superseded on:** 2026-04-16
> **Reason for archival:** This plan's Phase 0 probes were run and invalidated the core hypothesis that stdio-in-plugin was blocked by GitHub issue #26259. Probe 6 baseline (append #3 of `cowork-sync.md`, later folded into ADR-023) confirmed plugin-stdio entries DO bridge to the Cowork VM; a separate packaging bug (`workspaces` field in published tarball) was the real blocker and was fixed in tandem-editor@0.6.2. Branch (a) of this plan was implemented as PR #301 (mcp-stdio proxy) — already shipped.
>
> **Historical value:** Preserved because the Phase 0 probe methodology, decision tree, and Cowork vs Chat tab differentiation remain useful context. Do NOT use as active guidance — the premises (HTTP-only surface, stdio blocked) are out of date.

---

# Plan: Make Tandem MCP reachable from Claude Desktop (Cowork + Chat)

> **Status (2026-04-14):** Plan approved. **Phase 0 probes not yet executed** — full runbook handed to Bryan at end of session. Pick up tomorrow by collecting Probe 1–6 results, then selecting the branch in the decision tree below.
>
> **Probe runbook location:** in the preceding Claude Code conversation. Key pieces to re-hand if lost: (a) add `{"probe-everything": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"]}}` to `%APPDATA%\Claude\claude_desktop_config.json`, (b) fully restart Desktop (`taskkill /F /IM Claude.exe` then relaunch — tray icon matters), (c) curl `host.docker.internal` / `host.internal` / `gateway.internal` / `10.0.2.2` / `192.168.65.2` from inside Cowork, (d) try marketplace install of `bloknayrb/tandem`.
>
> **On resuming:** read probe results, pick the branch, dispatch implementation subagents per the "Execution model" section below. Mirror `src/channel/index.ts` for the proxy. Live `claude_desktop_config.json` is at `C:\Users\blokn\AppData\Roaming\Claude\claude_desktop_config.json`; back it up before experimenting.

## Context

Users report Claude Desktop's **Cowork** tab (and likely its **Chat** tab) can't see any `tandem_*` tools after running `tandem setup`. Tandem currently registers in `claude_desktop_config.json` as:

```json
"tandem": { "type": "http", "url": "http://localhost:3479/mcp" }
```

Regular Claude Code (CLI, reads `~/.claude.json`) works fine because it runs on the host.

**What we know with high confidence (from Anthropic support docs):**

- Cowork "Runs code and shell commands in an isolated virtual machine (VM) on your computer" — <https://support.claude.com/en/articles/13345190>
- Anthropic's Remote MCP article states: *"Local MCP servers configured in Claude Desktop via&#x20;****claude\_desktop\_config.json****&#x20;are a separate mechanism and do use your local network, but those aren't available in Cowork or claude.ai."* — <https://support.claude.com/en/articles/11175166>
- The officially sanctioned Cowork path for third-party tools is the **remote MCP connector** (public-internet URL reachable from Anthropic IP ranges).

**What we believed but can't verify from primary sources:**

- A DEV.to blog post claims Claude Desktop's SDK layer auto-bridges stdio entries from `claude_desktop_config.json` into the Cowork VM (spawn on host, proxy into VM). This claim is **not** in any support.claude.com article I could find and is **directly contradicted** by the Remote MCP quote above.

So the design must not bake in the "stdio auto-bridges" assumption. It has to be proven before we ship code around it.

**Goal.** After `tandem setup`, tandem's MCP tools are visible in at least Claude Code (already works) and Claude Desktop Cowork (currently broken). Chat tab is a stretch goal once we know what it honors.

## Phase 0 — Empirical verification (before any code)

Do all of this with the current tandem install and **no code changes**, one sitting, <1 hour:

1. **Probe 1 — does stdio bridge into Cowork?** Hand-edit `%APPDATA%\Claude\claude_desktop_config.json` to add a minimal stdio echo MCP server (`@modelcontextprotocol/server-everything` via `npx -y`). Restart Claude Desktop fully (taskkill the tray process), open Cowork, ask "list every MCP tool you have available" — does it list the probe server's tools (`echo`, `add`, `printEnv`, etc.)?
2. **Probe 2 — does HTTP fail differently?** With the existing `{"type":"http","url":"http://localhost:3479/mcp"}` and tandem running, ask Cowork for `tandem_*` tools. Absent = HTTP unreachable in Cowork (matches assumption).
3. **Probe 3 — Chat tab parity.** Repeat 1 + 2 in the Chat tab. Baseline expectation: Chat sees both. If not, something is broken at the config level — redo from step 0.
4. **Probe 4 — host-from-VM hostname.** In a Cowork session, paste:
   ```bash
   curl -v --max-time 5 http://host.docker.internal:3479/health
   curl -v --max-time 5 http://host.internal:3479/health
   curl -v --max-time 5 http://gateway.internal:3479/health
   curl -v --max-time 5 http://10.0.2.2:3479/health
   curl -v --max-time 5 http://192.168.65.2:3479/health
   ip route
   cat /etc/resolv.conf
   getent hosts host.docker.internal
   hostname
   uname -a
   ```
   Any `HTTP/1.1 200 OK` turns this plan into a docs-only fix.
5. **Probe 5 — Desktop logs.** `Get-ChildItem "$env:APPDATA\Claude\logs\"` (directory does not exist on Bryan's machine as of 2026-04-14). If it appears after Probes 1–3, grep `mcp.log` for `probe-everything|tandem|skip|bridge|spawn` to corroborate.
6. **Probe 6 — marketplace plugin install workaround.** In Claude Desktop Cowork, open **Settings → Plugins → Add marketplace**, paste `bloknayrb/tandem`, Sync, install. Restart Desktop. With tandem running, ask Cowork for `tandem_*` tools. If visible, we have a zero-code fix — just document the install flow. Tandem already publishes the plugin manifest at `.claude-plugin/plugin.json`.

**Decision tree after Phase 0:**

**Do not skip Phase 0.** The rest of the plan assumes branch (a) because that's what the community evidence suggests, but we explicitly branch if the probes say otherwise.

## Solution (assuming Phase 0 confirms branch (a) — stdio-bridge works)

Ship a **stdio → HTTP proxy** as a first-class tandem subcommand (`tandem mcp-stdio`). Claude Desktop spawns it on the host via its SDK bridge; the proxy speaks MCP stdio upstream and forwards every call to the running tandem HTTP server at `http://localhost:3479/mcp`. The HTTP entry in `~/.claude.json` (Claude Code) is retained — faster, native, no subprocess.

Design choices (validated and refined by code-review and plan-review agents):

- **Built-in proxy, not npx supergateway.** Same binary the user already installed; no network dependency at launch; no third-party bug-report deflection; Windows `npx` GUI-spawn PATH issues avoided.
- **process.execPath**\*\* + absolute CLI path, not bare **"tandem"**.\*\* Mirrors the existing `tandem-channel` shim pattern in `src/cli/setup.ts:47-51`. Avoids PATH failures when `tandem setup` was invoked via `npx` or in macOS GUI-launch contexts where login-shell PATH is not inherited.
- **Preflight reachability check** — copy the `checkServerReachable()` pattern from `src/channel/index.ts:29-56` (duplicate is cheap; no cross-module extraction).
- **Per-request forwarding, never caching.** On every `ListTools`/`CallTool`/etc. from Claude Desktop, call through to the HTTP client at request time. The proxy holds a long-lived client but does *not* snapshot tool schemas at startup.
- **Bidirectional notification relay.** Forward `notifications/cancelled` upstream (stdio → HTTP client) and downstream. Without this, aborted long-running tools (e.g., `tandem_save` on a large `.docx`) silently hang in Desktop while the HTTP call runs to completion.
- **Crash-on-disconnect, not reconnect.** Wire `transport.onerror` (SDK default is `maxRetries: 2` before firing `onerror`) to `process.exit(1)` so Desktop respawns the stdio child. Matches the channel-shim preflight behavior and avoids half-alive proxy state.
- **MCPB desktop extension is not the right tool.** MCPB bundles a server that runs inside Desktop's process space; it still needs a loopback to tandem's host HTTP server, so it doesn't solve connectivity. Defer to roadmap.
- **Stdio-only-everywhere is not an option.** `src/server/index.ts:229-246` shows the stdio mode is a compromise; Hocuspocus multi-client and `src/channel/index.ts` reply path both depend on the HTTP topology.

## Changes

### 1. New proxy subcommand — `src/cli/mcp-stdio-proxy.ts`

Thin MCP gateway:

- **Server side:** `Server` + `StdioServerTransport` from `@modelcontextprotocol/sdk` (already a prod dep — used by `src/channel/index.ts:13-15`).
- **Client side:** MCP `Client` + `StreamableHTTPClientTransport` targeting `${TANDEM_URL ?? "http://localhost:3479"}/mcp`.
- Before opening stdio, run a `checkServerReachable()` port probe (copy verbatim from `src/channel/index.ts:29-56`). On failure, stderr a clear "Tandem server not reachable at \<url>. Run `tandem` first." and `process.exit(1)`.
- Wire `httpClient.onerror` → `process.exit(1)` so mid-session HTTP server restarts cleanly respawn the proxy.
- **Request handlers** registered on the stdio `Server` (all call through to the HTTP `Client` at request time, no caching):
  - `ListToolsRequestSchema` → `client.listTools()`
  - `CallToolRequestSchema` → `client.callTool()`
  - `ListResourcesRequestSchema` → `client.listResources()`
  - `ReadResourceRequestSchema` → `client.readResource()`
  - `ListPromptsRequestSchema` → `client.listPrompts()`
  - `GetPromptRequestSchema` → `client.getPrompt()`
- **Notification handlers** (bidirectional):
  - Stdio → HTTP: `notifications/cancelled` (relay client abort upstream).
  - HTTP → stdio: any notifications the server pushes (progress, logging), forwarded to Desktop unchanged.
- Redirect `console.log/warn/info` → stderr (stdout is the stdio MCP wire). Same preamble as `src/channel/index.ts:20-23`.
- No Hocuspocus, no file handling, no browser — relay only.

Inspect `src/server/mcp/server.ts` and `src/server/mcp/` tool registrations during implementation to confirm nothing else (sampling, roots, experimental capabilities) needs relaying. If anything is missed, the tool appears broken only in Cowork/Desktop — add a follow-up.

### 2. CLI wiring — `src/cli/index.ts`

Add `mcp-stdio` dispatch mirroring `setup`/`start` (lazy dynamic import). It's internal plumbing; list it in `--help` briefly ("Internal: stdio→HTTP proxy used by Claude Desktop setup") so support tickets can surface it, but not in the headline usage. Because tsup uses `splitting: false` on the CLI entry and `mcp-stdio-proxy.ts` is a dynamic import, it will be inlined into `dist/cli/index.js` — no separate chunk needed.

### 3. Setup — `src/cli/setup.ts`

Split `buildMcpEntries` by target. Concrete signature change:

```ts
type TargetLabel = "Claude Code" | "Claude Desktop";

export function buildMcpEntriesForTarget(
  target: TargetLabel,
  channelPath: string,
  cliPath: string,                   // new — absolute path to dist/cli/index.js
  opts: BuildMcpEntriesOptions = {},
): McpEntries
```

- **Claude Code** (`~/.claude.json`): current HTTP entry unchanged.
- **Claude Desktop** (`claude_desktop_config.json`): stdio entry
  ```json
  "tandem": {
    "command": "<process.execPath>",
    "args": ["<absolute dist/cli/index.js>", "mcp-stdio"],
    "env": { "TANDEM_URL": "http://localhost:3479" }
  }
  ```
  Absolute CLI path from `resolve(PACKAGE_ROOT, "dist/cli/index.js")` (same constant style as `CHANNEL_DIST` in `src/cli/setup.ts:14`). Accept an `opts.nodeBinary` override like the existing `buildMcpEntries` does.

Restructure `runSetup` (`src/cli/setup.ts:225-243`): currently computes one `entries` and loops `applyConfig(t.configPath, entries)`. New loop computes target-specific entries inside the loop:

```ts
for (const t of targets) {
  const entries = buildMcpEntriesForTarget(t.label, CHANNEL_DIST, CLI_DIST, { withChannelShim });
  await applyConfig(t.configPath, entries);
}
```

Add a prereq check mirroring `validateChannelShimPrereq` at `src/cli/setup.ts:194` — refuse to write the Desktop stdio entry if `dist/cli/index.js` doesn't exist (source checkout without a build). Print the same "run `npm run build` first" remediation.

`applyConfig` already overwrites by key (`src/cli/setup.ts:168-172`), so existing users' HTTP-in-Desktop entry is cleanly replaced on re-run. No migration shim needed.

### 4. `tandem-channel` shim (in-scope)

The channel shim at `src/channel/index.ts` also connects to `http://localhost:3479`. When spawned by Claude Desktop on the host (via the SDK bridge), that HTTP call is to host localhost and works — so the shim does **not** need the proxy treatment. No changes to `src/channel/index.ts` itself. Document the distinction in README so future-us doesn't re-litigate it. If Phase 0 Probe 1 reveals stdio doesn't bridge at all, the channel shim is equally broken in Cowork and we defer to a Phase 0 fallback path.

### 5. Build config — `tsup.config.ts`

No structural change. Verify after `npm run build` that `node dist/cli/index.js mcp-stdio --help` resolves without `node_modules` lookup failures in a globally-installed shape (CLI entry is not `selfContained`, so it requires installed deps — normal npm-global install handles that).

### 6. Docs — stale-path cleanup

The following files still reference `~/.claude/mcp_settings.json` but actual code writes to `~/.claude.json` (see `src/cli/setup.ts:74`):

- `README.md:223`
- `docs/workflows.md:23`
- `docs/roadmap.md:284,290`

Fix these. **Do not** modify `docs/superpowers/plans/2026-04-01-npm-global-install.md` (15+ occurrences) or any other file under `docs/superpowers/plans/` — those are historical plan records, intentionally frozen. `CHANGELOG.md:270` is historically correct — leave it.

Add a **"Claude Desktop (Chat + Cowork) support"** section to `README.md` and `docs/architecture.md` describing the new path and the empirically-determined three-surface support matrix from Phase 0.

Bump `CHANGELOG.md` under `[Unreleased]`.

### 7. Tests — `tests/cli/setup.test.ts`

Extend existing fixture tests:

- Claude Code target → HTTP entry (unchanged).
- Claude Desktop target → `command`/`args` stdio entry, `args[1]` ends in `dist/cli/index.js`, `args[2] === "mcp-stdio"`, `env.TANDEM_URL` present.
- Prereq check: if `dist/cli/index.js` absent, `runSetup` errors like the channel-shim prereq does.
- Keep the existing "preserves non-mcpServers keys" and "backs up malformed JSON" invariants.

No E2E test for the proxy — it's an integration surface, manually verified in the Verification section. A unit test that spins a mock HTTP MCP server, runs the proxy over a pipe, and asserts a `ListTools` round-trip is gold-plating for v0; revisit if the proxy proves flaky in the wild.

## Critical files

- `src/cli/setup.ts` — target-aware `buildMcpEntriesForTarget`, CLI-path prereq check, restructured `runSetup` loop
- `src/cli/index.ts` — subcommand dispatch
- `src/cli/mcp-stdio-proxy.ts` — **new**
- `src/channel/index.ts:29-56` — pattern source (duplicate `checkServerReachable`)
- `src/server/mcp/server.ts` — reference for MCP capability surface the proxy must relay
- `tests/cli/setup.test.ts`
- `README.md`, `docs/workflows.md`, `docs/roadmap.md`, `docs/architecture.md`, `CHANGELOG.md`

## Verification

After `npm run build && npm pack && npm i -g ./tandem-editor-<v>.tgz`:

1. **Fresh setup.** `tandem setup --force` — inspect `~/.claude.json` (HTTP entry) and `%APPDATA%\Claude\claude_desktop_config.json` (stdio entry with absolute CLI path).
2. **Claude Code regression.** Start server (`tandem`), open a Claude Code session, `claude mcp list` — expect `tandem` HTTP ✓.
3. **Claude Desktop Chat.** Restart Desktop. In Chat, ask "what tandem tools do you have?" — enumerate expected or mark as limitation in README.
4. **Claude Cowork.** Switch to Cowork tab, same question. Call `tandem_getTextContent` on an open doc — verify round-trip content.
5. **Cancellation relay.** Trigger a long-running tool from Cowork, abort from Desktop, verify the HTTP server logs receive the cancellation (or the operation is interrupted mid-flight — whichever the tool surfaces).
6. **Server-restart recovery.** Kill `tandem`, invoke a Cowork tool — expect clean error surface, no hang. Restart `tandem`, retry — expect recovery (Desktop respawns the proxy on `process.exit(1)`).
7. **Unit tests.** `npm test -- setup` passes, including the three new assertions.

Record the empirical Code/Chat/Cowork support matrix in README based on what Phase 0 + steps 3–4 reveal.

## Out of scope (tracked separately)

- The `tandem-channel` entry at a stale `%LOCALAPPDATA%\Temp\tandem-setup-status-*` path in the live config is a leftover from a prior dev/test run. `tandem setup` overwrites it cleanly.
- Publishing tandem as an MCPB `.mcpb` desktop extension — different distribution story; defer.
- Public-tunnel onboarding (ngrok/cloudflared/Tailscale) — only needed if Phase 0 proves Cowork is remote-MCP-only. Decision tree handles this branch.

## Execution model

Dispatch each of the sections below to a dedicated subagent to keep the orchestrator's context clean. Independent pieces run in parallel, sequential pieces chain:

- **Phase 0 (probes 1–6)** — user-executed (requires Desktop UI + live Cowork session). Runbook already drafted; collect results, pick branch.
- **Implementation (assuming branch (a) — stdio-bridge)** — one subagent builds `src/cli/mcp-stdio-proxy.ts` + wires `src/cli/index.ts`. A second subagent restructures `src/cli/setup.ts` (`buildMcpEntriesForTarget`, CLI prereq check, `runSetup` loop). A third subagent extends `tests/cli/setup.test.ts`. These three can run in parallel on the same worktree since they touch different files; orchestrator merges findings.
- **Docs cleanup** — one subagent handles all `~/.claude/mcp_settings.json` fixes and the new Desktop-support README section in one pass.
- **Verification** — one subagent runs the seven verification steps and reports pass/fail + the empirical support matrix.
- **Code review** — one pr-review-toolkit:code-reviewer pass before opening the PR, plus a silent-failure-hunter pass focused on the proxy's error paths.

Each subagent receives a self-contained prompt with the exact files to touch, the patterns to mirror (`src/channel/index.ts` for the proxy, existing `buildMcpEntries`/`applyConfig` for setup), and the acceptance criteria from this plan. The orchestrator's job is to kick off, collect, and reconcile — not to read diff by diff.

## Risks

- **Foundational risk:** If Phase 0 Probe 1 disproves the stdio-bridge claim, the entire implementation plan above is moot and we execute branch (b), (c), or (d) in the decision tree instead. Phase 0 is non-negotiable.
- **Windows PATH/process.execPath with Volta/NVM:** `process.execPath` resolves to the version-manager shim, which usually works but has historically been fragile on Desktop GUI spawn. Mitigation: log the resolved path during `tandem setup` so support tickets can diagnose spawn failures quickly.
- **MCP SDK protocol drift:** the proxy must cover every request/notification type tandem exposes. A forgotten capability silently breaks in Cowork only. Mitigation: implementation step includes a `grep` of `setRequestHandler` across `src/server/mcp/` to enumerate.
