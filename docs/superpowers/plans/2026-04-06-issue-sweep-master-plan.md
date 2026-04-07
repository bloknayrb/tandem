# Issue Sweep Master Plan

## Status (as of 2026-04-06)
- **Wave 1: MERGED** (PR #213) -- #212 localStorage guards, #202 scroll reset, pre-existing lint fixes
- **#211** (tool count) -- verified correct, closed.
- **Wave 2a: MERGED** (PR #215) -- #195 suggestion diff display, #196 undo countdown, #201 edit button label
- **Wave 2b: MERGED** (PR #216) -- #197 disabled tooltips, #198 chat anchor expand, #200 review shortcut hints, #203 color picker cancel. Review caught wrong keybindings (A/D→Y/N) and conditional guard issue, both fixed before merge.
- **Waves 3-7: NOT STARTED**

## Wave 2a: Annotation Card UX (1 PR)
**Issues:** #195, #196, #201 -- all touch `AnnotationCard.tsx`

### #195 -- Show replacement text on suggestion cards
- **File:** `src/client/panels/AnnotationCard.tsx:317-323`
- **Bug:** `parsed.reason || parsed.newText` hides newText when reason exists
- **Fix:** Always show `parsed.newText` (styled as diff: strikethrough original + green new text). Show `parsed.reason` below when present.

### #196 -- Countdown indicator on undo window
- **File:** `src/client/panels/AnnotationCard.tsx` (Undo button area, line ~370-390)
- **Approach:** Pure CSS animation -- shrinking progress bar with `animation-duration: 10s` that starts on mount (when `undoable` becomes true). No new state needed.
- Timer source: `SidePanel.tsx:164` (10s setTimeout in `resolveAnnotation`)

### #201 -- Edit button tooltip + label
- **File:** `src/client/panels/AnnotationCard.tsx:171-183`
- **Fix:** Change `title="Edit annotation"` to more descriptive text. Add visible "Edit" label next to pencil icon.

## Wave 2b: Toolbar & Input UX (1 PR)
**Issues:** #197, #198, #200, #203 -- toolbar/chat interaction improvements

### #197 -- Tooltips on disabled toolbar buttons
- **File:** `src/client/editor/toolbar/ToolbarButton.tsx`
- **Approach:** Add `disabledTitle?: string` prop. In `Toolbar.tsx`, pass `disabledTitle="Select text first"` on annotation buttons.

### #198 -- Expand chat anchor preview on hover/click
- **File:** `src/client/panels/ChatPanel.tsx:265-282`
- **Current:** `maxHeight: "60px"`, truncates at 80 chars
- **Fix:** Add hover state to remove maxHeight and show full `textSnapshot`.

### #200 -- Review mode shortcut hints
- **File:** `src/client/panels/SidePanel.tsx:482-499` (Review button)
- **Fix:** Expand button title or add hint text showing key bindings before entering review mode.

### #203 -- Cancel button on color picker
- **File:** `src/client/editor/toolbar/Toolbar.tsx:269-305`
- **Fix:** Add Cancel/x button to color picker popover row.

## Wave 3: Toolbar Layout (1 PR)
**Issues:** #192, #204

### #192 -- Toolbar overflow on narrow windows
- **File:** `src/client/editor/toolbar/Toolbar.tsx:212-220`
- **Approach:** Start with `flexWrap: "wrap"`. Overflow menu only if wrapping looks bad.

### #204 -- Missing toolbar buttons for loaded extensions
- **File:** `src/client/editor/toolbar/FormattingToolbar.tsx`
- **Add buttons for:** Link (Ctrl+K), Horizontal Rule, Code Block
- Extensions already loaded in `Editor.tsx` (Link, StarterKit includes HR/CodeBlock).

## Wave 4: Notification & Interruption (2 PRs)

### Wave 4a: #208 -- Review banner removal
- **Clarify first:** No threshold-based review banner exists. May refer to held-annotation banner (`SidePanel.tsx:415-447`) or review completion overlay (`ReviewSummary.tsx`).

### Wave 4b: #188, #206, #207 -- Selection events & interruption
- Key files: `useAnnotationGate.ts`, `App.tsx:144-153`, `StatusBar.tsx:158-185`, `src/server/mcp/awareness.ts`
- Must read all 3 issue bodies before designing. #206 may reframe #188.

## Wave 5: Annotation Type Unification (1 PR, highest risk)
**Issues:** #193, #199
- Touches: `shared/types.ts`, `AnnotationCard.tsx`, `SidePanel.tsx`, `Toolbar.tsx`, `annotations.ts` (MCP), `FilterSelect.tsx`, `annotation.ts` (extension)
- #199 (stale Accept All) folds into #193's card action rework

## Wave 6: Feature Work (separate PRs)
- **#209** -- Claude cursor (synthetic awareness entry)
- **#191** -- Auto-save (debounced for .md, manual for .docx)
- **#153** -- Inline images (Tiptap Image extension)

## Wave 7: Deferred
#187, #190, #165, #59, #24, #103, #31, #15

## Execution Order
```
Wave 1 (DONE) -> Wave 2a + 2b (parallel) -> Wave 3 -> Wave 4a -> Wave 4b -> Wave 5 -> Wave 6
```

## 10-Step Pipeline (per wave)
1. Plan agent designs implementation
2. 2-3 reviewer agents critique plan (architecture, UX, CRDT safety)
3. Developer agent implements (worktree)
4. code-simplifier agent cleans up
5. Commit & PR
6. 3+ specialized PR review agents
7. Developer agent fixes review findings
8. Browser automation testing
9. Fix test issues
10. Merge
