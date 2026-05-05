# Tandem Redesign Wave 2 — Engineering Spec

Date: 2026-05-05
Issues: #518 (authorship gutter + review mode removal), #519 (Solo rail hiding), #520 (recent files menu)
Status: Design approved, reviewed, corrections applied

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
| `src/client/panels/SidePanel.svelte` | Delete `reviewMode` prop, `review-mode-btn` button, and `onToggleReviewMode`/`onExitReviewMode` props |
| `src/client/hooks/useReviewKeyboard.svelte.ts` | Delete file entirely |
| `src/client/panels/useAnnotationReview.svelte.ts` | Remove `getReviewMode` parameter from the function signature; remove all `reviewMode`-conditional keyboard handling and scroll-to-first behavior inside the hook (that logic belongs to the deleted `useReviewKeyboard`) |
| `src/client/components/HelpModal.svelte` | Remove "Exit review mode" shortcut entry |
| `src/client/components/SettingsPopover.svelte` | Remove "Exit review mode" shortcut entry |

**Preserve:** `readOnly` (used for `.docx` files), `ReviewOnlyBanner`, `useAnnotationReview` (keep accept/dismiss logic — only remove the `getReviewMode` parameter and keyboard-nav code), `useReviewCompletion`.

**E2E tests:** Remove or rewrite any test that clicks `data-testid="review-mode-btn"` or depends on review mode keyboard navigation (Tab-cycling through annotations). Those tests cover behavior that will not exist until a future keybindings feature. Do not carry them forward as skipped — delete them outright so they do not accumulate as tech debt.

---

### Part B: Authorship gutter

A 2px colored thread on the left margin of each paragraph indicates the dominant author. This is a heuristic visual — it reduces per-character attribution to a single per-paragraph signal for legibility.

**Architecture:** Extend `buildAuthorshipDecorations` in `src/client/editor/extensions/authorship.ts`. The function already builds `Decoration.inline()` entries. Add a second pass that computes dominant author per top-level block node and emits `Decoration.node()` entries with a discriminator attribute `data-tandem-author-block` (distinct from `data-tandem-author` used on inline spans — this prevents the `::before` CSS from accidentally applying to inline character spans).

**Node types that receive the gutter:** `paragraph` and `heading` only. Exclude list containers (`bullet_list`, `ordered_list`), `blockquote`, `code_block`, and other structural nodes. `doc.forEach` iterates top-level children only — it does not descend. A list node is one top-level block whose dominant author covers the entire list, which is visually misleading; excluding list containers avoids a broken gutter on `<ul>`/`<ol>` where `::before` renders outside all list items.

**Dominant-author algorithm:**
1. Call `doc.forEach((node, offset) => ...)` to visit top-level blocks. `offset` is a ProseMirror position.
2. Skip nodes whose `type.name` is not `paragraph` or `heading`.
3. The block spans `[offset, offset + node.nodeSize)` in ProseMirror positions. All resolved authorship ranges from `resolveAuthorshipRange` are already in ProseMirror coordinates — compare directly.
4. Tally overlapping character counts by author (`user` vs `claude`). Ignore `import` entries entirely.
5. If total coverage > 0: dominant = whichever has more characters; ties go to `user`.
6. If no coverage: emit no node decoration for that block.

**Decoration output:** `Decoration.node(offset, offset + node.nodeSize, { "data-tandem-author-block": "user" | "claude" })`.

**Visibility gating:** When `visible === false`, skip the second pass entirely (same guard as the inline pass).

**CSS additions to `editor.css`:**
```css
.tandem-editor [data-tandem-author-block]::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 0.45em;
  bottom: 0.45em;
  width: 2px;
  border-radius: 1px;
  transition: background 200ms;
}
.tandem-editor [data-tandem-author-block="user"]::before {
  background: var(--tandem-author-user);
  opacity: 0.55;
}
.tandem-editor [data-tandem-author-block="claude"]::before {
  background: var(--tandem-author-claude);
  opacity: 0.55;
}
```

Block nodes need `position: relative` for `::before` to anchor correctly. Verify `editor.css` already provides this for `p` and heading elements; add if absent.

**Constraint:** Do not change the authorship coordinate model, Y.Map structure, or `AuthorshipRange` type.

**Tests (extend `tests/client/authorship-decoration.test.ts`):**

The existing mock stubs `Decoration` but only captures `Decoration.inline()` calls in `capturedInlines`. Add a parallel `capturedNodes` array that records `Decoration.node()` calls. Then add:

- Single-author paragraph (all `claude` entries) → `capturedNodes` has one entry with `data-tandem-author-block="claude"`.
- Mixed-author paragraph (claude 3 chars, user 5 chars) → node decoration is `"user"` (majority wins).
- Tie-break (claude 3 chars, user 3 chars) → node decoration is `"user"` (tie goes to user).
- Authorship entry spanning two paragraphs → each paragraph tallies only the overlapping portion; both get independent node decorations.
- `import` author entries are excluded — a paragraph with only `import` coverage gets no node decoration.
- Heading node receives a gutter decoration; `bullet_list` node does not.
- No authorship coverage → no node decoration for that block.
- `visible: false` → `capturedNodes` is empty (guard verified, not just `capturedInlines`).

