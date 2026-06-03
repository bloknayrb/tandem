import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openAnnotatePopup,
  switchToAnnotationsTab,
} from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

// sample.md: "# Test Document\n..." — "Test Document" at flat offsets 2–15
const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";

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

test("A13: reply toggle collapses thread by default; click reveals replies", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  const created = (await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Initial comment",
    textSnapshot: TITLE_TEXT,
  })) as { error: false; data: { annotationId: string } } | { error: true };
  if (created.error !== false) throw new Error("tandem_comment failed");
  const commentId = created.data.annotationId;

  await mcp.callTool("tandem_annotationReply", {
    annotationId: commentId,
    text: "A user reply",
  });

  await page.goto("/");
  await switchToAnnotationsTab(page);
  const card = page.locator(`[data-testid='annotation-card-${commentId}']`);
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Toggle is present and shows reply count; thread is initially hidden.
  const toggle = page.locator(`[data-testid='reply-toggle-${commentId}']`);
  await expect(toggle).toBeVisible({ timeout: 5_000 });
  await expect(toggle).toContainText("1 reply");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-testid='comment-thread']")).not.toBeVisible();

  // Click → thread reveals with reply content.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const thread = page.locator("[data-testid='comment-thread']");
  await expect(thread).toBeVisible({ timeout: 3_000 });
  await expect(thread).toContainText("A user reply");

  // Click again → thread collapses.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(thread).not.toBeVisible();
});

test("A13 + #1000: note cards surface reply-toggle (private from Claude, shown to user)", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });

  // Create a note via the selection popup (the only way — no tandem_note MCP tool).
  await editor.locator("p").first().selectText();
  await openAnnotatePopup(page);
  await page.locator("[data-testid='popup-annotation-input']").fill("private note");
  await page.locator("[data-testid='popup-note-submit']").click();

  const annNode = page.locator("[data-annotation-id]").first();
  await expect(annNode).toBeVisible({ timeout: 10_000 });
  const noteId = await annNode.getAttribute("data-annotation-id");
  expect(noteId, "selection popup must yield an annotation id").toBeTruthy();

  // Post a reply against the note — server returns INVALID_ARGUMENT (notes
  // don't support replies); callTool returns the error object without throwing
  // since mcpError encodes errors in the JSON body, not isError. The client
  // must still suppress display via getVisibleReplies.
  await mcp.callTool("tandem_annotationReply", {
    annotationId: noteId as string,
    text: "this reply must never surface",
  });

  await switchToAnnotationsTab(page);

  // The reply-toggle must never render for a note (ADR-027).
  await expect(page.locator(`[data-testid='reply-toggle-${noteId}']`)).not.toBeVisible();
  // And the reply text must not appear anywhere in the side panel.
  await expect(page.locator("[data-testid='comment-thread']")).not.toBeVisible();
});
