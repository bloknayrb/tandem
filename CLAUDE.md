# Tandem -- Collaborative AI-Human Document Editor

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
- [MCP Tool Reference](docs/mcp-tools.md) -- All 31 MCP tools + channel API endpoints
- [Architecture](docs/architecture.md) -- Diagrams, data flows, coordinate systems, file map
- [Workflows](docs/workflows.md) -- Real-world usage patterns
- [Agent Workflow](docs/agent-workflow.md) -- 10-step agent-driven issue pipeline (`/issue-pipeline`)
- [Roadmap](docs/roadmap.md) -- Phase 2+ roadmap, future extensions
- [Design Decisions](docs/decisions.md) -- ADRs (001-026)
- [Lessons Learned](docs/lessons-learned.md) -- 48 lessons including E2E testing gotchas

## Critical Rules

These WILL break things if violated:

1. **Y.Map key strings from constants only.** Use `Y_MAP_ANNOTATIONS`, `Y_MAP_AWARENESS`, etc. from `shared/constants.ts` -- never raw string literals for Y.Map keys.
2. **Origin-tag server writes.** All server-side Y.Map writes must tag the transaction with an origin constant exported from `src/server/events/queue.ts`. Use `MCP_ORIGIN` (`"mcp"`) for user-intent writes from MCP tools — `doc.transact(() => { ... }, MCP_ORIGIN)`. Use `FILE_SYNC_ORIGIN` (`"file-sync"`) for echoes from the durable-annotation file-writer / file-watcher reload path. The durable-annotation sync observer skips `FILE_SYNC_ORIGIN` transactions (prevents re-persisting state just loaded from disk), and the channel event queue skips BOTH origins — `MCP_ORIGIN` because external consumers already saw the MCP call, `FILE_SYNC_ORIGIN` because file reloads are not user events.
3. **stdout is reserved.** `console.log/warn/info` all redirect to stderr in `index.ts` (defense-in-depth for stdio fallback). If you add a dependency that logs to stdout, it will corrupt the MCP wire in stdio mode.
4. **Ranges use `validateRange()` + `anchoredRange()`**, not raw offsets. `anchoredRange()` creates both flat + Yjs RelativePosition in one call.
5. **`tandem_getTextContent` uses `extractText()`, never `extractMarkdown()`.** Even for .md files. `extractMarkdown()` shifts character offsets relative to the annotation coordinate system. If you need actual markdown, use `tandem_save` and read the file.
6. **`tandem_edit` rejects heading markup ranges.** Ranges that overlap heading prefixes (e.g., `## `) return INVALID_RANGE -- target text content only.
7. **E2E tests use `data-testid` attributes** (kebab-case). Key selectors: `accept-btn`, `dismiss-btn`, `edit-btn`, `review-mode-btn`, `annotation-card-{id}`, `tab-{id}`, `file-open-dialog`, `file-path-input`, `open-file-btn`, `toast-container`.

## Architecture

Three layers: Editor (Tiptap in Tauri desktop or browser) <-> Tandem Server (Hocuspocus on :3478 + MCP HTTP on :3479) <-> Claude Code. The desktop app is the primary distribution; npm global install opens the same editor in a browser. Channel shim (`src/channel/`) pushes real-time events to Claude Code via SSE, replacing polling.

Key files for navigation:
- `src/cli/index.ts` -- CLI entrypoint (`tandem` command), arg parsing, dispatches to start/setup
- `src/cli/setup.ts` -- `tandem setup`: auto-detect Claude installs, write MCP config atomically
- `src/cli/start.ts` -- `tandem start`: spawn server (opens editor via `TANDEM_OPEN_BROWSER=1`)
- `src/server/index.ts` -- Entry point, port binding, console redirect
- `src/server/open-browser.ts` -- Cross-platform browser launcher for npm-install path (execFile-based)
- `src/server/mcp/` -- Tool definitions, `api-routes.ts`, `channel-routes.ts`, `file-opener.ts`, `document-service.ts`
- `src/server/positions.ts` -- Server coordinate conversions (`validateRange`, `anchoredRange`, `resolveToElement`, `refreshRange`)
- `src/server/events/` -- Channel event infrastructure (Y.Map observers, SSE)
- `src/client/` -- Tiptap editor, React components, hooks (`useYjsSync`, `useTabOrder`, `useTutorial`, `useNotifications`)
- `src/shared/` -- Types (`types.ts`), constants (`constants.ts`), offsets (`offsets.ts`), position types (`positions/`)

