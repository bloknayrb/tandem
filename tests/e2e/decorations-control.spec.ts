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

// "# Test Document" — "# " is the 2-char heading prefix, so "Test Document"
// spans flat offsets 2–15.
const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";

/** Open sample.md with a Claude comment on the title. */
async function openWithComment(dir: string): Promise<void> {
  await mcp.callTool("tandem_open", { filePath: path.join(dir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Review this title",
    textSnapshot: TITLE_TEXT,
  });
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

test("mute hides all decorations, restore brings them back", async ({ page }) => {
  await openWithComment(tmpDir);

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });

  // Scope to the EDITOR decoration — since #999 the rail/margin AnnotationCard
  // roots also carry `data-annotation-id`, and mute only suppresses the editor
  // decorations (the rail card stays), so an unscoped count would never reach 0.
  const decoration = editor.locator("[data-annotation-id]");
  await expect(decoration.first()).toBeVisible({ timeout: 15_000 });

  // Eye half mutes → decoration is suppressed.
  await page.getByTestId("decorations-mute-toggle").click();
  await expect(decoration).toHaveCount(0, { timeout: 5_000 });

  // Eye half again restores exactly the prior set.
  await page.getByTestId("decorations-mute-toggle").click();
  await expect(decoration.first()).toBeVisible({ timeout: 5_000 });
});

test("per-type row hides only that type; the side-panel card stays", async ({ page }) => {
  await openWithComment(tmpDir);

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });

  // Scope to the editor: the side-panel annotation card ALSO carries
  // data-annotation-type="comment", so an unscoped locator would match it too.
  const commentDecoration = page.locator(".tandem-editor [data-annotation-type='comment']");
  await expect(commentDecoration.first()).toBeVisible({ timeout: 15_000 });

  // Open the dropdown and turn Comments off.
  await page.getByTestId("decorations-menu-caret").click();
  await page.getByTestId("decorations-row-comments").click();

  // The inline comment mark is gone…
  await expect(commentDecoration).toHaveCount(0, { timeout: 5_000 });

  // Close the dropdown (it overlays the right-rail tab) before switching tabs.
  await page.getByTestId("decorations-menu-caret").click();

  // …but the annotation card in the side panel is unaffected (display-only).
  await switchToAnnotationsTab(page);
  const card = page.locator("[data-testid^='annotation-card-']");
  await expect(card.first()).toBeVisible({ timeout: 10_000 });
});
