# Tandem Redesign Acceptance Matrix

Date: 2026-05-04

This is the evidence gate for the first redesign implementation wave tracked by #513
through #522. It reconciles live GitHub issue criteria with the current `master`
implementation after #514, the settings dialog shell, the mini-toolbar work, font
assets, token changes, and the initial visual shell pass landed.

## Gate Decision

Do not start a new redesign feature until the open issue bodies and next PR scope
acknowledge the partial work already on `master`. #514 is complete enough to treat as
the foundation dependency. #515 and #516 are partial implementations and should be
finished as closeout PRs, not restarted from their original issue text. #517 through
#522 remain open implementation or QA slices.

## Evidence

- `src/client/hooks/useTandemSettings.ts:17` defines the persisted redesign settings
  surface: layout, primaryTab, panelOrder, editorWidthPercent, selectionDwellMs,
  showAuthorship, reduceMotion, textSize, theme, accentHue, editorFont, density,
  defaultMode, highContrast, annotationPatterns, and selectionToolbar.
- `src/client/App.svelte:135` wires accent hue, density, high contrast, and annotation
  patterns into root DOM/token effects; `src/client/App.svelte:142` keeps textSize on
  `--tandem-editor-font-size`.
- `index.html:57` through `index.html:92` define the `--tandem-*` accent and editor
  font tokens; `index.html:155` through `index.html:184` define density,
  high-contrast, and annotation-pattern root hooks.
- `src/client/components/SettingsPopover.svelte:16` through
  `src/client/components/SettingsPopover.svelte:34` show a centered multi-section
  settings shell, but its sections are Profile, Appearance, Editor, Accessibility,
  Automation, and About rather than the full issue #515 section list.
- `src/client/components/AppearanceSettings.svelte:62` through
  `src/client/components/AppearanceSettings.svelte:97` create radio controls for
  theme, layout, primary tab, panel order, text size, editor font, and density.
  The visible controls for editor width, authorship, high contrast, annotation
  patterns, dwell time, and selectionToolbar live in `EditorSettings`,
  `AccessibilitySettings`, and `SettingsPopover`. No visible `defaultMode` settings
  control was found.
- `src/client/components/SettingsPopover.svelte:354` through
  `src/client/components/SettingsPopover.svelte:366` render About from `/api/info`,
  but only version and MCP SDK are surfaced today.
- `src/client/editor/toolbar/Toolbar.svelte:246` through
  `src/client/editor/toolbar/Toolbar.svelte:249` gate the floating toolbar on
  settings.selectionToolbar and selection state. `src/client/editor/toolbar/Toolbar.svelte:259`
  through `src/client/editor/toolbar/Toolbar.svelte:320` implement bold, italic,
  code, highlight swatches, Comment, and Note. Strike and link are still missing.
- `src/client/editor/toolbar/Toolbar.svelte:146` through
  `src/client/editor/toolbar/Toolbar.svelte:173` write comments through the existing
  annotation Y.Map path; `src/client/editor/toolbar/Toolbar.svelte:189` through
  `src/client/editor/toolbar/Toolbar.svelte:201` use the shared highlight toggle path.
- `src/client/editor/toolbar/selection-toolbar.ts:20` through
  `src/client/editor/toolbar/selection-toolbar.ts:36` clamp vertical toolbar placement,
  but horizontal edge clamping is not implemented there.
- No slash-command implementation or `@tiptap/suggestion` dependency is present.
- `src/client/editor/extensions/authorship.ts:16` through
  `src/client/editor/extensions/authorship.ts:76` already preserve relRange-first,
  flat fallback authorship decorations with `data-tandem-author`; no paragraph
  dominant-author gutter implementation is present.
- `src/client/App.svelte:90` through `src/client/App.svelte:99` creates mode gating,
  and `src/client/panels/SidePanel.svelte:292` through
  `src/client/panels/SidePanel.svelte:297` show a held-count banner. Solo mode does
  not currently hide or collapse the rail by default.
- `src/client/App.svelte:54` and `src/client/App.svelte:70` through
  `src/client/App.svelte:78` reuse recent-file utilities, while
  `src/client/components/FileOpenDialog.svelte:189` through
  `src/client/components/FileOpenDialog.svelte:218` surface recent files in the open
  dialog. There is no tabs-area recent-files menu yet.

## Issue Matrix

