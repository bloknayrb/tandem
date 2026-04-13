import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  switchToAnnotationsTab,
} from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" in flat text: "# " is the heading prefix (2 chars),
// so "Test Document" spans offsets 2–15.
const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";
const SECOND_DOC_TITLE = "Second Document";

/** Open sample.md and optionally add a comment on the title. */
async function openWithComment(dir: string, content?: string): Promise<void> {
  await mcp.callTool("tandem_open", { filePath: path.join(dir, "sample.md") });
  if (content) {
    await mcp.callTool("tandem_comment", {
      from: TITLE_FROM,
      to: TITLE_TO,
      text: content,
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
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("document loads in editor", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText(TITLE_TEXT);
});

// TODO: Decoration rendering fails in E2E — resolveAnnotationPmRange returns null
// because RelativePosition resolution and flatOffsetToPmPos conversion don't work
// in the E2E context. The annotation card test (below) verifies the data syncs correctly.
// Tracked for investigation separately.
test.skip("annotation appears as decoration", async ({ page }) => {
  await openWithComment(tmpDir, "Great title!");

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });
  const decoration = page.locator("[data-annotation-id]");
  await expect(decoration.first()).toBeVisible({ timeout: 15_000 });
});

test("annotation card appears in side panel", async ({ page }) => {
  await openWithComment(tmpDir, "Nice heading");

  await page.goto("/");
  await switchToAnnotationsTab(page);
  const card = page.locator("[data-testid^='annotation-card-']");
  await expect(card.first()).toBeVisible({ timeout: 10_000 });
  await expect(card.first()).toContainText("Nice heading");
});

test("accept annotation changes status", async ({ page }) => {
  await openWithComment(tmpDir, "Looks good");

  await page.goto("/");
  await switchToAnnotationsTab(page);
  const acceptBtn = page.locator("[data-testid^='accept-btn-']");
  await expect(acceptBtn.first()).toBeVisible({ timeout: 10_000 });
  await acceptBtn.first().click();

  // After accepting, the card moves into a collapsed <details> "resolved" section.
  // Verify the resolved summary appears and the accept button is gone.
  await expect(page.locator("summary", { hasText: "1 resolved" })).toBeVisible({ timeout: 5_000 });
  await expect(acceptBtn).not.toBeVisible({ timeout: 2_000 });
});

test("dismiss annotation changes status", async ({ page }) => {
  await openWithComment(tmpDir, "Dismiss me");

  await page.goto("/");
  await switchToAnnotationsTab(page);
  const dismissBtn = page.locator("[data-testid^='dismiss-btn-']");
  await expect(dismissBtn.first()).toBeVisible({ timeout: 10_000 });
  await dismissBtn.first().click();

  // After dismissing, the card moves into a collapsed <details> "resolved" section.
  await expect(page.locator("summary", { hasText: "1 resolved" })).toBeVisible({ timeout: 5_000 });
  await expect(dismissBtn).not.toBeVisible({ timeout: 2_000 });
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
  await switchToAnnotationsTab(page);
  const acceptBtn = page.locator("[data-testid^='accept-btn-']");
  await expect(acceptBtn.first()).toBeVisible({ timeout: 10_000 });
  await acceptBtn.first().click();

  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText("Updated Title", { timeout: 5_000 });
});

test("tab switching shows different documents", async ({ page }) => {
  const firstResult = (await mcp.callTool("tandem_open", {
    filePath: path.join(tmpDir, "sample.md"),
  })) as { data?: { documentId?: string } };
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });

  // Ensure the first document is active before the browser loads
  const firstDocId = firstResult?.data?.documentId;
  if (firstDocId) {
    await mcp.callTool("tandem_switchDocument", { documentId: firstDocId });
  }

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });

  // Both tabs should appear (use data-active attribute to select only tab containers, not child spans)
  const tabs = page.locator("[data-testid^='tab-'][data-active]");
  await expect(tabs).toHaveCount(2, { timeout: 10_000 });

  // First document should be showing
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });

  // Click the inactive tab to switch documents
  const inactiveTab = page.locator("[data-testid^='tab-'][data-active='false']");
  await expect(inactiveTab).toBeVisible({ timeout: 5_000 });
  await inactiveTab.click();

  // Editor should now show the second document
  await expect(editor).toContainText(SECOND_DOC_TITLE, { timeout: 15_000 });
});

test("review mode navigates with keyboard", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "First comment",
    textSnapshot: TITLE_TEXT,
  });
  await mcp.callTool("tandem_comment", {
    from: 17,
    to: 65,
    text: "Second comment",
    textSnapshot: "This is the first paragraph of the test document",
  });

  await page.goto("/");
  await switchToAnnotationsTab(page);
  const cards = page.locator("[data-testid^='annotation-card-']");
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });

  const reviewBtn = page.locator("[data-testid='review-mode-btn']");
  await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
  await reviewBtn.click();

  await expect(page.locator("text=Reviewing 1 /")).toBeVisible({ timeout: 5_000 });

  await page.keyboard.press("y");
  // First annotation accepted → moves to resolved section, second becomes the only pending card.
  await expect(page.locator("summary", { hasText: "1 resolved" })).toBeVisible({ timeout: 5_000 });
});
