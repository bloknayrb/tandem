import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { cleanupAllOpenDocuments, McpTestClient } from "./helpers";

/**
 * Integration wizard E2E (#477 PR 3c-i + 3c-ii-b).
 *
 * Post-3c-ii-b: the wizard auto-opens via server-side first-run detection
 * (`GET /api/integrations/first-run-needed`) instead of behind a Settings
 * toggle. Settings exposes a "Reopen wizard" button for manual reopen.
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
const WIZARD_DISMISSED_KEY = "tandem:wizard-dismissed";

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
  // The wizard doesn't read any fixture content; we just need a document
  // open so the editor mounts.
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

test.beforeEach(async ({ page }, testInfo) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  // Mark the wizard dismissed so the auto-open path (which depends on
  // server-side first-run detection) doesn't fire for tests that target
  // the manual-reopen affordance. Tests that need auto-open clear this
  // explicitly via a `auto-open` annotation on their title.
  if (!testInfo.title.includes("auto-open")) {
    await page.evaluate((key) => {
      try {
        localStorage.setItem(key, "dismissed");
      } catch {
        /* ignore */
      }
    }, WIZARD_DISMISSED_KEY);
  } else {
    await page.evaluate((key) => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }, WIZARD_DISMISSED_KEY);
  }
  await page.reload();
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

  // SettingsModal closes; wizard appears.
  await expect(page.locator(SETTINGS_MODAL)).toHaveCount(0);
  await expect(page.locator(WIZARD)).toBeVisible({ timeout: 5_000 });
  // The wizard begins in the detect step.
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
