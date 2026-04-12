# Changelog

All notable changes to Tandem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-04-12

### Changed

- **Annotation type unification:** Three semantically identical types (`comment`, `suggestion`, `question`) collapsed into a single `comment` type with optional `suggestedText` and `directedAt` fields. `AnnotationTypeSchema` reduced from 5 values to 3: `highlight`, `comment`, `flag`. (#193, #245, #255)
- **Toolbar:** Three annotation buttons (Comment, Suggest, Ask Claude) replaced with a single Comment button with "Replace" and "@Claude" toggles (#193)
- **Side panel filters:** "Suggestions" → "With replacement", "Questions" → "For Claude" (#193)
- **`sanitizeAnnotation()` moved to `src/shared/sanitize.ts`** — now available to both server and client code. Client-side Y.Map reads are sanitized to handle legacy session data. (#255)

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

## [0.3.0] - 2026-04-07

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

## [0.2.12] - 2026-04-06

### Added

- Undo/redo toolbar buttons powered by Y.js UndoManager — tracks document edits with proper CRDT-aware undo scoping (#189, #210)
- Adjustable editor content width toggle — switch between comfortable and full-width layouts, preference persists in localStorage (#185, #205)
- SVG icons for unordered list, ordered list, and blockquote toolbar buttons, replacing plain text labels (#194)
- Automated npm publishing via GitHub Actions with OIDC trusted publisher (tokenless)

### Fixed

- Guard all localStorage access with try-catch for private/disabled browser storage modes; reset scroll position on annotation filter clear (#212, #202)

## [0.2.11] - 2026-04-06

### Added

- Auto-reload documents when files change on disk — Tandem detects external edits (e.g., Claude's Edit tool) via `fs.watch`, reloads content, and preserves existing annotations (#175)
- File watcher module with 500ms debounce and self-write suppression (prevents reload loops when Tandem saves)
- Toast notification when a document is reloaded from disk
- Runtime warning when `onDocSwapped` callback is missing during Hocuspocus doc swap (defensive guard for #178 audit)
- 28 new tests: observer reattachment, CTRL_ROOM lifecycle, buffer cap, file watcher debounce/suppress, annotation-preserving reload

### Fixed

- Dead CRDT `relRange` handling — `refreshRange` now strips broken CRDT anchors and re-anchors from flat offsets instead of leaving annotations permanently stuck with non-functional RelativePositions (#175)
- Buffer cap test was previously a no-op (empty loop body) — now actually exercises the event queue buffer (#178)

### Changed

- CLAUDE.md gotcha for Hocuspocus doc replacement updated to document the automatic `onDocSwapped` callback lifecycle (#178)

## [0.2.10] - 2026-04-05

### Added

- Resizable side panel — drag to resize between 200–600px, width persists in localStorage
- Accessibility: ARIA labels on annotation highlights (type-specific), annotation cards (`role="listitem"`, `aria-current`), annotation list (`role="list"`), review mode button (`aria-pressed`), live region for pending count and review progress

### Fixed

- Flaky session tests — each test file now uses an isolated temp directory via `vi.mock`, eliminating cross-file race conditions (#177)
- Session file writes use atomic rename with retry on Windows EPERM/EACCES (#173)

### Changed

- `atomicWrite()` extracted as shared helper in session manager — consolidates duplicate write-tmp-rename logic with exponential backoff retry

## [0.2.9] - 2026-04-05

### Fixed

- Changelog tab no longer disappears after upgrade — version check and sample/welcome.md now open before servers start, preventing CRDT merge races with stale browser tabs
- Tutorial annotation injection errors now get their own log message instead of being misattributed as file-open failures

## [0.2.8] - 2026-04-05

### Added

- CHANGELOG.md opens as the active tab on first startup after an npm update
- `checkVersionChange` helper tracks version transitions via `last-seen-version` file
- CHANGELOG.md now ships in the npm package

## [0.2.7] - 2026-04-05

### Fixed

- Force-reload (`tandem_open` with `force: true`) now clears Y.Doc in-place instead of destroying the Hocuspocus room — sidebar, observers, and connections survive
- TOCTOU fix: session deletion moved after successful reload transaction
- Observer ownership table corrected in architecture docs

### Added

- 4 new tests for force-reload (annotation clearing, awareness clearing, .txt reload, metadata)

## [0.2.6] - 2026-04-05

### Fixed

- Demo script rewritten to be self-referential for recording
- Observer ownership documentation added to architecture.md

## [0.2.5] - 2026-04-05

### Fixed

- `tandem setup` Claude Code MCP config path updated

## [0.2.4] - 2026-04-05

### Fixed

- Security audit findings (DNS rebinding, CORS, input validation)

## [0.2.3] - 2026-04-05

### Fixed

- `tandem setup` now writes Claude Code MCP config to `~/.claude.json` instead of `~/.claude/mcp_settings.json`, which Claude Code no longer reads

## [0.2.2] - 2025-04-05

### Fixed

- Silent failure review findings

## [0.2.1] - 2025-04-05

### Fixed

- Full security audit — 25 findings across 7 categories (#172)

## [0.2.0] - 2025-04-04

### Added

- Initial public release on npm as `tandem-editor`
- 30 MCP tools for collaborative document editing
- Multi-document tabs with CRDT-anchored annotations
- Chat sidebar with real-time channel push
- Support for .md, .docx, .txt, .html files
- `tandem` CLI with `setup` and `start` commands
- Claude Code skill auto-installation
