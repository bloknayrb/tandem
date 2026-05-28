# Test-Selector Manifest

> **Captured 2026-05-21** on `feat/design-system-impl` umbrella branch. Frozen
> reference for every `data-testid` declared in `src/client/`. Sub-PRs into
> the umbrella branch must not remove any selector listed here. Adding new
> selectors is fine — the snapshot file will diff cleanly and reviewers can
> see the addition.

## Contract

1. **No removals.** Tests across `tests/client/`, `tests/e2e/`, and downstream
   Playwright suites depend on these selectors. If a sub-PR renames a testid,
   every test referencing the old name fails — fix at the test side first,
   then update the selector + snapshot in one commit.
2. **Additions are fine** but the snapshot must be regenerated (`npx vitest
   run tests/design-system-impl/testid-coverage.test.ts -u`) and committed in
   the same PR so the diff is reviewable.
3. **Wrapper-prop passthroughs** (e.g. `ToolbarButton`, `FilterSelect`,
   `CollapsibleSection`, `App.svelte#resizeHandle`) accept a testid prop and
   the literal value lives at the call site. The snapshot captures both the
   wrapper's templated form and the call sites' literal strings.

## Enforcement

`tests/design-system-impl/testid-coverage.test.ts`:

- Walks `src/client/**/*.{svelte,ts,tsx,css}`
- Extracts every `data-testid=` attribute value via a single-line bracket-balanced parser (no greedy regex; one value per attribute)
- Normalises Svelte `{expr}` and JS `${expr}` to the literal `{*}` so the snapshot is stable across local variable renames
- Resolves a small lookup of known testid constants (currently `ERROR_BOUNDARY_RECOVER_BTN_TESTID` / `ERROR_BOUNDARY_RELOAD_BTN_TESTID` → `error-boundary-recover-btn` / `error-boundary-reload-btn`) — add new entries to `CONSTANT_RESOLUTIONS` when a new constant ships
- Filters out bare-identifier wrapper passthroughs (e.g. `{testId}`) because the literal selector arrives via the call site
- Sorts the unique set and asserts against
  `tests/design-system-impl/__snapshots__/testid-set.snap.txt`

When the test fails, the diff in `testid-set.snap.txt` shows exactly which
selectors were added or removed and reviewers gate on the change.

## Known gaps

