import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

// Default save folder (#1023) — Settings → Editor.
//
// The native Save-As dialog can't be driven from Playwright, so this spec
// covers the SETTINGS round-trip: typing a folder into the Editor tab persists
// to `tandem:settings` (localStorage) and survives a reload; Reset clears it.
// The dialog-default precedence itself is unit-tested via `pickSaveAsDirectory`.

const SETTINGS_KEY = "tandem:settings";
const MODAL = "[data-testid='settings-modal']";
const INPUT = "[data-testid='settings-default-save-folder-input']";
const RESET = "[data-testid='settings-default-save-folder-reset']";

let mcp: McpTestClient;
let tmpDir: string;

async function openEditorTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tandemTest?: { openSettingsModal: () => void } };
    if (!w.__tandemTest?.openSettingsModal) {
      throw new Error("__tandemTest.openSettingsModal is not installed");
    }
    w.__tandemTest.openSettingsModal();
  });
  await expect(page.locator(MODAL)).toBeVisible({ timeout: 5_000 });
  await page.locator("[data-testid='settings-modal-tab-editor']").click();
  await expect(page.locator(INPUT)).toBeVisible();
}

function readSavedDir(page: Page): Promise<string | null | undefined> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return (JSON.parse(raw) as { defaultSaveDirectory?: string | null }).defaultSaveDirectory;
  }, SETTINGS_KEY);
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

test("persists a typed folder to settings and survives reload", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openEditorTab(page);

  // Type a path and commit on blur.
  await page.locator(INPUT).fill("/tmp/tandem-saves");
  await page.locator(INPUT).blur();

  await expect.poll(() => readSavedDir(page)).toBe("/tmp/tandem-saves");

  // Reload — the value rehydrates into the input.
  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await openEditorTab(page);
  await expect(page.locator(INPUT)).toHaveValue("/tmp/tandem-saves");
});

test("trims whitespace and Reset clears the folder back to null", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openEditorTab(page);

  // Surrounding whitespace is normalized away on commit.
  await page.locator(INPUT).fill("  /srv/notes  ");
  await page.locator(INPUT).blur();
  await expect.poll(() => readSavedDir(page)).toBe("/srv/notes");

  // Reset coerces the stored value back to null.
  await page.locator(RESET).click();
  await expect.poll(() => readSavedDir(page)).toBeNull();
  await expect(page.locator(INPUT)).toHaveValue("");
});
