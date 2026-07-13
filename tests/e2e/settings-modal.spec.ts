import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

// SettingsModal (Wave 1 sibling component) — covers the three dismiss paths
// (Escape, scrim click, close button), tab switching, and the click-outside
// exemption for clicks inside the modal container.
//
// The `Ctrl+Shift+,` shortcut wiring is verified via the dev-only
// `__tandemTest.openSettingsModal()` hook installed in `App.svelte`.
// Playwright's `page.keyboard.press` routes through the focused element
// first, and Tiptap's default keymap binds `Mod-Shift-,` to subscript and
// consumes the event before the App.svelte window-level handler sees it.
// A `test.skip` placeholder below records the gap so the real-shortcut
// path is restored when the upstream keymap is reconciled.

let mcp: McpTestClient;
let tmpDir: string;

const MODAL = "[data-testid='settings-modal']";
const SCRIM = "[data-testid='settings-modal-scrim']";

async function openSettingsModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tandemTest?: { openSettingsModal: () => void } };
    if (!w.__tandemTest?.openSettingsModal) {
      throw new Error(
        "__tandemTest.openSettingsModal is not installed — App.svelte must export it in dev builds",
      );
    }
    w.__tandemTest.openSettingsModal();
  });
  await expect(page.locator(MODAL)).toBeVisible({ timeout: 5_000 });
}

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("Escape closes the SettingsModal", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await expect(page.locator(MODAL)).toHaveCount(0);
  await openSettingsModal(page);

  // Default tab is Appearance (first in DEFAULT_SETTINGS_TABS).
  await expect(page.locator("[data-testid='settings-modal-tab-appearance']")).toHaveAttribute(
    "aria-current",
    "page",
  );

  // Escape from inside the modal. The modal auto-focuses on open, so the
  // press routes through the production `document`-level Escape handler
  // registered in `SettingsModal.svelte#onMount`, which also stops
  // propagation to prevent other window-level shortcuts from acting.
  await page.locator(MODAL).press("Escape");
  await expect(page.locator(MODAL)).toHaveCount(0);
});

test("scrim click closes the SettingsModal", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await openSettingsModal(page);

  // Click a corner of the scrim — the centre is occluded by the modal dialog.
  await page.locator(SCRIM).click({ position: { x: 10, y: 10 } });
  await expect(page.locator(MODAL)).toHaveCount(0);
});

test("close button closes the SettingsModal", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await openSettingsModal(page);

  await page.locator("[data-testid='settings-modal-close-btn']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);
});

test("tab switching shows tab-specific content", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await openSettingsModal(page);

  // AI Assistant tab (id preserved as "claude-code" for backward compatibility).
  await page.locator("[data-testid='settings-modal-tab-claude-code']").click();
  await expect(page.locator("[data-testid='settings-modal-dwell-time-slider']")).toBeVisible();
  await expect(
    page.locator("[data-testid='settings-modal-selection-toolbar-toggle']"),
  ).toBeVisible();

  // Collaboration tab.
  await page.locator("[data-testid='settings-modal-tab-collaboration']").click();
  await expect(page.locator("[data-testid='settings-modal-display-name']")).toBeVisible();
  await expect(
    page.locator("[data-testid='settings-modal-default-mode-tandem-btn']"),
  ).toBeVisible();

  // Shortcuts tab.
  await page.locator("[data-testid='settings-modal-tab-shortcuts']").click();
  await expect(page.locator("[data-testid='settings-modal-shortcuts-list']")).toBeVisible();

  // About tab.
  await page.locator("[data-testid='settings-modal-tab-about']").click();
  await expect(page.locator("[data-testid='settings-modal-view-documentation-btn']")).toBeVisible();
  await expect(page.locator("[data-testid='settings-modal-app-info-footer']")).toBeVisible();

  // Earlier-tab content is no longer visible after switching.
  await expect(page.locator("[data-testid='settings-modal-dwell-time-slider']")).toHaveCount(0);
});

test("clicks inside the modal do NOT close it", async ({ page }) => {
  // Verifies the modal-container exemption in the pointerdown click-outside
  // handler (feedback_click_outside_exempt_menu). The `triggerEl` exemption
  // is not exercised here because the Wave 1 trigger is keyboard-only.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await openSettingsModal(page);

  // Click inside the modal's content area — modal must remain open.
  await page.locator("[data-testid='settings-modal-content']").click({
    position: { x: 10, y: 10 },
  });
  await expect(page.locator(MODAL)).toBeVisible();

  // Click a sidebar tab nav button — still open.
  await page.locator("[data-testid='settings-modal-tab-editor']").click();
  await expect(page.locator(MODAL)).toBeVisible();
});

