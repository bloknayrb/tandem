# #518A — Remove Review Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete all `reviewMode` state, props, CSS, keyboard handling, and UI from the codebase — the feature was cut in the final design.

**Architecture:** Pure deletion — no new behaviour, no migration. Remove from the bottom of the dependency tree upward: delete `useReviewKeyboard`, strip `useAnnotationReview`, then strip the leaf components (`Editor`, `SidePanel`), then `App`. Delete E2E tests that covered the removed behaviour.

**Tech Stack:** Svelte 5, TypeScript, Playwright (E2E)

---

## Files changed

| File | Action |
|---|---|
| `src/client/hooks/useReviewKeyboard.svelte.ts` | Delete |
| `src/client/panels/useAnnotationReview.svelte.ts` | Modify — remove 3 params + keyboard/scroll-to-first effects |
| `src/client/editor/Editor.svelte` | Modify — remove `reviewMode` prop + `tandem-review-dimmed` wrapper |
| `src/client/editor/editor.css` | Modify — delete `.tandem-review-dimmed` blocks |
| `src/client/panels/SidePanel.svelte` | Modify — remove `reviewMode`, `review-mode-btn`, toggle props |
| `src/client/App.svelte` | Modify — remove state, functions, prop pass-throughs |
| `src/client/components/HelpModal.svelte` | Modify — remove "Review Mode" shortcuts section |
| `src/client/components/SettingsPopover.svelte` | Modify — remove "Review" shortcuts section |
| `tests/e2e/annotation-lifecycle.spec.ts` | Modify — delete `review mode navigates with keyboard` test |
| `tests/e2e/settings-and-filters.spec.ts` | Modify — delete two tests that use `review-mode-btn` |

---

### Task 1: Delete useReviewKeyboard.svelte.ts

**Files:**
- Delete: `src/client/hooks/useReviewKeyboard.svelte.ts`

- [ ] **Step 1: Confirm no imports of useReviewKeyboard remain**

```bash
grep -r "useReviewKeyboard" src/
```

