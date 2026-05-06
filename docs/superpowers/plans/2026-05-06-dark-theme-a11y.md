# Dark Theme Completion + A11y Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dark-adapted annotation highlight colors, forced-colors fallbacks for background-only state surfaces, and an automated axe-core WCAG AA gate covering both light and dark mode.

**Architecture:** Two PRs. PR 1 is pure CSS: four token overrides in `index.html` plus `@media (forced-colors: active)` rules in the global block and in individual Svelte `<style>` blocks. PR 2 adds `@axe-core/playwright` and a new `tests/e2e/accessibility.spec.ts` fixture; it branches off PR 1 and targets master only after PR 1 merges.

**Tech Stack:** CSS custom properties, `@media (forced-colors: active)`, Svelte 5 scoped `<style>` blocks, `@axe-core/playwright`, Playwright E2E, Tandem dev stack (`npm run dev:standalone`, `npm run test:e2e`).

---

## Context: Key File Facts

These were verified before writing the plan — don't re-derive them:

- **`index.html`** line ~184: last line of `[data-theme="dark"]` block is `--tandem-scrollbar-thumb: oklch(0.38 0.014 270);`
- **`index.html`** lines 220–246: existing `@media (forced-colors: active)` block already maps token families to system colors. Add new surface rules **inside this block, after the existing `[data-testid="held-badge"]` rule**.
- **`src/client/status/StatusBar.svelte`**: held pill (`data-testid="sb-held"`) already has `border: 1px solid var(--tandem-warning-border)` inline → **no forced-colors fix needed**. Status dots and Claude-active dot are inline-style background circles with no class.
- **`src/client/components/ToastContainer.svelte`**: toast count badge uses dynamic `data-testid={`toast-count-${toast.id}`}` and background-only inline styles. Animation `tandem-toast-slide-in` uses only `opacity + transform` — no keyframe guard needed.
- **`src/client/panels/BulkActions.svelte`**: confirm button is `data-testid="bulk-confirm-btn"`, background-only inline styles.
- **`src/client/panels/AnnotationCard.svelte`**: type-badge pill has no class and no `data-testid`; Private pill is `data-testid="annotation-private-pill"`.
- **Mode toggle** lives in `src/client/editor/toolbar/ModeToggle.svelte` (not SidePanel). Active button state must be inspected — Task 5 includes a read step.
- **`@axe-core/playwright`** is not yet in `package.json`. Add to `devDependencies`.
- **E2E pattern:** `McpTestClient` in `tests/e2e/helpers.ts`; open a file with `mcp.callTool("tandem_open", { filePath })`, detect readiness via `page.locator(".tandem-editor").toBeVisible({ timeout: 10_000 })`.

---

## PR 1 — CSS Fixes

Branch: `fix/dark-theme-a11y-css`

---

### Task 1: Add dark highlight token overrides

**Files:**
- Modify: `index.html` (inside `[data-theme="dark"]` block, after line ~184)

- [ ] **Step 1: Open `index.html`. Find the `[data-theme="dark"]` block. Locate the last line:**
  ```css
  --tandem-scrollbar-thumb: oklch(0.38 0.014 270);
  ```

- [ ] **Step 2: Insert four lines immediately after it (before the closing `}` of the dark block):**
  ```css
        --tandem-highlight-yellow: rgba(255, 220, 0, 0.38);
        --tandem-highlight-green: rgba(72, 200, 80, 0.38);
        --tandem-highlight-blue: rgba(56, 168, 255, 0.38);
        --tandem-highlight-pink: rgba(240, 80, 160, 0.38);
  ```
  Preserve the existing two-space-per-level indentation used throughout the block.

- [ ] **Step 3: Run the token lint check — must stay clean:**
  ```bash
  npm run check:tokens
  ```
  Expected: no violations (changes are in `index.html`, not `src/client/`).

- [ ] **Step 4: Visual smoke — start the app and verify highlights in dark mode.**
  ```bash
  npm run dev:standalone
  ```
  Open `http://localhost:5173` in Chrome. Switch to dark theme (Settings → Appearance → Dark). Open `sample/welcome.md`. Select some text, apply each highlight color from the toolbar. Each color must be **clearly visible** against the dark background — not washed out. Tune any of the four rgba values if a color is too faint; the values in Step 2 are starting points.

- [ ] **Step 5: Commit:**
  ```bash
  git add index.html
  git commit -m "fix(theme): add dark-adapted highlight color token overrides"
  ```

