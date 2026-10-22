import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  ownsItsPixels,
  selectTextStable,
} from "./helpers";

// SettingsModal (Wave 1 sibling component) — covers the three dismiss paths
// (Escape, scrim click, close button), tab switching, and the click-outside
// exemption for clicks inside the modal container.
//
// These tests open the modal via the dev-only
// `__tandemTest.openSettingsModal()` hook installed in `App.svelte`, so they
// exercise the modal behavior independent of the keyboard shortcut. The real
// `Ctrl+,` keypress path is covered in `settings-and-filters.spec.ts`
// ("Ctrl+, opens the Settings modal").

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
    page.locator("[data-testid='settings-modal-solo-rail-hidden-toggle']"),
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

// Historical note, not a test (#1783). The `Ctrl+Shift+,` binding a permanently
// skipped, empty `test.skip` anchored here was removed entirely — the
// settings-UI refactor consolidated on a single `Ctrl+,` binding (no Shift).
// That real-keypress path is exercised in settings-and-filters.spec.ts
// ("Ctrl+, opens the Settings modal"), which doesn't hit the Tiptap-keymap
// contention the placeholder used to document (`Mod-Shift-,` collided with
// Tiptap's subscript binding; plain `Comma` with Ctrl held does not).

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

  // #2257: the toast must paint ABOVE the still-open modal's scrim, not as a
  // washed-out ghost beneath it. Probe the card (pointer-events: auto), not the
  // stack (pointer-events: none, which elementFromPoint skips), under poll
  // because the card slides in.
  await expect(page.locator(MODAL)).toBeVisible();
  await expect.poll(() => ownsItsPixels(toast.getByRole("status").first())).toBe(true);
  // And now that it is clickable over the modal, dismissing it must not count
  // as a click outside Settings.
  await toast.locator("[data-testid^='toast-dismiss-']").first().click();
  await expect(toast).toHaveCount(0);
  await expect(page.locator(MODAL)).toBeVisible();
});

// Escape closes Settings wherever focus is (Bryan: "Escape should always close
// Settings"). It used to act only when the event target was inside the dialog,
// so anything that left focus on <body> made Escape a no-op. The rule's
// exceptions are pinned alongside: the narrow drawer closes first, and a layer
// ABOVE Settings keeps its own Escape.

async function openEditor(page: Page): Promise<void> {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
}

test("Escape closes Settings after working-directory Save drops focus on <body>", async ({
  page,
}) => {
  // The reported path. Save carries `disabled={wdInflight}`, so it disables
  // itself for the length of its POST; Blink then blurs it to <body> (a
  // focusout with no relatedTarget). The dialog's stranded-focus recovery runs
  // a frame later, by which time this fast POST has answered and Save is
  // enabled again, so the recovery reads "nothing was lost" and focus stays on
  // <body> — where the old focus-inside rule ignored Escape.
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

  await openEditor(page);
  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-claude-code']").click();
  await expect(page.locator("[data-testid='settings-modal-working-directory']")).toBeVisible({
    timeout: 5_000,
  });
  await page.locator("[data-testid='settings-modal-working-directory-save']").click();
  await expect(page.locator("[data-testid='toast-container']")).toContainText(
    "Working directory saved.",
    { timeout: 5_000 },
  );

  await page.keyboard.press("Escape");
  await expect(page.locator(MODAL)).toHaveCount(0);
});

test("Escape closes Settings when focus is on <body>", async ({ page }) => {
  // The general form of the bug, independent of which control stranded focus.
  await openEditor(page);
  await openSettingsModal(page);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator(MODAL)).toHaveCount(0);
});

test("Escape closes the narrow drawer first, then Settings", async ({ page }) => {
  // W9: below 860px the section list is a drawer, and Escape closes it before
  // the dialog. Pressed from <body> so the drawer rule is shown to survive the
  // focus-anywhere change, not just the focus-inside path it was written for.
  await page.setViewportSize({ width: 600, height: 800 });
  await openEditor(page);
  await openSettingsModal(page);

  const modal = page.locator(MODAL);
  await page.locator("[data-testid='settings-modal-narrow-hamburger']").click();
  await expect(modal).toHaveAttribute("data-narrow-sidebar-open", "true");

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(modal).toHaveAttribute("data-narrow-sidebar-open", "false");
  await expect(modal).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});

test("Escape in Help opened over Settings closes only Help", async ({ page }) => {
  // The help shortcut is not gated on Settings, so Help stacks over it (later
  // in App.svelte, same z tier) and takes focus. Help listens in the window
  // capture phase, ahead of Settings' document listener.
  await openEditor(page);
  await openSettingsModal(page);

  await page.keyboard.press("Control+Slash");
  const help = page.locator("[data-testid='help-modal']");
  await expect(help).toBeVisible({ timeout: 2_000 });

  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(page.locator(MODAL)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(MODAL)).toHaveCount(0);
});