| Issue | Current state | Acceptance status | Next action |
| --- | --- | --- | --- |
| #514 Redesign foundation | Closed | Complete. Root attributes/classes, accent token family, editor font token, density spacing, high contrast, annotation patterns, persisted settings, and unit tests are present. | Treat as done. Future PRs should not reopen token namespace or density/text-size decisions unless a regression is found. |
| #515 Settings dialog/About | Open, partial | Partial. The app has a centered multi-section settings shell and surfaces most persisted settings, but `defaultMode` is not visibly surfaced, the section taxonomy differs from the issue, Shortcuts is missing, About only shows version/MCP SDK, and dynamic `/api/info` fields are underused. | Close out the actual gaps: `defaultMode`, section naming/content, Shortcuts, richer About fields, and targeted E2E for newly added controls. Keep View Changelog and Report a bug. |
| #516 Selection mini-toolbar | Open, partial | Partial. Selection toolbar gating, positioning, bold, italic, code, highlight swatches, Comment, Note, Y.Map comment creation, and focused tests exist. Missing first-pass criteria: strike, link, horizontal edge clamping, explicit Escape/blur dismissal, and overlay suppression with slash menu. | Finish as a closeout PR. Do not add Ask Claude or Flag unless the issue is expanded. |
| #517 Slash command menu | Open, not started | Not implemented. No slash menu, command registry, keyboard flow, pointer selection, or mini-toolbar suppression exists. | Implement after #516 overlay coordination. Prefer a Tiptap suggestion/menu pattern if adding the dependency deliberately. |
| #518 Authorship/review decorations | Open, partial foundation only | Inline authorship decorations already use `data-tandem-author` with relRange-first/flat fallback, but paragraph dominant-author gutter and annotation-aware review dimming are not implemented. | Align paragraph gutter semantics before coding. Extend the existing decoration plugins; do not change annotation or authorship coordinate models. |
| #519 Solo rail and held count | Open, partial foundation only | Mode gating and heldCount exist and the side panel can show a held banner, but Solo does not collapse/hide the rail by default and held count is not actionable from status/toolbar. | Reuse `modeGate.visibleAnnotations` and `heldCount`; add the Solo rail default and an actionable reveal/switch path without changing mode broadcast. |
| #520 Recent files/tab/status polish | Open, partial foundation only | Recent-file utilities and File Open dialog recent list exist. Tabs already have dirty dot/read-only surfaces and status has save/read-only indicators, but there is no tabs-area recent-files menu. | Decide whether the design requires a tab-area menu or only File Open polish, then implement the smallest accessible surface. Preserve cached reads and existing indicators. |
| #521 Visual redesign pass | Open, partial shell work | Initial token/font/shell pieces exist, but the broad visual pass across toolbar, tabs, editor shell, rail, cards, chat, status bar, empty states, toasts, review summary, onboarding, and read-only surfaces is not complete. | Split if broad. Keep behavior-preservation checks explicit for panel resize, tabbed-left, three-panel, connection banner, reply threads, `.docx`, and Apply Changes. |
| #522 Release-readiness QA | Open, blocked | Not ready to execute. It depends on #515 through #521 landing. | Keep last. Use it as cross-surface accessibility, responsive, reduced-motion, high-contrast, and visual evidence gate. |

## Preserved Planning Buckets

### Design Needs To Update

- Keep the repo's `--tandem-*` token namespace as canonical.
- Keep annotation visuals aligned with the actual three-type annotation model plus
  discriminator fields, not a new wire taxonomy.
- Reflect the current settings sections and persisted settings surface after the
  #515 closeout, rather than the older handoff copy.
- Decide whether inline username editing belongs in the status bar, Settings, or both.
- Clarify whether reactions/status badges require a new data model before design asks
  the repo to render them.

### Repo Needs To Implement

- #515 closeout: defaultMode control, settings dialog section/content gaps,
  Shortcuts, and richer About.
- #516 closeout: strike, link, edge/dismissal hardening, and overlay coordination.
- #517 slash command menu.
- #518 paragraph authorship gutter and annotation-aware review dimming.
- #519 Solo rail default and actionable held count.
- #520 recent-files/tab-area decision and implementation.
- #521 broad visual redesign pass.
- #522 final cross-surface release-readiness QA.

### Both Sides Need Alignment First

- One overlay rule set for mini-toolbar and slash menu positioning, dismissal, focus
  return, Escape, and mutual suppression.
- Authorship gutter semantics: design's paragraph gutter versus the repo's current
  inline attribution.
- Titlebar/toolbar merge and Tauri window-decoration behavior.
- Diff/apply-edit view relationship to the existing Apply Changes `.docx` flow.
- First-run onboarding: wizard replacement versus existing tutorial annotations.

### Out Of Scope For This Wave

- Outline panel.
- Paged `.docx` layout.
- Find/replace.
- Command palette.
- Share/export sheet.
- True mobile layout.
- Reactions/status badges unless design and repo agree on a data-model shape.

## Per-PR Evidence Rule

Every remaining redesign PR should include an acceptance-criteria mapping, focused
tests, `npm run typecheck`, relevant Vitest or Playwright output, and before/after UI
evidence when the change is visual. Each PR should explicitly state whether it changes
annotation wire shape, coordinate behavior, mode model, localStorage contract, or
public API; the default expected answer is no.