---

### Task 2: Fix StatusBar status dots for forced-colors

The connection-status dot and Claude-active indicator in `StatusBar.svelte` are 8×8px circles rendered entirely with inline `background` — no class, no border. In forced-colors mode they become invisible.

**Files:**
- Modify: `src/client/status/StatusBar.svelte`

- [ ] **Step 1: Read `src/client/status/StatusBar.svelte` and locate the two dot elements.** They look like:
  ```svelte
  <span style="width: 8px; height: 8px; border-radius: 50%; background: {dotColor}; ..."></span>
  ```
  Find both: the connection-status dot (animated with `tandem-reconnect-pulse`) and the Claude-active dot (animated with `tandem-status-pulse`).

- [ ] **Step 2: Add a `class` attribute to each dot element.** Connection dot gets `class="status-dot"`. Claude-active dot gets `class="claude-dot"`. Leave all inline styles untouched:
  ```svelte
  <span class="status-dot" style="width: 8px; height: 8px; border-radius: 50%; background: {dotColor}; ..."></span>
  ```
  ```svelte
  <span class="claude-dot" style="width: 8px; height: 8px; border-radius: 50%; background: var(--tandem-author-claude); ..."></span>
  ```

- [ ] **Step 3: Add forced-colors rules to the component's `<style>` block.** The existing `<style>` block only contains `@keyframes` inside `:global {}`. Add the media query **inside the `<style>` block but outside the `:global {}` wrapper** (Svelte scopes these selectors automatically):
  ```svelte
  <style>
    :global {
      @keyframes tandem-status-pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
      @keyframes tandem-reconnect-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    }

    @media (forced-colors: active) {
      .status-dot,
      .claude-dot {
        outline: 1px solid ButtonText;
        outline-offset: 1px;
      }
    }
  </style>
  ```
  `outline` is preferred over `border` for dots: it doesn't affect layout (no box model impact).

- [ ] **Step 4: Run typecheck and unit tests:**
  ```bash
  npm run typecheck && npm test
  ```
  Expected: 0 errors, all tests pass.

- [ ] **Step 5: Commit:**
  ```bash
  git add src/client/status/StatusBar.svelte
  git commit -m "fix(a11y): add forced-colors outlines to StatusBar status dots (#311)"
  ```

---

### Task 3: Fix ToastContainer badge for forced-colors

The toast count badge uses a dynamic `data-testid` and background-only inline styles. It needs a stable CSS class for targeting.

**Files:**
- Modify: `src/client/components/ToastContainer.svelte`

- [ ] **Step 1: Read `src/client/components/ToastContainer.svelte`. Find the badge `<span>` element.** It has `data-testid={`toast-count-${toast.id}`}` and inline styles including `background: {bgColor}`.

- [ ] **Step 2: Add `class="toast-badge"` to the badge `<span>`. Leave all inline styles untouched:**
  ```svelte
  <span class="toast-badge" data-testid={`toast-count-${toast.id}`} style="...existing styles...">
  ```

- [ ] **Step 3: Add a forced-colors rule to the component's `<style>` block.** Find (or create) the `<style>` block and add:
  ```css
  @media (forced-colors: active) {
    .toast-badge {
      border: 1px solid ButtonText;
    }
  }
  ```

- [ ] **Step 4: Run typecheck and unit tests:**
  ```bash
  npm run typecheck && npm test
  ```
  Expected: 0 errors, all tests pass.

- [ ] **Step 5: Commit:**
  ```bash
  git add src/client/components/ToastContainer.svelte
  git commit -m "fix(a11y): add forced-colors border to toast badge (#311)"
  ```

---

### Task 4: Audit ModeToggle for forced-colors

The active-state button in ModeToggle communicates selection. It may or may not have a border already.

**Files:**
- Conditionally modify: `src/client/editor/toolbar/ModeToggle.svelte`

- [ ] **Step 1: Read `src/client/editor/toolbar/ModeToggle.svelte` in full.**

- [ ] **Step 2: Inspect the active-button style.** Look for how the selected Solo/Tandem button is visually distinguished. If it already has a `border` or `outline` in its inline styles or CSS class, **no fix is needed — skip to Task 5**.

- [ ] **Step 3 (only if no border/outline exists): Add a forced-colors rule to the component's `<style>` block.** Identify the CSS class or selector for the active button, then add:
  ```css
  @media (forced-colors: active) {
    .active-btn /* replace with actual selector */ {
      outline: 2px solid ButtonText;
    }
  }
  ```

