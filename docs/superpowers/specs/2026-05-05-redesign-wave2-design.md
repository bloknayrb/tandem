# Tandem Redesign Wave 2 — Engineering Spec

Date: 2026-05-05
Issues: #518 (authorship gutter + review mode removal), #519 (Solo rail hiding), #520 (recent files menu)
Status: Design approved, pending implementation plan

---

## Overview

Three independent features that complete the redesign wave started in #514–#517. They share no runtime dependencies and can be implemented and reviewed in parallel. #521 (broad visual pass) is blocked on #518 landing first.

---

## #518 — Remove review mode; add authorship gutter

### Part A: Remove review mode

Review mode (the "dimmed non-annotated paragraphs" whole-app mode) was explicitly cut from the final design (design bundle chat5, 2026-04-29). Keyboard annotation navigation will be replaced by a future configurable-keybindings feature.

**Files to change:**

| File | Change |
|---|---|
| `src/client/App.svelte` | Delete `reviewMode` state, `toggleReviewMode`, `exitReviewMode`, and all prop pass-throughs to Editor, SidePanel, ReviewOnlyBanner |
| `src/client/editor/Editor.svelte` | Delete `reviewMode` prop and the `tandem-review-dimmed` wrapper div/class |
| `src/client/editor/editor.css` | Delete `.tandem-review-dimmed` and any associated selector blocks |
| `src/client/panels/SidePanel.svelte` | Delete `reviewMode` prop, `review-mode-btn` button, and related state |
| `src/client/hooks/useReviewKeyboard.svelte.ts` | Delete file entirely |
| `src/client/components/HelpModal.svelte` | Remove "Exit review mode" shortcut entry |
| `src/client/components/SettingsPopover.svelte` | Remove "Exit review mode" shortcut entry |

**Preserve:** `readOnly` (used for `.docx` files), `ReviewOnlyBanner`, `useAnnotationReview`, `useReviewCompletion`. These are unrelated to the dimmed-mode concept.

**E2E tests:** Any test referencing `data-testid="review-mode-btn"` must be removed or updated.

---

### Part B: Authorship gutter

A 2px colored thread on the left margin of each paragraph indicates the dominant author. This is a heuristic visual — it reduces per-character attribution to a single per-paragraph signal for legibility.

**Architecture:** Extend the existing `AuthorshipExtension` in `src/client/editor/extensions/authorship.ts`. The extension already builds inline `Decoration.inline()` entries from the authorship Y.Map. Add a second pass in `buildAuthorshipDecorations` that computes dominant author per top-level block node and emits `Decoration.node()` entries.

**Dominant-author algorithm:**
1. Walk each top-level block node in the ProseMirror document.
2. For each authorship map entry, check if its resolved range overlaps the block's character span.
3. Tally overlapping character counts by author (`user` vs `claude`). Ignore `import`.
4. If total coverage > 0: dominant = whichever author has more characters; ties go to `user`.
5. If no coverage: emit no node decoration for that block (no gutter thread).

**Decoration output:** `Decoration.node(blockFrom, blockTo, { "data-tandem-author": "user" | "claude" })`.

**Visibility gating:** The existing `visible` flag already suppresses inline decorations when `showAuthorship` is off. Pass the same flag to the node-decoration pass — when `visible === false`, skip the second pass entirely.

**CSS additions to `editor.css`:**
```css
.tandem-editor [data-tandem-author="user"]::before,
.tandem-editor [data-tandem-author="claude"]::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 0.45em;
  bottom: 0.45em;
  width: 2px;
  border-radius: 1px;
  transition: background 200ms;
}
.tandem-editor [data-tandem-author="user"]::before {
  background: var(--tandem-author-user);
  opacity: 0.55;
}
.tandem-editor [data-tandem-author="claude"]::before {
  background: var(--tandem-author-claude);
  opacity: 0.55;
}
```

The block node needs `position: relative` — verify the editor's block-level CSS already provides this; add if absent.

**Constraint:** Do not change the authorship coordinate model, Y.Map structure, or `AuthorshipRange` type.

**Tests (unit, `tests/` or `src/client/`):**
- `buildAuthorshipDecorations` with a two-paragraph doc where one paragraph has only `claude` entries returns a node decoration with `data-tandem-author="claude"` on that paragraph.
- A paragraph with mixed `user`/`claude` coverage returns the dominant author.
- A paragraph with no authorship entries returns no node decoration.
- `visible: false` returns `DecorationSet.empty` with no node decorations.

---

## #519 — Solo rail hiding and held-count visibility

### Settings

Add `soloRailHidden: boolean` (default `true`) to:
- `src/client/hooks/useTandemSettings.ts`: type definition and `DEFAULTS` object.
- `src/client/components/CoworkSettings.svelte` (or whichever file renders the Collaboration section): add a labeled toggle — "Hide side panel in Solo mode" — wired to `settings.soloRailHidden`.

### Rail hiding in App.svelte

Derive effective panel visibility without mutating the stored layout setting:

```ts
const effectivePanelHidden = $derived(
  modeState.tandemMode === 'solo' && settingsState.settings.soloRailHidden
);
```

`App.svelte` uses Svelte conditional rendering (not a CSS `data-rail` attribute) to show panels. Each layout arm (`three-panel`, `tabbed-left`, `tabbed`) renders panel columns conditionally. Wrap panel column rendering in each arm with `{#if !effectivePanelHidden}` so panels disappear in Solo without touching the stored `panelLayout` state. The editor column always renders.

