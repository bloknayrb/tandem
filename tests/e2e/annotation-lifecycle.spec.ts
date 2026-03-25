import { test, expect } from "@playwright/test";
import path from "path";
import { McpTestClient, createFixtureDir, cleanupFixtureDir } from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md", "sample2.md");
});

test.afterEach(async () => {
  // Close all open docs via MCP
  try {
    const status = (await mcp.callTool("tandem_status")) as any;
    if (status?.data?.openDocuments) {
      for (const doc of status.data.openDocuments) {
        await mcp.callTool("tandem_close", { documentId: doc.documentId });
      }
    }
  } catch {
    // Server may have shut down already
  }
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("document loads in editor", async ({ page }) => {
  const filePath = path.join(tmpDir, "sample.md");
  await mcp.callTool("tandem_open", { filePath });

  await page.goto("/");
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText("Test Document");
});

test("annotation appears as decoration", async ({ page }) => {
  const filePath = path.join(tmpDir, "sample.md");
  await mcp.callTool("tandem_open", { filePath });
  await mcp.callTool("tandem_comment", {
    from: 0,
    to: 13,
    content: "Great title!",
    textSnapshot: "Test Document",
  });

  await page.goto("/");
  const decoration = page.locator("[data-annotation-id]");
  await expect(decoration.first()).toBeVisible({ timeout: 10_000 });
});

test("annotation card appears in side panel", async ({ page }) => {
  const filePath = path.join(tmpDir, "sample.md");
  await mcp.callTool("tandem_open", { filePath });
  await mcp.callTool("tandem_comment", {
    from: 0,
    to: 13,
    content: "Nice heading",
    textSnapshot: "Test Document",
  });

  await page.goto("/");
  // Wait for annotation card text in side panel
  const card = page.locator("[data-testid^='annotation-card-']");
  await expect(card.first()).toBeVisible({ timeout: 10_000 });
  await expect(card.first()).toContainText("Nice heading");
});

test("accept annotation changes status", async ({ page }) => {
  const filePath = path.join(tmpDir, "sample.md");
  await mcp.callTool("tandem_open", { filePath });
  await mcp.callTool("tandem_comment", {
    from: 0,
    to: 13,
    content: "Looks good",
    textSnapshot: "Test Document",
  });

  await page.goto("/");
  const acceptBtn = page.locator("[data-testid='accept-btn']");
  await expect(acceptBtn.first()).toBeVisible({ timeout: 10_000 });
  await acceptBtn.first().click();

  // Status badge should show "accepted"
  await expect(page.locator("text=accepted")).toBeVisible({ timeout: 5_000 });
});

test("dismiss annotation changes status", async ({ page }) => {
  const filePath = path.join(tmpDir, "sample.md");
  await mcp.callTool("tandem_open", { filePath });
  await mcp.callTool("tandem_comment", {
    from: 0,
    to: 13,
    content: "Dismiss me",
    textSnapshot: "Test Document",
  });

  await page.goto("/");
  const dismissBtn = page.locator("[data-testid='dismiss-btn']");
  await expect(dismissBtn.first()).toBeVisible({ timeout: 10_000 });
  await dismissBtn.first().click();

  await expect(page.locator("text=dismissed")).toBeVisible({ timeout: 5_000 });
});

test("suggestion accept applies text change", async ({ page }) => {
  const filePath = path.join(tmpDir, "sample.md");
  await mcp.callTool("tandem_open", { filePath });
  await mcp.callTool("tandem_suggest", {
    from: 0,
    to: 13,
    newText: "Updated Title",
    reason: "Better title",
    textSnapshot: "Test Document",
  });

  await page.goto("/");
  const acceptBtn = page.locator("[data-testid='accept-btn']");
  await expect(acceptBtn.first()).toBeVisible({ timeout: 10_000 });
  await acceptBtn.first().click();

  // Document should now contain the new text
  const editor = page.locator(".ProseMirror");
  await expect(editor).toContainText("Updated Title", { timeout: 5_000 });
});

test("tab switching shows different documents", async ({ page }) => {
  const filePath1 = path.join(tmpDir, "sample.md");
  const filePath2 = path.join(tmpDir, "sample2.md");
  await mcp.callTool("tandem_open", { filePath: filePath1 });
  await mcp.callTool("tandem_open", { filePath: filePath2 });

  await page.goto("/");
  const editor = page.locator(".ProseMirror");
  // Should show second doc (last opened = active)
  await expect(editor).toContainText("Second Document", { timeout: 10_000 });

  // Click the first tab
  const firstTab = page.locator("[data-testid^='tab-']").first();
  await expect(firstTab).toBeVisible({ timeout: 5_000 });
  await firstTab.click();

  // Editor should now show first doc content
  await expect(editor).toContainText("Test Document", { timeout: 5_000 });
});

test("review mode navigates with keyboard", async ({ page }) => {
  const filePath = path.join(tmpDir, "sample.md");
  await mcp.callTool("tandem_open", { filePath });
  // Create two annotations
  await mcp.callTool("tandem_comment", {
    from: 0,
    to: 13,
    content: "First comment",
    textSnapshot: "Test Document",
  });
  await mcp.callTool("tandem_comment", {
    from: 16,
    to: 40,
    content: "Second comment",
  });

  await page.goto("/");
  // Wait for annotations to sync
  const cards = page.locator("[data-testid^='annotation-card-']");
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });

  // Enter review mode via button
  const reviewBtn = page.locator("[data-testid='review-mode-btn']");
  await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
  await reviewBtn.click();

  // Should show review indicator
  await expect(page.locator("text=Reviewing 1 /")).toBeVisible({ timeout: 5_000 });

  // Press Y to accept first annotation
  await page.keyboard.press("y");
  await expect(page.locator("text=accepted")).toBeVisible({ timeout: 5_000 });
});
