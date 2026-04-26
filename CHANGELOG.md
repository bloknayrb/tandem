# Changelog

All notable changes to Tandem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## \[Unreleased]

## \[0.8.0] - 2026-04-26

### Added

- **Semantic token lint enforcement (#356)** — `npm run check:tokens` scans `src/client/` for raw hex and non-neutral `rgba()` violations. Runs on pre-commit via lint-staged, blocking merges that introduce unsanctioned color literals.
- **`--tandem-suggestion-*` token family (#340)** — violet semantic tokens for replacement/suggestion annotations (`--tandem-suggestion`, `-fg-strong`, `-bg`, `-border`), visually distinct from the indigo accent family.
- **Annotation drop count surfacing (#351)** — `normalizeAnnotation` now returns drop counts in snapshot metadata so callers can detect lossy session migrations.
- **Plugin monitor declaration (#376)** — `plugin.json` now declares the `monitor` entry, closing the event push gap where Claude Code plugin installs didn't receive real-time notifications.
- **Persistent annotation undo (#415)** — undo state survives panel switches and scrolling; persists until page reload instead of clearing on the next render cycle.
- **Diagnostic position tests (#377)** — regression test suite for flat-offset resolution across headings, inline marks, nested lists, and blockquotes.

### Fixed

- **Three compounding coordinate system bugs (#260)** — inline markup (bold, italic, code) inflated character offsets; nested block structures (list items, blockquotes) lacked separators; and list item text extraction omitted `\n` between siblings. All three bugs compounded silently — a bold word inside a nested list could shift annotation placement by 10+ characters. Fixed in `getElementText()` and `extractText()` with full encapsulation of the position module behind `resolveToElement()`.
- **Flash animation alpha wash (#308)** — accept/dismiss flash used opaque background that hid annotation text; now uses `color-mix` with translucent blend against the surface.
- **Dark mode scrollbar styling (#369)** — scrollbars in the editor and side panel now respect the active theme.
- **Biome format check (#424)** — expanded a single-expression `useEffect` arrow that Biome 2.x reformatted differently than the original.

### Changed

- **User annotations simplified (#381)** — user-authored annotations show Edit and Remove only; Accept/Reject reserved for Claude and imported annotations. Reduces cognitive load — user notes are notes, not proposals.
- **Toolbar streamlined (#382)** — removed Replace and @Claude checkboxes from the annotation creation toolbar. These features remain available via MCP tools (`tandem_suggest`, `tandem_comment` with `directedAt`).

### Refactored

- **Codebase audit remediation (Phases 1–4)** — 8 god-files decomposed across 4 phases:
  - **Phase 1** (PRs #384–#389): wire-protocol types to `shared/`, token-store extraction, `awareness.ts` semantic tokens, Editor CSS extraction, tsconfig tightening, dead Tauri JS deps removed.
  - **Phase 2** (PRs #391, #392): `api-routes.ts` split into per-route handler modules; `file-opener.ts` decomposed into phased helpers with lifecycle tests.
  - **Phase 3** (PR #398, tests #399/408): event queue observer split — monolithic `queue.ts` broken into focused observer modules per Y.Map.
  - **Phase 4** (PRs #409–#413): `App.tsx` hooks extracted, `SidePanel.tsx` decomposed, `Toolbar.tsx`/`SettingsPopover.tsx` split, `AnnotationCard.tsx` broken into 3 sub-components.
- **Zero-arg handler factory simplification (#393)** — reduced boilerplate in MCP handler registrations.
- **Shared annotation test fixtures (#344)** — extracted reusable test helpers for annotation creation.
- **HTTP API silent failure surfacing (#396)** — API routes that swallowed errors now return proper status codes.

### Internal

- Mixed-partial `/api/setup` 207 test (#292).
- `@xmldom/xmldom` dependency bump (#390).
- CI: typecheck/lint/test gates on all PR base branches.

## \[0.7.1] - 2026-04-20

### Fixed

- **MSIX Claude Desktop detection** — `tandem setup` now detects Claude Desktop installed via MSIX (Microsoft Store) and generates stdio MCP entries for it (#372)

## \[0.7.0] - 2026-04-20

### Added

- **Auth token storage** — on first boot the server generates a 32-byte base64url token and persists it to the platform data directory (`%LOCALAPPDATA%\tandem\Data\auth-token` on Windows, `~/.local/share/tandem/auth-token` on Linux, `~/Library/Application Support/tandem/auth-token` on macOS). Subsequent boots reuse the token. First-boot race is protected by `O_EXCL` file creation. Tauri mode receives the token via `TANDEM_AUTH_TOKEN` env before sidecar spawn and never regenerates.
- **Auth middleware** — non-loopback MCP and API requests require `Authorization: Bearer <token>`. Loopback connections (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) remain exempt, preserving zero-config Claude Code usage. Token comparison uses SHA-256 on both sides before `crypto.timingSafeEqual` to eliminate the length oracle. Rate-limiting (5 attempts / 60 s) keyed by IPv4 address or IPv6 `/64` prefix with LRU eviction; Authorization headers are redacted from all rejection logs.
- **`TANDEM_BIND_HOST` bind-mode selection** — MCP HTTP server binds to `127.0.0.1` by default; set `TANDEM_BIND_HOST=0.0.0.0` (or a specific LAN IP) to expose Tandem on the local network. Hocuspocus WebSocket always stays loopback. Non-loopback bind without a token file exits 1 with guidance; `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` is the escape hatch. Multi-homed machines require `TANDEM_LAN_IP` to be set explicitly.
- **`tandem rotate-token`** — new CLI subcommand that atomically regenerates the auth token, notifies the running server to open a 60-second grace window for in-flight sessions, and re-runs `tandem setup` across all detected MCP config files. Prints old and new token fingerprints (first 8 hex chars of SHA-256). Refuses rotation when `TANDEM_AUTH_TOKEN` is set in the environment (Tauri mode).
- **Token forwarding in stdio bridge, monitor, and channel sidecars** — `tandem mcp-stdio`, `tandem monitor`, and the channel sidecar now forward `TANDEM_AUTH_TOKEN` as `Authorization: Bearer` on upstream HTTP calls. Malformed tokens (empty, `Bearer`-prefixed, < 32 chars, non-URL-safe) exit 1 with a specific message.
- **OAuth protected-resource metadata** — `/.well-known/oauth-protected-resource/mcp` now declares `bearer_methods_supported: ["header"]` and a literal-`localhost` `resource` field per RFC 9728.
- **`/health` session-presence guard** — `hasSession` is omitted from `/health` responses on non-loopback requests, preventing session-presence leakage on LAN binds.

### Security

- Loopback detection keys off `req.socket.remoteAddress` exclusively — `Host` header is never trusted for the loopback bypass decision.
- Fail-closed on LAN bind: `TANDEM_BIND_HOST=0.0.0.0` without a token file exits 1; the server never auto-generates a token and proceeds silently.
- `crypto.randomBytes` failure or non-writable data directory → server exits 1; no silent fallback.

## \[0.6.4] - 2026-04-20

### Fixed

- **Flaky layout-switch E2E test (#281)** — `toHaveCount` assertions on resize-handle locators lacked explicit timeouts, causing intermittent CI failures under load when React re-renders were slower than the default 5 s expectation. All 8 assertions now carry `{ timeout: 10_000 }`, and the missing `right-panel-resize-handle` absence assertion in the tabbed-layout block has been added.
- **Silent crashes in CLI entry points (#336)** — `src/cli/index.ts` and `src/channel/index.ts` lacked `process.once("uncaughtException")` / `process.once("unhandledRejection")` handlers. Uncaught throws in `tandem start`, `tandem setup`, and the Tauri channel sidecar exited silently with code 0, surfacing as "tools never appear" with no diagnostics. Both entries now write a labelled message to stderr and exit 1. The `uncaughtException` handler uses `err: unknown` with an `instanceof Error` guard so non-Error throws (strings, plain objects) produce the actual thrown value rather than `"undefined"`.

## \[0.6.3] - 2026-04-19

### Fixed

- **Annotation GC race on startup (#334)** — `cleanupOrphanedAnnotationFiles` previously ran as a `.then()` chain during boot, racing the boot-path doc opens. On upgrade paths where `sample/welcome.md` or `CHANGELOG.md` hadn't been opened in 30+ days, the GC could unlink the annotation file between read intent and the actual read, silently returning an empty doc. Now `await`-ed before all boot-path opens.
- **Settings Popover extends out of view (#306)** — centered the popover in the viewport with `transform: translate(-50%, -50%)` and added `maxHeight: calc(100vh - 32px)` + `overflowY: auto` so it is always fully visible and internally scrollable on short screens.
- **Dark-mode&#x20;****\*-bg****&#x20;tokens inconsistent (#307)** — `--tandem-success-bg` and `--tandem-warning-bg` in dark mode were hand-coded hex while `--tandem-error-bg` used `color-mix`. All three now use `color-mix(in srgb, var(--tandem-<semantic>) 15%, var(--tandem-surface))` for consistency with light-mode behavior.
- **stdio bridge silent-failure paths (#336 partial)** — three paths in `src/cli/mcp-stdio.ts` (preflight exit, `http.onclose`, `http.start()` TOCTOU) previously closed stdio without writing a JSON-RPC error, producing "tools never appear in Cowork" with no diagnostics. All three now synthesize `-32000` for any in-flight request ID before exit. Remaining #336 items (channel-shim tests, Windows npx smoke, nits) carry to v0.7.0.

### Changed

- **Annotation module internals** — extracted `mergeMap<T>` helper (#324), promoted `UPLOAD_PREFIX` to shared constants (#327), centralized app-data dir resolution in `platform.ts` (#328), extracted `ReplyAuthorSchema`, trimmed module headers, and dropped unused `docContexts` map (#332). No user-facing behavior changes.
- **Annotation serialization upgrades legacy&#x20;****type****&#x20;values on write** (#329) — records with non-canonical `type` (`"suggestion"` / `"question"` / anything outside `highlight` / `comment` / `flag`) are now routed through `sanitizeAnnotation` during snapshot serialization, which rewrites them to `"comment"`. **One-way lossy migration:** users with legacy-type annotations will see `type` flip to `"comment"` on the next durable write for that document — the original distinction between `suggestion` and `question` is not recoverable.
- **migrateToV1****&#x20;reports drop counts** (#330) — `migrateToV1(raw)` now returns `{ doc, droppedAnnotations, droppedReplies }` so future production callers can surface lossy upgrades to users rather than silently discarding malformed records. No production caller exists yet; a follow-up will wire drop counts to `npm run doctor` or a toast when the first caller lands.

### Internal

- Test coverage: `pickWinner`, `SerializedRelPos` edges, UNC paths, upload-path edges (#331); `wireAnnotationStore` perf baseline at 500/1000/5000 annotations (#335).
- Test sweep: stale hex color refs cleaned up post-PR #303 (#309).
- Accessibility: forced-colors fallback audit on PR #303 annotation surfaces (#311).
- CI: typecheck / lint / tests now gate on all PRs regardless of base branch; dropped unused `baseUrl` from `tsconfig.server.json` (#310).

## \[0.6.2] - 2026-04-16

### Fixed

- **Plugin stdio entries crash-loop on Windows** — `tandem-editor@0.6.1`'s published `package.json` shipped `"workspaces": ["packages/*"]`, a dev-only field for the vestigial `packages/tandem-doc/` alias stub. On Windows with Node 24 + npm 11, the presence of `workspaces` in an installed consumer package caused `npx -y tandem-editor …` to fail with `ERR_UNSUPPORTED_ESM_URL_SCHEME` (the bin path was handed to the ESM loader as a raw `c:\…` string instead of a `file://` URL). Claude Desktop's plugin loader spawns the stdio entries via `npx -y`, so both `tandem` and `tandem-channel` crash-exited before any user code ran, manifesting in Cowork sessions as entries that flapped "connecting → gone" and never surfaced `tandem_*` tools. Removed the unused `packages/tandem-doc/` directory and the `workspaces` field; direct `node dist/cli/index.js` invocation was never affected, so the Tauri desktop app's bundled sidecar was fine and only the npm-tarball/`npx` path needed the fix.

## \[0.6.1] - 2026-04-15

### Fixed

- **Tauri desktop app fails to start** — `src/cli/skill-content.ts` reads `skills/tandem/SKILL.md` at module-init via `readFileSync`, and `src/server/mcp/api-routes.ts` transitively imports it, so the bundled sidecar server crashed on startup with `ENOENT: skills/tandem/SKILL.md`. The `skills/` directory was never declared in `src-tauri/tauri.conf.json` bundle resources (latent since the v0.5.1 refactor to read SKILL.md at runtime). Add `"../skills/": "skills/"` so the sidecar's relative path resolution matches the npm-install layout. npm-published 0.6.0 was unaffected because `skills/` ships in the npm tarball via `package.json` `files`.

## \[0.6.0] - 2026-04-15

### Added

- **Plugin bridge to Cowork** — new `tandem mcp-stdio` subcommand is a stdio ↔ HTTP JSON-RPC proxy so Claude Desktop's plugin loader surfaces the full `tandem_*` tool surface into Cowork VM sessions. Verified empirically that plugin-loaded HTTP MCP entries don't bridge to Cowork but plugin-loaded stdio entries do. The plugin's `.claude-plugin/plugin.json` now declares stdio entries for both `tandem` (proxy) and `tandem-channel` (existing shim re-exposed as `tandem channel` subcommand), invoked via `npx -y tandem-editor …` so the plugin cache never needs dev dependencies. Both subcommands share a strict preflight in `src/cli/preflight.ts` that fails fast with a single clear message when the Tandem server isn't running on `localhost:3479`.
- `tandem channel` CLI subcommand — npm-delivered entry for the plugin's `tandem-channel` MCP server; shares runtime with the standalone `src/channel/index.ts` binary via the new `src/channel/run.ts` extraction.
- **Settings expansion** — Settings popover grows from layout/dwell/authorship into a fuller preferences surface:
  - Ctrl+, / Cmd+, hotkey (AZERTY/QWERTZ/IME-safe, survives non-QWERTY layouts)
  - Display Name field, synced live with the StatusBar via a shared `useUserName` hook
  - Reduce Motion toggle (JS-gates all autoscroll paths; defaults to `prefers-reduced-motion`)
  - Text Size S/M/L for editor reading density (browser zoom remains the WCAG 1.4.4 path)
  - Theme Light/Dark/System (CSS custom-property token system on `<html data-theme>` with `forced-colors` support for Windows High Contrast)
- Tier 0 accessibility prerequisites on SettingsPopover: `role="dialog"` + `aria-modal`, focus trap, Escape-to-close, pointerdown outside-dismiss, radiogroup semantics, 24×24 hit targets, focus-return on close

### Changed

- Repo's project-level `.mcp.json` renamed to `.mcp.json.example` and gitignored so it no longer ships inside plugin installs. The plugin's own `.claude-plugin/plugin.json` is authoritative for MCP wiring. Developers who clone the repo should copy the example to `.mcp.json` (gitignored) if they want Claude Code to auto-connect locally.
- Settings heading renamed "Layout Settings" → "Settings"
- Settings popover hardcoded hex values swapped to CSS tokens (remaining components will migrate in a follow-up)
- `shutdownForTests` renamed to `shutdownMonitor` (test-only alias kept for backward compatibility)
- `refreshMode` IIFE now wrapped in an outer `.catch` to keep future synchronous throws off the hot path

### Fixed

- **Monitor preserves last-known&#x20;****documentId** — doc-less events (e.g. `chat:message`) no longer blank out the tracked document, so the shutdown awareness clear always targets a valid document.
- **Monitor exits 1 on shutdown awareness failure** — if the final `clearAwareness` POST fails during SIGINT/SIGTERM, the monitor exits with a non-zero status rather than silently succeeding.
- **/api/setup****&#x20;returns accurate status codes** — 207 on partial failure (some targets configured, some failed) and 500 on total failure, instead of always returning 200.
- **Checkpoint after stdout write** — `lastEventId` is only advanced after `process.stdout.write` returns, so EPIPE on a closed pipe no longer silently skips an event on reconnect.
- **Async EPIPE surfaces as exit(1)** — `process.stdout.on('error')` listener now catches asynchronous EPIPE (plugin host closes pipe mid-stream); monitor exits 1 instead of silently advancing `lastEventId` past lost events.
- **Defensive exit on monitor fallthrough** — the retry loop exits 1 if it ever terminates without hitting the explicit exhaustion path.

## \[0.5.1] - 2026-04-13

### Added

- **Claude Code plugin support** — monitor-based event push (`src/monitor/index.ts`) gives real-time notifications without polling or the channel shim. Install via `claude plugin marketplace add bloknayrb/tandem`.
- **--with-channel-shim****&#x20;opt-in** — `tandem setup --with-channel-shim` writes the legacy `tandem-channel` MCP entry for setups that can't install the plugin.

### Changed

- `tandem setup` no longer writes the `tandem-channel` MCP entry by default — running the plugin and the shim simultaneously produces duplicate event notifications. The shim is now opt-in only via `--with-channel-shim`.

### Fixed

- **Windows update failure** — sidecar is now killed before the NSIS installer runs, preventing "Error opening file for writing: node-sidecar.exe" during updates
- **Mode check fails closed** — `/api/mode` errors now fall back to "solo" at startup (privacy signal, not a permissive default) while the hot-path background refresh keeps the last known good value to avoid mid-session suppression.
- **Retry counter resets on stable uptime** — retry count now resets only after 60s of continuous uptime, not on every delivered event; prevents infinite reconnect loops when the server crashes after each event.
- **Exponential backoff on reconnect** — monitor reconnects use 2s/4s/8s/16s/30s backoff instead of a fixed 2s delay.
- **SIGINT/SIGTERM clears awareness** — monitor posts a final `clearAwareness` before exit so the "Claude is active" indicator doesn't hang in the browser.
- **Per-route fetch timeouts** — `AbortSignal.timeout` enforces budgets per route (connect 10s, mode 2s, awareness 5s, error report 3s) to prevent hung SSE connects or mode lookups from stalling the monitor.
- **SSE parse errors don't advance&#x20;****lastEventId** — JSON parse failures and schema validation errors are logged with event ID + frame tail but do not advance `lastEventId`, so bad events are re-delivered on reconnect rather than silently dropped.
- **SKILL.md corrected** — `question` annotation guidance now uses `type === 'comment' && directedAt === 'claude' && author === 'user'`; all 5 highlight colors listed (yellow, red, green, blue, purple).

## \[0.5.0] - 2026-04-13

### Added

- **Authorship tracking** — Y.Map overlay marks text as user-written or Claude-written, with text-color styling (blue for user, orange for Claude) (#190)
- **Threaded annotation replies** — reply to annotations with back-and-forth conversation threads (#187)
- **Claude cursor decoration** — character-level cursor shows where Claude is editing in real time (#209)
- **Auto-save** — documents save automatically on change; Ctrl+S triggers immediate manual save (#272)
- **Text zoom** — keyboard shortcuts (Ctrl+=/Ctrl+-) for adjusting text size in the Tauri desktop app (#273)
- **Three-panel default layout** — editor, side panel, and chat visible by default (#264)
- **Selection event suppression** — selection events only fire after a chat message is sent, reducing noise (#270)
- V1.0 release plan added to roadmap (#279)

### Fixed

- Session persistence, tab bar horizontal scrollbar, and tab cycling keyboard shortcuts (#278)
- Authorship styling uses text color instead of background highlight; reopen sync corrected
- Annotation replies renamed from Acknowledge/Dismiss to Accept/Reject for clarity

### Changed

- Pinned Hocuspocus and Y.js dependency versions to prevent upstream breakage (#271)
- EOL normalizer added to lint-staged for .yml and .md files (#263)
- Lessons learned applied to codebase and tooling (#280)

## \[0.4.0] - 2026-04-12

### Added

- Tauri v2 desktop app wrapping the existing web editor (macOS, Linux, Windows)
- System tray with menu: Open Editor, Setup Claude, Check for Updates, About, Quit
- Single-instance detection — second launch focuses the existing window instead of opening a duplicate
- Node.js sidecar lifecycle: auto-spawn on startup, health polling, crash restart with exponential backoff
- Auto-updater checks on launch and every 8h; manual check available via tray menu "Check for Updates"
- Cross-platform CI release workflow (macOS arm64/x64, Linux x64, Windows x64) with GitHub Releases
- Window state persistence — position and size remembered across sessions
- Sample file copied to writable data directory on first run (supports read-only app bundles)
- Self-signed code signing for Windows builds in CI
- MCP setup auto-configuration on launch — writes Claude Code/Desktop config without manual `tandem setup`

### Fixed

- Accept `tauri.localhost` origin in WebSocket and CORS checks so the production WebView can connect
- Strip Windows `\\?\` extended-length path prefix returned by Tauri path APIs before passing to Node
- Sidecar binary name resolution corrected for Tauri's platform-specific naming convention
- Self-contained JS bundles via tsup `noExternal` so Tauri doesn't require `node_modules` at runtime
- Poll for port release before restarting after update install, preventing a startup race condition
- Surface last HTTP error in health-poll timeout diagnostics for easier debugging

### Changed

- Updater-unavailable log downgraded from error to debug (reduces noise in dev builds without updater keys)
- Unhandled sidecar events are now logged instead of silently dropped
- Warn when `sample/` directory is missing in release builds
- CI: fail build when updater signing key secret is absent
- CI: summary job catches partial platform build failures rather than reporting false success

## \[0.3.2] - 2026-04-12

### Changed

- **Annotation type unification:** Three semantically identical types (`comment`, `suggestion`, `question`) collapsed into a single `comment` type with optional `suggestedText` and `directedAt` fields. `AnnotationTypeSchema` reduced from 5 values to 3: `highlight`, `comment`, `flag`. (#193, #245, #255)
- **Toolbar:** Three annotation buttons (Comment, Suggest, Ask Claude) replaced with a single Comment button with "Replace" and "@Claude" toggles (#193)
- **Side panel filters:** "Suggestions" → "With replacement", "Questions" → "For Claude" (#193)
- **sanitizeAnnotation()****&#x20;moved to&#x20;****src/shared/sanitize.ts** — now available to both server and client code. Client-side Y.Map reads are sanitized to handle legacy session data. (#255)

### Added

- Link (Ctrl+K), Horizontal Rule, and Code Block buttons in the formatting toolbar (#204)
- Replacement cards show a visual diff — original text in red strikethrough → replacement in green (#195)
- Undo countdown progress bar — a shrinking indicator shows the 10-second undo window (#196)
- Review mode shortcut hints (Y / N / ↑↓ / Z) shown below the Review button (#200)
- Chat anchor previews expand on hover to show full text (#198)
- `disabledTitle` prop on toolbar buttons — annotation buttons show "Select text first" when no text is selected (#197)
- Explicit ✕ close button on the highlight color picker (#203)
- `tandem_comment` now accepts optional `suggestedText` and `directedAt` parameters (#193)
- `sanitizeAnnotation()` normalizes legacy `suggestion`/`question` entries at read boundaries — permanent migration for historical session data (#193)
- Exhaustive type switch in `buildDecorations` catches unhandled annotation types at compile time (#255)
- 8 new tests covering MCP tool params, sanitization edge cases, and legacy migration paths (#255)

### Fixed

- Toolbar wraps to a second row on narrow windows instead of overflowing; inline inputs shrink responsively (#192)
- Edit button on annotation cards now shows a visible "✎ Edit" label instead of icon-only (#201)
- Client-side legacy annotations (from pre-0.3.2 sessions) no longer render as invisible decorations or display raw JSON (#255)
- `sanitizeAnnotation` no longer drops `textSnapshot: ""` or `editedAt: 0` via falsy-check bug (#255)
- Event queue observer no longer silently dies if `sanitizeAnnotation` throws (#255)
- `handleEdit` catch-block no longer corrupts annotation data on JSON parse failure (#255)

### Deprecated

- `tandem_suggest` MCP tool — use `tandem_comment` with `suggestedText` parameter instead (#193)

### Removed

- **MCP wire change:** Removed unused `"overlay"` annotation kind from `AnnotationTypeSchema`. External clients sending `type: "overlay"` will now receive a Zod validation error. (#249)
- **MCP wire change:** `suggestion` and `question` annotation types removed from `AnnotationTypeSchema`. Use `comment` with `suggestedText` or `directedAt` fields. Legacy data is migrated automatically via `sanitizeAnnotation()`. (#193)

## \[0.3.0] - 2026-04-07

### Wave 4: Notification & Interruption Redesign

- **Solo/Tandem mode** replaces All/Urgent/Paused interruption controls (#207, #226)
- **Dwell-time selection events** — selections fire after 1s hold (#188)
- **Configurable layout** — tabbed or three-panel, with settings popover (#206)
- **Click-to-navigate** — click annotated text to jump to annotation card
- **Tab badges** — notification counts on inactive panel tabs
- **Skill-directed response routing** — Claude responds in chat panel, not terminal
- Review banner replaced with per-annotation toasts (#208, landed earlier)
- `Y_MAP_MODE` constant, Zod validation for mode reads, error logging in channel event bridge
- 894 tests passing

## \[0.2.12] - 2026-04-06

### Added

- Undo/redo toolbar buttons powered by Y.js UndoManager — tracks document edits with proper CRDT-aware undo scoping (#189, #210)
- Adjustable editor content width toggle — switch between comfortable and full-width layouts, preference persists in localStorage (#185, #205)
- SVG icons for unordered list, ordered list, and blockquote toolbar buttons, replacing plain text labels (#194)
- Automated npm publishing via GitHub Actions with OIDC trusted publisher (tokenless)

### Fixed

- Guard all localStorage access with try-catch for private/disabled browser storage modes; reset scroll position on annotation filter clear (#212, #202)

## \[0.2.11] - 2026-04-06

### Added

- Auto-reload documents when files change on disk — Tandem detects external edits (e.g., Claude's Edit tool) via `fs.watch`, reloads content, and preserves existing annotations (#175)
- File watcher module with 500ms debounce and self-write suppression (prevents reload loops when Tandem saves)
- Toast notification when a document is reloaded from disk
- Runtime warning when `onDocSwapped` callback is missing during Hocuspocus doc swap (defensive guard for #178 audit)
- 28 new tests: observer reattachment, CTRL\_ROOM lifecycle, buffer cap, file watcher debounce/suppress, annotation-preserving reload

### Fixed

- Dead CRDT `relRange` handling — `refreshRange` now strips broken CRDT anchors and re-anchors from flat offsets instead of leaving annotations permanently stuck with non-functional RelativePositions (#175)
- Buffer cap test was previously a no-op (empty loop body) — now actually exercises the event queue buffer (#178)

### Changed

- CLAUDE.md gotcha for Hocuspocus doc replacement updated to document the automatic `onDocSwapped` callback lifecycle (#178)

## \[0.2.10] - 2026-04-05

### Added

- Resizable side panel — drag to resize between 200–600px, width persists in localStorage
- Accessibility: ARIA labels on annotation highlights (type-specific), annotation cards (`role="listitem"`, `aria-current`), annotation list (`role="list"`), review mode button (`aria-pressed`), live region for pending count and review progress

### Fixed

- Flaky session tests — each test file now uses an isolated temp directory via `vi.mock`, eliminating cross-file race conditions (#177)
- Session file writes use atomic rename with retry on Windows EPERM/EACCES (#173)

### Changed

- `atomicWrite()` extracted as shared helper in session manager — consolidates duplicate write-tmp-rename logic with exponential backoff retry

## \[0.2.9] - 2026-04-05

### Fixed

- Changelog tab no longer disappears after upgrade — version check and sample/welcome.md now open before servers start, preventing CRDT merge races with stale browser tabs
- Tutorial annotation injection errors now get their own log message instead of being misattributed as file-open failures

## \[0.2.8] - 2026-04-05

### Added

- CHANGELOG.md opens as the active tab on first startup after an npm update
- `checkVersionChange` helper tracks version transitions via `last-seen-version` file
- CHANGELOG.md now ships in the npm package

## \[0.2.7] - 2026-04-05

### Fixed

- Force-reload (`tandem_open` with `force: true`) now clears Y.Doc in-place instead of destroying the Hocuspocus room — sidebar, observers, and connections survive
- TOCTOU fix: session deletion moved after successful reload transaction
- Observer ownership table corrected in architecture docs

### Added

- 4 new tests for force-reload (annotation clearing, awareness clearing, .txt reload, metadata)

## \[0.2.6] - 2026-04-05

### Fixed

- Demo script rewritten to be self-referential for recording
- Observer ownership documentation added to architecture.md

## \[0.2.5] - 2026-04-05

### Fixed

- `tandem setup` Claude Code MCP config path updated

## \[0.2.4] - 2026-04-05

### Fixed

- Security audit findings (DNS rebinding, CORS, input validation)

## \[0.2.3] - 2026-04-05

### Fixed

- `tandem setup` now writes Claude Code MCP config to `~/.claude.json` instead of `~/.claude/mcp_settings.json`, which Claude Code no longer reads

## \[0.2.2] - 2025-04-05

### Fixed

- Silent failure review findings

## \[0.2.1] - 2025-04-05

### Fixed

- Full security audit — 25 findings across 7 categories (#172)

## \[0.2.0] - 2025-04-04

### Added

- Initial public release on npm as `tandem-editor`
- 30 MCP tools for collaborative document editing
- Multi-document tabs with CRDT-anchored annotations
- Chat sidebar with real-time channel push
- Support for .md, .docx, .txt, .html files
- `tandem` CLI with `setup` and `start` commands
- Claude Code skill auto-installation
