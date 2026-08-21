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
3. **Wrapper-prop passthroughs** (e.g. `ToolbarButton`, `ChipGroup`,
   `CollapsibleSection`, `App.svelte#resizeHandle`) accept a testid prop and
   the literal value lives at the call site. The snapshot captures both the
   wrapper's templated form and the call sites' literal strings. `ChipGroup`
   (#798 A15) is fully templated — both its root (`{groupTestId}`) and per-chip
   (`{groupTestId}-{value}`) testids normalize to `{*}`/`{*}-{*}`, so the
   concrete filter chip testids are documented in the Filters bullet below
   rather than captured literally by the scan.

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
- `editor-scroll-pill`, `editor-scroll-pill-thumb` — the proximity-faded scroll
  thumb overlaying the scroller's right edge. The track is always mounted and
  `pointer-events: none`; only the thumb is interactive, and only while its
  opacity clears `HIT_TEST_MIN_OPACITY`. Gated on the `scrollPill` setting and
  hidden in source view, so an E2E selector must assert on the thumb's
  `display`, not merely on the track's presence
- `title-bar`, `titlebar-brand-menu`, `titlebar-brand-menu-popover`,
  `titlebar-default-model`, `titlebar-update-available-dot`,
  `brand-menu-{settings,shortcuts,theme-{*}}`
- `formatting-bar`, `formatting-bar-track` (#1302 — the control track that
  carries the `overflow-x: clip / overflow-y: visible` axis split; the
  truncation test targets it by testid rather than by DOM position),
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
- `popup-{format-row,annotate-row}` (A8 two-pill — the two `.pill-row` capsule containers)

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
- `status-word-count`, `save-indicator`, `sb-held`
- `user-name-input` removed — the display-name editor was pulled out of the status pill (its default value "You" rendered as a duplicated "You: You"); name editing lives in Settings → Collaboration (`settings-modal-display-name`).

### Annotations (5-card audience-first split, ADR-027 / Conflict #8)
- Dispatch + chrome: `annotation-card-{*}`,
  `annotation-snippet-{*}`, `annotation-list-scroll-container`,
  `annotation-private-pill`
- Actions: `accept-btn-{*}`, `dismiss-btn-{*}`, `archive-btn-{*}`,
  `remove-btn-{*}`, `send-to-claude-btn-{*}`, `undo-btn`
- Edit form: `edit-btn-{*}`, `edit-{newtext,reason,text}-{*}`,
  `edit-{save,cancel}-btn-{*}`
- Replies + threads: `reply-{btn,input,send-btn,cancel-btn}-{*}`,
  `reply-toggle-{*}` (A13 disclosure), `comment-thread`, `reply-{*}`,
  `reply-import-byline-{*}` (Word reviewer byline on imported note replies, #1000).
  (`reply-thread-expand-{*}` + `reply-thread-overlay*` retired with the
  portaled overlay — A13 #798, Bryan decision 2026-06-01.)
- Suggestion + import variants: `suggestion-diff-{*}`,
  `annotation-import-byline-{*}`, `annotation-select-checkbox-{*}`
- Margin column: `margin-column-{*}`, `margin-bubble-{*}`,
  `margin-leaders-{*}`, `margin-pin-btn-{*}` (pin a crowd-minimized card open;
  lives on the bubble wrapper, not in the card header, so it never appears in
  the side rail)
- Batch + bulk: `batch-promote-{bar,count,clear,confirm,commit,cancel}`,
  `bulk-{confirm,cancel,accept,dismiss}-btn`. Since #1444 the batch promote is
  two-step, and `batch-promote-confirm` names the button that **requests** the
  confirm while `batch-promote-commit` is the one that performs it — the name
  drifted from the meaning, and it was kept anyway because this set may gain a
  selector but never lose one.
- Sort: `annotation-sort-toggle` (position ↔ chronological, #1056)
- Filters: `filter-bar-toggle`, `clear-filters-btn`; chip groups (#798 A15,
  `ChipGroup`) — roots `filter-{type,author,status}`; per-chip
  `filter-type-{all,highlight,comment,note,with-replacement}`,
  `filter-author-{all,claude,user,import}`,
  `filter-status-{all,pending,accepted,dismissed}` (replaced the `FilterSelect`
  `<select>`s; e2e drives them with `.click()`, not `.selectOption()`)

### Side panels & rails
- `left-outline-rail`, `annotations-tab`, `chat-tab`
- `clear-chat-btn`, `held-banner`, `store-readonly-banner`,
  `store-readonly-dismiss`, `peek-strip-{*}`,
  `panel-edge-collapse-{*}` (resize-handle selectors synthesized — see Known
  gaps)

### Banners
- `banner-stack` — the measured wrapper around the five top-of-shell banners
  (server-restart strip, pending-update, updater, connection, license). Its bottom
  edge is published as `--tandem-banner-stack-bottom` so the fixed formatting-bar
  pill clears it; the selector is the hook the geometry E2E uses to inject a probe.
- `connection-banner`, `connection-banner-retry`
- `updater-banner`, `updater-banner-{install,dismiss,visible}`
- `pending-update-banner-live`, `pending-update-banner`,
  `pending-update-banner-{check,dismiss}` (#1118 — "your update may not have
  completed"). `pending-update-banner-live` is the **persistent** live-region host
  and is present even when the banner is not: a live region created in the same
  commit as its content is commonly never announced (#1431). Do not fold it inside
  the `{#if}`; `tests/client/pending-update-banner.test.ts` pins that.
- `review-only-banner`, `review-only-dismiss`,
  `convert-to-markdown-btn`
- `fidelity-report-banner`, `fidelity-report-details-toggle`,
  `fidelity-report-details`, `fidelity-report-import-losses`,
  `fidelity-report-export-downgrades` (#1145 — `.docx` honesty notice)
- `external-conflict-banner`, `external-conflict-keep-btn`,
  `external-conflict-reload-btn` (#1069 — keep-vs-reload after an external
  write; every format since #1238)
- `wake-stall-banner` (Track D-5 — "Claude hasn't picked this up for N
  minutes"). No dismiss selector, deliberately: like `fidelity-report-banner`
  it is a projection of live state rather than an event, so it erases itself
  when `/health` reports a poll and has nothing to acknowledge.

### Modals & dialogs
- `help-modal`, `help-modal-close`
- `error-boundary-{recover,reload}-btn` (resolved from constants)
- `command-palette`, `palette-{input,empty}`, `palette-item-{*}`,
  `palette-item-new-scratchpad`
- `onboarding-tutorial`, `tutorial-{dismiss,next}-btn`

### Settings — popover (REMOVED 2026-07-21 — consolidated into the modal below; testids deleted)
- `settings-popover`, `settings-content`, `settings-sidebar-{version,footer}`,
  `settings-mcp-status`, `settings-display-name`, `settings-shortcuts-list`
- `default-mode-{tandem,solo}-btn`, `solo-rail-hidden-toggle`,
  `dwell-time-slider`, `selection-toolbar-toggle`,
  `margin-view-toggle`, `cowork-settings-suspense-fallback`
- `view-{changelog,documentation}-btn`, `changelog-error`,
  `report-bug-link`, `app-info-footer`

### Settings — modal (Wave 9 + responsive)
- `settings-modal{,-scrim,-content,-close-btn,-narrow-hamburger}`
- `settings-readonly-banner` — forward-compat read-only notice
  (`SettingsReadonlyBanner.svelte`), rendered on BOTH settings surfaces
  (modal: between header and scroll body; popover: above the scroll body)
  when `settings._readOnly` is set. Distinct from `store-readonly-banner`
  (SidePanel's annotation-store lock banner).
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
  `settings-modal-push-routes`, `settings-modal-push-routes-shim` (#1432 — the
  persistent "Real-time updates" section; the `-shim` paragraph is route three,
  whose two arms are the honesty-critical copy),
  `settings-modal-view-{changelog,documentation}-btn`,
  `settings-modal-changelog-error`, `settings-modal-report-bug-link`

### Settings — Appearance tab
- `theme-{*}-btn`, `default-tab-{chat,annotations}-btn`,
  `text-size-{*}-btn`, `accent-hue-slider`,
  `density-{*}-btn`, `reduce-motion-toggle`, `appearance-formatting-bar` (1.11),
  `appearance-uniform-tab-width`, `appearance-scroll-pill`
- Decorations mirror group (1.13): `appearance-show-{authorship,comments,highlights,notes}`
  (interpolated via `{testid}`, so not in the testid-set snapshot; tracked here).
  Replaces the single `annotation-decorations-toggle` (#596 per-type split).

### Settings — Editor / Accessibility / Network
- `editor-measure-{*}` (Phase 3.5 Stage B reading-measure preset; one button per
  `narrow|comfortable|wide|full`, interpolated, so it lands as `editor-measure-{*}`
  in the snapshot. Replaced `editor-width-slider` when `editorWidthPercent` → `editorMeasure`.)
- `editor-font-{*}-btn`, `font-by-extension-section`,
  `font-by-extension-reset`, `font-by-extension-row-{*}`,
  `font-by-extension-{*}-{*}` (#1262: moved from Appearance — fonts are a
  property of the document surface, not app chrome)
- `appearance-show-raw-markdown` (#981, moved #1262 — testid keeps its
  historical `appearance-` prefix; Critical Rule 7 forbids renaming it)
- `high-contrast-toggle`, `annotation-patterns-toggle`
- `network-{restart-sidecar,degraded-delay-slider,retry-strategy}`

### Settings — Models tab
- `models-{empty-state,save-error,legacy-migration-banner,legacy-migrate-btn,legacy-migration-status}`
- `model-{row,default,toggle,edit-btn,delete-confirm,delete-btn}-{*}`,
  `model-add-btn`
- Edit modal: `model-edit-{modal,cancel,provider,displayname,modelid,apikey,apikey-replace-btn,endpoint,save}`
- First-run picker: `first-run-{model-modal,providers,provider-{*},displayname,modelid,apikey,endpoint,error,save,skip,skip-secondary}`

### Integration wizard (unified onboarding wizard)
The wizard shipped as a detection-led single screen (MAIN view) + a Cowork
opt-in sub-view, NOT the 6-step `pick→secrets→review→saving` flow the original
manifest anticipated. The phantom step/continue/save testids below never
shipped and were removed:
- `integration-wizard{,-close,-keychain-fallback,-advanced}`
- MCP connect machine: `integration-wizard-step-{detect,applying,done,error,verifying}`,
  `integration-wizard-{connect-btn,check-again,done-close,done-retry,error-retry}`
- Detected installs: `integration-wizard-card-{*}`, `integration-wizard-pick-{*}`,
  `integration-wizard-secret-{input,submit}-{*}`,
  `integration-wizard-apply-result-{*}`
- Post-apply reachability (#1174): `integration-wizard-reachability-{*}`,
  `integration-wizard-whats-next`
- Start at login (#1463): `integration-wizard-autostart{,-toggle,-error}` — desktop only, and
  hidden entirely when the OS reports no tray, so absence is not a regression signal on its own.
- Per-target delivery honesty (#1299): `integration-wizard-push-support-{*}` —
  renders ONLY on a client Tandem structurally cannot notify (today Claude
  Desktop), so its ABSENCE is the assertion for every other row. Carries
  `data-push-support="none"`; there is deliberately no affirmative counterpart.
- CLI honesty: `integration-wizard-shim-warning` — renders in the connect step
  for ALL detection outcomes, unlike the empty-state-only install testids
- More integrations + Cowork sub-view: `integration-wizard-more`,
  `integration-wizard-cowork-{setup,step,back,error,explainer}`, plus the reused
  `cowork-enable-confirm-btn` / `cowork-vethernet-cidr`
- Subnet pre-flight (#1298): `integration-wizard-cowork-preflight-{blocked,retry-btn}`.
  This sub-view has no confirm step — its footer button fires the real enable —
  so the probe runs on entry to the view, and the retry button *replaces*
  `cowork-enable-confirm-btn` while blocked rather than sitting beside it.
- Plugin install (#1390): `integration-wizard-plugin{,-commands,-copy,-copy-status}`
  in the push-mode block. **These four now live in `PushRoutesInfo.svelte`, not
  the wizard** (#1432) — the block was extracted so Settings → AI Assistant can
  render the same copy, and the ids kept their wizard-era names because Critical
  Rule 7 forbids removing a selector. The two hosts never show it at once: the
  wizard renders it only under `step === "done"`.
  `integration-wizard-settings-pointer` is the Done screen's gated pointer at
  that persistent home. Tandem shows these commands rather than running them
  (the reason is on `CLAUDE_PLUGIN_INSTALL_COMMANDS`), so `-commands` holds the
  text and `-copy` is the only affordance. `-copy-status` is the button's
  outcome, in its own live region rather than in the button label — a changed
  accessible name on an unfocused button announces nothing. Rendered once from
  a snippet ABOVE the registered/unregistered split rather than twice inside it
  — both branches carry it because neither one can omit it.

### Live regions (#1431)
Eleven regions that used to be written on the node their own `{#if}` created —
inserted together with their text, and so announced by nothing. Each selector
below names a region that is now mounted BEFORE its content and outlives it, so
the content's arrival is a mutation an AT can read. They are asserted in
`tests/client/live-regions*.test.ts`, which pins *empty first, then filled, same
node* — an assertion that the attribute merely exists proves nothing here.

- Host shape (wraps the `{#if}`, parent has no `gap`): `connection-banner-live`,
  `updater-banner-live`, `license-banner-live`, `wake-stall-live`,
  `review-only-live`, `find-replace-live`.
- Announcer shape (out-of-flow sr-only sibling, paired with `aria-hidden` on the
  visible message node): `external-conflict-live`, `source-view-live`,
  `integration-wizard-progress-live` (one region covering all three
  `loadingDots` call sites), and `fidelity-report-live-polite` /
  `fidelity-report-live-assertive` — two fixed-politeness regions replacing one
  node whose `role` was computed from state.

Deliberately NOT swept, with reasons in the #1431 PR: `panels/AnnotationCard`
and `status/StatusBar` (chattiness), `panels/SidePanel` (a `display: none`
ancestor takes any region there out of the a11y tree), and every `role="alert"`
site.

### Cowork modals & settings
- `cowork-onboarding-{step,confirm,error,enable-btn,enable-confirm-btn,enable-cancel-btn,skip-btn,learn-more-btn,learn-more-link}`
- Subnet pre-flight (#1298), on both surfaces that have a confirm step:
  `cowork-onboarding-preflight-{blocked,retry-btn}` and
  `cowork-preflight-{blocked,retry-btn}`. The retry button **replaces** the
  enable-confirm button while detection is known-failing, so a spec asserting
  `*-enable-confirm-btn` visible must first establish the probe did not block.
- Broken-probe line (#1436): `cowork-preflight-failed`,
  `cowork-onboarding-preflight-failed` and
  `integration-wizard-cowork-preflight-failed`. Distinct from `-blocked`
  because the two say opposite things: `-blocked` reports a detection failure
  we watched happen and so **replaces** Enable with a retry, while `-failed`
  reports that the check never ran and therefore leaves Enable exactly where it
  was — a spec asserting `*-preflight-failed` must find no `*-retry-btn`. The
  no-probe case renders neither — but note every surface that probes is already
  gated on `isTauriRuntime()` and `osSupported`, so in the shipped app that case
  is effectively unreachable and `-failed` is the arm a real session lands on.
  Absence of all three is still not evidence the probe passed.
- Pre-flight live regions (#1376): `cowork-preflight-live`,
  `cowork-onboarding-preflight-live` and `integration-wizard-cowork-preflight-live`.
  The `role="status"` wrapper, mounted for the life of the confirm (the wizard's
  for the life of the sub-view) so a hint arriving later is announced rather than
  inserted silently with its region. The `-blocked` testids sit INSIDE it, which
  is why they still come and go; the wrapper never does — `-failed` sits there
  for the same reason. The wizard's carries
  `display: contents` — its parent is a gapped flex column, so an empty box
  there would be a permanent gap; the other two parents are plain blocks.
  The remaining live regions that still had the pre-#1376 shape were swept in
  #1431 — see "Live regions (#1431)" below, which lists both the regions added
  and the sites deliberately left alone. Counts are deliberately not repeated
  here: sites and regions are not 1:1 (the wizard's three collapse to one,
  FidelityReportBanner's one expands to two), so a number in two places drifts.
- `cowork-admin-declined-{backdrop,modal,confirm-disable,error,status-error,disable-btn,disable-confirm-btn,disable-cancel-btn,retry-btn,learn-more-link}`
- `cowork-settings{,-loading,-unsupported,-undetected,-error}`,
  `cowork-toggle`, `cowork-toggle-checkbox`, `cowork-inline-toast`,
  `cowork-toggle-warnings` (degraded-success caveats from the last toggle — a
  `role="status"` block, deliberately not the `role="alert"` error banner, #1438),
  `cowork-explainer`,
  `cowork-enable-{confirm,confirm-btn,cancel-btn}`,
  `cowork-vethernet-cidr`,
  `cowork-reachability` (post-enable stdio-channel reachability verdict, #1174 gap #3),
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

### Empty states (3.11 D5)
- `empty-state-open-file` (state A primary), `empty-state-retry` + `empty-state-open-settings` (state C)
- State A AI-readiness CTA (#1268, keyed 1:1 off the `useAiReadiness` `chip` value — never re-derive from `lastError` in the view): `empty-state-connect-ai` (`aiChip: "connect"`), `empty-state-setup-claude` (`aiChip: "setup"` — keyed off `lastError === "cli-unusable"`, a filesystem probe the supervisor takes when the circuit breaker trips), `empty-state-setup-restart-anyway` (`aiChip: "setup"` secondary — the escape for a false-negative probe, so the branch is not a dead end), `empty-state-restart-claude` (`aiChip: "restart"` primary), `empty-state-start-fresh` (`aiChip: "restart"` secondary — irreversible, never the default handler)

### Licensing gate (#1116, ships dark)
- `license-trial-banner`, `license-trial-days` (trial countdown banner)
- `license-wall` (restricted-mode activation overlay)
- `license-activate-input`, `license-activate-error`, `license-activate-submit` (shared activation form)
- `license-settings-section`, `license-status-pill` (Settings → License tab)

### Test harnesses (not user-facing, kept for vitest)
- `notifications-harness`, `throw-on-render-ok`,
  `harness-{acknowledge,version,banner-dismiss,banner-version}`
