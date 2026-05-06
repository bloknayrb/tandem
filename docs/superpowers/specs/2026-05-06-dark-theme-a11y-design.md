# Dark Theme Completion + A11y Gate — v0.11.0

## What This Is

Issues #59 (dark theme toggle) and #369 (dark scrollbars) shipped in v0.8.0 and are closed. This spec covers the **three remaining gaps** that complete the v0.11.0 dark theme + accessibility work:

1. **Dark-adapted highlight colors** — `--tandem-highlight-*` tokens aren't overridden in `[data-theme="dark"]`; light semi-transparent values (e.g. `rgba(255, 235, 59, 0.3)`) are washed out against dark surfaces.
2. **Forced-colors fallbacks (#311)** — ~5 UI surfaces communicate state via background color only; in forced-colors/high-contrast mode they flatten to `Canvas`.
3. **Automated axe-core WCAG AA gate** — no CI fixture verifies contrast compliance; v1.0 exit criteria requires one.

Ships as two PRs:
- **PR 1** — CSS-only: dark highlight tokens + forced-colors fallbacks
- **PR 2** — Test infrastructure: axe-core Playwright fixture (both light + dark mode)

---

## PR 1 — Dark Highlight Tokens + Forced-Colors Fallbacks

### Dark Highlight Tokens

**File:** `index.html`, `[data-theme="dark"]` block

Add four overrides after the `--tandem-scrollbar-*` entries (the last entries currently in the dark block):

```css
--tandem-highlight-yellow: rgba(255, 220, 0, 0.38);
--tandem-highlight-green: rgba(72, 200, 80, 0.38);
--tandem-highlight-blue: rgba(56, 168, 255, 0.38);
--tandem-highlight-pink: rgba(240, 80, 160, 0.38);
```

**Rationale for values:** same hue family as light counterparts, opacity raised from 0.3 → 0.38 (highlights need to be more assertive against the dark surface `oklch(0.22 0.012 270)`), and each color is slightly brightened/shifted for visibility. The exact rgba values are **tuned visually during implementation** using `npm run dev:tauri` — these are starting points, not hard requirements. The implementation must verify each color reads clearly against the dark surface with a document open and annotation highlights active.

**Constraint:** `HIGHLIGHT_COLORS` in `src/client/utils/colors.ts` (used by the runtime/export path) is **not touched** — only the CSS custom properties change.

**`npm run check:tokens` implications:** this command scans `src/client/` for raw hex/rgba violations. The tokens themselves live in `index.html`, not in `src/client/`, so no check:tokens issue arises.

---

### Forced-Colors Fallbacks (#311)

**Context:** `@media (forced-colors: active)` replaces all background-color with system `Canvas`. Surfaces that rely solely on background to communicate state (warning state, active mode, notification badges) become invisible.

**Files and surfaces:**

| File | Surface | Fix |
|---|---|---|
| `src/client/status/StatusBar.svelte` | `.sb-held` warning pill | `border: 1px solid ButtonText` in forced-colors block |
| `src/client/components/ToastContainer.svelte` | Toast badge/icon | `border: 1px solid ButtonText` |
| `src/client/panels/SidePanel.svelte` | Mode pill (solo/tandem indicator) + held-annotation banner | `border: 1px solid ButtonText` on each |
| `src/client/panels/BulkActions.svelte` | Bulk-action button group | `outline: 1px solid ButtonText` (outline preferred for button groups; doesn't affect layout) |

**Pattern for each surface** — add to the component's `<style>` block:

```css
@media (forced-colors: active) {
  .sb-held {
    border: 1px solid ButtonText;
  }
}
```

**Discovery note:** exact CSS selectors must be confirmed by reading each component file during implementation. The table above names the components; the selectors are derived from the rendered markup, not prescribed here.

**Keyframe guard:** inspect `ToastContainer.svelte` for any animations that animate `background-color` or `color`. If found, add `@media (forced-colors: active) { .toast-* { animation: none; } }` to avoid invisible animated content. Treat this as inspect-and-fix-if-present.

**`App.svelte` and `CoworkSettings.svelte`:** these appeared in the grep for "mode-pill" but likely only pass props. Confirm during implementation; no fix is expected there.

---

## PR 2 — Axe-Core WCAG AA Gate

### Package

Add `@axe-core/playwright` to `devDependencies`. Run `npm install --save-dev @axe-core/playwright` and commit the updated `package.json` + `package-lock.json`.

### File

`tests/e2e/accessibility.spec.ts` — new file, follows the same ESM + `__dirname` pattern used by other E2E tests (per `feedback_e2e_test_gotchas`: use `fileURLToPath(import.meta.url)` for `__dirname` in ESM).

### Fixture Flow

```
1. Open Tandem with sample/welcome.md (same as existing E2E tests)
2. Wait for editor to be ready
3. --- Light mode pass ---
4.   page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
5.   Run axe with include/exclude (see Scope below)
6.   Assert violations === []
7. --- Dark mode pass ---
8.   page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
9.   Run axe with same include/exclude
10.  Assert violations === []
```

### Scope

**Include** (run axe only on these):
- `#root` — the Svelte mount target (`<div id="root">` in `index.html`); covers the shell, toolbar, tabs, sidebar, status bar

**Exclude** (explicitly skip):
- `[contenteditable]` — the ProseMirror editor content area; user document content has arbitrary contrast that Tandem doesn't control
- `.ProseMirror` — belt-and-suspenders exclusion alongside `contenteditable`

### Violation Handling

The first clean run will likely surface a small number of known-acceptable items. Suppress these via `axeBuilder.disableRules(['rule-id'])` with an inline comment explaining why each suppression is intentional. Examples of likely false-positives:

- Decorative SVG icons without explicit `aria-hidden` (if any exist)
- Color contrast on the authorship gutter `::before` pseudo-element (decorative)

Suppress only rules with a documented reason. The assertion must be `expect(results.violations).toEqual([])` — not `toHaveLength(0)` — so a failure prints the full violation objects for diagnosis.

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

Per `feedback_brief_subagents_about_webserver_workaround` and E2E skill: Playwright's `webServer` config starts the server before tests. The `freePort()` call kills :3478/:3479 on startup — running this fixture alongside `dev:server` will terminate the dev server. Run `npm run test:e2e` in isolation.

---

## Out of Scope

- Dark-mode verification of user document typography — handled by the token system already; not Tandem's surface to audit.
- VoiceOver / screen reader integration tests — out of scope for v0.11.0; tracked under v1.0 accessibility gate.
- `prefers-reduced-motion` handling — no new animations introduced by this work; no changes needed.
- Changes to `HIGHLIGHT_COLORS` runtime constants — CSS layer only.