---

## #519 — Solo rail hiding and held-count visibility

### Settings

Add `soloRailHidden: boolean` (default `true`) to `src/client/hooks/useTandemSettings.ts`:

1. Type definition: `soloRailHidden: boolean;`
2. `DEFAULTS`: `soloRailHidden: true`
3. `loadSettings` parse line (follow the existing boolean pattern):
   ```ts
   soloRailHidden: parsed.soloRailHidden === false ? false : DEFAULTS.soloRailHidden,
   ```
   This ensures a user who explicitly sets `false` survives a page reload. Without this line the setting resets to `true` on every load.

Add a labeled toggle to the settings UI. `CoworkSettings.svelte` is confirmed to exist — verify at implementation time whether it is the right section host for this toggle, or whether `AccessibilitySettings.svelte` or a new "Behavior" section is more appropriate. Label: "Hide side panel in Solo mode".

### Rail hiding in App.svelte

Derive effective panel visibility without mutating the stored layout setting:

```ts
const effectivePanelHidden = $derived(
  modeState.tandemMode === 'solo' && settingsState.settings.soloRailHidden
);
```

`App.svelte` uses Svelte conditional rendering — three layout arms (`three-panel`, `tabbed-left`, `tabbed`). In each arm, wrap **both** panel column divs **and** their associated `{@render resizeHandle(...)}` calls in `{#if !effectivePanelHidden}`. The editor column always renders regardless.

For `three-panel` specifically, both the left panel column + left resize handle and the right panel column + right resize handle must be suppressed together. Example pattern:

```svelte
{#if panelLayout.kind === "three-panel"}
  <div style="display: flex; flex: 1; overflow: hidden;">
    {#if !effectivePanelHidden}
      <!-- left panel column -->
      {@render resizeHandle("left", ...)}
    {/if}
    {@render editorColumn()}
    {#if !effectivePanelHidden}
      {@render resizeHandle("right", ...)}
      <!-- right panel column -->
    {/if}
  </div>
```

The stored `panelLayout` state is untouched — panels restore automatically when Solo is exited. Toolbar panel-layout buttons always reflect the stored setting.

**Upgrade note:** `soloRailHidden` defaults to `true`. Users whose `defaultMode` is `"solo"` will silently lose the panel on upgrade. A migration notice is deferred; document this tradeoff in the PR description so reviewers can weigh in before merge.

### Held count in StatusBar

`src/client/status/StatusBar.svelte` does not currently have `heldCount` or `mode` props — add both:

```ts
interface Props {
  // ... existing props ...
  heldCount?: number;
  mode?: TandemMode;
  onShowHeld?: () => void;
}
```

When `heldCount > 0` and `mode === 'solo'`, render:
```html
<button class="sb-held" onclick={onShowHeld}
  title="Show held annotations — switches to Tandem">
  <span class="held-dot" />
  <strong>{heldCount}</strong> held
</button>
```
Style with `--tandem-warning-fg`.

`src/client/App.svelte`: pass `heldCount={modeGate.heldCount}`, `mode={modeState.tandemMode}`, and `onShowHeld={() => modeState.setTandemMode('tandem')}` to `StatusBar`. Switching to Tandem flips `effectivePanelHidden` to false and surfaces the existing held banner in `SidePanel.svelte`.

### Tests

- `effectivePanelHidden` derived value: `true` when `mode === 'solo'` and `soloRailHidden === true`.
- `effectivePanelHidden`: `false` when `mode === 'solo'` and `soloRailHidden === false` (opt-out works).
- `effectivePanelHidden`: `false` when `mode === 'tandem'` regardless of setting.
- `loadSettings` round-trip: persisting `soloRailHidden: false` and reloading returns `false`, not the default `true`.
- StatusBar renders `sb-held` when `heldCount > 0` and `mode === 'solo'`.
- StatusBar does not render `sb-held` when `heldCount > 0` and `mode === 'tandem'`.
- `onShowHeld` callback fires when the `sb-held` button is clicked.

---

## #520 — Recent files menu and tab polish

### New component: `RecentFilesMenu.svelte`

Location: `src/client/tabs/RecentFilesMenu.svelte`

Props:
```ts
interface Props {
  recentFiles: string[];   // full paths, most-recent first
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}
```

Renders:
1. Header: "Recent files" (muted label).
2. For each path in `recentFiles`: extension badge (`M` for `.md`, `W` for `.docx`/`.doc`, `T` for `.txt`, `H` for `.html`), basename as the display name.
3. **If `recentFiles.length > 0`:** divider below the list. If the list is empty, omit the divider — header + empty space + "Browse files…" without a floating divider.
4. "Browse files…" action row → calls `onBrowse`.

