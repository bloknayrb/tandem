import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

const SETTINGS_MODAL = "[data-testid='settings-modal']";
const SHORTCUTS_TAB = "[data-testid='settings-modal-tab-shortcuts']";
const EDIT_BTN = "[data-testid='shortcut-edit-new-scratchpad']";
const RESET_BTN = "[data-testid='shortcut-reset-new-scratchpad']";
const RECORDING = "[data-testid='shortcut-recording-new-scratchpad']";
const CONFLICT = "[data-testid='shortcut-conflict-new-scratchpad']";
const ROW = "[data-testid='shortcut-row-new-scratchpad']";

async function openShortcutsTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tandemTest?: { openSettingsModal: () => void } };
    if (!w.__tandemTest?.openSettingsModal) {
      throw new Error("__tandemTest.openSettingsModal is not installed");
    }
    w.__tandemTest.openSettingsModal();
  });
  await expect(page.locator(SETTINGS_MODAL)).toBeVisible({ timeout: 5_000 });
  await page.locator(SHORTCUTS_TAB).click();
  await expect(page.locator(ROW)).toBeVisible();
}

function comboKbd(page: Page) {
  return page.locator(`${ROW} kbd`);
}

test.beforeEach(async ({ page }) => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  // Start from a clean slate so prior runs' overrides don't leak in.
  await page.evaluate(() => {
    try {
      const raw = localStorage.getItem("tandem:settings");
      const parsed = raw ? JSON.parse(raw) : {};
      parsed.customShortcuts = {};
      localStorage.setItem("tandem:settings", JSON.stringify(parsed));
    } catch {
      /* ignore */
    }
  });
  await page.reload();
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("records a new combo for New Scratchpad and reflects it", async ({ page }) => {
  await openShortcutsTab(page);
  await expect(comboKbd(page)).toHaveText("Ctrl+N");

  await page.locator(EDIT_BTN).click();
  await expect(page.locator(RECORDING)).toBeVisible();

  await page.keyboard.press("Control+j");

  // Recording ends; the row reflects the new combo and a reset control appears.
  await expect(page.locator(RECORDING)).toHaveCount(0);
  await expect(comboKbd(page)).toHaveText("Ctrl+J");
  await expect(page.locator(RESET_BTN)).toBeVisible();
});

test("blocks a conflicting combo and names the owner", async ({ page }) => {
  await openShortcutsTab(page);
  await page.locator(EDIT_BTN).click();
  await expect(page.locator(RECORDING)).toBeVisible();

  // Ctrl+S is owned by Save document (a reserved-style remappable default).
  await page.keyboard.press("Control+s");

  await expect(page.locator(CONFLICT)).toBeVisible();
  await expect(page.locator(CONFLICT)).toContainText("Save document");
  // Still recording — combo was not applied (the kbd is hidden mid-recording,
  // so liveness is asserted via the recording label staying visible).
  await expect(page.locator(RECORDING)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(RECORDING)).toHaveCount(0);
  // Default is unchanged and no reset control appeared.
  await expect(comboKbd(page)).toHaveText("Ctrl+N");
  await expect(page.locator(RESET_BTN)).toHaveCount(0);
});

test("reset restores the default combo", async ({ page }) => {
  await openShortcutsTab(page);
  await page.locator(EDIT_BTN).click();
  await page.keyboard.press("Control+j");
  await expect(comboKbd(page)).toHaveText("Ctrl+J");

  await page.locator(RESET_BTN).click();
  await expect(comboKbd(page)).toHaveText("Ctrl+N");
  await expect(page.locator(RESET_BTN)).toHaveCount(0);
});

test("a remapped combo persists across reload", async ({ page }) => {
  await openShortcutsTab(page);
  await page.locator(EDIT_BTN).click();
  await page.keyboard.press("Control+j");
  await expect(comboKbd(page)).toHaveText("Ctrl+J");

  await page.reload();
  await openShortcutsTab(page);
  await expect(comboKbd(page)).toHaveText("Ctrl+J");
});
