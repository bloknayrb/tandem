# Tandem -- Collaborative AI-Human Document Editor

> **Scope of this file:** Claude Code project memory for contributors working on Tandem. Read by Claude when collaborating on this codebase. User-facing positioning and the MCP-first integration policy live in `README.md`, `docs/positioning.md`, and [ADR-038](docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration). Tandem's integration contract is MCP; Claude is the default integration. This file is intentionally Claude-Code-specific because it IS Claude project memory — that's by design, not the product's positioning. Non-Claude agents (Codex, etc.) read the leaner `AGENTS.md` at the repo root; this file remains the authoritative, in-depth project memory.

## Quick Reference
- `npm run dev:server` -- Backend: Hocuspocus on :3478 + MCP HTTP on :3479
- `npm run dev:client` -- Frontend: Vite on :5173
- `npm run dev:standalone` -- Both frontend + backend (via concurrently)
- `npm run dev` -- Alias for `vite` (frontend only)
- `npm run build` -- Production build: typecheck + vite build + tsup -> `dist/server/`, `dist/channel/`, `dist/cli/`, `dist/client/`
- `npm run build:server` -- Bundle server + channel + CLI via tsup only
- `npm run start:server` -- Run bundled server (`node dist/server/index.js`)
- `npm run typecheck` -- Type-check server + client without emitting
- `npm run doctor` -- Diagnose setup issues (Node version, .mcp.json, server health, ports)
- `npm test` -- Run vitest (unit tests)
- `npm run test:e2e` -- Run Playwright E2E tests (auto-starts servers via webServer config)
- `npm run test:e2e:ui` -- Playwright UI mode for interactive E2E debugging
- `npm run check:tokens` -- Scan `src/client/` for raw hex/rgba violations (also runs on pre-commit via lint-staged)
- **Start the server before connecting Claude Code.** `npm run dev:standalone` runs both. Vite hot-reloads client code; restart `dev:server` then `/mcp` in Claude Code for server changes.

## Documentation
- [MCP Tool Reference](docs/mcp-tools.md) -- All 31 MCP tools (28 active, 3 deprecated stubs) + channel API endpoints
- [Architecture](docs/architecture.md) -- Diagrams, data flows, coordinate systems, file map
- [Workflows](docs/workflows.md) -- Real-world usage patterns
- [Agent Workflow](.claude/skills/issue-pipeline/SKILL.md) -- 10-step agent-driven issue pipeline (`/issue-pipeline`)
- [Roadmap](docs/roadmap.md) -- Phase 2+ roadmap, future extensions
- [Design Decisions](docs/decisions.md) -- ADRs (001-038)
- [Lessons Learned](docs/lessons-learned.md) -- 79 lessons including E2E testing gotchas, CORS-allowlist three-surface audits, DOM-nested scroll sync for content-anchored overlays, schema-backed palette migrations, epoch-vs-value reconcile discrimination, boot-time reaping of crash-orphaned atomic-write temps, verifying shipped-state before planning, per-surface privacy gates, and freshness guards that exercise the real operation
- [Knowledge Graph](.claude/knowledge-graph/README.md) -- **PILOT (review 2026-06-01).** 25 hand-curated concept/rule/ADR nodes with cross-edges. Query via `npm run kg neighbors <id>` / `npm run kg rules-for <id-or-file>`. Validate via `npm run kg:lint`. Kill if no surprising query in two weeks.

## Development Workflow

Quality over speed. Claude is an AI — time and effort have no cost. Never abbreviate steps. The only goal is the best possible work product.

For every feature or fix: draft a plan (`/plan`), spawn adversarial agents to review the plan from multiple angles before writing any code, implement, run `/simplify`, then verify (`npm run typecheck` + `npm test`; add `npm run test:e2e` for client/integration changes), run whatever manual testing is possible (browser automation via `claude-in-chrome`, MCP probing, etc.), and prompt Bryan to complete any testing that requires human interaction before continuing. Then commit and open the PR with `/commit-commands:commit-push-pr`. After `/pr-review-toolkit:review-pr` surfaces findings, repeat: plan the fixes, adversarial agent review, implement, update PR.

**`/diverge` (pilot, kill-gate 2026-06-27).** Optional step *before* `/plan` for genuinely open-ended design problems where the right shape is not obvious. Fans out 6 frame-isolated generator agents (regulator, speedrunner, biology, on-call, deletionist, future-self), runs a dedicated critic, deepens the top survivors, then presents a picker. ~16 `Agent` calls, 60–180s. Invoke when the next artifact would be `/plan` AND there's no confident one-sentence answer AND the problem is design-shaped (not bug-shaped, not a lookup, not constrained by existing patterns). Skip otherwise. Kill criteria: delete the command if not invoked within 30 days, if "none of these — reframe" is picked more than once, or if first-use produces lexical-only divergence (i.e. the survivors are rephrasings of one canonical answer, not structurally distinct shapes).

This is a two-person project (Bryan + Claude). Scope gates are minimal — if you encounter something broken while working, fix it rather than filing it for later. For small tangential fixes, bundle them in; for larger detours, note them and finish the current task first.

## Critical Rules

These WILL break things if violated:

1. **Y.Map key strings from constants only.** Use `Y_MAP_ANNOTATIONS`, `Y_MAP_AWARENESS`, etc. from `shared/constants.ts` -- never raw string literals for Y.Map keys.
2. **Origin-tag every Y.Doc write via the wrapper helpers.** Raw `doc.transact(...)` is forbidden anywhere in `src/`; the rule is surfaced by the warn-only `check-raw-transact.sh` PostToolUse hook plus the `npm run audit:origins` static walk (no blocking pre-commit hook or Biome rule is wired). Use one of five helpers from `src/shared/origins.ts`: `withMcp` (Claude-initiated writes from MCP tools), `withFileSync` (echoes from the durable-annotation file-writer / file-watcher reload path's JSON→Y.Map merge), `withInternal` (server-internal setup writes — session restore, mdast/docx population, tutorial seeding, scratchpad seeding, force-reload, server metadata broadcasts), `withReload` (the `reloadFromDisk` file-watcher flow including the post-reload `refreshAllRanges` continuation), or `withBrowser` (user edits originating in the browser). The durable-annotation sync observer skips `file-sync` and `internal`. The channel event queue skips `mcp`, `file-sync`, `internal`, and `reload` — only `browser` writes generate channel events. Picking the wrong helper is a silent bug; the helper choice is the contract. See ADR-031.
3. **stdout is reserved.** `console.log/warn/info` all redirect to stderr in `index.ts` (defense-in-depth for stdio fallback). If you add a dependency that logs to stdout, it will corrupt the MCP wire in stdio mode.
4. **Ranges use `validateRange()` + `anchoredRange()`**, not raw offsets. `anchoredRange()` creates both flat + Yjs RelativePosition in one call.
5. **`tandem_getTextContent` uses `extractText()`, never `extractMarkdown()`.** Even for .md files. `extractMarkdown()` shifts character offsets relative to the annotation coordinate system. If you need actual markdown, use `tandem_save` and read the file.
6. **`tandem_edit` rejects heading markup ranges.** Ranges that overlap heading prefixes (e.g., `## `) return INVALID_RANGE -- target text content only.
7. **E2E tests use `data-testid` attributes** (kebab-case). Key selectors: `accept-btn`, `dismiss-btn`, `edit-btn`, `annotation-card-{id}`, `annotation-private-pill`, `annotation-select-checkbox-{id}`, `annotation-import-byline-{id}`, `batch-promote-bar`, `batch-promote-count`, `batch-promote-clear`, `batch-promote-confirm`, `tab-{id}`, `tab-format-badge-{id}`, `unsaved-indicator-{id}`, `file-open-dialog`, `file-open-browse`, `open-file-btn`, `toast-container`, `settings-popover`, `settings-display-name`, `dwell-time-slider`, `view-documentation-btn`, `view-changelog-btn`, `app-info-footer`, `left-panel-resize-handle`, `panel-resize-handle`, `cowork-settings-suspense-fallback`, `toolbar-highlight-btn`, `toolbar-highlight-color-toggle`, `color-picker-close`, `toolbar-highlight-color-{yellow|green|blue|pink}`, `popup-annotation-input`, `popup-note-submit`, `popup-comment-submit`, `popup-highlight-{yellow|green|blue|pink}`, `popup-show-formatbar-btn`, `settings-content`, `error-boundary-recover-btn`, `error-boundary-reload-btn`, `outline-panel`, `outline-heading-{level}-{index}`, `find-replace-bar`, `find-input`, `replace-input`, `find-next-btn`, `find-prev-btn`, `replace-btn`, `replace-all-btn`, `find-close-btn`, `find-match-count`, `find-regex-toggle`, `find-case-toggle`, `find-word-toggle`, `command-palette`, `palette-input`, `palette-item-{id}`, `palette-empty`, `connection-banner-retry`, `filter-bar-toggle`, `outline-search-input`, `find-scope-pills`, `find-scope-doc`, `find-scope-tabs`, `find-cross-doc-results`, `formatting-bar`, `title-bar`, `titlebar-toggle-left`, `titlebar-toggle-right`, `titlebar-theme-toggle`, `titlebar-help-btn`, `titlebar-update-available-dot`, `network-restart-sidecar`, `network-degraded-delay-slider`, `network-retry-strategy`, `network-hold-annotations-toggle`, `network-advanced`, `network-advanced-toggle`, `models-empty-state`, `model-row-{id}`, `model-add-btn`, `model-edit-btn-{id}`, `model-delete-btn-{id}`, `model-delete-confirm-{id}`, `model-toggle-{id}`, `model-edit-modal`, `model-edit-provider`, `model-edit-displayname`, `model-edit-modelid`, `model-edit-apikey`, `model-edit-apikey-replace-btn`, `model-edit-endpoint`, `model-edit-save`, `model-edit-cancel`, `model-edit-advanced`, `model-edit-advanced-toggle`, `model-default-{id}`, `titlebar-default-model`, `models-legacy-migration-banner`, `models-legacy-migrate-btn`, `models-legacy-migration-status`, `models-save-error`, `first-run-model-modal`, `first-run-providers`, `first-run-provider-{id}`, `first-run-displayname`, `first-run-modelid`, `first-run-apikey`, `first-run-endpoint`, `first-run-save`, `first-run-skip`, `first-run-skip-secondary`, `first-run-error`, `left-outline-rail`, `toolbar-link-input`, `toolbar-link-submit`, `toolbar-link-cancel`, `store-readonly-banner`, `store-readonly-dismiss`, `palette-item-new-scratchpad`, `palette-item-save-as`, `activity-pill`, `activity-tray`, `activity-empty`, `activity-clear-all`, `activity-row-{id}`, `activity-dismiss-{id}`, `activity-action-{id}`, `new-tab-search`, `new-tab-recent-{index}`, `new-tab-browse`, `new-tab-reopen-closed`, `new-tab-empty`, `new-tab-no-match`, `decorations-menu`, `decorations-mute-toggle`, `decorations-menu-caret`, `decorations-row-{authorship|comments|highlights|notes}`, `decorations-settings-link`, `appearance-show-{authorship|comments|highlights|notes}`, `appearance-show-raw-markdown`, `formatbar-hide-btn`, `appearance-formatting-bar`, `settings-modal-shortcuts-list`, `settings-shortcuts-list`, `shortcut-row-{id}`, `shortcut-edit-{id}`, `shortcut-reset-{id}`, `shortcut-recording-{id}`, `shortcut-conflict-{id}`, `shortcuts-reset-all`, `settings-modal-open-integration-wizard`, `integration-wizard`, `integration-wizard-close`, `integration-wizard-advanced`, `integration-wizard-more`, `integration-wizard-keychain-fallback`, `integration-wizard-connect-btn`, `integration-wizard-check-again`, `integration-wizard-done-close`, `integration-wizard-done-retry`, `integration-wizard-error-retry`, `integration-wizard-step-{detect|applying|done|error}`, `integration-wizard-card-{slug}`, `integration-wizard-pick-{slug}`, `integration-wizard-secret-input-{id}`, `integration-wizard-secret-submit-{id}`, `integration-wizard-apply-result-{id}`, `integration-wizard-cowork-{setup|step|back|error}`, `cowork-enable-confirm-btn`, `integration-wizard-empty`, `integration-wizard-install-claude`, `integration-wizard-install-error`, `integration-wizard-install-success`.

## Architecture

Three layers: Editor (Tiptap in Tauri desktop or browser) <-> Tandem Server (Hocuspocus on :3478 + MCP HTTP on :3479) <-> Claude Code. The desktop app is the primary distribution; npm global install opens the same editor in a browser. Channel shim (`src/channel/`) pushes real-time events to Claude Code via SSE, replacing polling.

Key files for navigation:
- `src/cli/index.ts` -- CLI entrypoint (`tandem` command), arg parsing, dispatches to start/setup
- `src/cli/setup.ts` -- `tandem setup` orchestration; auto-config helpers (`detectTargets`, `applyConfig`, `installSkill`, `buildMcpEntries`) live in `src/server/integrations/apply.ts` since #477 PR 3c-ii-a
- `src/cli/start.ts` -- `tandem start`: spawn server (browser distribution deprecated in #477 PR 2; Tauri sidecar sets `TANDEM_TAURI_SIDECAR=1`)
- `src/server/index.ts` -- Entry point, port binding, console redirect
- `src/server/open-browser.ts` -- Cross-platform browser launcher for npm-install path (execFile-based)
- `src/server/mcp/` -- Tool definitions, `api-routes.ts`, `channel-routes.ts`, `file-opener.ts`, `document-service.ts`, `routes/info.ts`
- `src/server/positions.ts` -- Server coordinate conversions (`validateRange`, `anchoredRange`, `resolveToElement`, `refreshRange`)
- `src/server/events/` -- Channel event infrastructure (Y.Map observers, SSE)
- `src/server/integrations/` -- `IntegrationConfig` schema (`schema.ts`), atomic storage (`storage.ts`), migration framework (`migrations.ts`), keychain backend (`keychain.ts`), existing-config reader (`existing-config.ts`), auto-config helpers (`apply.ts`), HTTP routes (`api-routes.ts`). Wired into the integration setup wizard (PR 3c-i) and `tandem setup` / `tandem rotate-token` via `apply.ts`.
- `src/client/` -- Tiptap editor, Svelte 5 components, `.svelte.ts` rune-based hooks, types (`types.ts`)
- `src/shared/` -- Types (`types.ts`), constants (`constants.ts`), offsets (`offsets.ts`), position types (`positions/`)

Full file-level detail: [docs/architecture.md](docs/architecture.md#file-map)

## Key Patterns
- All document mutations go through the server's Y.Doc -> changes sync to editor via Hocuspocus
- Annotations stored in Y.Map('annotations'), not in document content. `author` field: `"user" | "claude" | "import"` (import = Word comments from .docx files). Annotation types: `"highlight"` (user-only, color-coded), `"comment"` (Claude-created, may include `suggestedText`), `"note"` (personal, not surfaced to Claude). `directedAt` is deprecated and stripped on read (ADR-027).
- Three coordinate systems: flat text offsets (server, includes heading prefixes), ProseMirror positions (client, structural), Yjs RelativePositions (CRDT-anchored, survive edits). Modules: `src/server/positions.ts`, `src/client/positions.ts`, shared types in `src/shared/positions/`
- `getElementText()` returns clean plain text (no markup tags) with `\n` separators between nested block children (list items, paragraphs within list items). Embedded elements (hardBreaks) emit `\n` to preserve XmlText index alignment. `extractText()` additionally prepends heading prefixes and joins top-level elements with `\n`.
- Multi-document: each file gets a documentId (hash of path) = Hocuspocus room name. All MCP tools accept optional `documentId`, defaulting to active document. `CTRL_ROOM` is reserved -- never use as a document ID. Server broadcasts `openDocuments` via Y.Map('documentMeta')
- Communication: `tandem_checkInbox` (poll for user actions + chat) and `tandem_reply` (Claude's chat responses). **Call `tandem_checkInbox` between tasks.** `tandem_status` and `tandem_checkInbox` return `mode: "solo" | "tandem"` — adapt behavior accordingly (in Solo mode, hold annotations)
- Solo/Tandem mode is stored in CTRL_ROOM's `Y_MAP_USER_AWARENESS` map under the `Y_MAP_MODE` key, not per-document. Mode changes broadcast to all open documents
- Selection events use dwell-time gating (default 1s) — only fire after the user holds a selection steady
- ADR-027: notes are user-private; Claude never reads them via MCP tools or channel events
- File open/close converge in `file-opener.ts` / `document-service.ts`; tab close goes through `POST /api/close`. `openFileByPath` accepts an optional `readOnly` flag to force read-only mode (used by the View Changelog button)
- Two independent panel visibility booleans (`leftPanelVisible`, `rightPanelVisible`) replace the old three-layout-mode system. **Post-Wave-I rails are fixed:** left = outline, right = Annotations + Chat. The cross-rail tab picker is gone (`RailTabPicker.svelte` deleted, `leftRailTabs` / `rightRailTabs` fields stripped from settings via v4→v5 migration, `RailTab` type removed). `LayoutModel` exposes visibility helpers only. Layout state persists in `tandem:settings`. `App.svelte` uses inline `{#snippet}` blocks for `resizeHandle` and `tabbedPanel` (right rail); left rail is rendered inline

## Semantic Tokens
- Token families defined in `index.html` `:root` (light) and `[data-theme="dark"]` blocks. Never use raw hex or non-neutral `rgba()` for semantic colors in `src/client/**/*.{ts,svelte}` — use `var(--tandem-*)` or import from `src/client/utils/colors.ts`. (`rgba(0,0,0,...)` / `rgba(255,255,255,...)` alpha values for shadows and overlays are fine.)
- **`--tandem-success-*`** — green. Success toasts, completion states. `--tandem-success`, `-fg`, `-fg-strong`, `-bg`, `-border`.
- **`--tandem-warning-*`** — amber. Warnings, held-annotation banners, unsaved indicators. `--tandem-warning`, `-fg`, `-fg-strong`, `-bg`, `-border`.
- **`--tandem-error-*`** — red. Error banners, destructive actions, flag annotations. `--tandem-error`, `-fg`, `-fg-strong`, `-bg`, `-border`.
- **`--tandem-info-*`** — blue. Informational banners, review-only mode. `--tandem-info`, `-fg`, `-fg-strong`, `-bg`, `-border`.
- **`--tandem-suggestion-*`** — violet. Replacement/suggestion annotations. `--tandem-suggestion`, `-fg-strong`, `-bg`, `-border`. Visually distinct from indigo accent.
- **`--tandem-accent-border`** — single token for accent-family bordered elements.
- **Spacing / radius / type / elevation / stacking scales** — use `--tandem-space-1..7`, `--tandem-r-1..5`, `--tandem-r-pill`, `--tandem-r-circle`, `--tandem-text-2xs..3xl`, `--tandem-shadow-1..4`, and `--tandem-z-base..tooltip` instead of raw px literals in client surfaces.
- **Highlight tokens** — CSS-facing highlight fills use `--tandem-highlight-yellow|green|blue|pink`. Keep `HIGHLIGHT_COLORS` raw rgba values for non-CSS export/runtime paths; Svelte surfaces should use `HIGHLIGHT_COLOR_VARS`.
- **Theme-picker swatch tokens** — `--tandem-swatch-light|dark|warm` are fixed-identity colors for the BrandMenu theme picker. Defined in `:root` only (no per-theme overrides — they preview each scheme, so they must not adapt to the active theme). The "system" swatch uses live `--tandem-bg`/`--tandem-fg` via `linear-gradient`.
- **`--tandem-author-user`** / **`--tandem-author-claude`** — authorship colors. Blue/orange in light, adjusted in dark. Authorship decorations use `data-tandem-author` attributes (not CSS classes) per ADR-026.
- **`--tandem-claude-focus-bg`** / **`--tandem-claude-focus-border`** — Claude focus paragraph indicator. Derived from `--tandem-author-claude` via `color-mix` (10% / 40% opacity against transparent). Used in `awareness.ts` for the paragraph gutter decoration.
- **Light mode:** `--tandem-success-bg`, `--tandem-warning-bg`, and `--tandem-error-bg` are derived via `color-mix(in srgb, var(--tandem-{color}) 10%, var(--tandem-surface))`. `--tandem-accent-bg` (`#eef2ff`) and `--tandem-info-bg` (`#eff6ff`) use hand-picked hex. `--tandem-suggestion-bg` uses `color-mix` like the other status families.
- **Dark mode:** all `*-bg` tokens use hand-coded saturated hex (e.g. `#052e16`, `#451a03`, `#450a0a`). `color-mix` produces washed-out surfaces against the dark neutral; hand-picked values read as intentionally colored.
- **`src/client/utils/colors.ts`** exports `warningStateColors` — import it instead of inlining all three CSS vars when you need the full set (e.g. `SidePanel.svelte` held-banner). Error/success/suggestion variants were removed in audit v2 (zero consumers); re-add the same shape if a future surface needs them.
- Raw hex in client code is a regression; lint rule tracked in #356.

## Desktop App (Tauri)
- `cargo tauri dev` -- Tauri dev mode (Vite hot-reload + Rust rebuild)
- `cargo tauri build` -- Production build (installer output)
- `src-tauri/` layout: `Cargo.toml`, `tauri.conf.json`, `capabilities/` (permission manifests), `src/lib.rs` (plugin registration), `src/main.rs` (entry point)
- **`single-instance` must be the FIRST plugin registered in `lib.rs`** -- later registration breaks instance detection
- Desktop-only plugins (single-instance, window-state, updater) use `capabilities/desktop.json`; core permissions in `capabilities/default.json`
- **`tauri.localhost` origin:** the Tauri WebView uses `http://tauri.localhost` (not `http://localhost`). The server accepts it in CORS, `apiMiddleware` Host-header check, and Hocuspocus WebSocket origin validation. Use the `TAURI_HOSTNAME` constant from `src/shared/constants.ts` -- never a raw string.
- **`strip_win_prefix()`** in `src-tauri/src/lib.rs` strips the `\\?\` extended-length prefix that Tauri path APIs return on Windows. Call it on every path before passing to the sidecar.
- **Self-contained bundles:** `tsup.config.ts` exports a `selfContained` shared config (`noExternal: [/.*/]` + `createRequire` banner) spread onto the server and channel entries. CLI entry does NOT use `selfContained`.
- **Sidecar name** is `"node-sidecar"`. Tauri appends the target triple at build time; actual binary is `node-sidecar-{target-triple}[.exe]`.
- `kill_sidecar()` is called **before** `app.restart()` after update install; Rust then polls the health endpoint (up to 5s) waiting for port release before restarting.
- **CI:** `tauri-release.yml` validates the signing key before building and has a `release-check` summary job that fails if any matrix build failed.
- **`create_overlay_titlebar()` must be called post-page-load** — the hit-test JS injected by `tauri-plugin-decorum` is cleared on WebView navigation; expose it as a `#[tauri::command]` and invoke from the component's `onMount` instead of from `setup()`.
- **Debugging the shell↔sidecar boundary:** run `cargo tauri dev --features devtools` to enable CrabNebula DevTools (IPC/event/log time-travel inspector); open the DevTools desktop app and connect to the running Tandem instance. The `devtools` feature is an opt-in optional dependency (Cargo can't gate deps on `cfg(debug_assertions)`), so it never reaches release builds. It is **mutually exclusive** with `tauri-plugin-log` — both install a global `tracing` subscriber, so the log plugin is `#[cfg(not(feature = "devtools"))]`-gated; DevTools owns logging when the feature is on. Normal builds (no feature) run the log plugin writing `tandem.log` (from `file_name: Some("tandem")`) to the OS log dir, rotated at a 25 MB size cap (`.max_file_size`) keeping one prior file (`RotationStrategy::KeepOne`). `TargetKind::LogDir` resolves via Tauri's `app_log_dir()`, which is keyed on the **bundle identifier** `com.tandem.editor` (NOT the `tandem` product name): `%LOCALAPPDATA%\com.tandem.editor\logs\tandem.log` (Windows) / `~/Library/Logs/com.tandem.editor/tandem.log` (macOS) / `~/.local/share/com.tandem.editor/logs/tandem.log` (Linux, `$XDG_DATA_HOME`).

## Gotchas

### Y.js / CRDT
- **Y.XmlText must be attached before populating.** Inserting formatted text into a detached Y.XmlText reverses segment order. Always attach to Y.Doc first, then insert (two-pass pattern in `mdast-ydoc.ts`).
- **Y.XmlElement.setAttribute needs `as any` for numbers.** TypeScript types say string-only but Tiptap stores numeric heading levels.
- **Stale browser tabs merge old CRDT state back.** If you change a file on disk and restart the server, an open browser tab will sync its old Y.Doc state back on reconnect, reverting your changes. Close all tabs before restarting, or use `force: true` to reload.
- **Force-reload clears in-place.** `tandem_open` with `force: true` clears annotations, awareness, and content in a single transaction. Don't use mid-review -- annotations are still lost. See observer ownership table in [architecture.md](docs/architecture.md#y-map-observer-ownership).
- **CRDT fallback logging.** `buildDecorations()` emits `console.warn` when an annotation falls back to flat offsets. Check the browser console -- these indicate CRDT degradation.
- **Dead CRDT RelativePositions must be stripped, not preserved.** After `reloadFromDisk` replaces Y.Doc content, old `relRange` RelativePositions reference deleted items. `refreshRange` strips dead `relRange` and re-anchors from flat offsets. A stale `relRange` that resolves to null blocks the lazy re-attachment recovery path -- deletion is better than preservation.
- **Hocuspocus replaces Y.Doc in `onLoadDocument`.** The `onDocSwapped` callback in `provider.ts` reattaches server event queue observers to the new instance. A runtime warning fires if the callback is missing. See #178 audit.
- **Annotation-sync cleanups distinguish swap vs close.** `registerAnnotationObserver` returns `(phase?: "swap" | "close") => void`. A Y.Doc swap keeps the per-doc tombstone ledger alive so in-flight debounced writes still serialize tombstones; only `"close"` drops the ledger. `reattachObservers` passes `"swap"`; `clearFileSyncContext` / `setFileSyncContext`'s replace path pass `"close"`. See #333.
- **Y.js "Invalid access" warnings** during session restore are harmless stderr noise.
- **`getElementText()` strips inline marks and separates nested blocks.** The function uses `toDelta()` (not `toString()`) for XmlText content, emitting `\n` for embedded elements (hardBreaks). Child XmlElements (listItem, paragraph, blockquote) are separated by `\n`. This matches ProseMirror's block structure for correct flat-offset alignment.

### MCP / Server
- **Channel shim uses low-level `Server`, not `McpServer`.** The Channels spec requires `import { Server } from '@modelcontextprotocol/sdk/server/index.js'` with explicit `setRequestHandler()` calls. The HTTP MCP server uses the high-level `McpServer` wrapper.
- **Channel meta keys use underscores only.** The Channels API silently drops meta keys containing hyphens. Use `document_id`, `annotation_id`, `event_type` -- not `document-id`.
- **`APP_VERSION` is baked at build time** via the `__APP_VERSION__` tsup define in `src/server/mcp/server.ts`. Falls back to `createRequire("../../package.json")` in tsx dev and vitest. `__MCP_SDK_VERSION__` follows the same pattern. `findChangelogPath()` in the same file walks up from `__dirname` to find `CHANGELOG.md` (handles both `src/server/mcp/` in dev and `dist/server/` in production).
- **MCP must start before Hocuspocus** in stdio mode -- init timeout fires if order is reversed.
- **Mutating integration routes (`POST /api/integrations`, `POST /api/integrations/apply`, `POST/DELETE /api/integrations/secrets/:ref`, `POST /api/integrations/install-claude-code`) require both `assertOriginAllowlisted` AND `assertLoopbackForMutation` at handler top, BEFORE any state mutation.** The apply route additionally gates on a constant-time nonce compare + in-process mutex + `IntegrationsFileSchema.safeParse` defense-in-depth. The install-claude-code route gates on origin + loopback + a dedicated in-process mutex (`getInstallGate()`/`_resetInstallGateForTests()`, mutex set inside the `try`) but **deliberately carries NO nonce** (S3: no persisted intent to bind, host-pinned + idempotent install). Read-only `GET` routes are intentionally exempt from the loopback gate; `GET /api/integrations/existing` scrubs `env`/`headers` so the bearer token in `~/.claude.json` never reaches the wire (`extractEntry` in `src/server/integrations/existing-config.ts`). `GET /api/integrations/claude-cli-status` is also ungated and LAN-reachable, so its response is **enum-only** (`{ presence }`) — never the resolved `~/.local/bin` path (F6). The installer itself (`install-claude-cli.ts`) fetches the pinned `https://claude.ai/install.{sh,ps1}` script and `execFile`s the interpreter on a locked-down temp file — never `| bash`/`| iex`; minimal allowlisted env so the wire-fetched script never sees the auth token (F1).

### Client / UI
- **ChatPanel + SidePanel are always mounted** (CSS display toggle, not conditional rendering) so local state persists across panel switches.
- **localStorage access needs try-catch.** Some browsers (incognito, storage-disabled) throw on access. Without the guard, the tutorial component crashes the app.
- **`tandem_editAnnotation` only works on pending annotations.** Accepted or dismissed annotations return an error.
- **Tutorial annotations are injected idempotently.** `injectTutorialAnnotations()` checks for existing IDs before inserting. Tutorial only activates on `sample/welcome.md`.

### Files, Sessions & Lifecycle
- **Session files** via `env-paths`: `%LOCALAPPDATA%\tandem\Data\sessions\` on Windows, `~/Library/Application Support/tandem/sessions/` on macOS, `~/.local/share/tandem/sessions/` on Linux. Delete to force fresh load.
- **Auto-open `sample/welcome.md`** on first run. On upgrade, `CHANGELOG.md` opens instead (read-only — prevents the 60s autosave timer from round-tripping it through `remark-stringify` and rewriting the file with escape noise; see lesson #69 and issue #605 for the underlying serializer fix). Both open **before** Hocuspocus/MCP start.
- **Startup document opens must precede server bind (HTTP mode only).** Any document that should appear on startup must be opened before Hocuspocus binds. Stale browser tabs reconnecting can CRDT-merge incomplete `openDocuments` lists, removing tabs that were added after the server started accepting connections. Stdio mode has no startup document opens.
- **OS file-association cold start.** When the Tauri desktop app is launched via the OS file-association handler (e.g. double-clicking a `.md` from Finder / Explorer), `src-tauri/src/lib.rs` reads `std::env::args()` via `extract_file_arg`, validates extension + path, and exports it as `TANDEM_OPEN_FILE` before spawning the sidecar. `src/server/startup-file.ts#maybeOpenStartupFile` consumes the env var and calls `openFileByPath` *before* HTTP bind, naturally preempting the `welcome.md` fallback. Warm-start (second instance) uses the `tauri-plugin-single-instance` callback to POST `/api/open` against the running sidecar. macOS file-association launches deliver paths via `RunEvent::Opened` (Apple Event `kAEOpenDocuments`) — not argv — and are queued in `PendingOpens` until `wait_for_health()` returns, then drained before the `SIDECAR_HEALTHY` flag flips. macOS cold-start can briefly show `welcome.md` before switching to the requested file (known limitation).
- **File watcher suppression checks at event arrival, not delivery.** `suppressNextChange()` is consumed in the `fs.watch` callback (arrival), not inside the debounce timer callback (delivery). Checking at delivery time creates a race where an external edit arriving within the debounce window gets suppressed instead of the self-write.
- **Word comment offsets need re-anchoring.** `.docx` comment ranges reference HTML-converted content. `docx-comments.ts` re-resolves via `anchoredRange()` after Y.Doc population.
- **Exception handler is narrowed, not blanket.** `uncaughtException`/`unhandledRejection` only swallow known Hocuspocus/ws errors (via `isKnownHocuspocusError`). Unknown errors call `process.exit(1)`.
- **Boot-time orphaned-temp reaper.** `reapOrphanedTemps` (`src/server/file-io/reaper.ts`) sweeps `.tandem-tmp-*` atomic-write siblings older than 1 hour from the annotations + sessions dirs **only** (never user document dirs). These orphan when the process is SIGKILLed between `writeFile` and `rename` (dev restarts, force-quits). Fire-and-forget at boot (un-awaited, with `.catch()`), skipped when the store is read-only. The 1-hour age gate — not the store lock — is what makes it safe against a concurrently-starting instance, since session-dir writes aren't lock-gated. The match regex (`^\.tandem-tmp-(\d+)-([0-9a-f]{12})$`) is the safety boundary: `store.lock`, `<hash>.json`, `.corrupt.*`, `.future`, and session files can never match.
- **Pre-overwrite document backups are path-keyed and once-per-run.** `snapshotBeforeFirstWrite` (`src/server/file-io/doc-backup.ts`) copies a `.md`/`.txt` file's on-disk bytes verbatim to `{APP_DATA}/doc-backups/<path-hash>/` before Tandem's FIRST `atomicWrite` to that path per server run (also called from Save-As when the target exists — that path can overwrite a never-Tandem-written file). Keyed by `docHash(filePath)` not docId (docId survives rename; the snapshot question is per-path). Failure contract is the OPPOSITE of `integrations/backup.ts`: a failed snapshot warns and lets the save proceed (gate stays unset → retried next save). Deliberate skips (no source file / byte-identical / 500 MB cap) DO set the gate. Shutdown now flushes dirty docs (`autoSaveAllToDisk`, 5s-bounded) before `saveCurrentSession`; the timer is stopped first.

### Testing & E2E
- **E2E tests start their own server** via Playwright `webServer`. `freePort()` kills existing :3478/:3479 -- running E2E alongside `dev:server` will terminate your dev server.
- **Uploaded files (`upload://` paths) are read-only.** `tandem_save` returns a session-only save.
- **`cargo test` in CI requires sidecar stubs + GTK libs.** `tauri_build::build()` checks all declared `resources` (including `dist/client`, `dist/server`, `dist/channel`) and the sidecar binary. Create stubs before running: `mkdir -p src-tauri/binaries dist/channel dist/server dist/client && touch "src-tauri/binaries/node-sidecar-${TRIPLE}" "src-tauri/binaries/node-sidecar-${TRIPLE}.exe"`. On Ubuntu CI also install `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` first.

## Security
- Server binds to 127.0.0.1 by default. LAN binding (`TANDEM_BIND_HOST`) requires an auth token; `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` is an explicit insecure opt-in for development only
- DNS rebinding protection on all routes (`apiMiddleware` Host-header validation + `createMcpExpressApp`)
- CORS allowlist is `http://127.0.0.1:*` and `http://tauri.localhost` only — bare `localhost` was narrowed out in PR #637 (DNS-rebinding hardening). Rejects UNC paths (Windows NTLM). Extension + 50MB size limits. Atomic saves

## Status

Core complete: 28 active MCP tools, multi-doc tabs, CRDT-anchored annotations, chat sidebar, channel push, .md/.docx/.txt/.html support, npm global install (`tandem-editor`), Tauri desktop app. v0.8.0 shipped: coordinate system bugs fixed, semantic token lint enforcement, annotation UX simplified, NSIS installer sidecar kill. v0.9.0 complete: MCP consolidation (#259, PR #449), redesign data model (#440–#445/#450, PRs #451/#458/#461/#462), UX polish (#435/#437, PRs #460/#463), CI stdio smoke test (#341, PR #459). Distribution items (#316, #317, #322) deferred to v0.15.0. v0.10.0 complete: React→Svelte 5 migration (#472/#508); all 39 .tsx files replaced; react/react-dom/@tiptap/react removed. v0.11.0 complete: dark theme WCAG AA, toolbar redesign (audience-first popup, authorship toggle, inline link input), scratchpad (`Ctrl+N` / `tandem_scratchpad`), command palette, find/replace, outline panel, store-readonly banner, internal link navigation, annotation correctness (AR1–AR3). v0.12.0 complete: 8-unit prep batch (#634–#641) — #477 PR-2 browser deprecation, Phase 0 sidecar spike, #576 spikes, AR4, anchor-drift test, release scaffolding. v0.13.0 complete: Waves 1, 1b, 2 — stability bug-bash + v7 floating-chrome redesign (titlebar/rails/tabs/status/outline/popup/slash-menu, Wave M dark-mode alignment), Settings → Network split, multi-provider Models registry (keychain + first-run picker), schema v2→v3 read-only forward-compat, D11 fonts, margin annotation view (#649), heading-section collapse (#650), scratchpad save-to-disk (#827), Claude typing-presence (#651), native file picker + drag-drop (#378), warm theme, integration setup wizard + first-run apply (#477 PRs 1/3a/3b/3c-i/3c-ii-a/3c-ii-b, default-on), native keychain, auto-launcher (#477 PR 4a/4b, default-on; opt-out `TANDEM_DISABLE_LAUNCHER=1`), integrations-probe hardening quartet (#794–#797), `IntegrationConfig.url` loopback constraint, README + docs rewrite, knowledge-graph pilot. v0.13.5 complete: design-system re-skin umbrella merged (`feat/design-system-impl` #939 — Phase 1 floating-chrome surfaces + Phase 3 cluster re-skins across banners/modals/find-replace/annotation-cards/empty-states/cowork/wizard-modals/decorations/selection-surface), customizable keyboard shortcuts (ADR-041), annotation GC + content-hash rename recovery (#313/#318), plus authorship-gutter and markdown-save escape fixes. v0.14.0 retains its planned annotation-migration scope (AR5/AR6 + #477 PR 3c-ii-c + #576). See [docs/roadmap.md](docs/roadmap.md) for full plan.

<!-- autoskills:start -->

Summary generated by `autoskills`. Check the full files inside `.claude/skills`.

## Tandem-Specific Skills

- `.claude/skills/changelog/SKILL.md` -- Generate a Keep a Changelog entry from git log since last tag
- `.claude/skills/dev-server/SKILL.md` -- Start dev environment (server + client) and verify MCP connection
- `.claude/skills/e2e/SKILL.md` -- Run Playwright E2E tests safely (warns about dev server conflicts)
- `.claude/skills/e2e-debug/SKILL.md` -- Debug Playwright E2E test failures (port conflicts, server startup, post-mortem)
- `.claude/skills/issue-pipeline/SKILL.md` -- 10-step agent-driven issue pipeline (`/issue-pipeline`)
- `.claude/skills/screenshots/SKILL.md` -- Capture README screenshots via Playwright + MCP

Generic skills (accessibility, frontend-design, nodejs-backend-patterns, playwright-best-practices, tauri-v2, typescript-advanced-types, vercel-composition-patterns, vercel-react-best-practices, vite, vitest) live in `.claude/skills/` and auto-trigger via the skill system.

<!-- autoskills:end -->

## Claude Code Automation

### Hooks (`.claude/hooks/`)

Wired in `.claude/settings.json`. PreToolUse hooks exit 2 to block; PostToolUse hooks exit 0 (warn only). Workflow-nudge hooks emit stderr but never block. Per-session state lives in `.claude/.workflow-state/<session_id>/` (gitignored, pruned at SessionStart after 7 days).

**SessionStart — `startup` matcher:**
- `sessionstart-prune-state.sh` -- Removes workflow-state dirs older than 7 days

**PreToolUse — `Edit|Write` matcher:**
- `block-sensitive.sh` -- Blocks edits to `.env`, `package-lock.json`, and other sensitive files
- `nudge-plan-review.sh` -- Warns when a `.claude/plans/*.md` was written this session but no `Agent` tool has run before a source edit (one-shot per plan)

**PreToolUse — `Bash` matcher:**
- `block-no-verify.sh` -- Blocks `--no-verify` flag (Husky bypass); fail-closed on parse error
- `nudge-simplify-before-commit.sh` -- Warns on `git commit` when source edits have happened since last `/simplify` (one-shot per edit batch)

**PreToolUse — `ExitPlanMode` matcher:**
- `block-plan-without-agent-review.sh` (+ `.mjs` body) -- Blocks plan-approval requests unless the session transcript shows an `Agent`/`Task` tool call after the most recent `Write`/`Edit` to a plan file under user-level `~/.claude/plans/` (project-level `<repo>/.claude/plans/` is intentionally excluded). Bypass: prepend `Agent feedback incorporated` to the plan body. Fail-closed on missing/oversize (>50 MB) transcripts and on plan paths that don't `realpath` under `~/.claude/plans/`.

**PostToolUse — unmatched (every tool):**
- `track-workflow-events.sh` -- Records markers used by nudge hooks: `last-plan-write`, `last-source-edit`, `last-agent-call`, `last-simplify`, and `last-commit` (detected from successful `git commit` invocations in `Bash` tool calls). Also clears the `stop-nudged` marker on successful commit so the stop reminder can re-fire after the next edit cycle. Fast-paths uninteresting tools to skip the node spawn.

**PostToolUse — `Edit|Write` matcher:**
- `typecheck-on-edit.sh` -- Runs `tsc --noEmit` after `.ts`/`.tsx` edits
- `svelte-check-on-edit.sh` -- Runs `svelte-check` after `.svelte` edits (opt-out: `TANDEM_SKIP_SVELTE_CHECK=1`)
- `check-console-log.sh` -- Warns on `console.log()` in `src/server/` (Critical Rule #3)
- `check-extract-markdown.sh` -- Warns on `extractMarkdown()` usage (Critical Rule #5)
- `check-ymap-keys.sh` -- Warns on raw Y.Map key strings (Critical Rule #1)
- `check-token-violation.sh` -- Runs `scripts/check-semantic-tokens.ts` for raw hex/rgba in `src/client/`
- `format-on-edit.sh` -- Runs Biome format on edited files
- `related-test.sh` -- Runs matching vitest after source edits (opt-out: `TANDEM_SKIP_RELATED_TEST=1`)

**PostToolUse — `Bash` matcher:**
- `nudge-pr-review.sh` -- Reminds to run `/pr-review-toolkit:review-pr` after a successful `gh pr create`

**Stop:**
- `stop-cycle-check.sh` -- Informational nudge at turn end if session has uncommitted source edits (one-shot per session)

### Agents (`.claude/agents/`)

- `annotation-model-reviewer.md` -- Reviews annotation lifecycle, MCP_ORIGIN tagging, ADR-027 privacy
- `svelte-migration-reviewer.md` -- Reviews `.svelte`/`.svelte.ts` for 6 known Svelte 5 reactive gotchas
- `crdt-reviewer.md` -- Reviews CRDT coordinate system bugs and range invariant violations
- `security-reviewer.md` -- Reviews security vulnerabilities specific to Tandem's threat model