// Real-shortcut path. Skipped because Playwright's `page.keyboard.press`
// routes through the focused element first and Tiptap's default keymap
// binds `Mod-Shift-,` to subscript, consuming the keydown before the
// App.svelte window-level handler sees it. The shortcut works in regular
// browser use; this gap is a Playwright-only artifact. The four tests
// above cover the modal behavior via the dev-only `__tandemTest` hook.
test.skip("Ctrl+Shift+, keypress opens the SettingsModal (manual path)", async () => {
  // Intentionally empty — left as a documentation anchor for the gap.
});

// #821 PR review (L99) — coverage for the AI Assistant tab's working-directory
// states introduced by #803 E5/E7. Both tests route-mock the integrations and
// launcher endpoints so the UI flow runs end-to-end against a fake network
// layer (no real claude-code integration / supervisor required in CI).

test("E7: working-directory load-error banner shows on non-2xx /api/integrations", async ({
  page,
}) => {
  // Force the integrations fetch to fail so the load-error banner path fires.
  await page.route("**/api/integrations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "INTERNAL_ERROR" }),
      });
    } else {
      await route.continue();
    }
  });

  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-claude-code']").click();

  // The banner only renders once the load completes (wdLoaded) with no
  // integration found AND a captured load error.
  await expect(
    page.locator("[data-testid='settings-modal-working-directory-load-error']"),
  ).toBeVisible({ timeout: 5_000 });
  // The working-directory editor section must stay hidden when no integration
  // resolved.
  await expect(page.locator("[data-testid='settings-modal-working-directory']")).toHaveCount(0);
});

test("E5: saving the working directory surfaces the success toast", async ({ page }) => {
  // Return a claude-code integration so the working-directory section renders,
  // and accept the launcher POST so the full notify chain (ctx.notify →
  // SettingsModal → App → ToastContainer) fires.
  await page.route("**/api/integrations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ integrations: [{ kind: "claude-code" }] }),
      });
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/launcher/working-directory", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, workingDirectory: null }),
      });
    } else {
      await route.continue();
    }
  });

  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-claude-code']").click();

  // Section renders because the mocked integration resolved.
  await expect(page.locator("[data-testid='settings-modal-working-directory']")).toBeVisible({
    timeout: 5_000,
  });

  await page.locator("[data-testid='settings-modal-working-directory-save']").click();

  const toast = page.locator("[data-testid='toast-container']");
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText("Working directory saved.");
});

// PR 6 — Network two-tier refactor.
// Advanced controls live under a `<CollapsibleSection>` that ships collapsed
// each time the modal opens (no persisted disclosure state). These tests pin
// down: (a) collapsed-on-open, (b) toggle expands, (c) toggle collapses again,
// (d) controls are operable once expanded.

test("PR6: Network Advanced section ships collapsed and toggles open", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-network']").click();

  const advanced = page.locator("[data-testid='network-advanced']");
  await expect(advanced).toBeVisible();
  // <details> exposes its open state as a boolean attribute. Collapsed-by-default.
  await expect(advanced).not.toHaveAttribute("open", /.*/);

  // Children are not visible while collapsed (a control inside the section
  // still exists in the DOM under <details>, but `toBeVisible()` returns
  // false because the user-agent hides closed-details children).
  const delaySlider = page.locator("[data-testid='network-degraded-delay-slider']");
  await expect(delaySlider).not.toBeVisible();

  // Toggle expands.
  await page.locator("[data-testid='network-advanced-toggle']").click();
  await expect(advanced).toHaveAttribute("open", /.*/);
  await expect(delaySlider).toBeVisible();

  // Prove pointer events route into the expanded <details> subtree. A
  // `pointer-events: none` regression on CollapsibleSection, or a stacking-
  // context bug occluding children, would block selectOption here. The
  // post-change toHaveValue check is not tautological: Playwright dispatches
  // a real change event and the read-back value comes from Svelte re-rendering
  // the `value={settings.sidecarRetryStrategy}` binding after the onUpdate
  // round-trip.
  const retrySelect = page.locator("[data-testid='network-retry-strategy']");
  // Exactly two strategies survive: the dead "Manual only" option was removed
  // (#1135). selectOption would still pass with stray options, so assert the
  // count to catch an accidental re-add of "manual" or any third option.
  await expect(retrySelect.locator("option")).toHaveCount(2);
  await retrySelect.selectOption("constant-2s");
  await expect(retrySelect).toHaveValue("constant-2s");

  // Toggle collapses again.
  await page.locator("[data-testid='network-advanced-toggle']").click();
  await expect(advanced).not.toHaveAttribute("open", /.*/);
  await expect(delaySlider).not.toBeVisible();
});

