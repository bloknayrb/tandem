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
  // Copy both fixture files into the same temp directory so the relative link resolves
  tmpDir = createFixtureDir("link-source.md", "link-target.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("clicking a relative .md link opens the target file as a new tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "link-source.md") });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText("Link Source");

  // The link text "Open the target document" is rendered as an anchor in the editor
  const link = editor.locator("a", { hasText: "Open the target document" });
  await expect(link).toBeVisible({ timeout: 5_000 });

  // Click the link — it should open link-target.md as a new tab without navigating away
  await link.click();

  // Wait for the new tab to appear in the tab bar
  const targetTabName = page.locator("[data-testid^='tab-name-']", {
    hasText: "link-target.md",
  });
  await expect(targetTabName).toBeVisible({ timeout: 10_000 });

  // The source tab should still be present
  const sourceTabName = page.locator("[data-testid^='tab-name-']", {
    hasText: "link-source.md",
  });
  await expect(sourceTabName).toBeVisible();
});
