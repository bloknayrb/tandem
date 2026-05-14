# Changelog

All notable changes to Tandem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),\
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v0.12.0

### Fixed

- **OS file-association review fixes round 2 (#628 follow-up)** — three additional findings from a multi-PR review pass:
  - `restart_sidecar` now clears `SIDECAR_HEALTHY` via a new `clear_healthy_under_lock` helper that takes the `PendingOpens` mutex, mirroring `promote_healthy_and_drain`'s consumer-side flip. A bare atomic store outside the lock re-opened the same TOCTOU window the lock was introduced to close: a macOS `RunEvent::Opened` reading flag=true after `kill_sidecar` but before the clear could POST to a dying server. New `pending_opens_tests::restart_clears_flag_under_lock_so_late_producer_queues` materializes the proof.
  - `handle_opened_urls` hoists `token_store::get_or_create_token` out of the per-URL loop. An "Open With Tandem" multi-file batch now hits the keyring once instead of N times. Mirrors `post_drained_paths`.
  - `extract_file_arg` now documents that `is_file()` follows symlinks intentionally — the final read goes through server-side `openFileByPath` which is the authority for path validation. Prevents a future reviewer from "tightening" this into `symlink_metadata`-based checks and duplicating the server's allowlist.
- **OS file-association review fixes (#628 follow-up)** — six fixes addressing findings from a multi-agent review pass on the cold-start file-open path:
  - Cold-start file is now resolved once in Tauri's `setup()` and threaded into `start_sidecar` as an explicit parameter. `restart_sidecar` passes `None`, so a Settings → Restart Sidecar (or any auto-restart) no longer re-injects `TANDEM_OPEN_FILE` and never re-opens the original launch file.
  - Closed the `PendingOpens` drain TOCTOU window by serializing `SIDECAR_HEALTHY` access through the queue mutex on both consumer (`promote_healthy_and_drain`: flip flag + drain in one critical section) and producer (`try_queue_or_post`: check flag under same lock before push). Eliminates the load-before-push race the original drain-then-flip ordering left open.
  - Windows NTFS Alternate Data Stream colon check now runs on the resolved absolute path (post-`cwd.join`), not just the argv candidate. Closes a gap where a relative path with a suspiciously-positioned colon could slip through.
  - `maybeOpenStartupFile` catch narrowed to wrap `openFileByPath` only; `setActiveDocId` failures (programming-bug class) now propagate to the top-level startup error handler instead of being silently swallowed.
  - When `TANDEM_OPEN_FILE` is set but fails to open and the welcome.md fallback fires, a distinct "Falling back to welcome.md" log line correlates the two events for support diagnostics.
  - `token_store::get_or_create_token` errors are logged at warn level at all three call sites (no functional impact today since loopback bypasses Bearer enforcement; removes a silent-failure footgun if LAN bind is ever enabled).
- **Markdown serializer escape noise on `.md` saves (#605, v1.0 blocker)** — every `.md` file Tandem auto-saved was silently rewritten with backslash-escape noise by `remark-stringify`'s default `unsafe` table (`[anchor]` → `\[anchor]`, `foo_bar` → `foo\_bar`, etc.). The serializer in `src/server/file-io/markdown.ts` now overrides the `text` handler to call `state.safe()` (preserving block-context escapes for line-leading `# `, `- `, `> `, fence runs, table pipes, setext underlines) and then selectively un-escape four intra-text classes: `\[label]` when `label` is not a `definition` identifier in the same tree (parse-aware via a `unist-util-visit` pre-pass — guards against the collapsed-reference-link regression class; label is normalized per CommonMark; negative lookahead also rejects an immediately following `[` to block adjacent-bracket reference-link injection; label character class excludes `\` to prevent O(n²) backtracking on adversarial input like `\[\[\[\[\[…`), `\_` strictly between word chars (CommonMark §6.2 intra-word flanking rule), standalone `` \` ``, and `\~` not followed by another `~` (GFM strikethrough needs `~~`). GFM autolink-literal `@`/`.`/`:` and table `|` escapes still flow through `safe()` untouched. `CHANGELOG.md` was re-serialized through the fixed code as a one-time data cleanup. The `readOnly: true` workaround on the upgrade auto-open path (PR #603) is retained as defense-in-depth.

### Added

- **15 keyboard shortcuts (#626)** — grouped by area:

  - **Tabs:** `Ctrl+W` close active tab (records to in-memory LIFO), `Ctrl+Alt+T` reopen most-recently-closed tab, `Ctrl+1`..`Ctrl+9` jump to tab by index, `Ctrl+O` open file dialog.
  - **Find / outline:** `Ctrl+F` focus outline search when outline panel is visible, otherwise open find bar (doc scope); `Ctrl+Shift+F` open find bar pre-scoped to "Open tabs"; `Ctrl+G` / `Ctrl+Shift+G` find next/previous (falls back to opening find bar when no active query).
  - **Panels / chrome:** `Ctrl+\` toggle left panel, `Ctrl+Shift+\` toggle right panel, `Ctrl+Shift+M` toggle solo/tandem mode.
  - **Annotations:** `Alt+]` / `Alt+[` next/previous annotation; `Ctrl+Enter` / `Ctrl+Shift+Enter` accept/dismiss focused annotation; `Ctrl+Alt+M` open the comment popup on current selection; `Ctrl+Alt+A` toggle authorship colors.
  - **Editor polish:** `Alt+L` select containing block (paragraph / heading / list item).

  All letter shortcuts use `KeyboardEvent.code` (e.g. `KeyT`, `KeyM`) rather than `e.key` so they remain layout-independent (Dvorak / AZERTY) and fire correctly on macOS when Option is held — `Option+letter` produces alt characters (`†`, `µ`, `¬`, `å`) that don't match the unmodified letter `e.key`. Digits and Backslash already used `e.code`; Enter is layout-stable and remains on `e.key`. `Ctrl+M` vs `Ctrl+Shift+M` discrimination is now explicit (`!e.shiftKey` / `e.shiftKey`).

  `reopenClosedTab` now checks `response.ok` so server-side 4xx/5xx no longer silently drop the popped record (fetch only rejects on network failures). Failure restores the record onto the stack and surfaces a toast with the basename so the user can retry; previously a failed reopen was logged to devtools only and the record was lost.

  `Ctrl+Alt+M` distinguishes its preconditions: no selection → "Select text to comment"; read-only doc → "Document is read-only"; palette/find open → silent (the user is in a different UI context); selection toolbar setting off → "Enable selection toolbar in Settings to comment via keyboard". A single toast string would have misfired in three out of four cases.

  `useNotifications` now exposes a `push()` method so client-originated UI feedback (the toasts above) can be surfaced through the same toast container as server-pushed notifications, instead of `console.warn`-ing into devtools the user never opens.

### Known Issues

- **`reloadFromDisk` two-write crash window (#622, v0.12.0 fix)** — when the file watcher detects an external edit, `reloadFromDisk` runs `refreshAllRanges` (own `MCP_ORIGIN` transact) and then a relocation pass (separate `MCP_ORIGIN` transact). Both flow through the durable-annotation sync observer. If the server is killed between the two transactions, durable annotation state can be left at partially-refreshed ranges. Pre-existing in master (not introduced by PR #621; surfaced by audit v2). Bounded by the narrow synchronous window between the two transactions. Tracked for fix in v0.12.0 via a `skipTransact` parameter on `refreshAllRanges` so reload can merge both passes into a single transaction.

### Fixed

- **Codebase leanness audit v2 (PR #621)** — eight-step audit (`docs/audit-v2.md`) covering dead code, dependency bloat, over-engineering, wrong-tool-for-the-job, and stale docs. Validated by four domain reviewers (annotation-model, crdt, security, svelte-migration) before any deletion. Outcomes:
  - **A1:** `reloadFromDisk` (file-watcher reload path in `mcp/file-opener.ts`) — first transaction (content repopulate + awareness clear) tagged `FILE_SYNC_ORIGIN` so the durable-annotation sync observer skips re-persisting state just loaded from disk. The second transaction (textSnapshot-driven relocation pass) stays `MCP_ORIGIN` so its writes persist (caught during the post-merge CRDT review).
  - **A2 + A2b:** Tutorial note now uses `author: "user"` (per ADR-027 — notes are user-private). `useTutorial.svelte.ts` updated to exclude tutorial-seeded annotations from its user-action detection so the step-1 → step-2 advance still gates on a real user-created annotation.
  - **A3:** Six `INVALID_RANGE` error codes in `mcp/annotations.ts` replaced with `NOT_FOUND` / `ANNOTATION_RESOLVED` / `INVALID_ARGUMENT`. `ToolErrorCodeSchema` extended to document the codes the code already uses.
- **Tab drag-to-reorder unblocked in Tauri + browser, then hardened against mid-drag races (PR #625)** — drag-to-reorder document tabs was wired end-to-end but didn't actually move tabs. Two independent root causes plus two follow-up refinements landed together: (1) **Tauri:** WebView2 on Windows defaults to `dragDropEnabled: true`, which routes all drag-drop through Tauri's native handler and blocks in-page HTML5 DnD entirely — flipped to `false` in `tauri.conf.json` (`useFileDrop.svelte.ts` already uses HTML5 `dataTransfer.files`, so OS file drops still work). (2) **Browser + Tauri:** an `$effect(() => { void tabs.length; clearDragState(); })` in `DocumentTabs.svelte` cleared `draggedId` / `dropTarget` whenever the `tabs` prop reference changed, so any upstream Yjs awareness / settings ping that re-derived `orderedTabs` during a drag nulled the drag state mid-flight; removed, and `handleDrop` now prefers closure-captured `draggedId` over `dataTransfer.getData("text/plain")` as defense-in-depth. (3) **Refinements:** a narrower replacement `$effect` clears drag state only when the dragged or target id actually disappears from `tabs` (mid-drag tab close — `dragend` doesn't fire reliably when the source element leaves the DOM), and `handleDragOver` now gates `e.preventDefault()` on `draggedId` being set so foreign drags (file from Explorer, now reachable in WebView thanks to `dragDropEnabled: false`) get the OS no-drop cursor instead of being silently swallowed. New `tests/client/DocumentTabs.svelte.test.ts` pins the original regression (case B fails red with the deleted effect re-added); the E2E `mouse drag reorders tabs` spec dispatches real HTML5 `DragEvent`s via `page.evaluate` because Playwright's `locator.dragTo()` synthesizes mouse events only and never fires HTML5 drag events.
- **Large markdown documents no longer freeze the editor on open (PR #612, closes #609)** — `loadContentIntoDoc` now batches the entire `mdastToYDoc` populate into a single `MCP_ORIGIN` transaction. Previously each `fragment.insert` / `xmlText.insert` fired its own CRDT update; on a ~4500-token document this flooded `y-prosemirror` with thousands of tiny updates, saturated the event loop, and tripped Hocuspocus disconnects. The shared `populateDocFromContent` helper now batches both the disk-open path (`openFileByPath`) and the upload path (`openFileFromContent`), so drag-dropped large markdown files no longer freeze either. Matches the existing `clearAndReload` / `reloadFromDisk` batching shape.
- **`.docx` files with malformed Word comments no longer abort the entire document open (PR #612)** — `injectCommentsAsAnnotations` runs inside the same flatten-into-outer transact as `htmlToYDoc`, so a single bad comment range used to throw out of the whole populate. The inject call is now contained per-comment with partial-write rollback (Yjs does not roll back inner-transact writes on throw, so we snapshot annotation keys before the inject and undo any that landed before the failure). Comment-extraction failures additionally surface as a warning notification instead of disappearing into the server log. Comment-injection failures (rare unhandled exceptions during annotation write) now surface as a warning notification too — symmetric with the extract-failure path, so the user always sees feedback when imported comments go missing.
- **Populate failures no longer poison the Y.Doc cache (PR #612)** — `populateDocFromContent` clears partial fragment + annotation state in a fresh top-level `MCP_ORIGIN` transact before rethrowing. Previously, a populate throw would leave the Hocuspocus-cached Y.Doc with half-applied content, and a retry would silently inherit the corrupted state.
- **Coalesce annotation decoration rebuilds with rAF (closes #610)** — `src/client/editor/extensions/annotation.ts` rebuilt the entire `DecorationSet` synchronously on every Y.Map('annotations') observer fire. On initial sync of a document with hundreds of annotations (force-reload, session restore, docx import) the observer can fire dozens of times in one tick — each one O(n) over every annotation — making the burst O(n²). The view-side observer now coalesces fires through `requestAnimationFrame`: one rebuild per frame, regardless of how many Y.Map mutations land in the burst. Adds a 500ms post-sync settle rebuild mirroring the `authorship.ts:223` pattern so initial-sync annotations land even if the observer attached before y-prosemirror populated the doc.

### Internal

- **Audit tooling (PR #621)** — added `knip` (devDep) + `audit:origins` + `audit:ymap-keys` scripts under `npm run`. `audit:origins` rewritten with the TypeScript compiler API after the initial regex+line-window heuristic produced 13/13 false positives.
- **Five Y.Map raw-key fixes (PR #621)** — `channel-routes.ts`, `document.ts`, `file-opener.ts` now use `Y_MAP_CLAUDE` / `Y_MAP_READ_ONLY` constants instead of raw string literals (Critical Rule #1 violations; functionally equivalent — same string values).
- **Dead-code sweep (PR #621)** — removed 13 React-migration stub files (`hooks/use*.ts` left as `export {};` after Svelte 5 port), 5 server exports (`killClaude`, `getHocuspocus`, `getClaudeStatus`, `AwarenessState`, `shutdownForTests` alias + test migration), 7 unused shared constants + 2 unused types, 4 unused client exports (`unregisterAction` / `unregisterByPrefix` / `getActions` from action registry; `createEditorFont`), 3 unused color exports (`errorStateColors` / `successStateColors` / `suggestionStateColors`), and 2 dependencies (`@tiptap/extension-unique-id`, `concurrently`). 11 commits, ~250 LOC removed, all CI green.
- **Centralize Tandem HTTP API paths into shared constants (closes #283)** — every `/api/*` path (registration + every client/CLI/channel/monitor fetch) now flows through `src/shared/api-paths.ts`. `API_BASE` in `src/client/utils/fileUpload.ts` no longer carries the `/api` suffix; clients build URLs as `${API_BASE}${API_FOO}`. Renaming a route now touches one file instead of N. Source-level coverage tests in `tests/channel/run-timeouts.test.ts` and `tests/monitor/runtime-fetches.test.ts` accept either the literal path or the resolved `API_*` constant.
- **Define `ChannelErrorCodeSchema` enum for `/api/channel-error` payloads (closes #284)** — channel-shim and monitor failure codes (`CHANNEL_CONNECT_FAILED`, `MONITOR_CONNECT_FAILED`) are now z.enum constants in `src/shared/types.ts` instead of free-form strings. The server route handler validates the incoming `error` field and returns 400 on unknown codes (still logs the rejected value so the diagnostic trail survives). Mirrors the existing `ToolErrorCodeSchema` pattern.
- **Extract shared `onOutsideEvent` dismiss helper (closes #589)** — `Toolbar.svelte` (scroll-based dismiss) and `HighlightColorPicker.svelte` (mousedown-based dismiss) both rolled their own document-listener + `contains(event.target)` guard. Consolidates into `src/client/utils/dismiss-outside.ts`. Capture-phase parity preserved at each call site.
- **Route `clearAndReload` through `populateDocFromContent` (closes #611)** — the force-reload path was the last remaining inline duplication of `loadDocx` + `extractDocxComments` + `htmlToYDoc` + `injectCommentsAsAnnotations`. Routing it through the shared helper means the rollback containment, partial-write cleanup, and comment-extract/inject notification UX that #612 added to the normal-open path now also apply on force-reload. Net delete: ~50 LOC, zero functional regressions.

### Changed

<!-- Populated as PRs land. -->

### Deferred

<!-- Populated as PRs land. -->

## [0.11.2] - 2026-05-13

### Fixed

- **`effect_update_depth_exceeded` on Tauri launch (PR #614, closes #613)** — installed v0.11.1 desktop builds threw Svelte's effect-depth error immediately on launch; the dev build (`npm run dev:tauri`) did not reproduce, narrowing the trigger to production-mode effect-flush scheduling. Three defense-in-depth fixes: (1) the authorship-toggle effect in `App.svelte` no longer dispatches a ProseMirror transaction on its first run — the plugin already reads `localStorage[AUTHORSHIP_TOGGLE_KEY]` at construction so the editor starts in the correct state; (2) rail-tab reconcile effects now `untrack` their writes to break any read-then-write self-dep; (3) the SettingsPopover error-clear effect skips assignment when values are already null. The existing in-code comment had explicitly warned this dispatch could "exceed the 1000-update depth limit"; under prod's tighter effect scheduling it did.

## [0.11.1] - 2026-05-13

### Added

- **Settings sidebar redesign (PR #600)** — pulls the Claude Design redesign's settings sidebar pattern into the existing tabbed popover. Each nav item gains an inline SVG icon; the sidebar header carries a live version chip from `/api/info`; a new persistent sidebar footer surfaces Changelog, Report-a-bug, and an MCP-connected status dot from every section instead of hiding them under About. `TANDEM_REPO_URL` and `TANDEM_ISSUES_NEW_URL` extracted to `shared/constants` and the three repo links routed through them.
- **Single titlebar consolidating all app chrome (PR #602)** — Tandem brand, Solo/Tandem mode toggle, Claude-active dot, authorship toggle, panel toggles, theme cycle, help, and settings are now in one titlebar row; the secondary toolbar row is deleted. Comment and Note now live exclusively in the floating selection popup (`popup-annotation-input`). Titlebar background uses `--tandem-surface-muted` so it blends with the formatting bar instead of looking like a lighter Windows chrome strip. `THEME_NEXT`/`THEME_LABEL` lookup tables replace the nested-ternary theme rotation; the orphan `useTabDirty` hook and stale `TitleBar.test.ts` are deleted. New testid: `title-bar`.

### Changed

- **`@tauri-apps/api` bumped to 2.11.x** — Tauri CLI v2.11+ enforces major.minor parity between the Rust crate and the npm package. The crate is at 2.11.1; the npm package was at 2.10.1, causing all platform builds to fail. This restores Tauri build parity.

### Fixed

- **Release-mode sidecar always spawns its own server (PR #601)** — a stale `tsx watch src/server/index.ts` from a `npm run dev:server` session was squatting on ports 3478/3479 and answering `/health`, so `start_sidecar` reused it and left the installed app's UI stuck on "Disconnected" — hover and right-click working, but every action that needed the server failing silently because the auth/session state didn't match. The `check_health` early-return is now gated on `cfg!(debug_assertions)` so the dev workflow (`cargo tauri dev` + `npm run dev:standalone`) still benefits from health-reuse, but installed builds never reuse a foreign sidecar. Also drops `stdio: "ignore"` from the Windows `taskkill` path so any future port-bind failure surfaces in logs instead of silently failing; `freePortWindows` now uses `execFileSync` (no shell).
- **CHANGELOG.md no longer rewritten on upgrade (PR #603)** — on version upgrade the app auto-opens `CHANGELOG.md` so the user can see what changed. Previously this opened writable, and the 60-second autosave timer would round-trip the file through `remark-stringify` with default escaping, leaving cosmetic backslash-escape noise on disk (`[1.0.0]` → `\[1.0.0]`, escaped underscores and backticks). The upgrade auto-open path now passes `readOnly: true`, matching the existing "View Changelog" button in Settings; autosave skips read-only documents so the file is not re-serialized. The underlying `remark-stringify` over-escape (which affects every `.md` round-tripped through Tandem) is tracked as #605 for v0.12.0.
- **Display name truncated to `USER_NAME_MAX_LEN` (PR #604, closes #599)** — `resolveUserName` now slices to the 40-char limit, plugging the gap where `persistUserName` and `subscribeToUserName`'s storage handler could persist or broadcast unbounded names from programmatic `setUserName` calls or legacy localStorage values. The `<input maxlength>` cap on the typed-input path remains; this fix covers the non-UI entry points. One slice in `resolveUserName` covers all three callsites.
- **Tutorial annotations now actually appear in `welcome.md` (PR #607)** — commit `acb81fd` (Mar 2026) rewrote welcome.md's intro paragraph but didn't update the matching `targetText` anchors in `tutorial-annotations.ts`. `indexOf("collaborative document editor")` and `indexOf("review your documents")` both returned -1 and 2 of 4 tutorial annotations silently failed to inject. Re-pointed the anchors to phrases that exist in current welcome.md (each occurs exactly once).
- **Titlebar review fixes (part of PR #602)** — async `onMount` listener-leak guard (in-flight Tauri-API awaits self-clean if the component unmounts mid-resolve), window controls correctly show disabled state when Tauri init fails, action-oriented theme button labels for WCAG 4.1.2 ("Switch to dark theme" describes the click outcome, not the current state), and `setup_overlay_titlebar` failure logged at error severity. New regression test `titlebar-listener-leak.test.ts` covers the unmount-mid-await path.
- **Settings changelog error surfacing (part of PR #600)** — the Changelog button lives in the always-rendered sidebar footer, but its error message used to live inside the About panel's `{:else}` arm — users on any other section got no feedback when a fetch failed. The error display now sits adjacent to the button and clears on section change.

### Internal

- **Token-violation hook promoted to blocking** — `check-token-violation.sh` PostToolUse hook now exits 2 (blocking) with `continueOnBlock` framing redirected to stderr so Claude Code sees actionable `file:line` details from the semantic-token scanner instead of silently warning. Hook framing aligned with `block-no-verify.sh` and `block-e2e-port-kill.sh`.

## [0.11.0] - 2026-05-11

### Added

- **Audience-first selection popup (AR3, PR #590)** — Replaces the three-mode state machine (`idle → comment | note`) with a unified popup that appears on text selection. The user types first and chooses audience at submit time via two buttons: "Comment" (sends to Claude, requires text) and "Note to self" (private, always enabled). Bold/Italic formatting and highlight color swatches remain as one-click actions in the top row. Enter submits as Comment; Shift+Enter inserts a newline; Escape dismisses. `InputGroup.svelte` deleted. New testids: `popup-annotation-input`, `popup-note-submit`, `popup-comment-submit`, `popup-highlight-{yellow|green|blue|pink}`.
- **Five annotation visual languages (AR2, PR #586)** — Claude-authored comments now render with a solid underline (`--tandem-author-claude`) instead of the same dashed style as user comments. All annotation inline decorations carry a `data-annotation-author` attribute for CSS targeting (e.g. theme overrides, annotation-patterns mode). The five languages are now fully distinct: highlight (colored bg), note (dotted muted underline), user comment (dashed blue), Claude comment (solid orange underline), suggestion (wavy violet).
- **Annotation schema foundation — audience model (AR1, PR #583)** — adds three optional fields to `AnnotationBase`: `audience` (`"private" | "outbound"`), `promotedFrom` (`"note"`), and `importSource` (`{ author, file }`). `sanitize.ts` derives `audience` on every read for legacy annotations (highlight/note/flag → `"private"`, comment → `"outbound"`, import → `"private"` per design brief). Wire-shape change: all MCP tool responses and channel events now include `audience`. Backward-compatible — existing annotations gain the field on first read; no data loss.
- **Command palette + action registry (closes #571)** — Ctrl+Shift+P opens a fuzzy-search command palette. A central action registry (`src/client/actions/registry.ts`) is the new source of truth for commands and their display shortcuts; the Settings → Shortcuts tab now derives its content from the registry rather than a hardcoded array. Ctrl+S and Ctrl+, are migrated from dedicated hook files into the global keydown handler; `useSaveShortcut.svelte.ts` and `useSettingsShortcut.svelte.ts` are deleted. ADR-029 records the design. New testids: `command-palette`, `palette-input`, `palette-item-{id}`, `palette-empty`.
- **Find / Replace bar (closes #570)** — Ctrl+F opens a find bar anchored to the bottom-right of the editor. Highlights all matches in the document using the existing highlight-yellow token; active match gets a warning-bg border. Enter / Shift+Enter cycle through matches. Replace replaces the active match and advances; All replaces in 100-match chunks to keep Yjs updates bounded. Regex-mode toggle (off by default) with inline error for invalid patterns. All options are session-only (not persisted). New testids: `find-replace-bar`, `find-input`, `replace-input`, `find-next-btn`, `find-prev-btn`, `replace-btn`, `replace-all-btn`, `find-close-btn`, `find-match-count`, `find-regex-toggle`, `find-case-toggle`, `find-word-toggle`.
- **Outline panel for H1–H3 navigation (closes #569)** — Settings → Appearance now offers a "Left Panel" radio (Side / Outline). When Outline is selected, the side/annotations panel is replaced with a compact heading navigator. Click any heading to jump the cursor. Roving tabindex for keyboard navigation. Disabled with explanatory text when the Tabbed layout (no left panel) is active. New testids: `outline-panel`, `outline-heading-{level}-{index}`, `left-slot-kind-radio-{side|outline}`.
- **Root-scoped editor font (closes #568)** — `--tandem-editor-font-family` is now applied to `document.documentElement` so the chosen font propagates to all surfaces (editor, tab labels, toolbar) rather than only the editor container. `applyEditorFontToRoot` and `createRootEditorFont` added alongside the existing per-element helpers.
- **Redesigned format badge on document tabs (closes #568)** — the 1-letter format icon is replaced with a styled pill badge (`MD`, `TXT`, `HTML`, `DOCX`) using format-specific semantic token colours. The dirty-dot slot is now always in layout with `visibility` toggled (prevents tab-width shift between dirty/clean states). New testids: `tab-format-badge-{id}`.
- **Temporary scratchpad (closes #475)** — `Ctrl+N` or "New Scratchpad" in the command palette / tab bar `+` menu opens an ephemeral in-memory document. Content is discarded when the tab is closed. Scratchpad paths use synthetic `upload://` URIs and are excluded from session restore and channel events. New `tandem_scratchpad` MCP tool lets Claude create scratchpads programmatically. Editor auto-focuses on mount for editable documents so the cursor is ready immediately.
- **Relative markdown link navigation (closes #479)** — Clicking relative `.md`, `.txt`, and `.html` links in the editor opens them as new Tandem tabs. External and non-supported links open in the default browser.
- **Documentation button in Settings (closes #457)** — A "View Documentation" button in the Settings popover About section opens `docs/workflows.md` as a read-only tab.
- **Store read-only warning banner (closes #506)** — When the annotation store is locked (read-only), a dismissible warning banner appears in the side panel. Dismiss state persists across sessions.
- **Claude Code automation hooks, agents, and skills (PR #591)** — 6 new hooks (stdout guard, svelte-check, token scanner, related-test runner, --no-verify blocker, E2E port-kill blocker), 2 specialized review agents (annotation-model, svelte-migration), 2 skills (`/changelog`, `/e2e-debug`), and `settings.json` wiring. Block hooks fail-closed on parse error; warn hooks include env-var opt-outs.
- **Theme-color meta tag sync** — `<meta name="theme-color">` updates reactively when the app theme changes, improving desktop PWA and mobile browser chrome appearance.

### Changed

- **Authorship toggle moved to toolbar (closes #587)** — The "Show Authorship" toggle moved from the Settings popover Accessibility section to the main toolbar right cluster for faster access. New testid: `toolbar-authorship-toggle`.
- **Settings dialog responsive breakpoint (closes #515)** — stacked single-column layout at ≤640px; sidebar capped at 45% of dialog height with vertical scroll; four E2E tests cover nav reachability, Tab cycling, focus-after-resize, and content width.
- **Redesign bundle checked into ****docs/redesign-bundle/**** (#521)** — captured the current handoff, HTML previews, CSS, and JSX surfaces used for the app-shell visual pass so follow-on UI work is grounded in a repo-local artifact instead of a transient design URL.
- **Regression coverage added for the remaining app-shell contracts (#521)** — new Playwright and Vitest checks now cover connection banners, reply threads, panel resize, layout switching, onboarding, readonly DOCX review, and apply-changes behavior.
- **Keyboard navigation E2E tests for floating selection toolbar (closes #516)** — Tab/Shift+Tab focus traversal, Enter activation, and Escape-to-editor focus return are now covered by four Playwright tests documenting APG-compliant behavior for transient contextual toolbars.
- **Redesign final QA suite (closes #522)** — Playwright tests covering viewport layouts (600/1280/1920px), `prefers-reduced-motion`, forced-colors/high-contrast mode, dark/light color scheme switching, and keyboard Tab-order reachability.
- **Automated WCAG AA gate** — `tests/e2e/accessibility.spec.ts` uses `@axe-core/playwright` to verify zero contrast violations in both light and dark mode on every CI run; editor content area excluded (user-authored content has arbitrary contrast).
- **Inline link input replaces browser prompt (closes #548, #589)** — The FormattingToolbar's Link button now opens an inline popover instead of `window.prompt()`. The input pre-populates with the existing href when editing a link; submitting empty unsets the link. New testids: `toolbar-link-input`, `toolbar-link-submit`, `toolbar-link-cancel`.

### Changed

- **Updater dialogs are now parented to the main window** — "Update Available", "No Updates Available", and "Update Error" dialogs attach to the Tandem window via `MessageDialogBuilder::parent()`, centering them over the app and inheriting Windows 11 dark-mode chrome from the `tauri-plugin-decorum` shell (closes #561, #553)
- **Custom window chrome via tauri-plugin-decorum** — native OS title bar replaced with a themed custom title bar that re-themes with the rest of the app; preserves Windows Aero Snap, Snap Layouts, resize border, and macOS traffic-light positioning (#554)
- **Tauri shell**: reload shortcuts (F5, Ctrl+F5, Shift+F5, Ctrl+R, Ctrl+Shift+R) are now blocked in the desktop app to prevent accidental navigation away from the editor; DevTools, Find, Print, and right-click context menu are preserved (#541)
- **Semantic token foundation expanded for redesign wave 2 (#521)** — added radius, font-size, shadow, z-index, editor-font-size, and highlight-color token families in `index.html`, plus checker rules that now flag raw `border-radius: <n>px` and inline `box-shadow: ... rgba(...)` in `src/client/`.
- **Read-only/info surfaces now use the shared info token family (#521)** — `ReviewOnlyBanner`, `ConnectionBanner`, `ToastContainer`, `StatusBar`, and related chrome now consume the shared token scales instead of hardcoded radius/text/shadow values.

### Tests

- **Plugin state machine unit tests for slash command menu (#517)** — added 7 Vitest tests in `tests/client/slash-command.test.ts` that exercise the ProseMirror plugin via a real Tiptap Editor in happy-dom: active state on `/` insertion, close meta, select meta, non-empty selection guard, query filtering with index clamping, ArrowDown wrap-around, and Enter-to-execute.

### Removed

- **ReviewSummary**\*\* overlay removed with review mode already gone (#521)\*\* — the dead component and `App.svelte` mount path are deleted rather than carried forward as unreachable redesign debt.

### Fixed

- **Annotation console flood eliminated (closes #585)** — Deriving `audience` from annotation type is now silent; the `audience-derived` event type has been removed from the sanitization event system. New annotations also carry an explicit `audience` field at creation time.
- **Audience conflict guard (closes #584)** — User-authored notes and highlights can no longer be stored with `audience: outbound`. The sanitization layer enforces this invariant and emits an `audience-conflict-resolved` event when a conflict is detected.
- **Browser path: no light-flash on first paint for dark-mode users** — an inline pre-mount script in `index.html` reads the persisted theme preference (falling back to `matchMedia`) and sets `data-theme` on `<html>` before Svelte mounts, matching the behaviour the Tauri shell already provided via `window.__TANDEM_INITIAL_THEME__` (#551 partial — FOUC mitigated; matchMedia source-of-truth fix deferred to #477)
- **ErrorBoundary now offers in-place recovery before falling back to a full reload (#507)** — the app-root `<svelte:boundary>` re-renders children via `reset()` on a "Try to recover" click, capped at three attempts before forcing the user to reload. The budget resets after each successful recovery so an unrelated subsequent error gets a fresh three attempts. Failed-state surface uses `--tandem-error-bg`/`-border`/`-fg-strong` tokens (was neutral) and re-announces via `role="alert"` on each fresh failure.
- **Toolbar**: HighlightColorPicker border now uses `--tandem-border` token, correctly adapting to light/dark theme switching (#536)
- **Theme system: Tauri shell now reads Windows app-mode preference (****AppsUseLightTheme****) for ****theme: "system"**** instead of taskbar color mode (closes #535)** — `get_app_theme` Rust command reads `WebviewWindow::theme()`, which maps to `HKCU\...\Personalize\AppsUseLightTheme`. Initial theme is seeded before Svelte mounts; `useTauriTheme.svelte.ts` subscribes to `onThemeChanged` and polls every 3s while focused. `matchMedia` subscription is skipped in Tauri to prevent race conditions.
- **Tauri shell: live OS app-mode flips now retheme without restart** — `systemTheme()` reads the live `tauriTheme.current` reactive store (updated by the Tauri theme bridge) instead of a startup-only snapshot; `applyTheme()` in `useTheme.svelte.ts` subscribes reactively so `<html data-theme>` updates immediately when the user switches Windows between light and dark app mode (Codex P1 follow-up to #535).
- **Dark annotation highlight colors** — `--tandem-highlight-yellow/green/blue/pink` now have dark-adapted overrides in `[data-theme="dark"]`; the light `rgba(255, 235, 59, 0.3)`-style values were washed out against dark surfaces.
- **Forced-colors fallbacks for background-only state surfaces (closes #311)** — StatusBar status dots, toast badge, ModeToggle active button, BulkActions confirm button, AnnotationCard type-badge and Private pill now have `border`/`outline` fallbacks in `@media (forced-colors: active)`.

## [0.10.1] - Unreleased

Plugin URL and auth resolution for custom-port and network-remote setups.

### Changed

- \*\*Monitor and channel honor \*\***CLAUDE_PLUGIN_OPTION_SERVER_URL** — `resolveTandemUrl()` now checks the `CLAUDE_PLUGIN_OPTION_SERVER_URL` environment variable (exported by Claude Code's plugin host from `plugin.json` `userConfig`) before falling back to `TANDEM_URL` and the localhost default. Both the monitor (`src/monitor/index.ts`) and channel shim (`src/channel/run.ts`) benefit automatically. No change for existing installs that don't use `userConfig`.
- \*\*Monitor and channel honor \*\***CLAUDE_PLUGIN_OPTION_AUTH_TOKEN** — new `resolveAuthToken()` function in `src/shared/cli-runtime.ts` mirrors `resolveTandemUrl()`. Precedence: `CLAUDE_PLUGIN_OPTION_AUTH_TOKEN` → `TANDEM_AUTH_TOKEN`. `authFetch` uses it automatically, so all stdio subcommands gain the new lookup without caller changes.

## [0.10.0] - 2026-05-03

Complete React → Svelte 5 migration. All 39 client `.tsx` files have been replaced with Svelte 5 rune-based equivalents; `react`, `react-dom`, and `@tiptap/react` are no longer in the bundle. Includes a review-mode correctness fix, accessibility improvements, and follow-on Codex security hardening.

### Removed

- **react**\*\*, ****react-dom****, ****@tiptap/react**** dropped (#472, #508)\*\* — the React adapter layer is gone. The editor integrates directly with `@tiptap/core` via Svelte 5 components. Bundle size and startup time both decrease.
- **tandem_suggest**\*\*, ****tandem_flag****, ****tandem_highlight**** hard-removed\*\* — stub tools deprecated in v0.9.0 (ADR-027) are now fully removed. MCP tool count: 28 → 25.

### Changed

- **React → Svelte 5 migration (#472, #508)** — all client components rewritten with Svelte 5 runes (`$state`, `$derived`, `$effect`). Component APIs, data-testid selectors, and observable behavior are unchanged; only the rendering layer is new.
- **Note annotation actions** — note cards in the side panel now show **Archive** and **Send to Claude** instead of Remove. "Send to Claude" promotes the note to a comment and fires an `annotation:created` channel event so Claude is notified immediately.

### Fixed

- **Review mode incorrectly treated private notes as review targets (#512, #523)** — Tab/Y/N keyboard navigation, "Accept All" / "Dismiss All" bulk actions, the "Review Complete" overlay trigger, tally counts, and the chat tab badge now all exclude `type: "note"` annotations. Notes remain visible as cards in the side panel. Word-imported comments (`author: "import"`) continue to be review targets.
- **Note privacy — ****tandem_getAnnotations**** and channel events never surface notes to Claude** — `type: "note"` entries are filtered from MCP tool responses and SSE channel events (Codex security review).
- **Y.Map key strings enforced via constants** — raw string literals for Y.Map keys eliminated across the codebase; all access goes through `Y_MAP_ANNOTATIONS`, `Y_MAP_AWARENESS`, etc. from `shared/constants.ts` (Codex security review).
- **Chat message XSS hardening** — link rendering in the chat panel now enforces a protocol allowlist (`https:`, `http:`, `mailto:`), blocking `javascript:` and other unsafe schemes (Codex security review).
- **annotation:edited**\*\* channel event deduplication\*\* — rapid successive edits no longer emit duplicate events to the channel (Codex security review).
- **svelte-check --fail-on-warnings**\*\* now gates the build\*\* — 26 pre-existing Svelte type warnings cleared; CI enforces zero-warning policy going forward.

### Added

- **Keyboard-accessible panel resize handles (#511, #524)** — Arrow keys resize by ±16 px, Page Up/Down by ±80 px, Home/End snap to the minimum/maximum width. `aria-valuenow` reflects the live panel width.
- **ARIA dialog focus management (#511, #524)** — HelpModal and ReviewSummary now trap Tab focus, restore focus on close, and close on Escape. Backdrops carry `role="presentation"`; dialog containers carry `role="dialog" aria-modal="true" tabindex="-1"`.
- **Form label associations (#511, #524)** — AnnotationEditForm inputs are now properly associated with their `<label>` elements.
- **AnnotationCard role corrected (#511, #524)** — changed from `role="button"` (nested-button violation) to `role="listitem"`.

## [0.9.1] - 2026-05-01

Hotfix patch bundling ADR-027 surface cleanup and file-I/O correctness fixes before the v0.10.0 Svelte conversion. All changes are patch-class; no MCP API changes.

### Fixed

- **Imported Word reviewer comments now surface to Claude by default (#482)** — `.docx` reviewer comments are imported as `author: "import"`, `type: "comment"` (was `type: "note"` in the unreleased PR #474 plan). Reverts the `tandem_getAnnotations` `includeImports` opt-in introduced in PR #474 — Claude can read imported comments alongside its own without an explicit flag, which matches the .docx review workflow. The opt-in plumbing (`includeImports` parameter, `importsExcluded` response field) is removed. Existing on-disk records with `author: "import", type: "note"` migrate transparently on read via `sanitizeAnnotation`; on next import the durable record is rewritten in place. Safe because PR #474 was never tagged in a release.
- **Markdown tables preserved across Tiptap round-trip (#379)** — bidirectional MDAST↔Y.Doc table conversion added to `mdast-ydoc.ts`. Tables with mixed column alignment, inline marks in cells, and empty cells all survive load/save cycles. Flat-offset alignment preserved so annotations anchored after a table resolve correctly.
- **HTML blocks and insertion-order fixed in mdast-ydoc (#496)** — raw HTML blocks (`<div>`, `<details>`, etc.) now round-trip as `html` nodes instead of being dropped. Insertion-order bug in `blockToYxml` fixed — the two-pass Y.XmlText attach-before-populate pattern now applied uniformly to all block types.
- **Channel shim per-request timeouts (#364)** — event bridge and `run.ts` now use bounded request-response fetches with split SSE handshake/body watchdogs and a 1 MB SSE frame buffer cap. `tandem_reply` returns a structured timeout error instead of hanging indefinitely.
- **Sanitize coercions routed to migration-log (#483)** — lossy ADR-027 type coercions in `sanitize.ts` (e.g. `flag` → `note`) now emit a `migration-log.ts` entry (once per doc/kind) instead of silently rewriting records, restoring the forensic trail for ADR-027 transitions.
- **Doc hash required for collection logs (#495)** — annotation collection log entries now require a `docHash` field, preventing cross-document log pollution from unkeyed writes.
- **Standalone monitor gated on backend readiness (#491)** — `dev:standalone` waits for the backend health endpoint before starting the monitor, eliminating the startup race that caused spurious connection errors.

### Tests

- **E2E toolbar regression guard (#484)** — Playwright coverage for the redesigned toolbar (ADR-027 note/comment/highlight flow), including a regression guard for the note button empty-annotation bug (#480).

## [0.9.0] - 2026-04-28

### Breaking Changes (MCP)

This is the last breaking-change window before semver lock. MCP tool count: 31 → 28.

- **tandem_suggest**\*\* deprecated (#259)\*\* — returns a structured error stub pointing to `tandem_comment` with `suggestedText`. Hard-remove in v0.10.0.
- **tandem_getContent**\*\* removed (#259)\*\* — superseded by `tandem_getTextContent`.
- **tandem_getSelections**\*\* removed (#259)\*\* — superseded by `tandem_checkInbox`.
- **tandem_setStatus**\*\* merged into ****tandem_status**** (#259)\*\* — `tandem_status` now accepts optional write params (`text`, `focusParagraph`, `focusOffset`). When params are present it writes to awareness; when absent it reads.
- **tandem_flag**\*\* deprecated (ADR-027, #473)\*\* — returns a `DEPRECATED` error stub. Use `tandem_comment` instead. Hard-remove in v0.10.0.
- **tandem_highlight**\*\* deprecated (ADR-027, #473)\*\* — returns a `DEPRECATED` error stub. Highlights are user-only. Hard-remove in v0.10.0.
- **Annotation ****directedAt**** field removed (ADR-027, #473)** — silently ignored on input; stripped from on-disk records via `sanitizeAnnotation` and the `normalizeAnnotation` fast path on read.

### Added

- **/api/info**\*\* endpoint (#441)\*\* — returns app version, MCP SDK version, tool count, data directory, and platform. Serves the Settings panel About footer.
- **Tabbed-left layout variant (#445)** — new `"tabbed-left"` layout mode places the side panel on the left and editor on the right. Three layout modes total: `tabbed`, `tabbed-left`, `three-panel`.
- **App version in Settings (#435)** — `useAppInfo` hook fetches `/api/info` and displays version + MCP SDK version in the Settings popover footer.
- **View Changelog button (#437)** — Settings panel button opens `CHANGELOG.md` as a read-only document tab via `POST /api/open` with `readOnly: true`.
- **Authorship ****data-tandem-author**** attributes (#443)** — authorship decorations switched from CSS classes (`.tandem-authorship--user`) to data attributes (`[data-tandem-author="user"]`), per ADR-026. Enables future attribute-based styling without class proliferation.
- **Schema foundations (#440, #442, #444, #450)** — `heldInSolo` field on `AnnotationBase`; 7 new `TandemSettings` fields (`accentHue`, `editorFont`, `density`, `defaultMode`, `highContrast`, `annotationPatterns`, `selectionToolbar`); `showAuthorship` default flipped to `true`; editor width minimum lowered from 50% to 40%.
- **Highlight palette migration (#450)** — palette switched from 5 colors to 4 (yellow/green/blue/pink). `LEGACY_COLOR_MAP` migrates `red` → `yellow`, `purple` → `blue` on annotation load.
- **CI stdio smoke test (#341)** — GitHub Actions step validates the Cowork stdio bridge (`scripts/ci/stdio-smoke.mjs`) on every push.
- **\__MCP_SDK_VERSION\_\_\*\*\*\* build-time injection** — tsup reads the real SDK version from the package root (not the CJS type marker) and injects it at build time.
- **tandem_getAnnotations**\*\* ****includeImports**** opt-in (ADR-027, #473)\*\* — accepts `includeImports: true` to surface `author: "import"` reviewer comments imported from `.docx` files. Default still excludes them so the user triages first. When imports are filtered out, the response includes `importsExcluded: N` so Claude can prompt the user to opt in.
- **Deprecated-tool user notifications (ADR-027, #473)** — `tandem_highlight`, `tandem_flag`, and `tandem_suggest` stubs now `pushNotification` a warning toast in addition to returning the `DEPRECATED` mcpError, so the user sees what Claude tried.

### Fixed

- **Cross-element edit merging (#456)** — canonical Y.js length + delta-walking merge for edits spanning multiple inline elements.
- **Annotation decoration initial-sync race** — Y.Map observers firing before y-prosemirror sync no longer produce empty decoration sets.
- **Channel checkpoint timing** — checkpoint advances after MCP notification delivery, not before, preventing event loss on reconnect.
- **Auto-save spurious tab switches** — auto-save no longer triggers `document:switched` events that confuse tab state.
- **Annotation recovery guard hardening** — narrowed guard scope for edge cases in session restore.
- **Event-bridge error handling** — uncaught errors in SSE delivery no longer crash the event loop.
- **MCP SDK version resolution** — `require("@modelcontextprotocol/sdk/package.json")` resolves to `dist/cjs/package.json` (a CJS type marker without `version`); build now walks back past `dist/` to find the real version.
- **Silent-migration logging (ADR-027, #473)** — `parseAnnotationDoc`, `migrateToV1`, and the `directedAt` strip fast path now log via the new `migration-log.ts` module (once per `${docHash}:${kind}`) instead of silently rewriting v0 records. Restores forensic trail for the v0→v1 transition.
- **normalizeReply**\*\* validation (#473)\*\* — replies are now Zod-validated before being merged; malformed entries are dropped + logged instead of poisoning the envelope.

### Changed

- **Redesign gap audit resolved (#439)** — 7 product decisions documented in ADR-026. Design response prompt at `docs/claude-design-response-prompt.md`.
- **Distribution items deferred** — #316 (macOS/Linux Cowork auto-setup), #317 (cross-platform firewall scoping), #322 (network-type detection) moved to v0.13.0. Requires macOS/Linux validation hardware.
- **Annotation type model unified to audience-based (ADR-027, #473)** — `flag` → `note`. Three types now: `highlight` (visual marker), `note` (private), `comment` (sent to Claude). Channel observer filters notes from SSE — they never reach Claude. `checkInbox` returns only `comment` annotations.
- **Note toolbar UX (#480)** — Note button now opens an inline input mirroring the Comment flow.
- **Note card visual distinction (#481)** — amber border + warning-bg tint distinguishes notes from comments in the side panel.

### Internal

- Annotation schema Zod validation with `LEGACY_COLOR_MAP` migration path.
- `ResizeHandle` and `TabbedPanelContainer` shared components extracted for layout code reuse.
- `useAppInfo` hook with exponential backoff retry for `/api/info` fetch.
- `file-opener` read-only mode support for changelog viewing.
- 900+ lines of new test coverage: authorship decorations, annotation decorations, panel layout, app info hook, settings fields, schema migration, info route, document edit edge cases.

## [0.8.0] - 2026-04-26

### Added

- **NSIS pre-install sidecar kill (#434)** — the NSIS installer now kills the running `node-sidecar.exe` process before file replacement, preventing "Error opening file for writing" failures during upgrade installs. Uses `nsis_tauri_utils::KillProcessCurrentUser` for user-scoped process termination. Tauri's built-in `CheckIfAppIsRunning` already handles the main binary.
- **Semantic token lint enforcement (#356)** — `npm run check:tokens` scans `src/client/` for raw hex and non-neutral `rgba()` violations. Runs on pre-commit via lint-staged, blocking merges that introduce unsanctioned color literals.
- **--tandem-suggestion-\*\*\*\*\* token family (#340)** — violet semantic tokens for replacement/suggestion annotations (`--tandem-suggestion`, `-fg-strong`, `-bg`, `-border`), visually distinct from the indigo accent family.
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

## [0.7.1] - 2026-04-20

### Fixed

- **MSIX Claude Desktop detection** — `tandem setup` now detects Claude Desktop installed via MSIX (Microsoft Store) and generates stdio MCP entries for it (#372)

## [0.7.0] - 2026-04-20

### Added

- **Auth token storage** — on first boot the server generates a 32-byte base64url token and persists it to the platform data directory (`%LOCALAPPDATA%\tandem\Data\auth-token` on Windows, `~/.local/share/tandem/auth-token` on Linux, `~/Library/Application Support/tandem/auth-token` on macOS). Subsequent boots reuse the token. First-boot race is protected by `O_EXCL` file creation. Tauri mode receives the token via `TANDEM_AUTH_TOKEN` env before sidecar spawn and never regenerates.
- **Auth middleware** — non-loopback MCP and API requests require `Authorization: Bearer <token>`. Loopback connections (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) remain exempt, preserving zero-config Claude Code usage. Token comparison uses SHA-256 on both sides before `crypto.timingSafeEqual` to eliminate the length oracle. Rate-limiting (5 attempts / 60 s) keyed by IPv4 address or IPv6 `/64` prefix with LRU eviction; Authorization headers are redacted from all rejection logs.
- **TANDEM_BIND_HOST**\*\* bind-mode selection\*\* — MCP HTTP server binds to `127.0.0.1` by default; set `TANDEM_BIND_HOST=0.0.0.0` (or a specific LAN IP) to expose Tandem on the local network. Hocuspocus WebSocket always stays loopback. Non-loopback bind without a token file exits 1 with guidance; `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` is the escape hatch. Multi-homed machines require `TANDEM_LAN_IP` to be set explicitly.
- **tandem rotate-token** — new CLI subcommand that atomically regenerates the auth token, notifies the running server to open a 60-second grace window for in-flight sessions, and re-runs `tandem setup` across all detected MCP config files. Prints old and new token fingerprints (first 8 hex chars of SHA-256). Refuses rotation when `TANDEM_AUTH_TOKEN` is set in the environment (Tauri mode).
- **Token forwarding in stdio bridge, monitor, and channel sidecars** — `tandem mcp-stdio`, `tandem monitor`, and the channel sidecar now forward `TANDEM_AUTH_TOKEN` as `Authorization: Bearer` on upstream HTTP calls. Malformed tokens (empty, `Bearer`-prefixed, < 32 chars, non-URL-safe) exit 1 with a specific message.
- **OAuth protected-resource metadata** — `/.well-known/oauth-protected-resource/mcp` now declares `bearer_methods_supported: ["header"]` and a literal-`localhost` `resource` field per RFC 9728.
- **/health**\*\* session-presence guard\*\* — `hasSession` is omitted from `/health` responses on non-loopback requests, preventing session-presence leakage on LAN binds.

### Security

- Loopback detection keys off `req.socket.remoteAddress` exclusively — `Host` header is never trusted for the loopback bypass decision.
- Fail-closed on LAN bind: `TANDEM_BIND_HOST=0.0.0.0` without a token file exits 1; the server never auto-generates a token and proceeds silently.
- `crypto.randomBytes` failure or non-writable data directory → server exits 1; no silent fallback.

## [0.6.4] - 2026-04-20

### Fixed

- **Flaky layout-switch E2E test (#281)** — `toHaveCount` assertions on resize-handle locators lacked explicit timeouts, causing intermittent CI failures under load when React re-renders were slower than the default 5 s expectation. All 8 assertions now carry `{ timeout: 10_000 }`, and the missing `right-panel-resize-handle` absence assertion in the tabbed-layout block has been added.
- **Silent crashes in CLI entry points (#336)** — `src/cli/index.ts` and `src/channel/index.ts` lacked `process.once("uncaughtException")` / `process.once("unhandledRejection")` handlers. Uncaught throws in `tandem start`, `tandem setup`, and the Tauri channel sidecar exited silently with code 0, surfacing as "tools never appear" with no diagnostics. Both entries now write a labelled message to stderr and exit 1. The `uncaughtException` handler uses `err: unknown` with an `instanceof Error` guard so non-Error throws (strings, plain objects) produce the actual thrown value rather than `"undefined"`.

## [0.6.3] - 2026-04-19

### Fixed

- **Annotation GC race on startup (#334)** — `cleanupOrphanedAnnotationFiles` previously ran as a `.then()` chain during boot, racing the boot-path doc opens. On upgrade paths where `sample/welcome.md` or `CHANGELOG.md` hadn't been opened in 30+ days, the GC could unlink the annotation file between read intent and the actual read, silently returning an empty doc. Now `await`-ed before all boot-path opens.
- **Settings Popover extends out of view (#306)** — centered the popover in the viewport with `transform: translate(-50%, -50%)` and added `maxHeight: calc(100vh - 32px)` + `overflowY: auto` so it is always fully visible and internally scrollable on short screens.
- **Dark-mode ****\*-bg**** tokens inconsistent (#307)** — `--tandem-success-bg` and `--tandem-warning-bg` in dark mode were hand-coded hex while `--tandem-error-bg` used `color-mix`. All three now use `color-mix(in srgb, var(--tandem-<semantic>) 15%, var(--tandem-surface))` for consistency with light-mode behavior.
- **stdio bridge silent-failure paths (#336 partial)** — three paths in `src/cli/mcp-stdio.ts` (preflight exit, `http.onclose`, `http.start()` TOCTOU) previously closed stdio without writing a JSON-RPC error, producing "tools never appear in Cowork" with no diagnostics. All three now synthesize `-32000` for any in-flight request ID before exit. Remaining #336 items (channel-shim tests, Windows npx smoke, nits) carry to v0.7.0.

### Changed

- **Annotation module internals** — extracted `mergeMap<T>` helper (#324), promoted `UPLOAD_PREFIX` to shared constants (#327), centralized app-data dir resolution in `platform.ts` (#328), extracted `ReplyAuthorSchema`, trimmed module headers, and dropped unused `docContexts` map (#332). No user-facing behavior changes.
- **Annotation serialization upgrades legacy ****type**** values on write (#329)** — records with non-canonical `type` (`"suggestion"` / `"question"` / anything outside `highlight` / `comment` / `flag`) are now routed through `sanitizeAnnotation` during snapshot serialization, which rewrites them to `"comment"`. **One-way lossy migration:** users with legacy-type annotations will see `type` flip to `"comment"` on the next durable write for that document — the original distinction between `suggestion` and `question` is not recoverable.
- **migrateToV1**\*\* reports drop counts (#330)\*\* — `migrateToV1(raw)` now returns `{ doc, droppedAnnotations, droppedReplies }` so future production callers can surface lossy upgrades to users rather than silently discarding malformed records. No production caller exists yet; a follow-up will wire drop counts to `npm run doctor` or a toast when the first caller lands.

### Internal

- Test coverage: `pickWinner`, `SerializedRelPos` edges, UNC paths, upload-path edges (#331); `wireAnnotationStore` perf baseline at 500/1000/5000 annotations (#335).
- Test sweep: stale hex color refs cleaned up post-PR #303 (#309).
- Accessibility: forced-colors fallback audit on PR #303 annotation surfaces (#311).
- CI: typecheck / lint / tests now gate on all PRs regardless of base branch; dropped unused `baseUrl` from `tsconfig.server.json` (#310).

## [0.6.2] - 2026-04-16

### Fixed

- **Plugin stdio entries crash-loop on Windows** — `tandem-editor@0.6.1`'s published `package.json` shipped `"workspaces": ["packages/*"]`, a dev-only field for the vestigial `packages/tandem-doc/` alias stub. On Windows with Node 24 + npm 11, the presence of `workspaces` in an installed consumer package caused `npx -y tandem-editor …` to fail with `ERR_UNSUPPORTED_ESM_URL_SCHEME` (the bin path was handed to the ESM loader as a raw `c:\…` string instead of a `file://` URL). Claude Desktop's plugin loader spawns the stdio entries via `npx -y`, so both `tandem` and `tandem-channel` crash-exited before any user code ran, manifesting in Cowork sessions as entries that flapped "connecting → gone" and never surfaced `tandem_*` tools. Removed the unused `packages/tandem-doc/` directory and the `workspaces` field; direct `node dist/cli/index.js` invocation was never affected, so the Tauri desktop app's bundled sidecar was fine and only the npm-tarball/`npx` path needed the fix.

## [0.6.1] - 2026-04-15

### Fixed

- **Tauri desktop app fails to start** — `src/cli/skill-content.ts` reads `skills/tandem/SKILL.md` at module-init via `readFileSync`, and `src/server/mcp/api-routes.ts` transitively imports it, so the bundled sidecar server crashed on startup with `ENOENT: skills/tandem/SKILL.md`. The `skills/` directory was never declared in `src-tauri/tauri.conf.json` bundle resources (latent since the v0.5.1 refactor to read SKILL.md at runtime). Add `"../skills/": "skills/"` so the sidecar's relative path resolution matches the npm-install layout. npm-published 0.6.0 was unaffected because `skills/` ships in the npm tarball via `package.json` `files`.

## [0.6.0] - 2026-04-15

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

- \*\*Monitor preserves last-known \*\***documentId** — doc-less events (e.g. `chat:message`) no longer blank out the tracked document, so the shutdown awareness clear always targets a valid document.
- **Monitor exits 1 on shutdown awareness failure** — if the final `clearAwareness` POST fails during SIGINT/SIGTERM, the monitor exits with a non-zero status rather than silently succeeding.
- **/api/setup**\*\* returns accurate status codes\*\* — 207 on partial failure (some targets configured, some failed) and 500 on total failure, instead of always returning 200.
- **Checkpoint after stdout write** — `lastEventId` is only advanced after `process.stdout.write` returns, so EPIPE on a closed pipe no longer silently skips an event on reconnect.
- **Async EPIPE surfaces as exit(1)** — `process.stdout.on('error')` listener now catches asynchronous EPIPE (plugin host closes pipe mid-stream); monitor exits 1 instead of silently advancing `lastEventId` past lost events.
- **Defensive exit on monitor fallthrough** — the retry loop exits 1 if it ever terminates without hitting the explicit exhaustion path.

## [0.5.1] - 2026-04-13

### Added

- **Claude Code plugin support** — monitor-based event push (`src/monitor/index.ts`) gives real-time notifications without polling or the channel shim. Install via `claude plugin marketplace add bloknayrb/tandem`.
- **--with-channel-shim**\*\* opt-in\*\* — `tandem setup --with-channel-shim` writes the legacy `tandem-channel` MCP entry for setups that can't install the plugin.

### Changed

- `tandem setup` no longer writes the `tandem-channel` MCP entry by default — running the plugin and the shim simultaneously produces duplicate event notifications. The shim is now opt-in only via `--with-channel-shim`.

### Fixed

- **Windows update failure** — sidecar is now killed before the NSIS installer runs, preventing "Error opening file for writing: node-sidecar.exe" during updates
- **Mode check fails closed** — `/api/mode` errors now fall back to "solo" at startup (privacy signal, not a permissive default) while the hot-path background refresh keeps the last known good value to avoid mid-session suppression.
- **Retry counter resets on stable uptime** — retry count now resets only after 60s of continuous uptime, not on every delivered event; prevents infinite reconnect loops when the server crashes after each event.
- **Exponential backoff on reconnect** — monitor reconnects use 2s/4s/8s/16s/30s backoff instead of a fixed 2s delay.
- **SIGINT/SIGTERM clears awareness** — monitor posts a final `clearAwareness` before exit so the "Claude is active" indicator doesn't hang in the browser.
- **Per-route fetch timeouts** — `AbortSignal.timeout` enforces budgets per route (connect 10s, mode 2s, awareness 5s, error report 3s) to prevent hung SSE connects or mode lookups from stalling the monitor.
- \*\*SSE parse errors don't advance \*\***lastEventId** — JSON parse failures and schema validation errors are logged with event ID + frame tail but do not advance `lastEventId`, so bad events are re-delivered on reconnect rather than silently dropped.
- **SKILL.md corrected** — `question` annotation guidance now uses `type === 'comment' && directedAt === 'claude' && author === 'user'`; all 5 highlight colors listed (yellow, red, green, blue, purple).

## [0.5.0] - 2026-04-13

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

## [0.4.0] - 2026-04-12

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

## [0.3.2] - 2026-04-12

### Changed

- **Annotation type unification:** Three semantically identical types (`comment`, `suggestion`, `question`) collapsed into a single `comment` type with optional `suggestedText` and `directedAt` fields. `AnnotationTypeSchema` reduced from 5 values to 3: `highlight`, `comment`, `flag`. (#193, #245, #255)
- **Toolbar:** Three annotation buttons (Comment, Suggest, Ask Claude) replaced with a single Comment button with "Replace" and "@Claude" toggles (#193)
- **Side panel filters:** "Suggestions" → "With replacement", "Questions" → "For Claude" (#193)
- \*\*sanitizeAnnotation()\*\*\*\* moved to \*\***src/shared/sanitize.ts** — now available to both server and client code. Client-side Y.Map reads are sanitized to handle legacy session data. (#255)

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
