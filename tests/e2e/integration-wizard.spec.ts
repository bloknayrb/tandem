import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { cleanupAllOpenDocuments, McpTestClient } from "./helpers";

/**
 * Integration wizard E2E (#477 PR 3c-i).
 *
 * Covers the happy path: open Settings → AI Assistant → toggle "Show
 * integration wizard" → click "Open integration wizard…" → verify the
 * full-screen modal renders → close via the × button and via Escape.
 *
 * Does NOT exercise the secrets step (no real keychain on CI Linux without
 * libsecret; that branch is covered by `useIntegrationWizard.test.ts` with
 * a mocked fetch).
 */

let mcp: McpTestClient;
let tmpDir: string;

const SETTINGS_MODAL = "[data-testid='settings-modal']";
const AI_TAB = "[data-testid='settings-modal-tab-claude-code']";
const WIZARD_TOGGLE = "[data-testid='settings-modal-show-integration-wizard-toggle']";
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

test.beforeEach(async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  // Reset the toggle between tests so each starts from the default-off state.
  await page.evaluate(() => {
    try {
      const k = "tandem:settings";
      const raw = localStorage.getItem(k);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      parsed.showIntegrationWizard = false;
      localStorage.setItem(k, JSON.stringify(parsed));
    } catch {
      /* ignore */
    }
  });
  await page.reload();
});

test("toggle off — Open wizard button is hidden", async ({ page }) => {
  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  await expect(page.locator(WIZARD_TOGGLE)).toBeVisible();
  await expect(page.locator(OPEN_WIZARD_BTN)).toHaveCount(0);
});

test("toggle on — Open wizard button appears and launches the modal", async ({ page }) => {
  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  await page.locator(`${WIZARD_TOGGLE} input`).check();

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
  await page.locator(`${WIZARD_TOGGLE} input`).check();
  await page.locator(OPEN_WIZARD_BTN).click();
  await expect(page.locator(WIZARD)).toBeVisible();

  await page.locator(WIZARD_CLOSE).click();
  await expect(page.locator(WIZARD)).toHaveCount(0);
});

test("Escape closes the wizard", async ({ page }) => {
  await openSettingsModal(page);
  await page.locator(AI_TAB).click();
  await page.locator(`${WIZARD_TOGGLE} input`).check();
  await page.locator(OPEN_WIZARD_BTN).click();
  await expect(page.locator(WIZARD)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(WIZARD)).toHaveCount(0);
});