Example for the `tabbed` arm (apply the same pattern to `tabbed-left` and `three-panel`):
```svelte
{:else}
  <!-- tabbed -->
  <div style="display: flex; flex: 1; overflow: hidden;">
    {@render editorColumn()}
    {#if !effectivePanelHidden}
      {@render resizeHandle(...)}
      <!-- panel column -->
    {/if}
  </div>
{/if}
```

The stored `panelLayout` state is untouched — panels restore automatically when Solo is exited. The toolbar panel-layout buttons reflect the stored setting (not the forced-hidden state) so users can see and change their preferred layout even while in Solo.

### Held count in StatusBar

`src/client/status/StatusBar.svelte`:
- Add `onShowHeld?: () => void` prop.
- When `heldCount > 0` (prop already present) and `mode === 'solo'`, render:
  ```html
  <button class="sb-held" onclick={onShowHeld} title="Show held annotations — switches to Tandem">
    <span class="held-dot" />
    <strong>{heldCount}</strong> held
  </button>
  ```
  Style with `--tandem-warning-fg` to match the held banner's color family.

`src/client/App.svelte`:
- Wire `onShowHeld` to `() => modeState.setTandemMode('tandem')`.
- Switching to Tandem restores the panel (via `effectivePanelHidden` becoming false) and surfaces the existing held banner in `SidePanel.svelte`.

### Tests

- `effectivePanelHidden` is `true` when `mode === 'solo'` and `soloRailHidden === true`.
- `effectivePanelHidden` is `false` when `mode === 'solo'` and `soloRailHidden === false`.
- `effectivePanelHidden` is `false` when `mode === 'tandem'` regardless of setting.
- StatusBar renders `sb-held` button when `heldCount > 0` and `mode === 'solo'`.
- StatusBar does not render `sb-held` when `heldCount > 0` and `mode === 'tandem'`.

---

## #520 — Recent files menu and tab polish

### New component: `RecentFilesMenu.svelte`

Location: `src/client/tabs/RecentFilesMenu.svelte`

Props:
```ts
interface Props {
  recentFiles: string[];        // full paths, most-recent first
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}
```

Renders:
1. Header row: "Recent files" (styled as `recent-head`, small caps or muted label).
2. For each path: extension badge (derived from `path.extname` — `M` for `.md`, `W` for `.docx`/`.doc`, `T` for `.txt`, `H` for `.html`), basename without extension as the name. No relative time (browser-side has no `fs.stat` access without a server round-trip — omit rather than add server coupling).
3. Divider.
4. "Browse files…" action row with a `+` icon → calls `onBrowse`.

Keyboard: `ArrowDown`/`ArrowUp` navigate list items; `Enter` selects; `Escape` calls `onClose`. Focus management: when the menu opens, focus the first item.

Accessibility: `role="menu"` on the container, `role="menuitem"` on each row, `aria-label="Recent files"` on the menu.

### Cache

Module-level cache in `src/client/utils/recentFiles.ts`:

```ts
let _cache: { files: string[]; ts: number } | null = null;
const CACHE_TTL = 30_000;

export function loadRecentFilesCached(): string[] {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL) return _cache.files;
  const files = loadRecentFiles();
  _cache = { files, ts: now };
  return files;
}

export function invalidateRecentFilesCache(): void {
  _cache = null;
}
```

Call `invalidateRecentFilesCache()` from wherever `saveRecentFiles` is called (currently `App.svelte`'s tab-sync effect).

### DocumentTabs.svelte changes

- Replace the bare `.tab-add` div with a `<button class="tab-add">` that toggles `showRecent: boolean` state on click.
- Render `<RecentFilesMenu>` absolutely positioned below the button when `showRecent` is true.
- Close on: Escape keydown (captured at menu level), click outside (a `<svelte:window onpointerdown>` that checks if the target is outside the menu+button), or after `onOpen`/`onBrowse` fires.
- Pass `recentFiles={loadRecentFilesCached()}` — read once when the menu opens, not on every render.
- Wire `onOpen` to call the existing file-open path: emit up to `App.svelte` via a new `onOpenFile` prop, which calls `yjsSync.openFileByPath(path)`.
- Wire `onBrowse` to set `showDialog = true` (existing FileOpenDialog flow).

### Tab/status polish

Per the acceptance matrix, dirty dot, read-only badge, and save indicator are already present. No additional changes required for this issue.

### Tests

- `RecentFilesMenu` renders correct extension badges for `.md`, `.docx`, `.txt`.
- Clicking a file path calls `onOpen` with that path.
- Clicking "Browse files…" calls `onBrowse`.
- Escape keydown calls `onClose`.
- `loadRecentFilesCached` returns cached value within 30s; re-reads after TTL.
- `invalidateRecentFilesCache` forces a fresh read.

---

## What is explicitly out of scope

- `#521` (broad visual pass) — blocked on `#518`; separate PR.
- `#522` (release QA) — last, blocked on `#518`–`#521`.
- Keyboard annotation navigation — future keybindings feature, not part of this wave.
- `heldInSolo` as a persisted server-side field — remains a client-derived value via `useModeGate` (current behavior unchanged).
- Relative timestamps in recent files menu — requires server round-trip; omitted.
- "New document" action in recent files menu — no server-side new-file creation today; omit.

---

## Sequencing

All three issues are independent. Suggested order for a single developer:

1. **#518A** (remove review mode) — pure deletion, lowest risk, unblocks a clean diff for #518B.
2. **#518B** (authorship gutter) — additive, no behavior change.
3. **#519** (Solo rail) — touches settings type and App.svelte layout derivation.
4. **#520** (recent files menu) — new component, isolated from 1–3.

For parallel agents: #518A, #519, and #520 can run concurrently. #518B should wait for #518A to land so it doesn't diff against deleted code.
