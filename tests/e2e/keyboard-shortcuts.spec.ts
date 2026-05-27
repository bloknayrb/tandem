import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  switchToAnnotationsTab,
} from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

/**
 * #859: after a keyboard panel toggle, focus is restored to a tabindex="-1"
 * peek strip / edge-collapse zone purely to preserve tab position. That focus
 * follows a keydown, so :focus-visible matches — we must suppress the keyboard
 * focus ring. Assert the active element draws neither an outline ring nor an
 * inset box-shadow ring (the peek strip's accent ring was an inset shadow).
 */
async function expectNoFocusRing(page: import("@playwright/test").Page) {
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow };
  });
  expect(ring).not.toBeNull();
  expect(ring!.outlineStyle).toBe("none");
  // The only ring the peek strip ever drew was `inset 0 0 0 2px <accent>`;
  // its elevation shadow is non-inset, so any `inset` keyword means a ring.
  expect(ring!.boxShadow).not.toContain("inset");
}

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md", "sample2.md", "link-target.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("Ctrl+W closes the active tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  // Both tabs visible
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();
  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample2).toBeVisible();

  // sample2.md is active by default (last opened). Press Ctrl+W.
  await page.keyboard.press("Control+w");

  // sample2.md tab is gone, sample.md remains.
  await expect(sample2).toHaveCount(0);
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();
});

test("Ctrl+O opens the file dialog", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Dialog absent before the shortcut
  await expect(page.locator("[data-testid='file-open-dialog']")).toHaveCount(0);

  await page.keyboard.press("Control+o");
  await expect(page.locator("[data-testid='file-open-dialog']")).toBeVisible();
});

test("'+' button → Browse opens the file dialog", async ({ page }) => {
  // Guards the post-refactor onRequestOpenDialog plumbing: DocumentTabs no longer
  // renders FileOpenDialog directly, so the existing "+" → Browse path must still
  // reach the lifted dialog rendering in App.svelte.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid='open-file-btn']")).toBeVisible();

  await page.locator("[data-testid='open-file-btn']").click();
  await page.locator("[data-testid='new-tab-browse']").click();

  await expect(page.locator("[data-testid='file-open-dialog']")).toBeVisible();
});

test("Ctrl+N switches to the Nth tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "link-target.md") });
  await page.goto("http://127.0.0.1:5173");

  // Wait for all three tabs.
  await expect(page.locator("[data-testid^='tab-name-']")).toHaveCount(3);

  // Tabs are role="tab" with aria-selected.
  const tabs = page.locator("[role='tab']");

  // Settle gate: wait for the server's active doc (the last-opened, link-target.md
  // → tab index 2) to land before issuing keyboard switches. This guarantees the
  // authoritative documentMeta sync has applied, so a keypress can't race a late
  // reconcile that would revert it. Load-bearing, not cosmetic — it is the precondition
  // the previous timeout-bump fix was missing.
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });

  // Press Ctrl+1 — first tab becomes active.
  await page.keyboard.press("Control+1");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

  // Press Ctrl+2 — second tab.
  await page.keyboard.press("Control+2");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

  // Press Ctrl+9 — clamps to last (3rd) tab.
  await page.keyboard.press("Control+9");
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
});

test("Ctrl+W is ignored while a form input has focus", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Open the find bar and focus its input (an INPUT element).
  await page.keyboard.press("Control+f");
  const findInput = page.locator("[data-testid='find-input']");
  await expect(findInput).toBeVisible();
  await findInput.focus();

  // Press Ctrl+W — the guard should swallow it; tab must still be present.
  await page.keyboard.press("Control+w");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();
});