test("PR6: Network Advanced disclosure resets across modal close/open", async ({ page }) => {
  // Ephemeral disclosure: re-opening the modal must show Advanced collapsed
  // again, even if the user expanded it in the prior session. Documents the
  // explicit decision recorded in the PR description.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-network']").click();
  await page.locator("[data-testid='network-advanced-toggle']").click();
  await expect(page.locator("[data-testid='network-advanced']")).toHaveAttribute("open", /.*/);

  await page.locator("[data-testid='settings-modal-close-btn']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);

  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-network']").click();
  await expect(page.locator("[data-testid='network-advanced']")).not.toHaveAttribute("open", /.*/);
});

test("#993: 'Use Warm when system is light' resolves system-light to warm, keeps dark", async ({
  page,
}) => {
  // Default theme is "system" and Chromium reports a light color scheme, so the
  // app resolves to data-theme="light" out of the box. The new toggle should
  // flip a light OS appearance to "warm" while a dark OS appearance stays "dark".
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  const html = page.locator("html");
  // Sanity: system + OS light resolves to light before the toggle.
  await expect(html).toHaveAttribute("data-theme", "light");

  await openSettingsModal(page);
  // Appearance is the default tab. The toggle is only rendered while Theme=system.
  const toggle = page.locator("[data-testid='appearance-system-light-warm'] input");
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();

  await toggle.check();
  await expect(toggle).toBeChecked();
  // System + OS light now resolves to the warm theme.
  await expect(html).toHaveAttribute("data-theme", "warm");

  // A dark OS appearance still resolves to dark regardless of the toggle.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "dark");

  // Back to light, warm is honored again.
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "warm");

  // Unchecking returns system-light to the neutral light theme.
  await toggle.uncheck();
  await expect(html).toHaveAttribute("data-theme", "light");
});

// A4: smart typography (opt-in, default off). Toggling appends/removes the
// Tiptap Typography extension via an editor rebuild — Editor.svelte
// (`smartTypography` $derived read inside the rebuild `$effect`). The
// extension's emDash input rule matches `/--$/` and replaces with an em
// dash; no trailing space is required to trigger it, but we type one anyway
// to mirror natural typing.
test("A4: smart typography toggle converts '--' to an em dash while typing", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });

  const firstParagraph = editor.locator("p", {
    hasText: "This is the first paragraph of the test document.",
  });
  await expect(firstParagraph).toBeVisible();

  // Baseline: setting off (default) — "--" stays literal.
  await firstParagraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type("--");
  await expect(firstParagraph).toContainText("document.--");
  // Undo the literal "--" before enabling the setting, so the two runs don't
  // interfere with each other's text.
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");

  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-editor']").click();
  const smartTypographyToggle = page.locator("[data-testid='editor-smart-typography'] input");
  await expect(smartTypographyToggle).toBeVisible();
  await expect(smartTypographyToggle).not.toBeChecked();
  await smartTypographyToggle.check();
  await expect(smartTypographyToggle).toBeChecked();
  await page.locator("[data-testid='settings-modal-close-btn']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);

  // Editor rebuilt with Typography registered — "--" now converts to an em dash.
  await firstParagraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type("-- ");
  await expect(firstParagraph).toContainText("document.— ");
});

// A5: spellcheck toggle (default on). Flips the native `spellcheck` DOM
// attribute on `.tandem-editor` via `editor.setOptions` — NOT an editor
// rebuild — so typing must keep working immediately after the toggle with no
// reload and no loss of focus/content.
test("A5: spellcheck toggle flips the editor's spellcheck attribute without destroying it", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });

  // Default on.
  await expect(editor).toHaveAttribute("spellcheck", "true");

  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-editor']").click();
  const spellcheckToggle = page.locator("[data-testid='editor-spellcheck-toggle'] input");
  await expect(spellcheckToggle).toBeVisible();
  await expect(spellcheckToggle).toBeChecked();
  await spellcheckToggle.uncheck();
  await expect(spellcheckToggle).not.toBeChecked();
  await page.locator("[data-testid='settings-modal-close-btn']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);

  // Flipped without a reload, and no editor recreation — same DOM node.
  await expect(editor).toHaveAttribute("spellcheck", "false");

  // Typing still works post-toggle (editor is alive, not torn down).
  const firstParagraph = editor.locator("p", {
    hasText: "This is the first paragraph of the test document.",
  });
  await firstParagraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" still editable");
  await expect(firstParagraph).toContainText("document. still editable");
});
