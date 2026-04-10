# Wave 4 Closeout — PR Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every issue surfaced by the four-agent PR review of `chore/wave-4-closeout` so the branch is ready to merge: one production no-op bug, three silent-failure diagnostics gaps, six E2E coverage/correctness gaps, a small type-design refactor, and documentation cleanup.

**Architecture:** Mix of small production fixes in `src/client/`, repairs and additions to `tests/e2e/settings-and-filters.spec.ts`, a cross-file type-design refactor for panel-width keys, and planning-doc cleanup. No new modules, no dependency changes, no architectural moves.

**Tech Stack:** React + Tiptap + Yjs, Playwright (E2E), Vitest (unit), TypeScript.

---

## Context: What the Review Found

The four-agent review (code-reviewer, pr-test-analyzer, silent-failure-hunter, type-design-analyzer) flagged these issues. Every one of them is addressed below.

**Critical (production bug):**
- `src/client/panels/SidePanel.tsx` — `listRef` points to the inner annotation-list div (`flex: 1`, no `overflow`) while the actual scroll container is the outer wrapper at line 453-461 (`overflowY: "auto"`). `listRef.current?.scrollTo({ top: 0 })` at line 414 is a no-op in production. The new E2E test at `tests/e2e/settings-and-filters.spec.ts:300-340` only passes because it injects `maxHeight`/`overflowY` onto the inner list, masking the bug. **Pre-existing on master** — not a regression introduced here, but the branch added the false-positive test.

**Important:**
- `src/client/App.tsx:135-137, 307-311` — `localStorage` catch blocks are silent (only a comment). Users lose panel width prefs with no diagnostic.
- `src/client/panels/SidePanel.tsx:407-414` — `querySelector` miss on the annotation card silently falls through to scroll-to-top.
- `tests/e2e/settings-and-filters.spec.ts:141-173` — Solo/Tandem E2E test asserts localStorage + `aria-pressed` only, never verifies that Solo mode actually holds pending annotations (the whole point of the feature).
- Clear-filters button path (`src/client/panels/SidePanel.tsx:630-651`) has no E2E coverage.
- Panel-width drag test uses ±80px, never exercises the `[200, 600]` clamp — clamp-boundary regression from a sign-inversion bug would go undetected.
- No test that cross-layout switches preserve the left panel width.
- `tests/e2e/settings-and-filters.spec.ts:372-384` — "active annotation in view" geometry assertion is brittle; passes trivially in tall viewports, doesn't prove the scroll-to-top branch was skipped.

**Minor / polish:**
- Stale `priority: 'urgent'` references in planning docs (`docs/superpowers/specs/2026-04-04-claude-code-skill-design.md:84,89` and `docs/superpowers/plans/2026-04-07-wave4-pr-review-fixes.md:507`) still instruct Claude to set a field that no longer exists.
- Bare string constants `PANEL_WIDTH_KEY` / `LEFT_PANEL_WIDTH_KEY` could become a `Record<PanelSide, string>`, replacing the ternary in `handleResizeStart` and making the shared-key regression structurally impossible.
- Hyphen naming on new storage keys diverges from the neighboring colon-namespaced `tandem:mode` / `tandem:settings` convention; a one-line comment prevents a future "fix" PR from breaking persistence.
- `tests/e2e/screenshots.spec.ts` is a build artifact generator (SCREENSHOTS=1 gated) living in the test directory; safer to move out so a CI filter-glob change can't accidentally enable it.

**Deferred (out of scope for this closeout):**
- Functional dwell-time E2E test (no non-flaky assertion surface — Y.Map propagation is async and observing per-keystroke dwell gating without timing races is not achievable with current Playwright harness).
- Session-loader strip of legacy `priority` field from persisted annotations (Y.Maps are schema-permissive; harmless to leave).
- `Annotation` discriminated union (`color` only on highlight type) — bigger refactor, not closeout scope.
- `PanelLayout` discriminated union (left width only meaningful in three-panel) — also bigger refactor.

---

## File Map

**Production code changes:**
- `src/client/panels/SidePanel.tsx` — move `listRef` to the outer wrapper, add `data-testid` on the scroll container, add `console.warn` on `querySelector` miss.
- `src/client/App.tsx` — add `console.warn` to the two silent `localStorage` catch blocks; refactor `handleResizeStart` to use the new `PANEL_WIDTH_KEYS` record.
- `src/shared/constants.ts` — export `PanelSide` type and `PANEL_WIDTH_KEYS: Record<PanelSide, string>`; keep existing `PANEL_WIDTH_KEY` / `LEFT_PANEL_WIDTH_KEY` exports for backward compat with E2E tests; add legacy-naming comment.

**Test changes:**
- `tests/e2e/settings-and-filters.spec.ts` — repair the scroll-reset test, strengthen the "active annotation in view" test, add held-annotations verification to the Solo/Tandem test, add Clear-button test, add clamp-boundary drag test, add cross-layout persistence test.

**Screenshot spec relocation:**
- Delete `tests/e2e/screenshots.spec.ts`.
- Create `scripts/capture-screenshots.spec.ts` with a sibling `scripts/capture-screenshots.config.ts` Playwright config. (Or move it under `docs/screenshots/` — final path decided in the task.)

**Doc changes:**
- `docs/superpowers/specs/2026-04-04-claude-code-skill-design.md` — strike `priority: 'urgent'` instructions.
- `docs/superpowers/plans/2026-04-07-wave4-pr-review-fixes.md` — update the one remaining stale `priority: 'urgent'` mention on line 507. (Line 602 uses "priority" in the sense of "task priority" — not annotation priority — leave that alone.)

---

## Task 1: Fix scroll-container mismatch in SidePanel

**Problem:** `listRef` is attached to the inner annotation-list div (`flex: 1`, no overflow) while `overflowY: "auto"` lives on the outer wrapper. `listRef.current?.scrollTo({ top: 0 })` on a non-scrolling element is a no-op. The fix: move `listRef` (and a new scroll-container testid) to the outer wrapper. This preserves the current UX (banner/header/filters scroll with the list) and keeps all existing CSS unchanged — only the ref target moves.