test("Escape in the file-open dialog over Settings closes only that dialog", async ({ page }) => {
  // Ctrl+O is not gated on Settings, so the browser build's file-open dialog
  // opens on top of it. It used to listen for Escape only on its own backdrop,
  // and its Browse `autofocus` yielded to the focus Settings already held, so
  // the first Escape closed Settings out from under it (master) or, once
  // Settings stood down, closed nothing. It now takes focus on mount and owns
  // Escape in the window capture phase, like Help and the command palette.
  await openEditor(page);
  await openSettingsModal(page);

  await page.keyboard.press("Control+KeyO");
  const fileDialog = page.locator("[data-testid='file-open-dialog']");
  await expect(fileDialog).toBeVisible({ timeout: 2_000 });

  await page.keyboard.press("Escape");
  await expect(fileDialog).toHaveCount(0);
  await expect(page.locator(MODAL)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(MODAL)).toHaveCount(0);
});

test("Escape closes Settings even with the selection popup open beneath it", async ({ page }) => {
  // The popup listens for Escape in the window CAPTURE phase and stops
  // propagation, so it ran before Settings' document listener and dismissed
  // itself under the scrim while the dialog on screen stayed open — with focus
  // inside the dialog. It now yields while any aria-modal dialog is open.
  await openEditor(page);
  await selectTextStable(page.locator(".tandem-editor p").first());
  const popup = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(popup).toBeVisible();

  await page.keyboard.press("Control+Comma");
  await expect(page.locator(MODAL)).toBeVisible({ timeout: 2_000 });

  await page.keyboard.press("Escape");
  await expect(page.locator(MODAL)).toHaveCount(0);
});

test("Escape closes Settings even with the activity tray open beneath it", async ({ page }) => {
  // Same shape as the selection popup: the tray's capture-phase Escape
  // preempted Settings when Settings was opened from the keyboard over it.
  await openEditor(page);
  await page.locator("[data-testid='activity-pill']").click();
  const tray = page.locator("[data-testid='activity-tray']");
  await expect(tray).toBeVisible();

  await page.keyboard.press("Control+Comma");
  await expect(page.locator(MODAL)).toBeVisible({ timeout: 2_000 });

  await page.keyboard.press("Escape");
  await expect(page.locator(MODAL)).toHaveCount(0);
  // The tray beneath is untouched by that press and takes the next one.
  await expect(tray).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tray).toHaveCount(0);
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

test("#1236: the start-at-login toggle is absent in the browser build", async ({ page }) => {
  // The only honest E2E assertion for autostart: it is a desktop-only control,
  // and this suite runs in a browser. Negative, but it pins a real regression —
  // an ungated toggle would call `invoke` and throw on click for every browser
  // user. The positive path needs a real OS registration and a reboot, so it
  // lives on the manual QA checklist (see ADR-046).
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-network']").click();

  // The tab itself must have rendered — otherwise this would pass vacuously
  // against a Network tab that failed to mount at all.
  await expect(page.locator("[data-testid='network-advanced']")).toHaveCount(1);
  await expect(page.locator("[data-testid='network-autostart-toggle']")).toHaveCount(0);
  await expect(page.locator("[data-testid='network-autostart-error']")).toHaveCount(0);
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

// #2195 — the "Tandem's Claude" section saves ONE field per change, so a stale
// view can never put back a start mode another window changed.
test("Tandem's Claude: choosing Off saves startMode alone", async ({ page }) => {
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
  await page.route("**/api/launcher/nonce", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ nonce: "e2e-nonce" }),
    }),
  );
  const patches: unknown[] = [];
  await page.route("**/api/launcher/settings", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { patch: unknown };
      patches.push(body.patch);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          settings: { startMode: "off", lifetime: "always", idleMinutes: 30 },
        }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          settings: { startMode: "auto", lifetime: "always", idleMinutes: 30 },
        }),
      });
    }
  });

  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-claude-code']").click();

  const section = page.locator("[data-testid='settings-modal-tandem-claude']");
  await expect(section).toBeVisible({ timeout: 5_000 });
  await expect(section).toContainText("keeps running in the background");
  const auto = page.locator("[data-testid='settings-modal-tandem-claude-start-auto']");
  await expect(auto).toBeChecked();
  await page.locator("[data-testid='settings-modal-tandem-claude-start-off']").check();
  await expect.poll(() => patches).toEqual([{ startMode: "off" }]);
  await expect(
    page.locator("[data-testid='settings-modal-tandem-claude-start-off']"),
  ).toBeChecked();
});
