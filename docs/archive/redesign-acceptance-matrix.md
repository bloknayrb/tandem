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
- `src/client/components/SettingsPopover.svelte` shows the centered #515 section
  taxonomy: Appearance, Editor, Accessibility, Collaboration, Claude Code/Cowork,
  Shortcuts, and About.
- `src/client/components/AppearanceSettings.svelte`, `EditorSettings`,
  `AccessibilitySettings`, and `SettingsPopover` surface the persisted settings
  controls, including `defaultMode`, selection dwell, selectionToolbar, editor width,
  authorship, high contrast, and annotation patterns.
- `src/client/components/SettingsPopover.svelte` renders About from `/api/info`,
  including fields beyond version and MCP SDK when the server provides them.
- `src/client/editor/toolbar/Toolbar.svelte` gates the floating toolbar on
  settings.selectionToolbar, future overlay suppression, and selection state; it
  implements bold, italic, strike, code, link, highlight swatches, Comment, and
  Note.
- `src/client/editor/toolbar/Toolbar.svelte:146` through
  `src/client/editor/toolbar/Toolbar.svelte:173` write comments through the existing
  annotation Y.Map path; `src/client/editor/toolbar/Toolbar.svelte:189` through
  `src/client/editor/toolbar/Toolbar.svelte:201` use the shared highlight toggle path.
- `src/client/editor/toolbar/selection-toolbar.ts` clamps both vertical and
  horizontal toolbar placement against viewport edges.
- `src/client/editor/extensions/slash-command.ts` implements the first-pass slash
  command menu without adding a new dependency; it supports Heading 1, Heading 2,
  bullet list, numbered list, quote, and code block.
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
| #515 Settings dialog/About | Open, closeout implemented locally | Complete after evidence is attached and the issue is closed. The dialog has the issue-aligned section taxonomy, all persisted settings including `defaultMode` are visible, About renders dynamic `/api/info` fields beyond version/MCP SDK, View Changelog and Report a bug remain, and focused E2E coverage pins the new controls/About surface. | Attach/confirm verification evidence, then close #515. |
| #516 Selection mini-toolbar | Open, closeout implemented on `fix/issue-516-selection-toolbar-closeout` | Complete after this branch lands. Selection toolbar gating, positioning, bold, italic, strike, code, link, highlight swatches, Comment, Note, Y.Map comment creation, horizontal/vertical clamping, Escape/scroll dismissal, and future slash-menu suppression plumbing are present with focused unit/E2E coverage. Ask Claude and Flag remain intentionally out of scope. | Merge the closeout branch, attach verification evidence, then close #516. |
| #517 Slash command menu | Open, closeout implemented on `fix/issue-517-slash-command-menu` | Complete after this branch lands. The slash menu supports Heading 1, Heading 2, bullet list, numbered list, quote, and code block; arrow keys, Enter, Escape, pointer selection, deletion cancellation, and mini-toolbar suppression are covered. No new dependency was added. | Merge the closeout branch, attach verification evidence, then close #517. |
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