- [ ] **Step 4 (only if fix was made): Run typecheck and tests:**
  ```bash
  npm run typecheck && npm test
  ```

- [ ] **Step 5 (only if fix was made): Commit:**
  ```bash
  git add src/client/editor/toolbar/ModeToggle.svelte
  git commit -m "fix(a11y): add forced-colors outline to active ModeToggle button (#311)"
  ```

---

### Task 5: Fix BulkActions and AnnotationCard via `index.html` forced-colors block

BulkActions confirm button and AnnotationCard Private pill both have static `data-testid` attributes. The AnnotationCard type-badge has neither class nor `data-testid` and needs a class added.

**Files:**
- Modify: `src/client/panels/BulkActions.svelte`
- Modify: `src/client/panels/AnnotationCard.svelte`
- Modify: `index.html` (extend existing forced-colors block)

- [ ] **Step 1: In `AnnotationCard.svelte`, find the type-badge `<span>`.** It is the first `<span>` inside the annotation card header that shows the annotation type (`comment`, `replacement`, `note`). It has inline styles including a background color. Add `class="annotation-type-badge"` to it. Leave all inline styles intact.

- [ ] **Step 2: In `index.html`, find the existing `@media (forced-colors: active)` block** (around line 220). It ends with:
  ```css
        /* Held-count badge uses warning-bg only (no border) — add one so it stays visible. */
        [data-testid="held-badge"] {
          border: 1px solid ButtonText;
        }
      }
  ```
  Replace that closing section with:
  ```css
        /* Held-count badge uses warning-bg only (no border) — add one so it stays visible. */
        [data-testid="held-badge"] {
          border: 1px solid ButtonText;
        }

        /* BulkActions confirm button: background-only in normal mode. */
        [data-testid="bulk-confirm-btn"] {
          border: 1px solid ButtonText;
        }

        /* AnnotationCard private pill: background-only warning fill. */
        [data-testid="annotation-private-pill"] {
          border: 1px solid ButtonText;
        }
      }
  ```

- [ ] **Step 3: In `AnnotationCard.svelte`'s `<style>` block, add a forced-colors rule for the type badge** (which uses a Svelte-scoped class, so it can't go in `index.html`):
  ```css
  @media (forced-colors: active) {
    .annotation-type-badge {
      border: 1px solid ButtonText;
    }
  }
  ```

- [ ] **Step 4: Run token check, typecheck, and unit tests:**
  ```bash
  npm run check:tokens && npm run typecheck && npm test
  ```
  Expected: all clean.

- [ ] **Step 5: Commit:**
  ```bash
  git add src/client/panels/BulkActions.svelte src/client/panels/AnnotationCard.svelte index.html
  git commit -m "fix(a11y): forced-colors borders for BulkActions and AnnotationCard surfaces (#311)"
  ```

---