**Files:**
- Modify: `src/client/panels/SidePanel.tsx:453-462` (outer wrapper — add `ref` and `data-testid`)
- Modify: `src/client/panels/SidePanel.tsx:730-735` (inner list — drop `ref`)
- Modify: `tests/e2e/settings-and-filters.spec.ts:292-333` (drop inline-style injection, target the new testid)

- [ ] **Step 1: Update the existing scroll-reset test first (TDD — this must fail against unchanged production code).**

Edit `tests/e2e/settings-and-filters.spec.ts` — replace the body of `test("side panel resets scroll to top on filter change (no active annotation)"...)` with a version that targets the new scroll-container testid and drops the inline-style injection:

```ts
test("side panel resets scroll to top on filter change (no active annotation)", async ({
  page,
}) => {
  // Seed enough annotations to overflow the side panel, then scroll the list
  // down, change a filter, and assert the list is back at the top. Guards
  // SidePanel.tsx's filter-change scroll-reset effect.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  // 15 comments on the title — parallel seeding over HTTP MCP.
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      mcp.callTool("tandem_comment", {
        from: 2,
        to: 6,
        text: `note ${i}`,
        textSnapshot: "Test",
      }),
    ),
  );

  await page.goto("/");
  await switchToAnnotationsTab(page);

  // The scroll container is the SidePanel's outer wrapper, not the inner
  // role="list" div. Production scrollTo() is wired to this element.
  const scrollContainer = page.locator(
    "[data-testid='annotation-list-scroll-container']",
  );
  await expect(scrollContainer).toBeVisible();
  // Wait for all 15 cards to render inside it.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(15);

  // Scroll to the bottom of the real scroll container.
  await scrollContainer.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const scrollBefore = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeGreaterThan(0);

  // Change the type filter — effect should scroll back to 0.
  await page
    .locator("[data-testid='filter-type']")
    .selectOption("comment");
  await expect
    .poll(async () => scrollContainer.evaluate((el) => el.scrollTop), {
      timeout: 2_000,
    })
    .toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it FAILS against unchanged production code.**

Run: `npx playwright test tests/e2e/settings-and-filters.spec.ts -g "resets scroll to top on filter change"`

Expected: FAIL — either "locator not found for `annotation-list-scroll-container`" or `scrollBefore` assertion failing because the inner list can't scroll naturally in a short viewport. This confirms the test is exercising the real bug, not a masked version.

- [ ] **Step 3: Move the `data-testid` and `ref` to the outer wrapper in `SidePanel.tsx`.**

Edit `src/client/panels/SidePanel.tsx:453-462`. Current:

```tsx
  return (
    <div
      style={{
        width: "100%",
        background: "#fafafa",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
```

Replace with:

```tsx
  return (
    <div
      ref={listRef}
      data-testid="annotation-list-scroll-container"
      style={{
        width: "100%",
        background: "#fafafa",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
```

- [ ] **Step 4: Drop the obsolete `ref` from the inner list.**

Edit `src/client/panels/SidePanel.tsx:730-735`. Current:

```tsx
      {/* Annotation list */}
      <div
        ref={listRef}
        style={{ padding: "8px 16px", flex: 1 }}
        role="list"
        aria-label="Annotations"
      >
```

Replace with:

```tsx
      {/* Annotation list */}
      <div
        style={{ padding: "8px 16px", flex: 1 }}
        role="list"
        aria-label="Annotations"
      >
```

- [ ] **Step 5: Run the test to verify it PASSES.**

Run: `npx playwright test tests/e2e/settings-and-filters.spec.ts -g "resets scroll to top on filter change"`

Expected: PASS.

- [ ] **Step 6: Run the sibling "active annotation in view" test to verify it still passes — the ref move could regress it.**

Run: `npx playwright test tests/e2e/settings-and-filters.spec.ts -g "keeps active annotation in view"`

Expected: PASS. `scrollIntoView` walks up to find the nearest scroll ancestor, so it continues to work against the outer wrapper.

- [ ] **Step 7: Commit.**

```bash
git add src/client/panels/SidePanel.tsx tests/e2e/settings-and-filters.spec.ts
git commit -m "$(cat <<'EOF'
fix(client): attach listRef to the real scroll container in SidePanel

listRef was on the inner role="list" div which has no overflow, so
scrollTo({top: 0}) was a no-op in production. The actual scroll
container is the outer wrapper. Move the ref (and a new testid) there
so the filter-change scroll-reset fallback actually runs, and drop the
inline-style injection from the E2E test that was masking this bug.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Strengthen "active annotation in view" assertion

**Problem:** The assertion at `tests/e2e/settings-and-filters.spec.ts:372-384` only checks the card's bounding box overlaps the list's — in a tall viewport it passes trivially without scrolling. It also never proves the scroll-to-top branch was *skipped*. Add a `scrollTop > 0` assertion on the scroll container.

**Files:**
- Modify: `tests/e2e/settings-and-filters.spec.ts:335-385`

- [ ] **Step 1: Update the test to assert `scrollTop > 0` on the scroll container after the filter change, proving the fallback did NOT run.**

Replace the body of `test("side panel keeps active annotation in view on filter change"...)` with:

```ts
test("side panel keeps active annotation in view on filter change", async ({ page }) => {
  // The sibling branch of the filter-change effect: when an annotation is
  // active (review mode), the list should scroll *it* into view instead of
  // jumping to the top (#202). We assert both that the card is visible AND
  // that scrollTop > 0 — the latter proves the scroll-to-top fallback did
  // not fire (which would be a silent regression).
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      mcp.callTool("tandem_comment", {
        from: 2,
        to: 6,
        text: `note ${i}`,
        textSnapshot: "Test",
      }),
    ),
  );

  await page.goto("/");
  await switchToAnnotationsTab(page);

  const scrollContainer = page.locator(
    "[data-testid='annotation-list-scroll-container']",
  );
  await expect(scrollContainer).toBeVisible();
  const cards = page.locator("[data-testid^='annotation-card-']");
  await expect(cards).toHaveCount(15);

  // Activate a card near the bottom. Clicking sets activeAnnotationId.
  const targetCard = cards.nth(12);
  await targetCard.scrollIntoViewIfNeeded();
  await targetCard.click();

  // Reset the scroll so the effect has to work to put the card back in view.
  await scrollContainer.evaluate((el) => {
    el.scrollTop = 0;
  });

  // Change the type filter. The effect should scroll the active card into
  // view instead of resetting to scrollTop = 0.
  await page.locator("[data-testid='filter-type']").selectOption("comment");

  // (a) The active card must end up inside the scroll container's visible area.
  await expect
    .poll(
      async () => {
        const listBox = await scrollContainer.boundingBox();
        const cardBox = await targetCard.boundingBox();
        if (!listBox || !cardBox) return false;
        return (
          cardBox.y + cardBox.height > listBox.y &&
          cardBox.y < listBox.y + listBox.height
        );
      },
      { timeout: 2_000 },
    )
    .toBe(true);

  // (b) scrollTop must be nonzero — proves the scroll-to-top fallback did NOT
  // run. Without this, the test passes trivially in tall viewports.
  const finalScroll = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(finalScroll).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify PASS.**

Run: `npx playwright test tests/e2e/settings-and-filters.spec.ts -g "keeps active annotation in view"`

Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add tests/e2e/settings-and-filters.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): assert scrollTop > 0 on active-annotation-in-view path

The bounding-box overlap assertion could pass trivially in a tall
viewport without the scroll effect running at all. Add an explicit
scrollTop > 0 check to prove the scroll-to-top fallback branch is
skipped when an active annotation is present.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add console.warn diagnostics to silent catch blocks

**Problem:** Three silent catch blocks swallow localStorage / DOM errors with only a comment. `console.warn` routes to stderr on the server and the browser devtools, matches CLAUDE.md's "stdout is reserved" rule, and makes "my panel width keeps resetting" diagnosable. Two sites in `App.tsx`, one in `SidePanel.tsx`.

**Files:**
- Modify: `src/client/App.tsx:135-137` (`loadPanelWidth` catch)
- Modify: `src/client/App.tsx:307-311` (resize save catch)
- Modify: `src/client/panels/SidePanel.tsx:407-414` (filter-change querySelector miss)

- [ ] **Step 1: Add a warn to `loadPanelWidth`'s catch block.**

Edit `src/client/App.tsx:126-139`. Current:

```tsx
function loadPanelWidth(key: string): number {
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (Number.isFinite(parsed)) {
        return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, parsed));
      }
    }
  } catch {
    // localStorage unavailable (incognito/storage-disabled)
  }
  return PANEL_DEFAULT_WIDTH;
}
```

Replace with:

```tsx
function loadPanelWidth(key: string): number {
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (Number.isFinite(parsed)) {
        return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, parsed));
      }
      // Non-finite saved value — fall through and warn so corrupt storage
      // is diagnosable instead of silently reverting to the default.
      console.warn(
        `[tandem] ignoring non-numeric panel width for ${key}: ${saved}`,
      );
    }
  } catch (err) {
    console.warn(`[tandem] localStorage unavailable reading ${key}:`, err);
  }
  return PANEL_DEFAULT_WIDTH;
}
```

- [ ] **Step 2: Add a warn to the resize save catch.**

Edit `src/client/App.tsx:307-311`. Current:

```tsx
      try {
        localStorage.setItem(storageKey, String(latestWidth));
      } catch {
        // localStorage unavailable
      }
