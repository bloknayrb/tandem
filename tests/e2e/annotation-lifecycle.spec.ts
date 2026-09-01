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
 * The author-tint model, pinned AT ITS CALL SITE.
 *
 * Read the two assertions below together — either one alone is worthless here,
 * and the first revision of this test learned that the expensive way.
 *
 * THE TRAP. That revision compared a user NOTE against a Claude COMMENT and
 * asserted the backgrounds differ. Those two cards differ on BOTH axes, so the
 * assertion passes under the model this change replaced as well: the old
 * six-branch derivation tinted a note `--tandem-warning-bg` and a Claude
 * comment `--tandem-author-claude-bg`, which are also not equal. Reverting
 * `AnnotationCard.svelte` to the old model left the whole suite green,
 * `getCardTint` included — the unit test proves the MAP, and nothing proved the
 * map is the TINT.
 *
 * So the pin needs a pair that isolates each axis:
 *   - user note vs user comment must be the SAME  -> type is not the axis
 *   - user comment vs claude comment must DIFFER  -> author is the axis
 * The first is the one that actually kills the revert; "differ" can never
 * distinguish the two models on its own.
 *
 * The dot assertions need the same care. Note-hollow / comment-filled is only
 * meaningful between cards by the SAME author — against a Claude comment, a
 * rule that hollowed every user-authored dot would pass too.
 *
 * WHY `cssAlpha(...) === 1` ON EACH BACKGROUND. `not.toBe` also passes when one
 * side is broken: typo a token and `var()` falls back to the initial value, so
 * the card computes `rgba(0, 0, 0, 0)` — different from the other card, and
 * untinted. Asserting each ground is actually opaque is what separates "these
 * two tints differ" from "one of them failed to resolve".
 *
 * Colours are compared to each other rather than pinned literally: the tokens
 * are free to be retuned (`token-contrast.spec.ts` owns their contrast), while
 * two authors collapsing onto one ground is the regression — and that is
 * invisible in a screenshot diff of either card alone.
 *
 * None of this is reachable from a unit test: the tint is an inline
 * `var(--tandem-author-*-bg)` that needs a real stylesheet, and the hollow dot
 * is a `:global(...)` rule in a PARENT component styling a CHILD's element.
 */
test("tint follows author and not type, and a note's dot is hollow", async ({ page }) => {
  await openWithComment(tmpDir, "Claude-authored comment");
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", { timeout: 10_000 });

  // Both user-authored annotations come through the UI. A note cannot come from
  // MCP at all (user-only, ADR-027), and routing the user comment the same way
  // keeps the two cards differing ONLY in type, which is the whole point.
  const seed = async (text: string, audience: "note" | "comment") => {
    await editor.click();
    await selectTextStable(editor.locator("p").first());
    await openAnnotatePopup(page);
    await page.locator("[data-testid='popup-annotation-input']").fill(text);
    await submitAnnotation(page, audience);
  };
  await seed("User-authored note", "note");
  await seed("User-authored comment", "comment");

  await switchToAnnotationsTab(page);
  const cards = page.locator("[data-testid^='annotation-card-']");
  await expect(cards).toHaveCount(3, { timeout: 10_000 });

  // Keyed on the rendered content, not on `data-annotation-type` — two of the
  // three cards are comments, so a type selector is ambiguous for exactly the
  // pair this test exists to compare.
  const read = async (text: string) => {
    const card = cards.filter({ hasText: text });
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

  const userNote = await read("User-authored note");
  const userComment = await read("User-authored comment");
  const claudeComment = await read("Claude-authored comment");

  for (const [name, card] of [
    ["user note", userNote],
    ["user comment", userComment],
    ["claude comment", claudeComment],
  ] as const) {
    expect(
      cssAlpha(card.cardBg),
      `the ${name} card's ground is not opaque (${card.cardBg}) — its token probably failed to resolve`,
    ).toBe(1);
  }

  expect(
    userNote.cardBg,
    "a note and a comment by the SAME author must share a ground — type is not the tint axis",
  ).toBe(userComment.cardBg);

  expect(
    userComment.cardBg,
    "two authors must not share a ground — author IS the tint axis",
  ).not.toBe(claudeComment.cardBg);

  // Same author on both sides, so this isolates type. `transparent` computes to
  // rgba(0, 0, 0, 0); read the alpha rather than matching a string, since the
  // serialization is not guaranteed.
  expect(cssAlpha(userNote.dotBg), `the note dot must have no fill; got ${userNote.dotBg}`).toBe(0);
  expect(userNote.dotBorder, "a hollow dot with no border is an invisible dot").toBeGreaterThan(0);
  expect(
    cssAlpha(userComment.dotBg),
    `a comment dot by the same author must stay filled; got ${userComment.dotBg}`,
  ).toBe(1);
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