Expected: one result — the file itself. (If more, note them; you'll clean them up in later tasks.)

- [ ] **Step 2: Delete the file**

```bash
rm src/client/hooks/useReviewKeyboard.svelte.ts
```

- [ ] **Step 3: Verify deletion**

```bash
ls src/client/hooks/useReview*
```

Expected: `No such file or directory`

---

### Task 2: Strip getReviewMode from useAnnotationReview.svelte.ts

**Files:**
- Modify: `src/client/panels/useAnnotationReview.svelte.ts`

- [ ] **Step 1: Remove three params from UseAnnotationReviewParams interface**

In `src/client/panels/useAnnotationReview.svelte.ts`, the interface currently reads (lines 41–55):

```ts
export interface UseAnnotationReviewParams {
  getYdoc: () => Y.Doc | null;
  getEditor: () => TiptapEditor | null;
  getAnnotations: () => Annotation[];
  onActiveAnnotationChange: (id: string | null) => void;
  getReviewMode: () => boolean;
  onToggleReviewMode: () => void;
  onExitReviewMode: () => void;
  getBulkConfirm: () => "accept" | "dismiss" | null;
  setBulkConfirm: (v: "accept" | "dismiss" | null) => void;
  getScrollBehavior: () => ScrollBehavior;
}
```

Replace with:

```ts
export interface UseAnnotationReviewParams {
  getYdoc: () => Y.Doc | null;
  getEditor: () => TiptapEditor | null;
  getAnnotations: () => Annotation[];
  onActiveAnnotationChange: (id: string | null) => void;
  getBulkConfirm: () => "accept" | "dismiss" | null;
  setBulkConfirm: (v: "accept" | "dismiss" | null) => void;
  getScrollBehavior: () => ScrollBehavior;
}
```

- [ ] **Step 2: Remove the three params from the function destructure**

The function signature currently destructures (lines 78–89):

```ts
export function useAnnotationReview({
  getYdoc,
  getEditor,
  getAnnotations,
  onActiveAnnotationChange,
  getReviewMode,
  onToggleReviewMode,
  onExitReviewMode,
  getBulkConfirm,
  setBulkConfirm,
  getScrollBehavior,
}: UseAnnotationReviewParams): UseAnnotationReviewReturn {
```

Replace with:

```ts
export function useAnnotationReview({
  getYdoc,
  getEditor,
  getAnnotations,
  onActiveAnnotationChange,
  getBulkConfirm,
  setBulkConfirm,
  getScrollBehavior,
}: UseAnnotationReviewParams): UseAnnotationReviewReturn {
```

- [ ] **Step 3: Delete cancelBulkOrExit and handleKeyDown functions plus the keyboard $effect**

Remove lines 274–327 entirely (the `cancelBulkOrExit` function, `handleKeyDown` function, and the `$effect` that registers the keyboard listener). Replace that block with nothing.

The section to remove starts at:

```ts
  function cancelBulkOrExit() {
    if (getBulkConfirm()) {
      setBulkConfirm(null);
    } else {
      onExitReviewMode();
    }
  }

  // Keyboard handler for review mode
  function handleKeyDown(e: KeyboardEvent) {
```

…and ends at the closing `});` of the `$effect` for the keyboard listener:

```ts
    return () => window.removeEventListener("keydown", handleKeyDown);
  });
```

- [ ] **Step 4: Delete prevReviewMode and the scroll-to-first $effect**

Remove lines 341–350:

```ts
  // Scroll to first annotation when entering review mode
  let prevReviewMode = false;
  $effect(() => {
    const reviewMode = getReviewMode();
    const targets = getReviewTargets();
    if (reviewMode && !prevReviewMode && targets.length > 0) {
      reviewIndex = 0;
      scrollToAnnotation(targets[0]);
    }
    prevReviewMode = reviewMode;
  });
```

- [ ] **Step 5: Simplify the sync-activeAnnotation $effect**

The effect at (now renumbered) lines ~330–338 currently reads:

```ts
  $effect(() => {
    const reviewMode = getReviewMode();
    const targets = getReviewTargets();
    if (reviewMode && targets.length > 0) {
      onActiveAnnotationChange(targets[reviewIndex]?.id ?? null);
    } else {
      onActiveAnnotationChange(null);
    }
  });
```

Replace with:

```ts
  $effect(() => {
    const targets = getReviewTargets();
    onActiveAnnotationChange(targets[reviewIndex]?.id ?? null);
  });
```

- [ ] **Step 6: Simplify the keep-index-in-bounds $effect**

The effect currently reads:

```ts
  $effect(() => {
    const reviewMode = getReviewMode();
    const targets = getReviewTargets();
    if (reviewMode && reviewIndex >= targets.length) {
      reviewIndex = Math.max(0, targets.length - 1);
    }
  });
```

Replace with:

```ts
  $effect(() => {
    const targets = getReviewTargets();
    if (reviewIndex >= targets.length) {
      reviewIndex = Math.max(0, targets.length - 1);
    }
  });
```

- [ ] **Step 7: Delete the auto-exit $effect**

Remove the entire effect block:

```ts
  // Auto-exit when no pending left
  $effect(() => {
    const reviewMode = getReviewMode();
    const targets = getReviewTargets();
    if (reviewMode && targets.length === 0) {
      onExitReviewMode();
    }
  });
```

- [ ] **Step 8: Run typecheck**

```bash
npm run typecheck
```

Expected: errors about `getReviewMode`, `onToggleReviewMode`, `onExitReviewMode` still passed at call sites in SidePanel. Note the errors — you will fix them in Task 5.

---

### Task 3: Strip reviewMode from Editor.svelte and editor.css

**Files:**
- Modify: `src/client/editor/Editor.svelte`
- Modify: `src/client/editor/editor.css`

- [ ] **Step 1: Remove reviewMode prop from Editor.svelte Props interface**

In `src/client/editor/Editor.svelte`, find the Props interface. Remove the `reviewMode?: boolean` line. Also remove it from the destructure. Search for:

```bash
grep -n "reviewMode" src/client/editor/Editor.svelte
```

Remove every line that references `reviewMode` — the prop declaration, the destructure, and the conditional `class={reviewMode ? "tandem-review-dimmed" : ""}` on the outer div.

The outer div at line 167 currently reads:
```svelte
<div class={reviewMode ? "tandem-review-dimmed" : ""}>
```

The inner structure is:
```svelte
<div class={reviewMode ? "tandem-review-dimmed" : ""}>
  <div bind:this={editorRoot}></div>
</div>
```

Replace with just:
```svelte
<div bind:this={editorRoot}></div>
```

(Remove the outer div entirely — it existed only to carry the class.)

Also remove the `if (activeAnnotationId && reviewMode)` branch at line 148 — change it to just:
```ts
if (activeAnnotationId) {
```

- [ ] **Step 2: Remove .tandem-review-dimmed from editor.css**

In `src/client/editor/editor.css`, remove lines 75–89:

```css
.tandem-review-dimmed .ProseMirror {
  color: var(--tandem-fg-subtle);
  transition: color 0.2s;
}
.tandem-review-dimmed .tandem-highlight,
.tandem-review-dimmed .tandem-comment,
.tandem-review-dimmed .tandem-suggestion,
.tandem-review-dimmed .tandem-note {
  color: var(--tandem-fg);
}
.tandem-review-dimmed .tandem-annotation-active {
  outline: 2px solid var(--tandem-accent);
  outline-offset: 1px;
  border-radius: 2px;
}
```

---

### Task 4: Strip reviewMode from SidePanel.svelte

**Files:**
- Modify: `src/client/panels/SidePanel.svelte`

- [ ] **Step 1: Remove reviewMode, onToggleReviewMode, onExitReviewMode from Props**

Search for all reviewMode-related lines:

```bash
grep -n "reviewMode\|onToggleReviewMode\|onExitReviewMode\|review-mode-btn" src/client/panels/SidePanel.svelte
```

Remove:
- `reviewMode?: boolean` from Props interface
- `onToggleReviewMode?: () => void` from Props interface
- `onExitReviewMode?: () => void` from Props interface
- Their destructure lines

- [ ] **Step 2: Remove the review-mode-btn button block**

Lines 331–352 contain the Review button. Remove the entire button:

```svelte
<button
  ...
  data-testid="review-mode-btn"
  ...
>
  {reviewMode ? "Exit Review" : "Review"}
</button>
```

- [ ] **Step 3: Remove the review mode indicator block**

Lines 357–368 contain a conditional block `{#if reviewMode && review.getReviewTargets().length > 0}` that shows the "Reviewing N / M" indicator. Remove the entire `{#if}` block.

- [ ] **Step 4: Remove getReviewMode, onToggleReviewMode, onExitReviewMode from the useAnnotationReview call**

At lines 141–152, the `useAnnotationReview` call currently passes:

```ts
const review = useAnnotationReview({
  getYdoc: () => ydoc,
  getEditor: () => editor,
  getAnnotations: () => annotations,
  onActiveAnnotationChange: (id) => onActiveAnnotationChange(id),
  getReviewMode: () => reviewMode,
  onToggleReviewMode: () => onToggleReviewMode(),
  onExitReviewMode: () => onExitReviewMode(),
  getBulkConfirm: () => bulkConfirm,
  setBulkConfirm: (v) => (bulkConfirm = v),
  getScrollBehavior: () => scrollBehavior,
});
```

Replace with:

```ts
const review = useAnnotationReview({
  getYdoc: () => ydoc,
  getEditor: () => editor,
  getAnnotations: () => annotations,
  onActiveAnnotationChange: (id) => onActiveAnnotationChange(id),
  getBulkConfirm: () => bulkConfirm,
  setBulkConfirm: (v) => (bulkConfirm = v),
  getScrollBehavior: () => scrollBehavior,
});
```

---

### Task 5: Strip reviewMode from App.svelte

**Files:**
- Modify: `src/client/App.svelte`

- [ ] **Step 1: Remove reviewMode state and toggle functions**

At line 146, remove:
```ts
let reviewMode = $state(false);
```

At lines 207–213, remove:
```ts
function toggleReviewMode() {
  reviewMode = !reviewMode;
}

function exitReviewMode() {
  reviewMode = false;
}
```

- [ ] **Step 2: Remove reviewMode prop-throughs in three-panel layout (lines ~328–374)**

Find the two `PanelSlot kind="side"` instances in the three-panel layout. Each currently has:

```svelte
{reviewMode}
onToggleReviewMode={toggleReviewMode}
onExitReviewMode={exitReviewMode}
```

Remove those three lines from each PanelSlot.

- [ ] **Step 3: Remove reviewMode from tabbedPanel snippet (lines ~579–596)**

The `tabbedPanel` snippet has a `PanelSlot kind="side"` with the same three lines:

```svelte
{reviewMode}
onToggleReviewMode={toggleReviewMode}
onExitReviewMode={exitReviewMode}
```

Remove them.

- [ ] **Step 4: Remove reviewMode from Editor (line ~518)**

```svelte
{reviewMode}
```

Remove that prop from the Editor component inside `editorColumn`.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors. If any remain, search for `reviewMode`:

```bash
grep -rn "reviewMode\|toggleReviewMode\|exitReviewMode" src/client/
```

Fix any remaining references.

---

### Task 6: Strip review shortcuts from HelpModal and SettingsPopover

**Files:**
- Modify: `src/client/components/HelpModal.svelte`
- Modify: `src/client/components/SettingsPopover.svelte`

- [ ] **Step 1: Remove "Review Mode" section from HelpModal.svelte**

In `src/client/components/HelpModal.svelte`, the SECTIONS array contains:

```ts
  {
    title: "Review Mode",
    rows: [
      { keys: ["Tab"], description: "Next annotation" },
      { keys: ["Shift", "Tab"], description: "Previous annotation" },
      { keys: ["Y"], description: "Accept annotation" },
      { keys: ["N"], description: "Reject annotation" },
      { keys: ["Z"], description: "Undo last accept/reject" },
      { keys: ["E"], description: "Examine (scroll & exit)" },
      { keys: ["Escape"], description: "Exit review mode" },
    ],
  },
```

Remove the entire object (including the trailing comma).

- [ ] **Step 2: Remove "Review" section from SettingsPopover.svelte**

In `src/client/components/SettingsPopover.svelte`, the SHORTCUT_SECTIONS array contains:

```ts
  {
    title: "Review",
    rows: [
      { keys: "Tab", description: "Next annotation" },
      { keys: "Shift+Tab", description: "Previous annotation" },
      { keys: "Y", description: "Accept annotation" },
      { keys: "N", description: "Reject annotation" },
      { keys: "Escape", description: "Exit review mode or close dialogs" },
    ],
  },
```

Remove the entire object.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors, 0 warnings.

---

### Task 7: Delete review mode E2E tests

**Files:**
- Modify: `tests/e2e/annotation-lifecycle.spec.ts`
- Modify: `tests/e2e/settings-and-filters.spec.ts`

- [ ] **Step 1: Delete the keyboard nav test in annotation-lifecycle.spec.ts**

In `tests/e2e/annotation-lifecycle.spec.ts`, remove the entire test block starting at line 172:

```ts
test("review mode navigates with keyboard", async ({ page }) => {
```

Delete from that line through the closing `});` of the test.

- [ ] **Step 2: Delete two review-mode tests in settings-and-filters.spec.ts**

In `tests/e2e/settings-and-filters.spec.ts`, delete the test:

```ts
test("side panel keeps active annotation in view on filter change", async ({ page }) => {
```

Also delete the test:

```ts
test("side panel scrolls to top (+ logs warn) when active annotation is filtered out", async ({
```

Both tests rely on `review-mode-btn` to set `activeAnnotationId` from the side panel — a code path that no longer exists. Delete them outright (do not skip).

- [ ] **Step 3: Confirm no remaining review-mode-btn references**

```bash
grep -rn "review-mode-btn\|useReviewKeyboard\|reviewMode\|toggleReviewMode\|exitReviewMode" src/ tests/
```

Expected: zero results.

---

### Task 8: Final verification and commit

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 2: Run unit tests**

```bash
npm test
```

Expected: all pass. If any test imports something that was deleted, fix it.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(#518A): remove review mode (cut from final design)"
```