```

Replace with:

```tsx
      try {
        localStorage.setItem(storageKey, String(latestWidth));
      } catch (err) {
        console.warn(
          `[tandem] failed to persist ${storageKey}:`,
          err,
        );
      }
```

- [ ] **Step 3: Add a warn for the filter-change `querySelector` miss.**

Edit `src/client/panels/SidePanel.tsx:401-415`. Current:

```tsx
  useEffect(() => {
    if (!didMountFiltersRef.current) {
      didMountFiltersRef.current = true;
      return;
    }
    const currentActive = activeAnnotationIdRef.current;
    if (currentActive) {
      const card = document.querySelector(`[data-testid="annotation-card-${currentActive}"]`);
      if (card) {
        card.scrollIntoView({ block: "center" });
        return;
      }
    }
    listRef.current?.scrollTo({ top: 0 });
  }, [filterType, filterAuthor, filterStatus]);
```

Replace with:

```tsx
  useEffect(() => {
    if (!didMountFiltersRef.current) {
      didMountFiltersRef.current = true;
      return;
    }
    const currentActive = activeAnnotationIdRef.current;
    if (currentActive) {
      const card = document.querySelector(`[data-testid="annotation-card-${currentActive}"]`);
      if (card) {
        card.scrollIntoView({ block: "center" });
        return;
      }
      // Card not in the DOM after a filter change — either the active
      // annotation was filtered out or the render hasn't committed yet.
      // Fall through to scroll-to-top but log so "scroll jumped
      // unexpectedly" bug reports are diagnosable.
      console.warn(
        `[tandem] SidePanel: active annotation ${currentActive} not found on filter change; scrolling to top`,
      );
    }
    listRef.current?.scrollTo({ top: 0 });
  }, [filterType, filterAuthor, filterStatus]);
```

- [ ] **Step 4: Run typecheck and the three tests touching these paths to verify no regression.**

Run: `npm run typecheck && npx playwright test tests/e2e/settings-and-filters.spec.ts -g "panel|filter"`

Expected: typecheck clean; panel and filter tests all pass.

- [ ] **Step 5: Commit.**

```bash
git add src/client/App.tsx src/client/panels/SidePanel.tsx
git commit -m "$(cat <<'EOF'
fix(client): log silent failures in panel-width and filter-scroll paths

Three catch blocks and one querySelector miss previously swallowed
errors with only a comment, making "my panel width reset" and "scroll
jumped unexpectedly" bug reports undiagnosable. Add console.warn on:

- loadPanelWidth parse/storage errors
- resize-save localStorage failures
- SidePanel filter-change effect when the active annotation card is
  not in the DOM

console.warn routes to stderr (server) and devtools (browser), matching
CLAUDE.md's "stdout reserved for MCP wire" rule.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add held-annotations verification to Solo/Tandem E2E test

**Problem:** The current test at `tests/e2e/settings-and-filters.spec.ts:141-173` only checks localStorage + `aria-pressed`. The whole point of Solo mode (per CLAUDE.md) is to *hold* pending annotations — visible via the "{n} annotation(s) held" banner in `SidePanel.tsx:464`. Seed a pending annotation, switch to Solo, assert the banner appears; switch back, assert it's gone.

**Files:**
- Modify: `tests/e2e/settings-and-filters.spec.ts:142-172`

- [ ] **Step 1: Extend the existing Solo/Tandem test to seed an annotation and assert on the held banner.**

Edit `tests/e2e/settings-and-filters.spec.ts`. Replace the existing `test("Solo/Tandem mode toggle switches via toolbar"...)` body with:

```ts
test("Solo/Tandem mode toggle switches via toolbar and holds pending annotations", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  // Seed a pending annotation so Solo mode has something to hold.
  await mcp.callTool("tandem_comment", {
    from: 2,
    to: 6,
    text: "pending note",
    textSnapshot: "Test",
  });

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });
  await switchToAnnotationsTab(page);

  const soloBtn = page.locator("[data-testid='mode-solo-btn']");
  const tandemBtn = page.locator("[data-testid='mode-tandem-btn']");
  await expect(soloBtn).toBeVisible({ timeout: 5_000 });
  await expect(tandemBtn).toBeVisible();

  // Default is tandem.
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "false");

  // In Tandem mode the held banner is absent — the annotation is visible.
  const heldBanner = page.getByText(/\d+ annotation(s)? held/);
  await expect(heldBanner).toHaveCount(0);

  // Switch to solo. Assert via localStorage (race-free) + aria-pressed
  // (visible state). Avoid asserting through tandem_status because Y.Map
  // propagation over Hocuspocus is async.
  await soloBtn.click();
  await expect(soloBtn).toHaveAttribute("aria-pressed", "true");
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "false");
  const soloSaved = await page.evaluate((key) => localStorage.getItem(key), TANDEM_MODE_KEY);
  expect(soloSaved).toBe("solo");

  // The held banner must appear in Solo mode — this is the feature's actual
  // contract, not just the localStorage bit. Catches regressions where the
  // toggle updates storage but fails to drive the useModeGate hook.
  await expect(heldBanner).toBeVisible({ timeout: 2_000 });

  // Switch back.
  await tandemBtn.click();
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "false");
  const tandemSaved = await page.evaluate((key) => localStorage.getItem(key), TANDEM_MODE_KEY);
  expect(tandemSaved).toBe("tandem");

  // Banner must clear when back in Tandem.
  await expect(heldBanner).toHaveCount(0, { timeout: 2_000 });
});
```

- [ ] **Step 2: Run the test to verify PASS.**

Run: `npx playwright test tests/e2e/settings-and-filters.spec.ts -g "Solo/Tandem mode toggle"`

Expected: PASS. (The `getByText` regex tolerates `1 annotation held` / `2 annotations held`.)

- [ ] **Step 3: Commit.**

```bash
git add tests/e2e/settings-and-filters.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): verify Solo mode holds pending annotations via banner

The previous assertions only checked localStorage + aria-pressed,
missing the actual feature contract (annotations should be held).
A regression where the toggle updates storage but misses useModeGate
would pass the old test. Seed a pending annotation, assert the held
banner appears in Solo and disappears in Tandem.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add Clear-button scroll-reset coverage

**Problem:** The Clear-filters button at `SidePanel.tsx:630-651` used to call `listRef.current?.scrollTo({ top: 0 })` directly and now relies on the centralized filter-change `useEffect`. The existing E2E test only drives `filter-type` via `selectOption`. If the effect breaks, the Clear path silently regresses.

**Files:**
- Modify: `tests/e2e/settings-and-filters.spec.ts` (add one test)

- [ ] **Step 1: Add a new test after the "resets scroll to top on filter change" test.**

Insert into `tests/e2e/settings-and-filters.spec.ts` immediately after the closing brace of the "resets scroll to top on filter change" test:

```ts
test("Clear-filters button also resets scroll to top", async ({ page }) => {
  // The Clear button is a sibling trigger for the same scroll-reset effect.
  // Guards against a regression where the effect is wired to selectOption
  // events but not to the Clear path that sets all three filters at once.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      mcp.callTool("tandem_comment", {
        from: 2,
        to: 6,
        text: `note ${i}`,
        textSnapshot: "Test",
      }),
    ),
  );

  await page.goto("/");
  await switchToAnnotationsTab(page);

  const scrollContainer = page.locator(
    "[data-testid='annotation-list-scroll-container']",
  );
  await expect(scrollContainer).toBeVisible();
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(15);

  // Set a filter so the Clear button appears.
  await page.locator("[data-testid='filter-type']").selectOption("comment");

  // Scroll to the bottom.
  await scrollContainer.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const scrollBefore = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeGreaterThan(0);

  // Click Clear — the filter-change effect should reset scroll to 0.
  // (There's no testid on the Clear button; target by visible text.)
  await page.getByRole("button", { name: "Clear" }).click();

  await expect
    .poll(async () => scrollContainer.evaluate((el) => el.scrollTop), {
      timeout: 2_000,
    })
    .toBe(0);
});
```

- [ ] **Step 2: Run the test.**

Run: `npx playwright test tests/e2e/settings-and-filters.spec.ts -g "Clear-filters button"`

Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add tests/e2e/settings-and-filters.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): cover Clear-filters button scroll-reset path

The Clear button fires the same centralized filter-change effect but
wasn't exercised by any test. Add coverage so a future refactor that
breaks the effect's wiring can't silently regress the Clear path.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Refactor panel-width keys to `Record<PanelSide, string>` + legacy naming comment

**Problem:** `handleResizeStart` at `App.tsx:281-317` carries a `side === "left" ? LEFT_PANEL_WIDTH_KEY : PANEL_WIDTH_KEY` ternary that previously had the exact bug the new E2E test guards against (both handles writing to the same key). Modeling this as `Record<PanelSide, string>` makes the shared-key regression structurally impossible. Also add a one-line comment explaining why the two key strings use legacy hyphen naming (vs neighboring colon convention).

**Files:**
- Modify: `src/shared/constants.ts:27-30` (add `PanelSide` export + `PANEL_WIDTH_KEYS` record + legacy comment)
- Modify: `src/client/App.tsx:3-13` (imports)
- Modify: `src/client/App.tsx:124` (drop the local `PanelSide` type alias)
- Modify: `src/client/App.tsx:281-317` (use the record in `handleResizeStart`)

- [ ] **Step 1: Update `src/shared/constants.ts` to export `PanelSide` and `PANEL_WIDTH_KEYS`, keeping the existing two key exports for backward compat with E2E tests.**

Edit `src/shared/constants.ts:27-30`. Current:

```ts
// Right-side panel width (shared between tabbed layout and three-panel right panel).
export const PANEL_WIDTH_KEY = "tandem-panel-width";
// Left-side panel width (three-panel layout only — independent of the right).
export const LEFT_PANEL_WIDTH_KEY = "tandem-left-panel-width";
```

Replace with:

```ts
// Panel-width localStorage keys.
//
// NOTE: these use legacy hyphen naming (vs the neighboring colon convention
// `tandem:mode`/`tandem:settings`) because they predate the colon scheme and
// changing the strings would invalidate every existing user's saved widths.
// Do not "fix" the style — the key string is the persistence contract.
//
// Right-side panel width is shared between the tabbed layout and the
// three-panel right panel. The left key only applies in three-panel mode.
export const PANEL_WIDTH_KEY = "tandem-panel-width";
export const LEFT_PANEL_WIDTH_KEY = "tandem-left-panel-width";

