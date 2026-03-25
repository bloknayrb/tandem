import { test, expect } from "@playwright/test";
import path from "path";
import { McpTestClient, createFixtureDir, cleanupFixtureDir } from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" in flat text: "# " is the heading prefix (2 chars),
// so "Test Document" spans offsets 2–15.
const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";

/** Open sample.md and optionally add a comment on the title. */
async function openWithComment(dir: string, content?: string): Promise<void> {
  await mcp.callTool("tandem_open", { filePath: path.join(dir, "sample.md") });
  if (content) {
    await mcp.callTool("tandem_comment", {
      from: TITLE_FROM,
      to: TITLE_TO,
      content,
      textSnapshot: TITLE_TEXT,
    });
  }
}

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md", "sample2.md");
});

test.afterEach(async () => {
  try {
    const status = (await mcp.callTool("tandem_status")) as {
      data?: { openDocuments?: Array<{ documentId: string }> };
    };
    const docs = status?.data?.openDocuments ?? [];
    await Promise.all(docs.map((d) => mcp.callTool("tandem_close", { documentId: d.documentId })));
  } catch {
    // Server may have shut down
  }
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("document loads in editor", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText(TITLE_TEXT);
});

test("annotation appears as decoration", async ({ page }) => {
  await openWithComment(tmpDir, "Great title!");

  await page.goto("/");
  const decoration = page.locator("[data-annotation-id]");
  await expect(decoration.first()).toBeVisible({ timeout: 10_000 });
});

test("annotation card appears in side panel", async ({ page }) => {
  await openWithComment(tmpDir, "Nice heading");

  await page.goto("/");
  const card = page.locator("[data-testid^='annotation-card-']");
  await expect(card.first()).toBeVisible({ timeout: 10_000 });
  await expect(card.first()).toContainText("Nice heading");
});

test("accept annotation changes status", async ({ page }) => {
  await openWithComment(tmpDir, "Looks good");

  await page.goto("/");
  const acceptBtn = page.locator("[data-testid='accept-btn']");
  await expect(acceptBtn.first()).toBeVisible({ timeout: 10_000 });
  await acceptBtn.first().click();

  await expect(page.locator("text=accepted")).toBeVisible({ timeout: 5_000 });
});

test("dismiss annotation changes status", async ({ page }) => {
  await openWithComment(tmpDir, "Dismiss me");

  await page.goto("/");
  const dismissBtn = page.locator("[data-testid='dismiss-btn']");
  await expect(dismissBtn.first()).toBeVisible({ timeout: 10_000 });
  await dismissBtn.first().click();

  await expect(page.locator("text=dismissed")).toBeVisible({ timeout: 5_000 });
});

test("suggestion accept applies text change", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_suggest", {
    from: TITLE_FROM,
    to: TITLE_TO,
    newText: "Updated Title",
    reason: "Better title",
    textSnapshot: TITLE_TEXT,
  });

  await page.goto("/");
  const acceptBtn = page.locator("[data-testid='accept-btn']");
  await expect(acceptBtn.first()).toBeVisible({ timeout: 10_000 });
  await acceptBtn.first().click();

  const editor = page.locator(".ProseMirror");
  await expect(editor).toContainText("Updated Title", { timeout: 5_000 });
});

test("tab switching shows different documents", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });

  await page.goto("/");
  const editor = page.locator(".ProseMirror");
  await expect(editor).toContainText("Second Document", { timeout: 10_000 });

  const firstTab = page.locator("[data-testid^='tab-']").first();
  await expect(firstTab).toBeVisible({ timeout: 5_000 });
  await firstTab.click();

  await expect(editor).toContainText(TITLE_TEXT, { timeout: 5_000 });
});

test("review mode navigates with keyboard", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    content: "First comment",
    textSnapshot: TITLE_TEXT,
  });
  await mcp.callTool("tandem_comment", {
    from: 16,
    to: 65,
    content: "Second comment",
  });

  await page.goto("/");
  const cards = page.locator("[data-testid^='annotation-card-']");
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });

  const reviewBtn = page.locator("[data-testid='review-mode-btn']");
  await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
  await reviewBtn.click();

  await expect(page.locator("text=Reviewing 1 /")).toBeVisible({ timeout: 5_000 });

  await page.keyboard.press("y");
  await expect(page.locator("text=accepted")).toBeVisible({ timeout: 5_000 });
});