test("Help modal advertises the new shortcuts", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Open via the brand menu — Wave M moved the Help entry there (the old standalone
  // help button was removed). "?" keyboard shortcut is intentionally suppressed while
  // focus is inside the contenteditable editor.
  await page.locator("[data-testid='titlebar-brand-menu']").click();
  await page.locator("[data-testid='brand-menu-shortcuts']").click();
  const modal = page.locator("[data-testid='help-modal']");
  await expect(modal).toBeVisible();

  await expect(modal.getByText("Close active tab")).toBeVisible();
  await expect(modal.getByText("Open file…")).toBeVisible();
  await expect(modal.getByText("Jump to tab by number")).toBeVisible();
  await expect(modal.getByText("Find in open tabs")).toBeVisible();
  await expect(modal.getByText("Find next match")).toBeVisible();
  await expect(modal.getByText("Find previous match")).toBeVisible();
  await expect(modal.getByText("Toggle Solo / Tandem mode")).toBeVisible();
  await expect(modal.getByText("Toggle left panel")).toBeVisible();
  await expect(modal.getByText("Toggle right panel")).toBeVisible();
  await expect(modal.getByText("Reopen closed tab (this session)")).toBeVisible();
  await expect(modal.getByText("Next annotation")).toBeVisible();
  await expect(modal.getByText("Previous annotation")).toBeVisible();
  await expect(modal.getByText("Accept focused annotation")).toBeVisible();
  await expect(modal.getByText("Dismiss focused annotation")).toBeVisible();
  // "Comment on selection" (Ctrl+Alt+M) became user-remappable (ADR-041) and
  // has no registry row, so it now lives in the editable Settings → Shortcuts
  // list rather than the Help catalog.
  await expect(modal.getByText("Heading 1")).toBeVisible();
  await expect(modal.getByText("Heading 6")).toBeVisible();
  await expect(modal.getByText("Select containing block")).toBeVisible();
  await expect(modal.getByText("Toggle authorship colors")).toBeVisible();
});

test("Ctrl+Shift+F opens the find bar pre-scoped to Open tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']")).toHaveCount(2);

  await page.keyboard.press("Control+Shift+F");
  await expect(page.locator("[data-testid='find-replace-bar']")).toBeVisible();
  await expect(page.locator("[data-testid='find-scope-tabs']")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("Ctrl+Shift+F with one tab open hides scope pills (single-doc fallback)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.keyboard.press("Control+Shift+F");
  await expect(page.locator("[data-testid='find-replace-bar']")).toBeVisible();
  // Scope pills only render when tabs.length > 1 (existing FindReplaceBar guard).
  await expect(page.locator("[data-testid='find-scope-pills']")).toHaveCount(0);
});

test("Ctrl+G with no active query opens the find bar", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await expect(page.locator("[data-testid='find-replace-bar']")).toHaveCount(0);
  await page.keyboard.press("Control+g");
  await expect(page.locator("[data-testid='find-replace-bar']")).toBeVisible();
});

// Notes on coverage scope:
// - The "no active query → open find bar" smart-fallback above is the
//   regression-risk behavior unique to this PR.
// - "Ctrl+G with active query advances to the next match" is exercised in unit
//   tests via `shouldDispatchFindNav` (the only logic the keydown branch adds
//   on top of Tiptap's own `findNext` command). End-to-end assertion through
//   Yjs + ProseMirror + the find-replace plugin proved too brittle for stable
//   CI — match-count timing depends on collab-extension sync internals.
// - The "Ctrl+G is ignored when a form input has focus" guard is covered by
//   the existing "Ctrl+W is ignored" test (same shouldIgnoreShortcut helper).

test("Ctrl+Shift+M toggles solo / tandem mode", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Default mode is tandem.
  const tandemBtn = page.locator("[data-testid='mode-tandem-btn']");
  const soloBtn = page.locator("[data-testid='mode-solo-btn']");
  // The `[data-tandem-mode="solo"]` CSS rule in index.html (the de-emphasis
  // fade for solo mode) is the ground truth — assert the root attribute
  // toggles in lockstep with the toolbar state.
  const root = page.locator("[data-tandem-mode]").first();
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "false");
  await expect(root).toHaveAttribute("data-tandem-mode", "tandem");

  await page.keyboard.press("Control+Shift+M");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "true");
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "false");
  await expect(root).toHaveAttribute("data-tandem-mode", "solo");

  await page.keyboard.press("Control+Shift+M");
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(root).toHaveAttribute("data-tandem-mode", "tandem");
});

test("Alt+Shift+Left toggles the left panel", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Capture initial left-panel visibility via the resize-handle testid.
  const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
  const initial = await leftHandle.count();

  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect.poll(async () => leftHandle.count()).not.toBe(initial);
  // focusToggleTarget queues focus via microtask to the activated element's
  // replacement: peek strip when the rail just collapsed, edge zone when
  // it just expanded. Direction depends on the test fixture's initial
  // panel-visibility, so derive the expected target from the current
  // post-toggle visibility rather than assuming a fixed direction.
  const visibleAfterFirst = (await leftHandle.count()) > 0;
  await expect(
    page.getByTestId(visibleAfterFirst ? "panel-edge-collapse-left" : "peek-strip-left"),
  ).toBeFocused();
  // #859: focus restoration must not leave a lingering keyboard focus ring on
  // the tabindex="-1" restoration target.
  await expectNoFocusRing(page);

  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect.poll(async () => leftHandle.count()).toBe(initial);
  const visibleAfterSecond = (await leftHandle.count()) > 0;
  await expect(
    page.getByTestId(visibleAfterSecond ? "panel-edge-collapse-left" : "peek-strip-left"),
  ).toBeFocused();
  await expectNoFocusRing(page);
});