export type PanelSide = "left" | "right";

/**
 * Maps a panel side to its localStorage key. Using a Record instead of two
 * bare constants makes the "both handles write to the same key" regression
 * (#228) structurally impossible — you can't accidentally map both sides to
 * the same value at a callsite.
 */
export const PANEL_WIDTH_KEYS: Record<PanelSide, string> = {
  left: LEFT_PANEL_WIDTH_KEY,
  right: PANEL_WIDTH_KEY,
};
```

- [ ] **Step 2: Update `src/client/App.tsx` imports to pull `PanelSide` and `PANEL_WIDTH_KEYS` from shared.**

Edit `src/client/App.tsx:3-13`. Current:

```tsx
import {
  DISCONNECT_DEBOUNCE_MS,
  LEFT_PANEL_WIDTH_KEY,
  PANEL_WIDTH_KEY,
  PROLONGED_DISCONNECT_MS,
  TANDEM_MODE_DEFAULT,
  TANDEM_MODE_KEY,
  Y_MAP_DWELL_MS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../shared/constants";
```

Replace with:

```tsx
import {
  DISCONNECT_DEBOUNCE_MS,
  LEFT_PANEL_WIDTH_KEY,
  PANEL_WIDTH_KEY,
  PANEL_WIDTH_KEYS,
  PROLONGED_DISCONNECT_MS,
  TANDEM_MODE_DEFAULT,
  TANDEM_MODE_KEY,
  Y_MAP_DWELL_MS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
  type PanelSide,
} from "../shared/constants";
```

- [ ] **Step 3: Delete the local `PanelSide` type alias.**

Edit `src/client/App.tsx:124`. Delete this line:

```tsx
type PanelSide = "left" | "right";
```

- [ ] **Step 4: Replace the ternary in `handleResizeStart` with a record lookup.**

Edit `src/client/App.tsx:281-317`. Current:

```tsx
  const handleResizeStart = useCallback((e: React.MouseEvent, side: PanelSide) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = side === "left" ? leftPanelWidthRef.current : panelWidthRef.current;
    const setter = side === "left" ? setLeftPanelWidth : setPanelWidth;
    const storageKey = side === "left" ? LEFT_PANEL_WIDTH_KEY : PANEL_WIDTH_KEY;
    let latestWidth = startWidth;
```

Replace with:

```tsx
  const handleResizeStart = useCallback((e: React.MouseEvent, side: PanelSide) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = side === "left" ? leftPanelWidthRef.current : panelWidthRef.current;
    const setter = side === "left" ? setLeftPanelWidth : setPanelWidth;
    const storageKey = PANEL_WIDTH_KEYS[side];
    let latestWidth = startWidth;
```

Leave the rest of `handleResizeStart` unchanged. The `startWidth` / `setter` lines still use the ternary because they pick runtime state, not keys; only the `storageKey` is structurally risky (the bug we're guarding against was `storageKey === same key for both sides`).

- [ ] **Step 5: Run typecheck + the panel-width tests to verify nothing broke.**

Run: `npm run typecheck && npx playwright test tests/e2e/settings-and-filters.spec.ts -g "panel"`

Expected: typecheck clean; panel tests pass.

- [ ] **Step 6: Commit.**

```bash
git add src/shared/constants.ts src/client/App.tsx
git commit -m "$(cat <<'EOF'
refactor(constants): model panel-width keys as Record<PanelSide, string>

The storageKey ternary in handleResizeStart previously had the exact
bug #228 guards against (both sides mapped to the same key). Modeling
the mapping as a Record makes the shared-key regression structurally
impossible at the callsite. Also document why the existing key strings
use legacy hyphen naming so a future reader doesn't "fix" it and break
persistence.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add panel-width clamp-boundary E2E test

**Problem:** The existing drag test uses ±80px, well inside `[200, 600]`. The most likely regression is a sign-inversion on the right handle (delta is negated) — a clamp-boundary drag is the cheap test that catches it. Add one over-max drag and one under-min drag.

**Files:**
- Modify: `tests/e2e/settings-and-filters.spec.ts` (add one test after the existing panel-widths test)

- [ ] **Step 1: Add the test. Insert after the `"three-panel layout resizes left/right widths independently"` test body.**

Insert in `tests/e2e/settings-and-filters.spec.ts` directly after the previous panel-widths test closes:

```ts
test("panel-width drags clamp to [200, 600]", async ({ page }) => {
  // Extreme drags in both directions must not exceed PANEL_MAX_WIDTH (600)
  // or drop below PANEL_MIN_WIDTH (200). Sign-inversion regressions on the
  // right handle would surface here before anywhere else.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  // Enter three-panel layout and clear stale width state.
  await page.locator("[data-testid='settings-btn']").click();
  await expect(page.locator("[data-testid='settings-popover']")).toBeVisible();
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await page.keyboard.press("Escape");
  await page.evaluate(
    ([leftKey, rightKey]) => {
      localStorage.removeItem(leftKey);
      localStorage.removeItem(rightKey);
    },
    [LEFT_PANEL_WIDTH_KEY, PANEL_WIDTH_KEY],
  );
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
  const rightHandle = page.locator("[data-testid='right-panel-resize-handle']");

  async function dragHandleBy(
    handle: ReturnType<typeof page.locator>,
    deltaX: number,
  ): Promise<void> {
    const box = await handle.boundingBox();
    if (!box) throw new Error("resize handle has no bounding box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + deltaX, cy, { steps: 20 });
    await page.mouse.up();
  }

  const readLeft = () =>
    page.evaluate((k) => Number(localStorage.getItem(k)), LEFT_PANEL_WIDTH_KEY);
  const readRight = () =>
    page.evaluate((k) => Number(localStorage.getItem(k)), PANEL_WIDTH_KEY);

  // Over-max left drag: starting at 300, drag +500 → would be 800, must
  // clamp to 600.
  await dragHandleBy(leftHandle, 500);
  expect(await readLeft()).toBe(600);

  // Under-min left drag: drag -500 → would be 100, must clamp to 200.
  await dragHandleBy(leftHandle, -500);
  expect(await readLeft()).toBe(200);

  // Right handle has inverted sign (drag right = narrower). Over-max: drag
  // -500 (left) → 300 - (-500) = 800, must clamp to 600.
  await dragHandleBy(rightHandle, -500);
  expect(await readRight()).toBe(600);

  // Under-min: drag +500 → 600 - 500 = 100, must clamp to 200.
  await dragHandleBy(rightHandle, 500);
  expect(await readRight()).toBe(200);
});
```

- [ ] **Step 2: Run the test.**

Run: `npx playwright test tests/e2e/settings-and-filters.spec.ts -g "clamp"`

Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add tests/e2e/settings-and-filters.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): cover panel-width clamp boundaries

Existing drag test uses ±80px, well inside [200, 600]. Add over-max
and under-min drags for both handles so a sign-inversion regression
on the right handle can't sneak through.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Add cross-layout panel-width persistence test

**Problem:** The tabbed layout's single handle reuses `PANEL_WIDTH_KEY` (`App.tsx:666` routes it to `side: "right"`). If a user resizes in three-panel, switches to tabbed, resizes again, then switches back, the left width should still be preserved. Not covered — a regression where the tabbed layout corrupts the left key would go undetected.

**Files:**
- Modify: `tests/e2e/settings-and-filters.spec.ts` (add one test)

- [ ] **Step 1: Add the test after the clamp test.**

Insert in `tests/e2e/settings-and-filters.spec.ts` directly after the clamp test:

```ts
test("three-panel left width survives a tabbed-layout round trip", async ({ page }) => {
  // Scenario: user resizes left panel in three-panel mode, switches to
  // tabbed (only the right key gets touched), switches back to three-panel.
  // The left width must still be what the user set. Guards against a
  // regression where the tabbed handle accidentally writes to the left key
  // or the layout switch clobbers left state.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  // Clear all width state before starting.
  await page.evaluate(
    ([leftKey, rightKey]) => {
      localStorage.removeItem(leftKey);
      localStorage.removeItem(rightKey);
    },
    [LEFT_PANEL_WIDTH_KEY, PANEL_WIDTH_KEY],
  );
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  // Enter three-panel mode.
  await page.locator("[data-testid='settings-btn']").click();
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await page.keyboard.press("Escape");

  const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
  await expect(leftHandle).toBeVisible();

  async function dragHandleBy(
    handle: ReturnType<typeof page.locator>,
    deltaX: number,
  ): Promise<void> {
    const box = await handle.boundingBox();
    if (!box) throw new Error("resize handle has no bounding box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + deltaX, cy, { steps: 10 });
    await page.mouse.up();
  }

  // Drag the left handle +80 → left ≈ 380.
  await dragHandleBy(leftHandle, 80);
  const leftAfterDrag = await page.evaluate(
    (k) => localStorage.getItem(k),
    LEFT_PANEL_WIDTH_KEY,
  );
  expect(Number(leftAfterDrag)).toBeGreaterThanOrEqual(370);
  expect(Number(leftAfterDrag)).toBeLessThanOrEqual(390);

  // Switch to tabbed layout.
  await page.locator("[data-testid='settings-btn']").click();
  await page.locator("[data-testid='layout-tabbed-btn']").click();
  await page.keyboard.press("Escape");

  // Drag the tabbed handle so the right key changes.
  const tabbedHandle = page.locator("[data-testid='panel-resize-handle']");
  await expect(tabbedHandle).toBeVisible();
  await dragHandleBy(tabbedHandle, -60);

  // Left key must still be what we set earlier — tabbed mode must not
  // touch it.
  const leftAfterTabbed = await page.evaluate(
    (k) => localStorage.getItem(k),
    LEFT_PANEL_WIDTH_KEY,
  );
  expect(leftAfterTabbed).toBe(leftAfterDrag);

  // Switch back to three-panel and verify the left handle is still at the
  // original value.
  await page.locator("[data-testid='settings-btn']").click();
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await page.keyboard.press("Escape");
  const leftAfterBack = await page.evaluate(
    (k) => localStorage.getItem(k),
    LEFT_PANEL_WIDTH_KEY,
  );
  expect(leftAfterBack).toBe(leftAfterDrag);
});
```

- [ ] **Step 2: Run the test.**

Run: `npx playwright test tests/e2e/settings-and-filters.spec.ts -g "survives a tabbed-layout round trip"`

Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add tests/e2e/settings-and-filters.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): cover left-width persistence across tabbed round trip

If tabbed-mode resizing accidentally wrote to the left-width key, or
layout switching clobbered state, the user's left width would silently
reset on return to three-panel. Add a round-trip test so this class of
regression is caught.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Clean stale `priority: 'urgent'` references in planning docs

**Problem:** The `priority` field was removed from annotations, but planning docs still instruct Claude to set it. These aren't user-facing but future agents reading the spec will be misled. Two files, three real references (`docs/superpowers/plans/2026-04-07-wave4-pr-review-fixes.md:602` is a false positive — "lower-priority suggestions" means task priority, not annotation priority — leave it alone).

**Files:**
- Modify: `docs/superpowers/specs/2026-04-04-claude-code-skill-design.md:84,89`
- Modify: `docs/superpowers/plans/2026-04-07-wave4-pr-review-fixes.md:507`

- [ ] **Step 1: Read the surrounding context at lines 84, 89 of the skill-design spec to understand what they say now.**

Run: `sed -n '80,95p' docs/superpowers/specs/2026-04-04-claude-code-skill-design.md` (via Read tool, not cat).

- [ ] **Step 2: Edit `docs/superpowers/specs/2026-04-04-claude-code-skill-design.md` lines 84 and 89 to remove `priority: 'urgent'` guidance.**

Replace line 84 (`Priority: set 'priority: 'urgent'' on any annotation type when the finding is critical and the user is in 'urgent-only' mode.`) with:

```
> Historical: the `priority` field on annotations has been removed. Urgency is now implicit in annotation `type` — flags and questions always surface, comments and suggestions follow the Solo/Tandem hold gate.
```

Replace line 89 (`- **Urgent**: Only create 'tandem_flag' and annotations with 'priority: 'urgent''. Hold everything else.`) with:

```
- **Solo mode:** Hold all annotations until the user switches to Tandem. Flags and questions are exempt (they always surface).
```

(Exact replacement text can be adjusted to fit surrounding markdown structure — the key is no more references to a `priority` field or an `urgent-only` mode.)

- [ ] **Step 3: Edit `docs/superpowers/plans/2026-04-07-wave4-pr-review-fixes.md:507`.**

Read the line in context first (one line above and below), then replace the line that starts with `Replace "visible in urgent-only mode" with a note that 'priority: 'urgent'' is still accepted...` with a one-line retrospective note:

```
Historical note: the `priority` field was fully removed in Wave 4. Urgency is now implicit in annotation type (flags/questions always surface).
```

Do NOT touch line 602 — "lower-priority suggestions" there refers to task priority in a self-review section.

- [ ] **Step 4: Grep to confirm no remaining `priority: 'urgent'` (or `'urgent'` in annotation context) references in active planning docs.**

Run Grep with pattern `priority.*urgent` path `docs/superpowers/`.

Expected: only matches inside the plan file being executed *right now* (the plan you're writing) or the Wave 4 retrospective note you just added. No active guidance telling a reader to set `priority`.

- [ ] **Step 5: Commit.**

```bash
git add docs/superpowers/specs/2026-04-04-claude-code-skill-design.md docs/superpowers/plans/2026-04-07-wave4-pr-review-fixes.md
git commit -m "$(cat <<'EOF'
docs(superpowers): strike stale priority: 'urgent' references

The priority field was removed in Wave 4 but planning docs still
instructed Claude to set it. Replace with a historical note so future
agents reading the spec aren't misled into emitting a dead field.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Move screenshots spec out of `tests/e2e/`

**Problem:** `tests/e2e/screenshots.spec.ts` is a build-artifact generator gated by `SCREENSHOTS=1`. It has no real assertions (just `toBeVisible` pre-conditions) and a CI filter-glob change could accidentally enable it. Move it to `scripts/` with its own Playwright config so it can't be swept up by the test runner.

**Files:**
- Delete: `tests/e2e/screenshots.spec.ts`
- Create: `scripts/capture-screenshots.ts` (or keep `.spec.ts` under a separate directory — decide in step 1)
- Create: `scripts/capture-screenshots.config.ts` (if keeping Playwright test format)
- Modify: `package.json` (add a `capture:screenshots` script)

- [ ] **Step 1: Read the current `tests/e2e/screenshots.spec.ts` to decide between two relocation options.**

Read: `tests/e2e/screenshots.spec.ts` (full file).

Decide between:
- **Option A (recommended):** keep the `.spec.ts` Playwright format but move it under `scripts/screenshots/capture.spec.ts` with a sibling `scripts/screenshots/playwright.config.ts` that points `testDir` at `scripts/screenshots/` only. Playwright's default test discovery runs from `playwright.config.ts` at the repo root, which points at `tests/e2e/`, so this location is fully isolated.
- **Option B:** convert to a plain Node script using Playwright's programmatic API (`chromium.launch()` directly). More work, no real upside over Option A.

Go with Option A.

- [ ] **Step 2: Create `scripts/screenshots/` and move the file.**

```bash
mkdir -p scripts/screenshots
git mv tests/e2e/screenshots.spec.ts scripts/screenshots/capture.spec.ts
```

- [ ] **Step 3: Update imports in the moved file to point at the new helper path.**

The original file imported from `./helpers`. After the move, update to:

Edit `scripts/screenshots/capture.spec.ts` imports:

```ts
import { createFixtureDir, cleanupFixtureDir, McpTestClient } from "../../tests/e2e/helpers";
```

(Adjust to exactly match the symbols the original file imports — run `grep "from \"./helpers\"" scripts/screenshots/capture.spec.ts` after the move to see what's used.)

- [ ] **Step 4: Create `scripts/screenshots/playwright.config.ts`.**

Create new file `scripts/screenshots/playwright.config.ts` that extends the root Playwright config but overrides `testDir`:

```ts
import { defineConfig } from "@playwright/test";
import baseConfig from "../../playwright.config";

export default defineConfig({
  ...baseConfig,
  testDir: "./",
  // SCREENSHOTS=1 must be set for anything to actually capture output.
  fullyParallel: false,
  workers: 1,
});
```

- [ ] **Step 5: Add a `capture:screenshots` script to `package.json`.**

Read `package.json` scripts section, then add a new script entry (preserve existing scripts):

```json
"capture:screenshots": "cross-env SCREENSHOTS=1 playwright test --config=scripts/screenshots/playwright.config.ts"
```

(If `cross-env` is not already a dependency, use plain `SCREENSHOTS=1 playwright test ...` — Playwright runs on POSIX shells in practice but the project supports Windows; check `package.json` for existing env-var conventions. If scripts use `set VAR=value &&` or similar, match that pattern instead.)

- [ ] **Step 6: Run the standard E2E suite to verify the capture file is no longer discovered.**

Run: `npx playwright test --list 2>&1 | grep -c screenshots`

Expected: `0` — the capture file is no longer in the root config's test discovery.

- [ ] **Step 7: Run the capture script to verify it still works in its new home.**

Run: `npm run capture:screenshots`

Expected: PASS. (Or "0 tests run" if SCREENSHOTS gating keeps tests skipped — the goal is "no error, spec discovered by the isolated config".)

- [ ] **Step 8: Commit.**

```bash
git add scripts/screenshots/ package.json
git rm tests/e2e/screenshots.spec.ts  # if git mv didn't already handle it
git commit -m "$(cat <<'EOF'
refactor(e2e): move screenshot capture out of tests/e2e/

The file is a build-artifact generator (SCREENSHOTS=1 gated) with no
real assertions. Isolating it under scripts/screenshots/ with its own
Playwright config prevents a future CI filter-glob change from
accidentally sweeping it into the test run.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Final verification

Run the full validation pipeline to confirm nothing regressed.

- [ ] **Step 1: Typecheck.**

Run: `npm run typecheck`

Expected: clean, no errors.

- [ ] **Step 2: Unit tests.**

Run: `npm test`

Expected: all 896+ tests pass.

- [ ] **Step 3: Lint / format.**

Run: `npx biome check --write src/ tests/`

Expected: no errors; any auto-fixable formatting applied.

- [ ] **Step 4: Full E2E suite.**

Run: `npm run test:e2e`

Expected: all E2E tests pass, including the new additions (`clamp`, `round trip`, `Clear-filters button`, strengthened scroll-reset and active-annotation tests, and the held-banner assertions).

- [ ] **Step 5: Spot-check the capture script in isolation.**

Run: `npm run capture:screenshots -- --list`

Expected: the capture spec is listed from its new home, nothing from `tests/e2e/`.

- [ ] **Step 6: Stage any auto-format fixes and commit as a closeout.**

```bash
git add -u
git commit --allow-empty -m "$(cat <<'EOF'
chore(wave-4): close out PR review fixes

All findings from the four-agent review of chore/wave-4-closeout are
addressed: scroll-container production bug fixed, silent-failure
diagnostics added, E2E gaps covered (held banner, Clear button, clamp
boundaries, tabbed round trip), panel-width keys refactored to Record,
stale priority references cleaned, screenshot capture relocated.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Push the branch and update the PR body with a closeout note referencing this plan.**

Run: `git push`

Then open the PR on GitHub (if one exists) and link this plan in the description under a "Review fixes" section.

---

## Self-Review

Walking the spec with fresh eyes against this plan:

**Spec coverage check:**

| Review finding | Task |
|---|---|
| Scroll-container mismatch (Critical) | Task 1 |
| Silent `localStorage` catches in `App.tsx` | Task 3 |
| Silent `querySelector` miss in `SidePanel.tsx` | Task 3 |
| Solo/Tandem test doesn't verify held-annotations contract | Task 4 |
| Clear button has no coverage | Task 5 |
| Panel-width clamp not exercised | Task 7 |
| Cross-layout width persistence not tested | Task 8 |
| Active-annotation geometry assertion brittle | Task 2 |
| Stale `priority: 'urgent'` planning docs | Task 9 |
| `Record<PanelSide, string>` refactor | Task 6 |
| Legacy naming comment on width keys | Task 6 |
| Screenshot spec placement | Task 10 |
| Final verification | Task 11 |

All issues tracked. Deferred items (dwell functional test, legacy session-loader strip, `Annotation` discriminated union, `PanelLayout` discriminated union) are documented in the Context section with explicit reasoning.

**Placeholder scan:** No "TBD", no "implement later", no "add appropriate X", no bare "similar to Task N" references — every step has concrete file paths and code.

**Type consistency:** `PanelSide` is defined in `src/shared/constants.ts` (Task 6, Step 1) and imported in `src/client/App.tsx` (Task 6, Step 2). `PANEL_WIDTH_KEYS` has the same Record shape everywhere it's referenced. `data-testid="annotation-list-scroll-container"` is introduced in Task 1 Step 3 and used consistently by Tasks 1, 2, and 5.

**Execution order dependencies:**
- Task 1 must precede Task 2 (both reference the new testid).
- Task 1 must precede Task 5 (Clear test uses the new testid).
- Task 6 must precede Tasks 7 and 8 if you want the new tests to exercise the refactored code path, but it's not strictly required since the tests read `localStorage` keys directly rather than calling into the refactored setter.
- Task 3 can run independently of everything else.
- Task 9 is doc-only and can run at any point.
- Task 10 is independent; the screenshot file doesn't interact with any other change.
- Task 11 must be last.

No other ordering constraints.
