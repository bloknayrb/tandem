import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { cleanupAllOpenDocuments, McpTestClient } from "./helpers";

/**
 * Integration wizard E2E (#477 PR 3c-i + 3c-ii-b).
 *
 * Post-3c-ii-b: the wizard auto-opens via server-side first-run detection
 * (`GET /api/integrations/first-run-needed`). The Playwright webServer sets
 * `TANDEM_DISABLE_FIRST_RUN_WIZARD=1` so the auto-open path is suppressed
 * for the whole E2E suite (other specs would otherwise have the wizard
 * cover their editor surfaces). This spec exclusively exercises the
 * manual-reopen affordance from Settings — the auto-open path is covered
 * by unit tests for `useFirstRunNeeded` and `makeFirstRunHandler`.
 *
 * Does NOT exercise the secrets step (no real keychain on CI Linux without
 * libsecret; that branch is covered by `useIntegrationWizard.test.ts` with
 * a mocked fetch).
 */

let mcp: McpTestClient;
let tmpDir: string;

const SETTINGS_MODAL = "[data-testid='settings-modal']";
const AI_TAB = "[data-testid='settings-modal-tab-claude-code']";
const OPEN_WIZARD_BTN = "[data-testid='settings-modal-open-integration-wizard']";
const WIZARD = "[data-testid='integration-wizard']";
const WIZARD_CLOSE = "[data-testid='integration-wizard-close']";

async function openSettingsModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tandemTest?: { openSettingsModal: () => void } };
    if (!w.__tandemTest?.openSettingsModal) {
      throw new Error("__tandemTest.openSettingsModal is not installed");
    }
    w.__tandemTest.openSettingsModal();
  });
  await expect(page.locator(SETTINGS_MODAL)).toBeVisible({ timeout: 5_000 });
}

test.beforeAll(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-e2e-iw-"));
  fs.writeFileSync(path.join(tmpDir, "sample.md"), "# sample\n", "utf-8");
});

test.afterAll(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test.beforeEach(async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
});

test("Reopen wizard button is visible in Settings → AI Assistant tab", async ({ page }) => {
  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  // The preview toggle is gone — the button is always visible.
  await expect(page.locator(OPEN_WIZARD_BTN)).toBeVisible();
});

test("Reopen wizard button launches the modal and closes Settings", async ({ page }) => {
  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  await expect(page.locator(OPEN_WIZARD_BTN)).toBeVisible();
  await page.locator(OPEN_WIZARD_BTN).click();

  await expect(page.locator(SETTINGS_MODAL)).toHaveCount(0);
  await expect(page.locator(WIZARD)).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("[data-testid='integration-wizard-step-detect']")).toBeVisible();
});

test("× button closes the wizard", async ({ page }) => {
  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  await page.locator(OPEN_WIZARD_BTN).click();
  await expect(page.locator(WIZARD)).toBeVisible();

  await page.locator(WIZARD_CLOSE).click();
  await expect(page.locator(WIZARD)).toHaveCount(0);
});

test("Escape closes the wizard", async ({ page }) => {
  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  await page.locator(OPEN_WIZARD_BTN).click();
  await expect(page.locator(WIZARD)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(WIZARD)).toHaveCount(0);
});

// Phase 3d coverage: dismiss-then-reopen-fresh. Exercises the same Svelte
// `{#if shouldShowWizard}` mount property that auto-open uses — closing the
// wizard must fully unmount it so a subsequent open starts at step=detect
// with no carry-over state (the SidePanel's pick array, the secret form
// values, etc.). Auto-open E2E is structurally untestable today because
// Playwright's `webServer.env` is process-spawn-time only; this manual-
// reopen variant covers the equivalent mount lifecycle.
test("Reopen → close → reopen lands fresh at step=detect", async ({ page }) => {
  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  await page.locator(OPEN_WIZARD_BTN).click();
  await expect(page.locator(WIZARD)).toBeVisible();
  await expect(page.locator("[data-testid='integration-wizard-step-detect']")).toBeVisible();

  // Close, reopen — must come back to the same fresh step rather than
  // remembering the previous session.
  await page.keyboard.press("Escape");
  await expect(page.locator(WIZARD)).toHaveCount(0);

  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  await page.locator(OPEN_WIZARD_BTN).click();
  await expect(page.locator(WIZARD)).toBeVisible();
  await expect(page.locator("[data-testid='integration-wizard-step-detect']")).toBeVisible();
});

// Phase 2b regression: closing the wizard via the manual-reopen path
// must NOT write `tandem:wizard-dismissed` for the current server version
// — otherwise a later auto-open (server says needed: true) would be
// silently suppressed. Auto-open is suppressed via TANDEM_DISABLE_FIRST
// _RUN_WIZARD=1 in this suite, so `firstRun.needed` is `false` at close
// time; that's exactly the case that should NOT burn the slot.
test("Manual reopen → close does NOT persist wizard dismissal", async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem("tandem:wizard-dismissed"));
  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  await page.locator(OPEN_WIZARD_BTN).click();
  await expect(page.locator(WIZARD)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(WIZARD)).toHaveCount(0);
  const dismissed = await page.evaluate(() => localStorage.getItem("tandem:wizard-dismissed"));
  expect(dismissed).toBeNull();
});

// The pre-3c-ii-b preview toggle has been removed (the wizard now
// auto-opens via server-side first-run detection). Pin its absence so a
// future Settings tab refactor doesn't accidentally resurrect it.
test("settings-modal-show-integration-wizard-toggle no longer exists", async ({ page }) => {
  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  await expect(
    page.locator("[data-testid='settings-modal-show-integration-wizard-toggle']"),
  ).toHaveCount(0);
});