Keyboard: `ArrowDown`/`ArrowUp` navigate list items; `Enter` selects focused item; `Escape` calls `onClose`. On open, focus the first list item (or "Browse files…" if list is empty).

Accessibility: `role="menu"`, `role="menuitem"` on each row, `aria-label="Recent files"`.

### File open path

`yjsSync` does not expose a `openFileByPath` method. Opening a file goes through `POST /api/open` with `{ filePath }` — the same path used by `FileOpenDialog.openByPath`. 

`RecentFilesMenu`'s `onOpen` handler (wired in `DocumentTabs.svelte`) should call `POST ${API_BASE}/open` with the selected path, then call `invalidateRecentFilesCache()` and `onClose()`. Error handling follows the same pattern as `FileOpenDialog` (surface an error string on non-ok response). Import `API_BASE` from `src/client/utils/api.ts` (or wherever it is currently defined).

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

Call `invalidateRecentFilesCache()` at every `saveRecentFiles` call site. Currently this is `App.svelte`'s tab-sync effect and the new `onOpen` handler. If `saveRecentFiles` is also called elsewhere, wrap the export itself to auto-invalidate rather than auditing every call site:

```ts
export function saveRecentFiles(list: string[]): void {
  // ... existing implementation ...
  invalidateRecentFilesCache();
}
```

### DocumentTabs.svelte changes

The `+` button already exists as `<button data-testid="open-file-btn">` — do not replace it with a new element. Instead:
- Add `showRecent: boolean` state, toggled by the existing button's `onclick`.
- Render `<RecentFilesMenu>` absolutely positioned below the button when `showRecent` is true.
- Pass `recentFiles={loadRecentFilesCached()}` — snapshot once when `showRecent` flips to true via a `$derived` or `$effect` that captures on open.
- Close on: `Escape` (menu-level keydown), pointer-down outside the menu+button (`<svelte:window onpointerdown>` checking `!menuEl.contains(event.target) && !buttonEl.contains(event.target)`), or after `onOpen`/`onBrowse` fires.
- `data-testid="open-file-btn"` is in `CLAUDE.md`'s listed testids — keep it on the button; the existing E2E test that clicks it to open `FileOpenDialog` should still pass (clicking without the recent menu visible still opens the dialog, or adjust behavior so a click toggles recent menu and a double-click / keyboard opens dialog directly — confirm this UX decision at implementation time).
- Wire `onOpen` to post `POST /api/open` as described above.
- Wire `onBrowse` to set `showDialog = true`.

**Tauri note:** `DocumentTabs` sits below the custom titlebar drag region. `onpointerdown` for click-outside detection should check `event.target` is not within the Tauri drag region (check `data-tauri-drag-region` attribute on ancestors) to avoid closing the menu on drag-start events.

### Tab/status polish

Per the acceptance matrix, dirty dot, read-only badge, and save indicator are already present. No additional changes required for this issue.

### Tests

Unit (extend `tests/client/recent-files.test.ts`):
- `loadRecentFilesCached` returns the cached list on second call within 30s without re-reading localStorage.
- `loadRecentFilesCached` re-reads localStorage after 30s TTL.
- `invalidateRecentFilesCache` followed immediately by `loadRecentFilesCached` calls `loadRecentFiles()` again (not serving stale data).
- `saveRecentFiles` auto-invalidates the cache (if the wrapping approach is used).

Component / E2E (Playwright):
- Open recent files menu; press `ArrowDown`; press `Enter` — verifies the second item's path was passed to `onOpen`.
- Empty recent files list: menu renders "Browse files…" without a divider.
- Extension badges: `.md` → `M`, `.docx` → `W`, `.txt` → `T`.

---

## What is explicitly out of scope

- `#521` (broad visual pass) — blocked on `#518`; separate PR.
- `#522` (release QA) — last, blocked on `#518`–`#521`.
- Keyboard annotation navigation — future keybindings feature.
- `heldInSolo` as a persisted server-side field — remains a client-derived value via `useModeGate`.
- Relative timestamps in recent files menu — requires `fs.stat` server round-trip; omitted.
- Migration notice for `soloRailHidden` default change — deferred; document in PR description.

---

## Sequencing

All three issues are independent. Suggested order for a single developer:

1. **#518A** (remove review mode) — pure deletion, lowest risk, unblocks a clean diff for #518B.
2. **#518B** (authorship gutter) — additive, no behavior change.
3. **#519** (Solo rail) — touches settings type and App.svelte layout derivation.
4. **#520** (recent files menu) — new component, isolated from 1–3.

For parallel agents: #518A, #519, and #520 can run concurrently. #518B should wait for #518A to land so it doesn't diff against deleted code.
