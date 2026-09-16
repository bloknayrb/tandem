import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openAnnotatePopup,
  selectTextStable,
  submitAnnotation,
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
  await selectTextStable(editor.locator("p").first());
  await openAnnotatePopup(page);
  await page.locator("[data-testid='popup-annotation-input']").fill("private note");
  await submitAnnotation(page, "note");

  const annNode = page.locator("[data-annotation-id]").first();
  await expect(annNode).toBeVisible({ timeout: 10_000 });
  const noteId = await annNode.getAttribute("data-annotation-id");
  expect(noteId, "selection popup must yield an annotation id").toBeTruthy();

  // Switch to annotations tab and find the note card.
  await switchToAnnotationsTab(page);
  const noteCard = page.locator(`[data-testid='annotation-card-${noteId}']`);
  await expect(noteCard).toBeVisible({ timeout: 5_000 });

  // Post a reply via the browser UI — note replies are user-authored and private
  // from Claude (#1000 / ADR-027). tandem_annotationReply (MCP) rejects
  // Claude-authored note replies server-side, so the browser reply button is the
  // correct data path here.
  const replyBtn = page.locator(`[data-testid='reply-btn-${noteId}']`);
  await expect(replyBtn).toBeVisible({ timeout: 3_000 });
  await replyBtn.click();

  await page.locator(`[data-testid='reply-input-${noteId}']`).fill("private reply text");
  await page.locator(`[data-testid='reply-send-btn-${noteId}']`).click();

  // Notes use the same A13 collapse-by-default disclosure as comments (#1000).
  // The ADR-027 boundary is enforced server-side (channel observer), not here.
  const toggle = page.locator(`[data-testid='reply-toggle-${noteId}']`);
  await expect(toggle).toBeVisible({ timeout: 5_000 });
  await expect(toggle).toContainText("1 reply");
  // Thread collapsed by default — not visible until toggle is clicked.
  const thread = page.locator("[data-testid='comment-thread']");
  await expect(thread).not.toBeVisible();
  // Reply button says plain "Reply" — count lives on the toggle.
  await expect(replyBtn).toContainText("Reply");
  // Open the disclosure and confirm the reply text is visible.
  await toggle.click();
  await expect(thread).toBeVisible();
  await expect(thread).toContainText("private reply text");
});

test("#1626: a reply's suggestion renders and Accept writes it into the document", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  const created = (await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Initial comment",
    textSnapshot: TITLE_TEXT,
    suggestedText: "First Proposal",
  })) as { error: false; data: { annotationId: string } } | { error: true };
  if (created.error !== false) throw new Error("tandem_comment failed");
  const commentId = created.data.annotationId;

  const replied = (await mcp.callTool("tandem_annotationReply", {
    annotationId: commentId,
    text: "On reflection, this reads better",
    suggestedText: "Refined Proposal",
  })) as { error: false; data: { replyId: string } } | { error: true };
  if (replied.error !== false) throw new Error("tandem_annotationReply failed");
  const replyId = replied.data.replyId;

  await page.goto("/");
  await switchToAnnotationsTab(page);
  const card = page.locator(`[data-testid='annotation-card-${commentId}']`);
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Waits on the RENDERED card, never on a channel event: `narrowReplyForChannel`
  // refuses `author !== "user"`, so a Claude-authored reply never projects.
  const box = page.locator(`[data-testid='reply-suggestion-${replyId}']`);
  if (!(await box.isVisible())) {
    await page.locator(`[data-testid='reply-toggle-${commentId}']`).click();
  }
  await expect(box).toBeVisible({ timeout: 5_000 });
  await expect(box).toContainText("Refined Proposal");

  await page.locator(`[data-testid='accept-reply-btn-${replyId}']`).click();

  // The reply's text lands in the document — not the parent's first proposal —
  // and the parent leaves the pending list.
  await expect(page.locator(".tiptap")).toContainText("Refined Proposal", { timeout: 5_000 });
  await expect(page.locator(".tiptap")).not.toContainText("First Proposal");
});