test("Alt+Shift+Right toggles the right panel", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  const rightHandle = page.locator("[data-testid='panel-resize-handle']");
  const initial = await rightHandle.count();

  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect.poll(async () => rightHandle.count()).not.toBe(initial);
  const visibleAfterFirst = (await rightHandle.count()) > 0;
  await expect(
    page.getByTestId(visibleAfterFirst ? "panel-edge-collapse-right" : "peek-strip-right"),
  ).toBeFocused();
  // #859: focus restoration must not leave a lingering keyboard focus ring on
  // the tabindex="-1" restoration target.
  await expectNoFocusRing(page);

  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect.poll(async () => rightHandle.count()).toBe(initial);
  const visibleAfterSecond = (await rightHandle.count()) > 0;
  await expect(
    page.getByTestId(visibleAfterSecond ? "panel-edge-collapse-right" : "peek-strip-right"),
  ).toBeFocused();
  await expectNoFocusRing(page);
});

test("Ctrl+Alt+T reopens the most recently closed tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  const sample = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample).toBeVisible();
  await expect(sample2).toBeVisible();

  // Close active tab (sample2.md is last-opened, so it's active).
  await page.keyboard.press("Control+w");
  await expect(sample2).toHaveCount(0);

  // Reopen via Ctrl+Alt+T.
  await page.keyboard.press("Control+Alt+t");
  await expect(sample2).toBeVisible();
});

test("Ctrl+Alt+T no-ops when no tabs have been closed", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // No tabs closed yet — pressing the shortcut should be a silent no-op.
  await page.keyboard.press("Control+Alt+t");
  await expect(page.locator("[data-testid^='tab-name-']")).toHaveCount(1);
  expect(errors).toHaveLength(0);
});

test("Alt+] does not crash with no annotations and no console errors", async ({ page }) => {
  // The pure logic of Alt+]/Alt+[ navigation (sortAnnotationsByPosition,
  // nextAnnotationId, prevAnnotationId) is covered by useAnnotationOrder.test.ts.
  // E2E coverage focuses on no-crash behavior — the visual cycle assertion
  // through aria-current proved brittle (timing-dependent on Yjs annotation
  // sync interleaving with the lifted useAnnotationReview's auto-set effect).
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Empty annotations list: Alt+] / Alt+[ should be silent no-ops.
  await page.keyboard.press("Alt+BracketRight");
  await page.keyboard.press("Alt+BracketLeft");
  expect(errors).toHaveLength(0);
});

test("Ctrl+Enter accepts the first pending annotation", async ({ page }) => {
  // The lifted useAnnotationReview auto-sets activeAnnotationId to the first
  // pending annotation on initial mount, so Ctrl+Enter immediately operates on
  // that target without needing Alt+] to establish a cursor first.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: 2,
    to: 15,
    text: "Accept me via keyboard",
    textSnapshot: "Test Document",
  });
  await page.goto("http://127.0.0.1:5173");
  await switchToAnnotationsTab(page);

  const card = page.locator("[data-testid^='annotation-card-']").first();
  await expect(card).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("Control+Enter");

  // After accept, the card moves into the collapsed "resolved" details section.
  await expect(page.locator("summary", { hasText: "1 resolved" })).toBeVisible({
    timeout: 5_000,
  });
});

test("Ctrl+Shift+Enter dismisses the first pending annotation", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: 2,
    to: 15,
    text: "Dismiss me via keyboard",
    textSnapshot: "Test Document",
  });
  await page.goto("http://127.0.0.1:5173");
  await switchToAnnotationsTab(page);

  const card = page.locator("[data-testid^='annotation-card-']").first();
  await expect(card).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("Control+Shift+Enter");

  await expect(page.locator("summary", { hasText: "1 resolved" })).toBeVisible({
    timeout: 5_000,
  });
});

