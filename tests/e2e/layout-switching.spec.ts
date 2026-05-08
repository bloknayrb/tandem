import { expect, test } from "@playwright/test";
import path from "path";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
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
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

// Layout-mode (tabbed/tabbed-left/three-panel) removed in PR #580. See issue #581.
test.skip("layout switching preserves the mounted editor and persisted layout", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });

  const firstEditorHandle = await editor.elementHandle();
  if (!firstEditorHandle) throw new Error("editor handle missing");

  await page.locator("[data-testid='settings-btn']").click();
  await page.locator("[data-testid='layout-tabbed-left-btn']").click();
  await expect(page.locator("[data-testid='left-panel-resize-handle']")).toHaveCount(1);
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await expect(page.locator("[data-testid='right-panel-resize-handle']")).toHaveCount(1);
  await page.keyboard.press("Escape");

  const secondEditorHandle = await editor.elementHandle();
  if (!secondEditorHandle) throw new Error("editor handle missing after layout switch");
  expect(
    await firstEditorHandle.evaluate((node, other) => node === other, secondEditorHandle),
  ).toBe(true);

  const savedLayout = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { layout?: string }).layout : null;
  }, TANDEM_SETTINGS_KEY);
  expect(savedLayout).toBe("three-panel");
});
