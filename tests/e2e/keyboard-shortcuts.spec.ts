import { expect, test } from "@playwright/test";
import path from "path";
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
  await page.goto("http://localhost:5173");

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
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Dialog absent before the shortcut
  await expect(page.locator("[data-testid='file-open-dialog']")).toHaveCount(0);

  await page.keyboard.press("Control+o");
  await expect(page.locator("[data-testid='file-open-dialog']")).toBeVisible();
});

test("Ctrl+N switches to the Nth tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "link-target.md") });
  await page.goto("http://localhost:5173");

  // Wait for all three tabs.
  await expect(page.locator("[data-testid^='tab-name-']")).toHaveCount(3);

  // Tabs are role="tab" with aria-selected.
  const tabs = page.locator("[role='tab']");

  // Press Ctrl+1 — first tab becomes active.
  await page.keyboard.press("Control+1");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

  // Press Ctrl+2 — second tab.
  await page.keyboard.press("Control+2");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

  // Press Ctrl+9 — clamps to last (3rd) tab.
  await page.keyboard.press("Control+9");
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
});

test("Ctrl+W is ignored while a form input has focus", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
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
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Open via the title-bar help button — the "?" keyboard shortcut is intentionally
  // suppressed while focus is inside the contenteditable editor.
  await page.locator("[data-testid='titlebar-help-btn']").click();
  const modal = page.locator("[data-testid='help-modal']");
  await expect(modal).toBeVisible();

  await expect(modal.getByText("Close active tab")).toBeVisible();
  await expect(modal.getByText("Open file…")).toBeVisible();
  await expect(modal.getByText("Jump to tab by number")).toBeVisible();
});
