# Plan: Durable Annotations + Frictionless Multi-Surface Setup

> **Status (2026-04-16):** Approved. Ready to implement Phase 1.
> **Roadmap issues filed:** [#313](https://github.com/bloknayrb/tandem/issues/313), [#314](https://github.com/bloknayrb/tandem/issues/314), [#315](https://github.com/bloknayrb/tandem/issues/315), [#316](https://github.com/bloknayrb/tandem/issues/316), [#317](https://github.com/bloknayrb/tandem/issues/317), [#318](https://github.com/bloknayrb/tandem/issues/318), [#319](https://github.com/bloknayrb/tandem/issues/319), [#320](https://github.com/bloknayrb/tandem/issues/320), [#321](https://github.com/bloknayrb/tandem/issues/321), [#322](https://github.com/bloknayrb/tandem/issues/322)
> **Review rounds:** 8 parallel agents across 2 rounds before approval; key findings incorporated (see "Evidence backing" table and "Critical Architectural Decisions" section).
> **Supersedes:** the 2026-04-14 Cowork MCP bridge plan (refuted by [GitHub anthropics/claude-code#26259](https://github.com/anthropics/claude-code/issues/26259) — bundled-stdio-binary-as-MCP approach is blocked by Cowork VM's plugin-config filter).

## Context

**Problem.** Tandem today keeps annotations in in-memory Y.Map with a Hocuspocus session-blob backup. Two consequences:

1. **Annotations are fragile.** A server crash mid-session can lose annotations. No portability — inspecting, moving, or exporting annotations requires the server running.
2. **Only host-reachable MCP works.** Claude Code CLI (primary use case) and main Claude Desktop Chat work via HTTP on `127.0.0.1:3479`. Cowork VMs cannot reach host loopback.

**Audience correction.** Tandem's primary users are non-technical document editors, not developers. The plan owner's personal primary use is Claude Code. So the plan must:
- Keep Claude Code working with zero regressions for existing users.
- Not assume git, workspace files under version control, or CLI/shell competence from end users.
- Enable "install the Tauri desktop app → everything works" as the goal for non-technical users.

**Evidence backing key claims** (verified by four review agents over three rounds):

| Claim | Evidence |
|---|---|
| Cowork VM strips non-HTTPS MCP entries from plugin.json | [GitHub anthropics/claude-code#26259](https://github.com/anthropics/claude-code/issues/26259) |
| Cowork VM egress is open on personal accounts | Session config `egressAllowedDomains: ["*"]` at `%LOCALAPPDATA%\...\local-agent-mode-sessions\<ws>\<vm>\local_*.json` |
| Workspace bind-mounts into VM at `/sessions/<name>/mnt/<workspace-dir>` | `cowork_vm_node.log` line 2440 (verified by Cowork research agent) |
| VM reaches host LAN IP but NOT `127.0.0.1` | `host.docker.internal` resolves to `192.168.1.201` in VM, times out only because Tandem binds `127.0.0.1` |
| Anthropic's own Cowork plugins use only HTTPS MCP URLs | `%LOCALAPPDATA%\...\cowork_plugins\cache\knowledge-work-plugins\productivity\1.1.0\.mcp.json` |
| `Y.relativePositionToJSON()` serializes natively | `src/server/positions.ts:115` |
| Plan's original 31-MCP-tool count | Verified via grep across `src/server/mcp/` |
| `MCP_ORIGIN = "mcp"` lives in `src/server/events/queue.ts:33` | Verified by completeness audit — NOT in `shared/constants.ts` |
| `reattachObservers()` at `src/server/events/queue.ts:319` | Verified — new observer MUST register here to survive Hocuspocus doc swap |

**Thesis.** Two changes deliver crash-safe annotations and frictionless multi-surface setup without assuming git, workspace-mounted bridges, or bundled Linux binaries:

1. **Persist annotations to Tauri/CLI app-data** (not to the user's document folder) as durable JSON keyed by doc-hash. Y.Map becomes the realtime browser-sync cache; app-data JSON is the crash-safe source of record.
2. **Auto-configure all three Claude surfaces from the Tauri desktop app** on first launch: write HTTP MCP entries; generate a per-install auth token enforced only when binding to non-loopback; bind Tandem server to `0.0.0.0` in "Cowork mode" (opt-in, default OFF) so the VM can reach it; walk the per-workspace Cowork plugin registry and install plugin entries automatically. Claude Code / CLI users see zero regression.

---

## Critical Architectural Decisions

### Auth token: loopback-exempt, server-owned

**Decision.** Token is owned by the Tandem server, not Tauri. Generated on first boot into `env-paths` app-data. Validation is **loopback-exempt**: requests to `127.0.0.1` / `localhost` / `tauri.localhost` are trusted (matches today's behavior); only non-loopback binds require the token. This preserves Claude Code CLI behavior exactly and lets the token emerge organically when Cowork mode is enabled.

**Consequences:**
- Existing Claude Code users upgrade with zero config change.
- `tandem setup` (CLI) still works standalone — writes configs with the token so future `0.0.0.0` mode is already authenticated.
- Tauri is a *convenience layer*, not a dependency for any surface.

### Header-only auth, never query-string

Token goes in `Authorization: Bearer <token>` header. Query-string tokens leak into access logs, Claude Desktop's `cowork_vm_node.log`, and on-disk `installed_plugins.json`. If Cowork's plugin-loader HTTP client truly cannot set headers (to verify at implementation time against Anthropic's plugin.json spec), fall back to a short-lived session-exchange endpoint, not a long-lived query-string secret.

### Hocuspocus WebSocket parity

When Tandem binds to `0.0.0.0`, Hocuspocus WebSocket (port 3478) is also exposed on LAN. Current WS has only Origin-header validation (trivially spoofable by non-browsers) — no auth. **Hocuspocus MUST either:**
- Stay bound to `127.0.0.1` while only MCP goes to `0.0.0.0`, OR
- Require token in WS subprotocol or initial message.

Default implementation: **keep Hocuspocus on 127.0.0.1**. The Cowork VM doesn't need Y.Doc WebSocket access — only MCP. Browser/Tauri clients stay loopback. This is the safer default and avoids a full redesign of WS auth.

### Origin tags: where they live

`MCP_ORIGIN` already lives in `src/server/events/queue.ts:33`. Add `FILE_SYNC_ORIGIN` there alongside it — do NOT create a parallel constant in `shared/constants.ts`. Export both from `queue.ts`.

### CLAUDE.md update required

Current Critical Rule #2: "Origin-tag MCP writes. All server-side Y.Map writes must use `doc.transact(() => { ... }, 'mcp')`." Update to: *"Use `MCP_ORIGIN` for user-intent writes; use `FILE_SYNC_ORIGIN` for file-watcher echoes. The annotation file-writer observer skips `FILE_SYNC_ORIGIN` transactions; the channel event queue skips both `MCP_ORIGIN` (external consumers already saw the MCP call) and `FILE_SYNC_ORIGIN` (file reloads aren't user events)."* Update happens as part of Phase 1.

### Default-off for Cowork 0.0.0.0 mode

Binding to 0.0.0.0 exposes the port on LAN. Default state: **OFF**. Toggle lives in Tauri settings UI with a plain-language warning describing LAN exposure. Never auto-enable without explicit user action. CLI users can enable via a config file or env var.

### Feature flag for annotation store

`TANDEM_ANNOTATION_STORE=off` env var falls back to pre-plan behavior (session-blob only). Default is ON. Flag is a kill-switch for the first release; remove in the release after.

---

## Phase 1 — Durable Annotations in App Data

**Goal.** Annotations survive crashes, process restarts, and machine moves (when app-data copied). No product-surface changes; no user-visible workspace files; zero regression for Claude Code.

### Storage model
- **Location**: `env-paths` app-data dir — `%LOCALAPPDATA%\tandem\Data\annotations\` on Windows, analogous on mac/Linux. Test override via `TANDEM_APP_DATA_DIR` env var.
- **Layout**: one JSON per document, named `<doc-hash>.json`. Hash is SHA-256 of normalized absolute path (or `upload_<id>` for uploads). Matches existing `sessionKey(filePath)` semantics.
- **Rename handling**: deferred → [#313](https://github.com/bloknayrb/tandem/issues/313).

### JSON schema
```json
{
  "schemaVersion": 1,
  "docHash": "sha256:...",
  "meta": { "filePath": "...", "lastUpdated": 1744819200000 },
  "annotations": [
    {
      "id": "ann_...",
      "type": "highlight",
      "author": "claude",
      "range": { "from": 42, "to": 87 },
      "relRange": { "fromRel": {...}, "toRel": {...} },
      "content": "...",
      "status": "pending",
      "timestamp": 1744819200000,
      "editedAt": 1744819200456,
      "rev": 3,
      "textSnapshot": "..."
    }
  ],
  "tombstones": [
    { "id": "ann_...", "rev": 4, "deletedAt": 1744819200789 }
  ],
  "replies": [
    { "id": "rep_...", "annotationId": "ann_...", "author": "user", "text": "...", "timestamp": 1744819200123, "rev": 1 }
  ]
}
```

### Conflict resolution
- **Per-annotation monotonic `rev` counter**. Increments only on user-intent mutation (tools). Observer re-serializing merged state **must NOT bump rev** (otherwise rev walks upward forever on reads).
- **Explicit tombstones** — deletes live in `tombstones[]`, not absence. Absence means "never existed." Resolves the day-one data-loss bug in the original plan.
- **Merge rules on load**:
  - ID in file tombstones and alive in Y.Map: if file tombstone's `rev` > Y.Map's `rev`, remove from Y.Map. Otherwise keep.
  - ID alive in file, alive in Y.Map: higher `rev` wins. Tie-break 1: `editedAt` more recent. Tie-break 2: file wins over `null`-origin Y.Map state (browser/session-restored).
  - ID alive in file, absent from Y.Map: add to Y.Map.
  - ID absent from file, alive in Y.Map: keep in Y.Map, re-write file to include it.
- **Pre-plan migration**: annotations from session-blob lacking `rev` default to `rev: 0`. First mutation bumps to 1.

### Reentrancy guard
- Add `FILE_SYNC_ORIGIN` export to `src/server/events/queue.ts:33`.
- File-writer observer skips `FILE_SYNC_ORIGIN` transactions.
- File-watcher callback wraps Y.Map writes in `ydoc.transact(() => ..., FILE_SYNC_ORIGIN)`.
- **Channel event queue observers at `events/queue.ts:169,231` must ALSO skip `FILE_SYNC_ORIGIN`** (currently skip only `MCP_ORIGIN`). Without this, external file reloads emit spurious `annotation:*` SSE events to Claude Code.

### File-watcher suppression (fix)
- Current `suppressed: boolean` at `src/server/file-watcher.ts:13` → convert to **counter** with TTL.
- Each `suppressNextChange()` increments with a 2-second decay timer. If the expected `change` event doesn't arrive (atomic rename fires `rename` instead, per fs.watch quirks), the counter auto-decrements after TTL so it doesn't leak upward and eventually swallow legitimate external edits.
- Log `console.warn` when counter > 5 — shouldn't happen normally.
- Reset counter on `unwatchFile` / re-watch.

### Observer registration (critical)
The new file-writer observer MUST be added to `reattachObservers()` at `src/server/events/queue.ts:319`. Without this, on every Hocuspocus doc swap (happens on first browser connect per CLAUDE.md), the new Y.Map instance loses the file-writer observer and annotations silently stop persisting.

### Force-reload semantics
`tandem_open force:true` clears annotations Y.Map atomically (per CLAUDE.md). Under the plan, this must ALSO clear the JSON file (or write a tombstone sweep) — otherwise `loadAndMerge` on next open resurrects the cleared annotations.

### Word comment import (.docx)
Current `docx-comments.ts` generates import IDs as `import-{commentId}-{Date.now()}`. Reopening a .docx produces new IDs, accumulating duplicates in the JSON. **Fix**: import IDs become content-hashed: `import-sha256(commentId + originalRange + originalText).slice(0, 12)`. Dedupe on write: if an annotation with the same hashed ID exists, it's an idempotent re-import, not a new entry.

### Session blob interaction
- Session blob stays unchanged (can't selectively exclude annotations Y.Map from `Y.encodeStateAsUpdate`).
- App-data JSON is SUPPLEMENTAL. Written after every mutation; loaded on doc open AFTER session restore; merge rules apply.
- On first upgrade: session-restored annotations default to `rev:0`; observer writes one atomic snapshot (not per-annotation). Silent success for the user.

### Concurrent-writer protection
Two Tandem processes writing the same annotation file (e.g., `npm run dev:server` + Tauri desktop simultaneously) would corrupt it. **Lock strategy**:
- Primary: port 3479 bind acts as process lock — if bind fails, server exits, file-writer never starts.
- Belt-and-braces: lockfile in app-data annotations dir (`store.lock`) via `proper-lockfile` or equivalent. If another process holds it, start read-only (no file writes). Log a warning.

### Failure-mode UX
- **Disk full / permission denied**: catch write errors, emit a throttled `pushNotification` toast ("Annotation save failed — changes may not persist"). If >3 consecutive failures, disable file-writer for that doc and show a persistent banner. Don't silently lose data.
- **Malformed JSON on load**: rename `<hash>.json` → `<hash>.json.corrupt.<timestamp>`, toast the user, fall back to session-blob annotations. Keep corrupt copies for 7 days.
- **Schema version mismatch**: top-level `schemaVersion` field. Older Tandem encountering future schema: rename to `.json.future`, keep session blob as authoritative, toast. New Tandem reading older schema: migrate in place (add defaults).

### Per-doc, not global, debounce
The 100ms write-debounce queue is per-doc, not global — Claude Code often opens 3–5 docs in parallel for refactors. Cleanup on doc close.

### New modules
- `src/server/annotations/store.ts`
- `src/server/annotations/doc-hash.ts`
- `src/server/annotations/schema.ts` (with Zod + schemaVersion migration)
- `src/server/annotations/sync.ts` (observer registration + merge logic)

### Modified files
- `src/server/events/queue.ts` — export `FILE_SYNC_ORIGIN`; extend origin filters at lines 169, 231; add file-writer observer to `reattachObservers()` at line 319.
- `src/server/mcp/annotations.ts:36-41` — mutations bump `rev`; deletes write tombstones.
- `src/server/mcp/file-opener.ts` — on open, register doc-hash and call `loadAndMerge` after session restore.
- `src/server/mcp/document-service.ts` — hook into clear-and-reload path to clear JSON file too on `force:true`.
- `src/server/file-io/docx-comments.ts` — content-hashed import IDs.
- `src/server/file-watcher.ts` — counter-based `suppressed` with TTL.
- `src/server/yjs/provider.ts` — wire observer registration into doc-swap flow.
- `src/server/session/manager.ts` — hook GC on startup to clean orphaned annotation files (reuse 30-day policy, deferred to [#318](https://github.com/bloknayrb/tandem/issues/318) for full scope).
- CLAUDE.md — update Critical Rule #2; add gotchas for annotation file semantics.

### Tests
- `tests/server/annotation-store.test.ts` (new): atomic writes, schema migration, debounce coalescing, tombstone GC, corrupt-file quarantine.
- `tests/server/annotation-merge.test.ts` (new): every merge case including tombstone-vs-alive, rev ties, null-origin tie-break, pre-plan rev=0 defaults.
- Existing tests needing updates: `file-watcher.test.ts` (counter semantics), `event-queue.test.ts` (FILE_SYNC_ORIGIN filters), `docx-comments.test.ts` (dedup), `reload.test.ts` (JSON clear), plus ~15 existing annotation/session tests needing fixture-dir isolation via `TANDEM_APP_DATA_DIR`. Estimated 20–25 test files touched.

### Verification
- **Unit + integration**: as listed above.
- **Crash safety manual test**: add annotations, kill server mid-session, restart, reopen doc, confirm annotations present.
- **Claude Code regression manual**: existing `.mcp.json` in Tandem repo continues to work unchanged. No token required (loopback-exempt).
- **Observability**: `npm run doctor` extended to report annotation-dir size, per-doc last-write time, suppress-counter value, current schema version.

**Scope**: LARGE. 4 new files, 9 modified, 2 new test files + ~20 test updates. ~800 LoC new / ~400 changed. 2.5–3 weeks focused.

---

## Phase 2 — Tauri Multi-Surface Auto-Setup

**Goal.** Install Tauri → main Chat, Claude Code CLI, Cowork all configured automatically. Claude Code users who don't install Tauri are unaffected.

### Token storage
- **Server owns token generation**: on first boot, if no token exists, generate 32-byte base64url random, store to OS keychain (Windows DPAPI / Credential Manager, macOS Keychain, Linux Secret Service) via the Rust `keyring` crate. Fallback to `env-paths` app-data with file permissions locked to the user (`0600` on POSIX) if keychain unavailable. Never write to a directory synced by OneDrive/iCloud/Time Machine.
- **`tandem setup` CLI**: reads the token from the same keychain / fallback file, writes it into `.mcp.json` / `claude_desktop_config.json` as an `Authorization: Bearer <token>` header entry in the MCP config.
- **Token comparison**: `crypto.timingSafeEqual` with length-padding.
- **Rotation**: `tandem rotate-token` CLI subcommand regenerates; re-runs setup across known configs. User-created `.mcp.json` files outside setup's knowledge must be re-run manually (documented).

### Network bind mode
- **Default**: `127.0.0.1`-only. Loopback-exempt auth (token optional on loopback). Zero behavior change from today.
- **Cowork mode (opt-in)**: binds MCP to `0.0.0.0:3479`; Hocuspocus WebSocket stays `127.0.0.1:3478` (Cowork VM doesn't need WS). All non-loopback requests require the token via header. Host-header allowlist: `127.0.0.1`, `localhost`, `tauri.localhost`, the specific LAN IP resolved at bind time. Reject others.
- **CORS stays strict** under Cowork mode — same `http://localhost:*` reflection policy. Cowork VM isn't a browser; CORS doesn't affect it. Same-LAN browser attackers stay CORS-blocked.
- **`/health` exempt from auth** so Playwright webServer checks pass on CI. `/health` returns version+ok only, no state; LAN fingerprint risk accepted.
- **Rate-limit auth failures** per source IP (token-bucket: 5 failures/min, then 429 with backoff). Log failures.

### Firewall scoping (Windows)
On install/Cowork-toggle-on, run `netsh advfirewall firewall add rule name="Tandem Cowork" dir=in action=allow protocol=TCP localport=3479 remoteip=<detected-vm-subnet>`. The VM subnet is Hyper-V default `172.16.0.0/12` or the vEthernet adapter's detected subnet. Without scoping, the port is reachable from every LAN device. macOS/Linux equivalents → [#317](https://github.com/bloknayrb/tandem/issues/317).

### Three-surface auto-configuration

**Main Chat**: Tauri calls the exported setup logic from `src/cli/setup.ts` to write to `claude_desktop_config.json` with `Authorization: Bearer <token>` in the MCP entry's auth config. Read-modify-write of the config JSON (preserve other users' entries).

**Claude Code CLI**: same mechanism for `~/.claude.json` (or per-project `.mcp.json` if already present). `tandem setup` CLI remains the primary path for standalone CLI users.

**Cowork (per-workspace)**: Tauri walks `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\local-agent-mode-sessions\<ws>\<vm>\` on launch AND uses the Rust `notify` crate to watch for new workspace directories. Cowork installer:
1. **Read-modify-write** each `cowork_plugins/installed_plugins.json` — merge Tandem entry by id, preserve other plugins. Lock during write.
2. Same pattern for `known_marketplaces.json`.
3. Write plugin manifest to `cowork_plugins/cache/tandem/tandem/<version>/` (idempotent).
4. Update `cowork_settings.json`'s `enabledPlugins` map to include `tandem@tandem`.
5. Plugin MCP entry:
```json
{
  "mcpServers": {
    "tandem": {
      "type": "http",
      "url": "http://<HOST-LAN-IP>:3479/mcp"
    }
  }
}
```
Token delivered via header: the plugin.json `http` type must support `headers`. **Verification required at implementation time** against Anthropic's plugin.json spec. If not supported, fall back to Phase 2.1 (TBD — session-exchange endpoint or tunnel).

**Failure modes**:
- Claude Desktop not installed → skip Cowork setup, log info.
- `local-agent-mode-sessions/` absent → watch parent `Claude\` dir for its creation.
- `installed_plugins.json` locked by Claude Desktop → retry with exponential backoff; toast if still failing after 30s.
- LAN IP changes (DHCP) → re-run setup on every Tauri launch; existing VM sessions pick up new URL on next plugin reload.

**Windows-only cfg-gate.** Phase 2's Cowork installer is Windows-first (Bryan's primary). `#[cfg(target_os = "windows")]` gating. macOS/Linux Cowork support → [#316](https://github.com/bloknayrb/tandem/issues/316).

### Uninstall cleanup
- NSIS uninstaller (Windows) runs a scrubbing step: removes Tandem's entries from `cowork_plugins/installed_plugins.json`, `known_marketplaces.json`, `cowork_settings.json` in every workspace, plus `claude_desktop_config.json` and `~/.claude.json` MCP entries. Does NOT remove annotation app-data (user may reinstall).
- macOS/Linux uninstall is user-manual; provide a `tandem uninstall-integrations` subcommand.

### Trust requirement UX
Cowork workspaces only load plugins from "trusted" workspaces (set in Claude Desktop UI). Tauri onboarding includes a "Enable Tandem in Cowork" step with screenshots + a status check that detects whether Tandem's plugin loaded successfully in the most recent Cowork session.

### New modules
- `src-tauri/src/mcp_setup.rs`
- `src-tauri/src/cowork_installer.rs` (cfg-gated Windows-only)
- `src-tauri/src/token_store.rs` (keyring wrapper)
- `src/server/auth.ts` (middleware, constant-time compare)
- `src/cli/rotate-token.ts`

### Modified files
- `src/cli/setup.ts` — read token from keychain; write as header; export core logic for Tauri.
- `src/server/index.ts` — bind mode selection; load token from keychain on boot (generate if missing).
- `src/server/mcp/server.ts` — extend `apiMiddleware` for Cowork Host-header allowlist; exempt `/health`; attach auth middleware to `/mcp` + `/api/*` (not to `/health`).
- `src/server/mcp/api-routes.ts` — channel shim passes token via in-process env var.
- `src-tauri/src/lib.rs` — register new commands, hook first-launch auto-setup.
- `src-tauri/tauri.conf.json` — no CSP change needed; capability additions for `local-agent-mode-sessions/` access.
- `src-tauri/capabilities/default.json` — Windows-gated capabilities.
- Tauri UI — settings panel with "Enable in Cowork" toggle, setup-status display, security warning modal.

### Verification
- **Unit (Rust)**: Cowork installer writes correct JSON; token generation/persistence roundtrip via keychain + fallback file; LAN IP discovery.
- **Integration**: fresh Windows profile launches Tauri, confirms main Chat + CLI configs written; opts into Cowork, confirms plugin entries appear in at least one workspace and auth header works.
- **Manual Cowork probe**: install Tauri app on a new VM, start Cowork session, confirm `tandem_*` tools surface, call `tandem_highlight`, observe host UI reflect it.
- **Security manual**: with Cowork mode on, attempt to hit `http://<host-ip>:3479/mcp` from another LAN machine WITHOUT the token — confirm 401 with constant-time behavior; confirm rate-limit kicks in.
- **Claude Code regression manual**: existing `.mcp.json` in Tandem repo continues to work (loopback-exempt auth).

**Scope**: LARGE. 5 new files (3 Rust, 2 TypeScript), 8 modified across TS + Rust + Tauri config + UI. ~1400 LoC new / ~400 changed. 3–4 weeks focused, including Cowork manual verification.

---

## Claude Code Compatibility Guarantees

Explicit commitments for the plan owner's primary surface:

1. **No mandatory token on loopback.** Existing `.mcp.json` / `~/.claude.json` entries work unchanged. First run after upgrade: same behavior as today.
2. **`tandem setup` still works standalone.** Does not require Tauri. Writes token-less entries if server is pre-token-generation (loopback-exempt).
3. **`tandem mcp-stdio` still forwards to HTTP** unchanged, and preflight continues to pass when server is on loopback.
4. **No latency regression for rapid tool bursts.** Per-doc debounced writes (100ms) coalesce; file-watcher suppress counter prevents echo spurts. Added overhead per mutation: one observer fire + one queued file-write. Target: under 5ms added per tool call (measured).
5. **Multi-doc concurrent work unaffected.** Per-doc store granularity; no global locks.
6. **Channel events (SSE) for Claude Code** do not double-fire. `FILE_SYNC_ORIGIN` filtered in `queue.ts`.
7. **Feature-flag escape hatch.** `TANDEM_ANNOTATION_STORE=off` reverts to pre-plan behavior.
8. **Existing `.mcp.json` in Tandem's own repo** continues to work through both phases — Bryan's own dev loop is a first-class test case.

---

## Critical Files

**Must-modify:**
- `src/server/events/queue.ts` (origin tags, filter extensions, reattach observer)
- `src/server/mcp/annotations.ts`
- `src/server/mcp/file-opener.ts`
- `src/server/mcp/document-service.ts`
- `src/server/mcp/server.ts`
- `src/server/mcp/api-routes.ts`
- `src/server/file-watcher.ts`
- `src/server/file-io/docx-comments.ts`
- `src/server/yjs/provider.ts`
- `src/server/session/manager.ts`
- `src/server/index.ts`
- `src/cli/setup.ts`
- `src/cli/mcp-stdio.ts` (forward header auth when tokened)
- `src-tauri/src/lib.rs`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`
- `CLAUDE.md`
- `playwright.config.ts` (token-aware webServer if needed)

**Must-create:**
- `src/server/annotations/{store,doc-hash,schema,sync}.ts`
- `src/server/auth.ts`
- `src/cli/rotate-token.ts`
- `src-tauri/src/{mcp_setup,cowork_installer,token_store}.rs`

## Existing Utilities to Reuse
- `atomicWrite` — `src/server/session/manager.ts:17`, `src/server/file-io/index.ts:86-89`
- `refreshRange` / `refreshAllRanges` — `src/server/positions.ts:282-345`
- `Y.relativePositionToJSON()` — `src/server/positions.ts:115`
- `sessionKey(filePath)` pattern — `src/server/session/manager.ts`
- `reattachObservers()` — `src/server/events/queue.ts:319`
- `apiMiddleware` + `LOCALHOST_ORIGIN_RE` — `src/server/mcp/server.ts`
- `onDocSwapped` hook — `src/server/yjs/provider.ts`
- `strip_win_prefix()` — `src-tauri/src/lib.rs`
- `env-paths` — already a dependency
- `pushNotification` — `src/client/hooks/useNotifications.ts`
- Existing Hocuspocus `setup.ts` auto-detection logic — extract core function

## Test Impact
- **New test files**: 2 (`annotation-store.test.ts`, `annotation-merge.test.ts`)
- **Existing tests updated**: ~20–25 (file-watcher counter semantics, event-queue origin filters, docx-comments dedup, reload.test, session-restore, ~15 annotation tests needing `TANDEM_APP_DATA_DIR` fixture isolation, auth middleware tests, E2E webServer health exemption)
- **Playwright webServer**: `/health` exempt from auth avoids CI breakage.

---

## Rollout Strategy

- **Phase 1 release**: `TANDEM_ANNOTATION_STORE` env var ON by default; provide opt-out. Ship with crash-safety manual test + Claude Code regression matrix documented in release notes. Remove flag in the following release.
- **Phase 2 release**: Cowork mode ships OFF by default. Users opt in via Tauri settings or CLI env var. CLI users who never enable it see zero change.
- **Rotation**: bump Tandem version; publish npm + Tauri installer simultaneously (existing pipeline).
- **Monitoring**: extend `npm run doctor` to report new health signals (annotation dir size, counter state, schema version, last-write times). Users submitting support reports get a standard `doctor` output to paste.

---

## Deferred Roadmap Items (GitHub Issues)

All items scoped OUT of this plan have been filed as issues on bloknayrb/tandem:

- [#313](https://github.com/bloknayrb/tandem/issues/313) — Content-hash annotation identity for rename tracking (medium priority)
- [#314](https://github.com/bloknayrb/tandem/issues/314) — Export annotations as sharable file next to document (medium)
- [#315](https://github.com/bloknayrb/tandem/issues/315) — Extract DocumentStore interface for tool logic (low)
- [#316](https://github.com/bloknayrb/tandem/issues/316) — macOS and Linux Cowork auto-setup support (medium)
- [#317](https://github.com/bloknayrb/tandem/issues/317) — OS-specific firewall rule scoping for Cowork mode (medium)
- [#318](https://github.com/bloknayrb/tandem/issues/318) — Tombstone and abandoned-file garbage collection (low)
- [#319](https://github.com/bloknayrb/tandem/issues/319) — Structured diagnostics dashboard (low)
- [#320](https://github.com/bloknayrb/tandem/issues/320) — Annotation schema v1→v2 migration framework (low)
- [#321](https://github.com/bloknayrb/tandem/issues/321) — Hocuspocus WebSocket LAN auth (low until needed)
- [#322](https://github.com/bloknayrb/tandem/issues/322) — Network-type detection for Cowork mode warning (medium)

---

## Risks

- **LAN exposure in Cowork mode.** Mitigations: default OFF, opt-in warning, token mandatory for non-loopback, firewall-rule scoping (Windows), rate-limiting, Hocuspocus stays loopback.
- **Token leakage.** Header-only (never query-string), OS keychain storage, exclude from backup-syncing dirs, rotate subcommand, audit Claude Desktop logs for URL logging during implementation.
- **Observer reattachment silent failure.** Mitigated by explicit `reattachObservers()` update + integration test covering browser-swap + annotation persist.
- **Pre-plan upgrade first-run.** Mitigated by rev=0 default migration, explicit merge rules for null-origin state, feature flag kill-switch.
- **`installed_plugins.json` conflicts with Claude Desktop writes.** Mitigated by read-modify-write with file lock + exponential backoff + user toast on persistent failure.
- **Cross-platform Phase 2.** Windows-only in this plan; mac/Linux tracked as issues. Risk of user expecting Cowork to work on Mac — mitigated by in-UI OS-detection and clear messaging.
- **Anthropic plugin.json `http`-type `headers` field support.** Needs verification at implementation time. If unsupported, Phase 2's token delivery falls back to a session-exchange endpoint — design sketch before committing full Phase 2.
- **Hocuspocus doc-swap race** on annotation merge. Mitigated by registering merge in `onDocSwapped` callback chain.
- **Test fixture pollution of app-data.** Mitigated by `TANDEM_APP_DATA_DIR` env var override.
- **Disk full / permission denied silent loss.** Mitigated by throttled toast + persistent banner after repeated failures.
- **Malformed JSON destroys annotations.** Mitigated by quarantine pattern + session-blob fallback.
- **Schema downgrade path.** Mitigated by `schemaVersion` field + rename-to-`.future` on encountering newer schema.

---

## First Action When Resuming

Start with `src/server/events/queue.ts` — add `FILE_SYNC_ORIGIN` export, extend origin filters at lines 169+231 and the reattach hook at line 319. This is the structural prerequisite for the rest of Phase 1 (all observer registration and reentrancy prevention depends on the new origin tag). Then schema/store/doc-hash/sync modules under `src/server/annotations/`.