### Task 6: Update CHANGELOG and open PR 1

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Open `CHANGELOG.md`. Under `## [Unreleased]`, add to the `### Fixed` section** (create it after `### Added` if it doesn't exist):
  ```markdown
  ### Fixed

  - **Dark annotation highlight colors** — `--tandem-highlight-yellow/green/blue/pink` now have dark-adapted overrides in `[data-theme="dark"]`; the light `rgba(255, 235, 59, 0.3)`-style values were washed out against dark surfaces.
  - **Forced-colors fallbacks for background-only state surfaces (closes #311)** — StatusBar status dots, toast badges, BulkActions confirm button, AnnotationCard type-badge and Private pill now have `border`/`outline` fallbacks in `@media (forced-colors: active)`.
  ```

- [ ] **Step 2: Run the full E2E suite to confirm nothing regressed:**
  ```bash
  npm run test:e2e
  ```
  Expected: all tests pass. If a forced-colors test from the redesign QA suite was previously failing for any of these surfaces, it should now pass.

- [ ] **Step 3: Commit and push:**
  ```bash
  git add CHANGELOG.md
  git commit -m "chore(changelog): document dark highlight tokens and forced-colors fixes"
  git push -u origin fix/dark-theme-a11y-css
  ```

- [ ] **Step 4: Open PR 1:**
  ```bash
  gh pr create \
    --title "fix(theme): dark highlight tokens + forced-colors fallbacks (#311)" \
    --body "$(cat <<'EOF'
  ## Summary

  - Adds dark-adapted `--tandem-highlight-*` token overrides to `index.html` `[data-theme="dark"]` block — light rgba values were invisible against the dark surface
  - Adds `@media (forced-colors: active)` fallbacks to StatusBar status dots, toast badge, BulkActions confirm button, AnnotationCard type-badge and Private pill

  ## Test plan

  - [ ] `npm run check:tokens` — clean
  - [ ] `npm run typecheck` — 0 errors
  - [ ] `npm test` — all unit tests pass
  - [ ] `npm run test:e2e` — all E2E tests pass
  - [ ] Manual: dark mode with highlights active — all four colors visible
  - [ ] Manual: Windows High Contrast mode — state surfaces remain distinguishable

  Closes #311

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

---

## PR 2 — Axe-Core WCAG AA Gate

**Branch off PR 1's branch** (not master). Only target master after PR 1 is merged.

```bash
git checkout fix/dark-theme-a11y-css   # or master if PR 1 already merged
git checkout -b feat/axe-core-a11y-gate
```

---

### Task 7: Install @axe-core/playwright

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install the package:**
  ```bash
  npm install --save-dev @axe-core/playwright
  ```

- [ ] **Step 2: Verify it appears in `devDependencies`:**
  ```bash
  node -e "const p = require('./package.json'); console.log(p.devDependencies['@axe-core/playwright'])"
  ```
  Expected: a version string like `^4.x.x`.

- [ ] **Step 3: Commit:**
  ```bash
  git add package.json package-lock.json
  git commit -m "chore(deps): add @axe-core/playwright for WCAG AA E2E gate"
  ```

---

### Task 8: Write the accessibility E2E fixture

**Files:**
- Create: `tests/e2e/accessibility.spec.ts`

- [ ] **Step 1: Create `tests/e2e/accessibility.spec.ts` with this content:**

  ```typescript
  import { expect, test } from "@playwright/test";
  import AxeBuilder from "@axe-core/playwright";
  import path from "path";
  import {
    cleanupAllOpenDocuments,
    cleanupFixtureDir,
    createFixtureDir,
    McpTestClient,
  } from "./helpers";

  let mcp: McpTestClient;
  let tmpDir: string;

  test.beforeEach(async () => {
    mcp = new McpTestClient();
    await mcp.connect();
    tmpDir = createFixtureDir("sample.md");
    await mcp.callTool("tandem_open", {
      filePath: path.join(tmpDir, "sample.md"),
    });
  });

  test.afterEach(async () => {
    await cleanupAllOpenDocuments(mcp);
    await mcp.close();
    cleanupFixtureDir(tmpDir);
  });

  test.describe("WCAG AA — light mode", () => {
    test("app chrome has no violations", async ({ page }) => {
      await page.goto("/");
      await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 10_000 });

      await page.evaluate(() =>
        document.documentElement.setAttribute("data-theme", "light")
      );

      const results = await new AxeBuilder({ page })
        .include("#root")
        .exclude("[contenteditable]")
        .exclude(".ProseMirror")
        .analyze();

      expect(results.violations).toEqual([]);
    });
  });

  test.describe("WCAG AA — dark mode", () => {
    test("app chrome has no violations", async ({ page }) => {
      await page.goto("/");
      await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 10_000 });

      await page.evaluate(() =>
        document.documentElement.setAttribute("data-theme", "dark")
      );

      const results = await new AxeBuilder({ page })
        .include("#root")
        .exclude("[contenteditable]")
        .exclude(".ProseMirror")
        .analyze();

      expect(results.violations).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Run typecheck to confirm no import errors:**
  ```bash
  npm run typecheck
  ```
  Expected: 0 errors.

- [ ] **Step 3: Commit the initial file (tests will likely fail on first run — that's expected):**
  ```bash
  git add tests/e2e/accessibility.spec.ts
  git commit -m "test(a11y): add axe-core WCAG AA fixture for light and dark mode"
  ```

---

### Task 9: First run — document violations and add suppressions

- [ ] **Step 1: Run only the accessibility tests:**
  ```bash
  npx playwright test tests/e2e/accessibility.spec.ts --reporter=list
  ```

- [ ] **Step 2: For each violation reported, evaluate whether it is:**
  - **A real bug** → fix the underlying issue (token change, `aria-label` addition, etc.) and re-run. Don't suppress real bugs.
  - **A known-acceptable suppression** → document why it's acceptable with an inline comment and add to `disableRules`.

  Examples of likely acceptable suppressions:
  - Decorative SVG icons that lack `aria-hidden` → fix by adding `aria-hidden="true"` to the SVG element (preferred over suppressing). SVG icons in Tandem are typically in `src/client/components/icons/` or inlined in toolbar components — grep for `<svg` to find them.
  - Authorship `::before` gutter decoration reported as contrast violation → suppress with reason

- [ ] **Step 3: If real bugs are found (e.g. AnnotationCard diff text fails contrast in dark mode), fix them now** by adjusting the relevant token in `index.html`'s `[data-theme="dark"]` block or adding a `color` override to the component. Re-run after each fix.

- [ ] **Step 4: Add suppressions for genuinely decorative / non-interactive elements.** Update `accessibility.spec.ts` — add `disableRules` to the `AxeBuilder` chain **in both test blocks** (light and dark):
  ```typescript
  const results = await new AxeBuilder({ page })
    .include("#root")
    .exclude("[contenteditable]")
    .exclude(".ProseMirror")
    // Decorative authorship gutter ::before — no text content, purely visual
    .disableRules(["color-contrast"])  // only if ::before pseudo-elements are the sole trigger
    .analyze();
  ```
  If `color-contrast` covers too many real surfaces, use `withRules` instead to run only specific rules, or use `.exclude()` for the specific element.

  **Important:** prefer fixing real issues over suppressing. Only suppress what genuinely cannot or should not be changed (decorative elements, third-party content).

- [ ] **Step 5: Run until both tests pass with zero violations:**
  ```bash
  npx playwright test tests/e2e/accessibility.spec.ts --reporter=list
  ```
  Expected: 2 tests passed.

- [ ] **Step 6: Commit all changes (suppressions + any real fixes):**
  ```bash
  git add tests/e2e/accessibility.spec.ts index.html
  # include any component files fixed
  git commit -m "test(a11y): achieve zero axe violations in light + dark mode"
  ```

---

### Task 10: Full E2E suite + CHANGELOG + open PR 2

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full E2E suite:**
  ```bash
  npm run test:e2e
  ```
  Expected: all tests pass including the new accessibility tests.

- [ ] **Step 2: Open `CHANGELOG.md`. Under `## [Unreleased]`, add to the `### Added` section:**
  ```markdown
  - **Automated WCAG AA gate** — `tests/e2e/accessibility.spec.ts` uses `@axe-core/playwright` to verify zero contrast violations in both light and dark mode on every CI run; editor content area excluded (user-authored content has arbitrary contrast).
  ```

- [ ] **Step 3: Commit and push:**
  ```bash
  git add CHANGELOG.md tests/e2e/accessibility.spec.ts
  git commit -m "chore(changelog): document axe-core WCAG AA gate"
  git push -u origin feat/axe-core-a11y-gate
  ```

- [ ] **Step 4: Open PR 2.** If PR 1 is not yet merged, set the base branch to `fix/dark-theme-a11y-css`. After PR 1 merges, update PR 2's base to `master` with `gh pr edit --base master`.
  ```bash
  gh pr create \
    --base fix/dark-theme-a11y-css \
    --title "test(a11y): automated axe-core WCAG AA gate (light + dark mode)" \
    --body "$(cat <<'EOF'
  ## Summary

  - Adds `@axe-core/playwright` to `devDependencies`
  - New `tests/e2e/accessibility.spec.ts` runs axe on the app chrome (`#root`, excluding editor content area) in both light and dark mode
  - Establishes a zero-violation baseline; documented suppressions explain why each is acceptable

  ## Test plan

  - [ ] `npm run typecheck` — 0 errors
  - [ ] `npm run test:e2e` — all tests pass including new accessibility tests
  - [ ] Both light mode and dark mode axe passes report zero violations

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

---

## Verification Checklist (both PRs merged)

- [ ] `npm run check:tokens` — clean
- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — all unit tests pass
- [ ] `npm run test:e2e` — all E2E tests pass including accessibility.spec.ts
- [ ] Dark mode with annotation highlights active — all four colors clearly visible
- [ ] Windows High Contrast mode — status dots, toast badge, BulkActions buttons, AnnotationCard badges remain distinguishable
- [ ] `npm view tandem-editor version` unchanged (this is v0.11.0 work, not a release)
