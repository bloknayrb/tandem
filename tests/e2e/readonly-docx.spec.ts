import { expect, test } from "@playwright/test";
import path from "path";
import { cleanupAllOpenDocuments, cleanupFixtureDir, createFixtureDir, McpTestClient } from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("single-paragraph.docx");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("docx documents show review-only UI", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "single-paragraph.docx") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-testid='review-only-banner']")).toBeVisible();
  await expect(page.locator("[data-active='true']")).toContainText("RO");
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
});
