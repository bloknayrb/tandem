import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  cssAlpha,
  McpTestClient,
  openAnnotatePopup,
  selectTextStable,
  submitAnnotation,
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

/**
 * The author-tint model, pinned where it actually renders.
 *
 * Two rules ship here and neither is visible to a unit test, because both are
 * composited: the card background is an inline `var(--tandem-author-*-bg)` that
 * only resolves against a real stylesheet, and the hollow note dot is a
 * `:global([data-annotation-type="note"] .ach-dot)` rule in a PARENT component
 * styling a CHILD component's element. Delete either and every vitest suite
 * stays green.
 *
 * WHY THE DOT IS LOAD-BEARING. It is the only privacy signal left in the
 * header. Notes and comments authored by the same person now share a tint by
 * design — that is the point of tinting by author — so the tint cannot
 * distinguish them, and the type icon is hidden entirely at stub density. The
 * hollow dot is what remains, and it was chosen because swapping `background`
 * for a `border` on an element that already exists costs zero width and so
 * cannot disturb the stub-density budget.
 *
 * Asserting the two cards DIFFER rather than pinning literal colours: the
 * tokens are free to be retuned (token-contrast.spec.ts owns their contrast),
 * but a user card and a Claude card collapsing to the same ground is the
 * regression, and it is invisible in a screenshot diff of either card alone.
 */
test("cards are tinted by author, and a note's dot is hollow", async ({ page }) => {
  await openWithComment(tmpDir, "Claude-authored comment");
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", { timeout: 10_000 });

  // A note can only be made through the UI — notes are user-only by ADR-027,
  // so no MCP tool can create one.
  await editor.click();
  await selectTextStable(editor.locator("p").first());
  await openAnnotatePopup(page);
  await page.locator("[data-testid='popup-annotation-input']").fill("User-authored note");
  await submitAnnotation(page, "note");

  await switchToAnnotationsTab(page);
  const cards = page.locator("[data-testid^='annotation-card-']");
  await expect(cards).toHaveCount(2, { timeout: 10_000 });

  const read = async (type: "note" | "comment") => {
    const card = page.locator(`[data-testid^='annotation-card-'][data-annotation-type="${type}"]`);
    await expect(card).toHaveCount(1);
    return card.evaluate((el) => {
      const dot = el.querySelector("[data-testid^='annotation-author-dot-']");
      if (!dot) throw new Error("card has no author dot");
      const dotStyle = getComputedStyle(dot);
      return {
        cardBg: getComputedStyle(el).backgroundColor,
        dotBg: dotStyle.backgroundColor,
        dotBorder: parseFloat(dotStyle.borderTopWidth),
      };
    });
  };

  const note = await read("note");
  const comment = await read("comment");

  expect(
    note.cardBg,
    "a user note and a Claude comment must not share a background — author IS the tint axis",
  ).not.toBe(comment.cardBg);

  // `transparent` computes to rgba(0, 0, 0, 0); read the alpha rather than
  // matching a string, since the serialization is not guaranteed.
  expect(cssAlpha(note.dotBg), `the note dot must have no fill; got ${note.dotBg}`).toBe(0);
  expect(note.dotBorder, "a hollow dot with no border is an invisible dot").toBeGreaterThan(0);
  expect(cssAlpha(comment.dotBg), `a comment dot must stay filled; got ${comment.dotBg}`).toBe(1);
});

test("document loads in editor", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText(TITLE_TEXT);
});

test("annotation appears as decoration", async ({ page }) => {
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
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Better title",
    suggestedText: "Updated Title",
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

test("claude annotation shows Accept/Reject but not Remove", async ({ page }) => {
  await openWithComment(tmpDir, "Review this");

  await page.goto("/");
  await switchToAnnotationsTab(page);
  const acceptBtn = page.locator("[data-testid^='accept-btn-']");
  await expect(acceptBtn.first()).toBeVisible({ timeout: 10_000 });

  const dismissBtn = page.locator("[data-testid^='dismiss-btn-']");
  await expect(dismissBtn.first()).toBeVisible({ timeout: 2_000 });

  // Claude annotations must not show a Remove button
  const removeBtn = page.locator("[data-testid^='remove-btn-']");
  await expect(removeBtn).not.toBeVisible({ timeout: 2_000 });
});