test("Ctrl+Alt+M opens the comment popup focused on its textarea", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator(".ProseMirror", { hasText: "Test Document" })).toBeVisible({
    timeout: 10_000,
  });

  // Pin selectionToolbar=on so a future default flip in settings doesn't
  // fail this test for an unrelated reason. The Ctrl+Alt+M handler now
  // routes to a toast when the setting is off; this test asserts the
  // happy path.
  await page.evaluate(() => {
    const raw = localStorage.getItem("tandem:settings");
    const settings = raw ? JSON.parse(raw) : {};
    settings.selectionToolbar = true;
    localStorage.setItem("tandem:settings", JSON.stringify(settings));
  });
  await page.reload();
  await expect(page.locator(".ProseMirror", { hasText: "Test Document" })).toBeVisible({
    timeout: 10_000,
  });

  // Select the title via Ctrl+A then narrow with another key combo. Easier:
  // triple-click selects the paragraph.
  await page.locator(".ProseMirror h1, .ProseMirror p").first().click({ clickCount: 3 });

  await page.keyboard.press("Control+Alt+m");

  await expect(page.locator("[data-testid='popup-comment-submit']")).toBeVisible({
    timeout: 3_000,
  });
  // The popup's textarea should have focus. Poll because Svelte's focus effect
  // settles after the popup mounts — a one-shot evaluate flakes intermittently.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName), { timeout: 3_000 })
    .toBe("TEXTAREA");
});

test("Ctrl+Alt+T after closing via the X button (DocumentTabs path) reopens", async ({ page }) => {
  // Verifies that closeTabAndRecord wraps the DocumentTabs onTabClose prop, not
  // just the Ctrl+W keydown branch.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample2).toBeVisible();

  // Click the X button on sample2's tab. The TabItem renders a close button
  // inside the tab; locate it relative to the tab-name span's tab container.
  // (Per CLAUDE.md the tab itself has data-testid="tab-{id}", and the close
  //  button is inside it with role="button" / appropriate aria.)
  const sample2Tab = page.locator("[role='tab']").filter({ has: sample2 });
  // The close button is the only button inside the tab item.
  await sample2Tab.locator("button").first().click();
  await expect(sample2).toHaveCount(0);

  await page.keyboard.press("Control+Alt+t");
  await expect(sample2).toBeVisible();
});

test("Escape closes the command palette even when focus is outside it", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.keyboard.press("Control+Shift+P");
  const palette = page.locator("[data-testid='command-palette']");
  await expect(palette).toBeVisible({ timeout: 3_000 });

  // Move focus out of the palette (the modal-level onkeydown only fired while a
  // palette descendant held focus — the regression). A window-level Escape
  // handler must dismiss the palette regardless of where focus sits.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
});

test("command palette overlay covers the title bar +new-tab button", async ({ page }) => {
  // Dimming-by-proxy: the title bar's +button and Solo/Tandem toggle use a
  // z-index: 99999 decorum lift. If the palette overlay (z-index 100000) sits
  // below it, those controls poke through the backdrop and remain clickable.
  // Clicking at the +button's coordinates must hit the overlay (closing the
  // palette via handleBackdropClick), NOT the +button underneath.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.keyboard.press("Control+Shift+P");
  const palette = page.locator("[data-testid='command-palette']");
  await expect(palette).toBeVisible({ timeout: 3_000 });

  // The +button's recent-files menu (role=dialog, aria-label="New tab") must be
  // absent before and after the click — its presence would prove the click
  // reached the +button beneath the overlay.
  const newTabMenu = page.locator("[role='dialog'][aria-label='New tab']");
  await expect(newTabMenu).toHaveCount(0);

  const box = await page.locator("[data-testid='open-file-btn']").boundingBox();
  if (!box) throw new Error("open-file-btn has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Click landed on the overlay → handleBackdropClick closed the palette.
  await expect(palette).toHaveCount(0);
  // …and the +button underneath never fired, so its menu never opened.
  await expect(newTabMenu).toHaveCount(0);
});

test("Help modal overlay covers the title bar +new-tab button", async ({ page }) => {
  // Representative case for the shared --tandem-z-above-titlebar tokenization
  // (#839): every full-screen modal overlay must cover the title bar's
  // --tandem-z-titlebar (99999) decorum lift. Same dimming-by-proxy proof as the
  // palette test — clicking at the +button must hit the overlay (closing the
  // modal), not the +button beneath it.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.locator("[data-testid='titlebar-brand-menu']").click();
  await page.locator("[data-testid='brand-menu-shortcuts']").click();
  const modal = page.locator("[data-testid='help-modal']");
  await expect(modal).toBeVisible();

  const newTabMenu = page.locator("[role='dialog'][aria-label='New tab']");
  await expect(newTabMenu).toHaveCount(0);

  const box = await page.locator("[data-testid='open-file-btn']").boundingBox();
  if (!box) throw new Error("open-file-btn has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Click landed on the overlay (which dismisses on backdrop click), not the +button.
  await expect(modal).toHaveCount(0);
  await expect(newTabMenu).toHaveCount(0);
});
