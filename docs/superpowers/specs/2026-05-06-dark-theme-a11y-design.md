# Dark Theme Completion + A11y Gate — v0.11.0

## What This Is

Issues #59 (dark theme toggle) and #369 (dark scrollbars) shipped in v0.8.0 and are closed. This spec covers the **three remaining gaps** that complete the v0.11.0 dark theme + accessibility work:

1. **Dark-adapted highlight colors** — `--tandem-highlight-*` tokens aren't overridden in `[data-theme="dark"]`; light semi-transparent values (e.g. `rgba(255, 235, 59, 0.3)`) are washed out against dark surfaces.
2. **Forced-colors fallbacks (#311)** — several UI surfaces communicate state via background color only; in forced-colors/high-contrast mode they flatten to `Canvas`.
3. **Automated axe-core WCAG AA gate** — no CI fixture verifies contrast compliance; v1.0 exit criteria requires one.

Ships as two PRs:
- **PR 1** — CSS-only: dark highlight tokens + forced-colors fallbacks
- **PR 2** — Test infrastructure: axe-core Playwright fixture (both light + dark mode). **PR 2 branches off PR 1's branch** and targets `master` only after PR 1 is merged and CI is green — this ensures the gate doesn't fail on the initial run from pre-existing contrast issues.

---

## PR 1 — Dark Highlight Tokens + Forced-Colors Fallbacks

### Dark Highlight Tokens

**File:** `index.html`, `[data-theme="dark"]` block

Add four overrides after the `--tandem-scrollbar-*` entries (confirmed last entries in the dark block):

```css
--tandem-highlight-yellow: rgba(255, 220, 0, 0.38);
--tandem-highlight-green: rgba(72, 200, 80, 0.38);
--tandem-highlight-blue: rgba(56, 168, 255, 0.38);
--tandem-highlight-pink: rgba(240, 80, 160, 0.38);
```

**Rationale for values:** same hue family as light counterparts, opacity raised from 0.3 → 0.38 (more assertive against the dark surface `oklch(0.22 0.012 270)`), colors slightly brightened/shifted. The exact rgba values are **tuned visually during implementation** using `npm run dev:tauri` — these are starting points, not hard requirements. Verify each reads clearly against the dark surface with a document open and annotation highlights active.

**Constraint:** the highlight color values used in the runtime/export path (non-CSS, e.g. serialization) are defined elsewhere in the codebase and are **not touched** — only the four CSS custom properties in `index.html` change.

**`npm run check:tokens` implications:** this command scans `src/client/` for raw hex/rgba violations. These token definitions live in `index.html`, not in `src/client/`, so no check:tokens issue arises.

**CHANGELOG:** add under `### Fixed` in `[Unreleased]`.

---

### Forced-Colors Fallbacks (#311)

**Context:** `@media (forced-colors: active)` replaces background-color with system `Canvas`. Surfaces that rely solely on background to communicate state become invisible. Note: `index.html` already contains a forced-colors block — check it before adding duplicates; any existing fixes there should be migrated to the relevant component `<style>` block if they're component-specific concerns.

**Surfaces to fix** — the implementer must read each file to confirm the element has no existing border/outline fallback before adding one:

| File | Surface | Expected fix |
|---|---|---|
| `src/client/status/StatusBar.svelte` | Held-annotation warning pill | `border: 1px solid ButtonText` |
| `src/client/status/StatusBar.svelte` | Connection-status dot + Claude-active indicator (background-only circles) | `outline: 1px solid ButtonText` (outline doesn't affect circular shape layout) |
| `src/client/components/ToastContainer.svelte` | Toast count badge | `border: 1px solid ButtonText` |
| `src/client/panels/SidePanel.svelte` | Mode pill (solo/tandem indicator) | `border: 1px solid ButtonText` — **only if it has no existing border**; the held-annotation banner in the same file already uses `warningStateColors.border` and does NOT need a fix |
| `src/client/panels/BulkActions.svelte` | Confirm/reject button group | `outline: 1px solid ButtonText` |
| `src/client/panels/AnnotationCard.svelte` | Type-badge pill (comment/replacement/note) + Private pill | `border: 1px solid ButtonText` on each |

**Selector note:** Svelte component `<style>` blocks use scoped selectors. Use the actual CSS class on each element (inspect the component template), not `data-testid` attributes (test IDs aren't CSS hooks). If no suitable class exists, add a semantic one — e.g. `.held-pill`, `.status-dot`.

**Pattern for each fix** — add to the component's `<style>` block:

```css
@media (forced-colors: active) {
  .held-pill {
    border: 1px solid ButtonText;
  }
}
```

**Keyframe guard:** inspect `ToastContainer.svelte` for animations that animate `background-color` or `color`. If found, add `@media (forced-colors: active) { animation: none; }` to avoid invisible animated content.

**`App.svelte` and `CoworkSettings.svelte`:** appeared in the initial grep but likely only pass props. Confirm during implementation; no fix expected.

**CHANGELOG:** add under `### Fixed` in `[Unreleased]` alongside the highlight token fix (same PR).

---

## PR 2 — Axe-Core WCAG AA Gate

### Package

Add `@axe-core/playwright` to `devDependencies`. Run `npm install --save-dev @axe-core/playwright` and commit the updated `package.json` + `package-lock.json`.

### File

`tests/e2e/accessibility.spec.ts` — new file, following the same ESM + `__dirname` pattern used by other E2E tests: `fileURLToPath(import.meta.url)`.

### Fixture Flow

```
1. Open Tandem with sample/welcome.md (same as existing E2E tests)
2. Wait for editor to be ready
3. --- Light mode pass ---
4.   page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
5.   Run axe with include/exclude (see Scope)
6.   Assert violations === []
7. --- Dark mode pass ---
8.   page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
9.   Run axe with same include/exclude
10.  Assert violations === []
```

**Why `setAttribute` is safe:** `useTheme.ts` sets `data-theme` imperatively; no MutationObserver or reactive loop watches the attribute. External `page.evaluate` sets it and it sticks — the Svelte reactive system will not flip it back unless the user-pref signal changes independently.

### Scope

**Include:**
- `#root` — the Svelte mount target (`<div id="root">` in `index.html`); covers shell, toolbar, tabs, sidebar, status bar, annotation panel

**Exclude:**
- `[contenteditable]` — ProseMirror content area; user document content has arbitrary contrast Tandem doesn't control
- `.ProseMirror` — belt-and-suspenders alongside `contenteditable`

**Note on AnnotationCard suggestion diffs:** the struck-through/green diff spans inside `AnnotationCard.svelte` render inside `#root` but outside `.ProseMirror` — they will be scanned. Their contrast depends on `--tandem-error-bg` / `--tandem-success-bg` token values in dark mode, which have not been pre-verified. If axe flags these on first run, treat them as legitimate findings (fix tokens) rather than suppressions.

### Violation Handling

Suppress only rules with a documented reason using `axeBuilder.disableRules(['rule-id'])` and an inline comment. Likely legitimate suppressions on first run:

- Decorative SVG icons without `aria-hidden` (if any)
- Authorship gutter `::before` pseudo-element (decorative, no text)

The assertion must be `expect(results.violations).toEqual([])` — not `toHaveLength(0)` — so failures print full violation objects.

### Test Structure

```typescript
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test.describe('WCAG AA — light mode', () => {
  test('app chrome has no violations', async ({ page }) => {
    // open welcome.md, wait for ready ...
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'light')
    )
    const results = await new AxeBuilder({ page })
      .include('#root')
      .exclude('[contenteditable]')
      .exclude('.ProseMirror')
      .analyze()
    expect(results.violations).toEqual([])
  })
})

test.describe('WCAG AA — dark mode', () => {
  test('app chrome has no violations', async ({ page }) => {
    // open welcome.md, wait for ready ...
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'dark')
    )
    const results = await new AxeBuilder({ page })
      .include('#root')
      .exclude('[contenteditable]')
      .exclude('.ProseMirror')
      .analyze()
    expect(results.violations).toEqual([])
  })
})
```

### Webserver Note

Per E2E skill: Playwright's `webServer` config kills :3478/:3479 on startup — running alongside `dev:server` will terminate the dev server. Run `npm run test:e2e` in isolation.

**CHANGELOG:** add under `### Added` in `[Unreleased]`.

---

## Out of Scope

- Dark-mode verification of user document typography — handled by token indirection; not Tandem's surface to audit.
- VoiceOver / screen reader integration tests — out of scope for v0.11.0; tracked under v1.0 accessibility gate.
- `prefers-reduced-motion` — no new animations in this work; no changes needed.
- Changes to runtime highlight color constants (non-CSS export paths) — CSS layer only.