Full file-level detail: [docs/architecture.md](docs/architecture.md#file-map)

## Key Patterns
- All document mutations go through the server's Y.Doc -> changes sync to editor via Hocuspocus
- Annotations stored in Y.Map('annotations'), not in document content. `author` field: `"user" | "claude" | "import"` (import = Word comments from .docx files). User annotations are plain notes to Claude — `suggestedText` and `directedAt: "claude"` are Claude-only features created via MCP tools (`tandem_suggest`, `tandem_comment`), not the UI.
- Three coordinate systems: flat text offsets (server, includes heading prefixes), ProseMirror positions (client, structural), Yjs RelativePositions (CRDT-anchored, survive edits). Modules: `src/server/positions.ts`, `src/client/positions.ts`, shared types in `src/shared/positions/`
- `getElementText()` returns clean plain text (no markup tags) with `\n` separators between nested block children (list items, paragraphs within list items). Embedded elements (hardBreaks) emit `\n` to preserve XmlText index alignment. `extractText()` additionally prepends heading prefixes and joins top-level elements with `\n`.
- Multi-document: each file gets a documentId (hash of path) = Hocuspocus room name. All MCP tools accept optional `documentId`, defaulting to active document. `CTRL_ROOM` is reserved -- never use as a document ID. Server broadcasts `openDocuments` via Y.Map('documentMeta')
- Communication: `tandem_checkInbox` (poll for user actions + chat) and `tandem_reply` (Claude's chat responses). **Call `tandem_checkInbox` between tasks.** `tandem_status` and `tandem_checkInbox` return `mode: "solo" | "tandem"` — adapt behavior accordingly (in Solo mode, hold annotations)
- Solo/Tandem mode is stored in CTRL_ROOM's `Y_MAP_USER_AWARENESS` map under the `Y_MAP_MODE` key, not per-document. Mode changes broadcast to all open documents
- Selection events use dwell-time gating (default 1s) — only fire after the user holds a selection steady
- File open/close converge in `file-opener.ts` / `document-service.ts`; tab close goes through `POST /api/close`

## Semantic Tokens
- Token families defined in `index.html` `:root` (light) and `[data-theme="dark"]` blocks. Never use raw hex or non-neutral `rgba()` for semantic colors in `src/client/**/*.{ts,tsx}` — use `var(--tandem-*)` or import from `src/client/utils/colors.ts`. (`rgba(0,0,0,...)` / `rgba(255,255,255,...)` alpha values for shadows and overlays are fine.)
- **`--tandem-success-*`** — green. Success toasts, completion states. `--tandem-success`, `-fg`, `-fg-strong`, `-bg`, `-border`.
- **`--tandem-warning-*`** — amber. Warnings, held-annotation banners, unsaved indicators. `--tandem-warning`, `-fg`, `-fg-strong`, `-bg`, `-border`.
- **`--tandem-error-*`** — red. Error banners, destructive actions, flag annotations. `--tandem-error`, `-fg`, `-fg-strong`, `-bg`, `-border`.
- **`--tandem-info-*`** — blue. Informational banners, review-only mode. `--tandem-info`, `-fg`, `-fg-strong`, `-bg`, `-border`.
- **`--tandem-suggestion-*`** — violet. Replacement/suggestion annotations. `--tandem-suggestion`, `-fg-strong`, `-bg`, `-border`. Visually distinct from indigo accent.
- **`--tandem-accent-border`** — single token for accent-family bordered elements.
- **`--tandem-author-user`** / **`--tandem-author-claude`** — authorship colors. Blue/orange in light, adjusted in dark. Authorship decorations use `data-tandem-author` attributes (not CSS classes) per ADR-026.
- **`--tandem-claude-focus-bg`** / **`--tandem-claude-focus-border`** — Claude focus paragraph indicator. Derived from `--tandem-author-claude` via `color-mix` (10% / 40% opacity against transparent). Used in `awareness.ts` for the paragraph gutter decoration.
- **Light mode:** `--tandem-success-bg`, `--tandem-warning-bg`, and `--tandem-error-bg` are derived via `color-mix(in srgb, var(--tandem-{color}) 10%, var(--tandem-surface))`. `--tandem-accent-bg` (`#eef2ff`) and `--tandem-info-bg` (`#eff6ff`) use hand-picked hex. `--tandem-suggestion-bg` uses `color-mix` like the other status families.
- **Dark mode:** all `*-bg` tokens use hand-coded saturated hex (e.g. `#052e16`, `#451a03`, `#450a0a`). `color-mix` produces washed-out surfaces against the dark neutral; hand-picked values read as intentionally colored.
- **`src/client/utils/colors.ts`** exports `errorStateColors`, `successStateColors`, `warningStateColors`, `suggestionStateColors` — import these instead of inlining all three CSS vars when you need the full set (e.g. `SidePanel.tsx` held-banner).
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
- **`APP_VERSION` is read from `package.json`** via `createRequire` in `src/server/mcp/server.ts`. Don't hardcode version strings.
- **MCP must start before Hocuspocus** in stdio mode -- init timeout fires if order is reversed.

### Client / UI
- **ChatPanel + SidePanel are always mounted** (CSS display toggle, not conditional rendering) so local state persists across panel switches.
- **localStorage access needs try-catch.** Some browsers (incognito, storage-disabled) throw on access. Without the guard, the tutorial component crashes the app.
- **`tandem_editAnnotation` only works on pending annotations.** Accepted or dismissed annotations return an error.
- **Tutorial annotations are injected idempotently.** `injectTutorialAnnotations()` checks for existing IDs before inserting. Tutorial only activates on `sample/welcome.md`.

### Files, Sessions & Lifecycle
- **Session files** via `env-paths`: `%LOCALAPPDATA%\tandem\Data\sessions\` on Windows, `~/Library/Application Support/tandem/sessions/` on macOS, `~/.local/share/tandem/sessions/` on Linux. Delete to force fresh load.
- **Auto-open `sample/welcome.md`** on first run. On upgrade, `CHANGELOG.md` opens instead. Both open **before** Hocuspocus/MCP start.
- **Startup document opens must precede server bind (HTTP mode only).** Any document that should appear on startup must be opened before Hocuspocus binds. Stale browser tabs reconnecting can CRDT-merge incomplete `openDocuments` lists, removing tabs that were added after the server started accepting connections. Stdio mode has no startup document opens.
- **File watcher suppression checks at event arrival, not delivery.** `suppressNextChange()` is consumed in the `fs.watch` callback (arrival), not inside the debounce timer callback (delivery). Checking at delivery time creates a race where an external edit arriving within the debounce window gets suppressed instead of the self-write.
- **Word comment offsets need re-anchoring.** `.docx` comment ranges reference HTML-converted content. `docx-comments.ts` re-resolves via `anchoredRange()` after Y.Doc population.
- **Exception handler is narrowed, not blanket.** `uncaughtException`/`unhandledRejection` only swallow known Hocuspocus/ws errors (via `isKnownHocuspocusError`). Unknown errors call `process.exit(1)`.

### Testing & E2E
- **E2E tests start their own server** via Playwright `webServer`. `freePort()` kills existing :3478/:3479 -- running E2E alongside `dev:server` will terminate your dev server.
- **Uploaded files (`upload://` paths) are read-only.** `tandem_save` returns a session-only save.

## Security
- Server binds to 127.0.0.1 only
- DNS rebinding protection on all routes (`apiMiddleware` Host-header validation + `createMcpExpressApp`)
- CORS reflects `http://localhost:*` origins. Rejects UNC paths (Windows NTLM). Extension + 50MB size limits. Atomic saves

## Status

Core complete: 31 MCP tools, multi-doc tabs, CRDT-anchored annotations, chat sidebar, channel push, .md/.docx/.txt/.html support, npm global install (`tandem-editor`), Tauri desktop app (v0.8.0 released). Run B (v0.8.0) shipped: coordinate system bugs fixed, semantic token lint enforcement, annotation UX simplified, NSIS installer sidecar kill. Redesign gap audit (#439) resolved: 7 product decisions in [ADR-026](docs/decisions.md#adr-026-redesign-gap-audit-decisions-439), 6 issues filed (#440–#445), design response prompt at `docs/claude-design-response-prompt.md`. See [docs/roadmap.md](docs/roadmap.md) for remaining work.

<!-- autoskills:start -->

Summary generated by `autoskills`. Check the full files inside `.claude/skills`.

## Tandem-Specific Skills

- `.claude/skills/dev-server/SKILL.md` -- Start dev environment (server + client) and verify MCP connection
- `.claude/skills/e2e/SKILL.md` -- Run Playwright E2E tests safely (warns about dev server conflicts)
- `.claude/skills/screenshots/SKILL.md` -- Capture README screenshots via Playwright + MCP

Generic skills (accessibility, frontend-design, nodejs-backend-patterns, playwright-best-practices, tauri-v2, typescript-advanced-types, vercel-composition-patterns, vercel-react-best-practices, vite, vitest) live in `.claude/skills/` and auto-trigger via the skill system.

<!-- autoskills:end -->