- **Synthesized selectors from snippets.** `App.svelte#resizeHandle` snippet
  produces `left-panel-resize-handle`, `right-panel-resize-handle`, and
  `panel-resize-handle` (overridden via the snippet's `testId` arg) but the
  extractor only sees the template form `testId ?? \`{*}-panel-resize-handle\``
  in the snapshot. Renaming the snippet's literal `${side}-panel-resize-handle`
  template would still trigger a diff (the snapshot line changes), but
  renaming a call-site `testId="panel-resize-handle"` argument would slip
  past this gate — the corresponding E2E test would still fail loudly.
- **Constants other than the two error-boundary ones** are not auto-resolved.
  If you add a new testid constant module, also add it to
  `CONSTANT_RESOLUTIONS` so the snapshot shows the literal selector instead
  of the identifier.

## Selector families (orientation guide)

Groupings below are for quick mental mapping — they are **not** the source of
truth. The committed snapshot file is. Every entry here resolves to one or
more lines in `__snapshots__/testid-set.snap.txt`.

### Editor chrome
- `editor-root` — top-level editor mount point
- `editor-stage` — Phase 3.5 grid-stage container (content track + per-side
  margin tracks); the margin-annotation positioning layer (`marginLayerEl`)
- `title-bar`, `titlebar-brand-menu`, `titlebar-brand-menu-popover`,
  `titlebar-default-model`, `titlebar-update-available-dot`,
  `brand-menu-{settings,shortcuts,theme-{*}}`
- `formatting-bar`,
  `toolbar-link-{input,submit,cancel}`,
  `toolbar-highlight-color-{toggle,{*}}`, `color-picker-close`,
  `formatbar-hide-btn` (1.11 — hides the optional bar; the popup mirrors its controls)
- Decorations split button (1.13) — lives in the formatting bar (subsumes the
  standalone authorship toggle; `formatbar-authorship-toggle` removed):
  `decorations-menu`, `decorations-mute-toggle`, `decorations-menu-caret`,
  `decorations-row-{authorship,comments,highlights,notes}`,
  `decorations-settings-link`
- `mode-{toggle,solo-btn,tandem-btn}`

### Selection popup (audience-first, ADR-027)
- `popup-{annotate-btn,annotation-input,note-submit,comment-submit,highlight-{*},show-formatbar-btn}`

### Find/Replace
- `find-replace-bar`, `find-{input,prev-btn,next-btn,close-btn,match-count}`
- `find-scope-{pills,doc,tabs}`, `find-cross-doc-results`
- `find-{case,word,regex}-toggle`
- `replace-{input,btn,all-btn}`

### Tabs strip & file open
- `tab-scroll-container`, `tab-{*}`, `tab-name-{*}`, `unsaved-indicator-{*}`
- `open-file-btn`, `file-open-{dialog,submit,error}`, `file-path-input`,
  `file-upload-zone`, `recent-files-list`, `recent-file-{*}`,
  `clear-recent-files`
- New-tab launcher (a7, sub-PR 1.9b): `new-tab-search`, `new-tab-recent-{*}`,
  `new-tab-browse`, `new-tab-reopen-closed`, `new-tab-empty`, `new-tab-no-match`
  (the primary action keeps `palette-item-new-scratchpad`)

### Status bar
- `status-word-count`, `save-indicator`, `user-name-input`, `sb-held`

### Annotations (5-card audience-first split, ADR-027 / Conflict #8)
- Dispatch + chrome: `annotation-card-{*}`,
  `annotation-snippet-{*}`, `annotation-list-scroll-container`,
  `annotation-private-pill`
- Actions: `accept-btn-{*}`, `dismiss-btn-{*}`, `archive-btn-{*}`,
  `remove-btn-{*}`, `send-to-claude-btn-{*}`, `undo-btn`
- Edit form: `edit-btn-{*}`, `edit-{newtext,reason,text}-{*}`,
  `edit-{save,cancel}-btn-{*}`
- Replies + threads: `reply-{btn,input,send-btn,cancel-btn}-{*}`,
  `reply-thread-expand-{*}`, `reply-thread-overlay`,
  `reply-thread-overlay-{close,input,send,cancel,reply}`,
  `comment-thread`, `reply-{*}`
- Suggestion + import variants: `suggestion-diff-{*}`,
  `annotation-import-byline-{*}`, `annotation-select-checkbox-{*}`
- Margin column: `margin-column-{*}`, `margin-bubble-{*}`,
  `margin-leaders-{*}`
- Batch + bulk: `batch-promote-{bar,count,clear,confirm}`,
  `bulk-{confirm,cancel,accept,dismiss}-btn`
- Filters: `filter-bar-toggle`, `clear-filters-btn`

### Side panels & rails
- `left-outline-rail`, `annotations-tab`, `chat-tab`
- `clear-chat-btn`, `held-banner`, `store-readonly-banner`,
  `store-readonly-dismiss`, `peek-strip-{*}`,
  `panel-edge-collapse-{*}` (resize-handle selectors synthesized — see Known
  gaps)

### Banners
- `connection-banner`, `connection-banner-retry`
- `updater-banner`, `updater-banner-{install,dismiss,visible}`
- `review-only-banner`, `review-only-dismiss`,
  `convert-to-markdown-btn`

### Modals & dialogs
- `help-modal`, `help-modal-close`
- `error-boundary-{recover,reload}-btn` (resolved from constants)
- `command-palette`, `palette-{input,empty}`, `palette-item-{*}`,
  `palette-item-new-scratchpad`
- `onboarding-tutorial`, `tutorial-{dismiss,next}-btn`

### Settings — popover (legacy, still shipped)
- `settings-popover`, `settings-content`, `settings-sidebar-{version,footer}`,
  `settings-mcp-status`, `settings-display-name`, `settings-shortcuts-list`
- `default-mode-{tandem,solo}-btn`, `solo-rail-hidden-toggle`,
  `dwell-time-slider`, `selection-toolbar-toggle`,
  `margin-view-toggle`, `cowork-settings-suspense-fallback`
- `view-{changelog,documentation}-btn`, `changelog-error`,
  `report-bug-link`, `app-info-footer`

### Settings — modal (Wave 9 + responsive)
- `settings-modal{,-scrim,-content,-close-btn,-narrow-hamburger}`
- `settings-modal-sidebar-{version,footer}`,
  `settings-modal-mcp-status`, `settings-modal-tab-{*}`,
  `settings-modal-display-name`, `settings-modal-shortcuts-list`,
  `settings-modal-app-info-footer`
- `settings-modal-default-mode-{tandem,solo}-btn`,
  `settings-modal-solo-rail-hidden-toggle`,
  `settings-modal-dwell-time-slider`,
  `settings-modal-selection-toolbar-toggle`,
  `settings-modal-margin-view-toggle`,
  `settings-modal-cowork-suspense-fallback`,
  `settings-modal-open-integration-wizard`,
  `settings-modal-view-{changelog,documentation}-btn`,
  `settings-modal-changelog-error`, `settings-modal-report-bug-link`

### Settings — Appearance tab
- `theme-{*}-btn`, `default-tab-{chat,annotations}-btn`,
  `text-size-{*}-btn`, `accent-hue-slider`, `editor-font-{*}-btn`,
  `density-{*}-btn`, `reduce-motion-toggle`, `appearance-formatting-bar` (1.11)
- Decorations mirror group (1.13): `appearance-show-{authorship,comments,highlights,notes}`
  (interpolated via `{testid}`, so not in the testid-set snapshot; tracked here).
  Replaces the single `annotation-decorations-toggle` (#596 per-type split).

### Settings — Editor / Accessibility / Network
- `editor-measure-{*}` (Phase 3.5 Stage B reading-measure preset; one button per
  `narrow|comfortable|wide|full`, interpolated, so it lands as `editor-measure-{*}`
  in the snapshot. Replaced `editor-width-slider` when `editorWidthPercent` → `editorMeasure`.)
- `high-contrast-toggle`, `annotation-patterns-toggle`
- `network-{restart-sidecar,degraded-delay-slider,retry-strategy,hold-annotations-toggle}`

### Settings — Models tab
- `models-{empty-state,save-error,legacy-migration-banner,legacy-migrate-btn,legacy-migration-status}`
- `model-{row,default,toggle,edit-btn,delete-confirm,delete-btn}-{*}`,
  `model-add-btn`
- Edit modal: `model-edit-{modal,cancel,provider,displayname,modelid,apikey,apikey-replace-btn,endpoint,save}`
- First-run picker: `first-run-{model-modal,providers,provider-{*},displayname,modelid,apikey,endpoint,error,save,skip,skip-secondary}`

### Integration wizard (F1–F6)
- `integration-wizard{,-close,-save,-keychain-fallback,-done-close}`
- Steps: `integration-wizard-step-{detect,pick,secrets,review,saving,done,error}`
- `integration-wizard-continue-{detect,pick,secrets}`,
  `integration-wizard-pick-{*}`,
  `integration-wizard-secret-{input,submit}-{*}`,
  `integration-wizard-apply-result-{*}`

### Cowork modals & settings
- `cowork-onboarding-{step,confirm,error,enable-btn,enable-confirm-btn,enable-cancel-btn,skip-btn,learn-more-btn,learn-more-link}`
- `cowork-admin-declined-{backdrop,modal,confirm-disable,error,status-error,disable-btn,disable-confirm-btn,disable-cancel-btn,retry-btn}`
- `cowork-settings{,-loading,-unsupported,-undetected,-error}`,
  `cowork-toggle`, `cowork-toggle-checkbox`, `cowork-inline-toast`,
  `cowork-enable-{confirm,confirm-btn,cancel-btn}`,
  `cowork-vethernet-cidr`,
  `cowork-lan-ip-override{,-checkbox}`,
  `cowork-{workspace-table,workspace-row-{*}-{*},workspace-report-{*}-{*},rescan-btn}`

### Outline & navigation
- `outline-panel`, `outline-search-input`, `outline-heading-{*}-{*}`

### Toasts & notifications
- `toast-container`, `toast-{*}`, `toast-count-{*}`, `toast-dismiss-{*}`

### Activity center (1.10)
- `activity-pill`, `activity-tray`, `activity-empty`, `activity-clear-all`
- `activity-row-{*}`, `activity-dismiss-{*}`, `activity-action-{*}`

### Apply & collapsible primitives
- `apply-changes-btn`
- Collapsible passthrough: `testid ? \`{*}-toggle\` : undefined` (CollapsibleSection wrapper — actual selectors live at call sites)

### Test harnesses (not user-facing, kept for vitest)
- `notifications-harness`, `throw-on-render-ok`,
  `harness-{acknowledge,version,banner-dismiss,banner-version}`
