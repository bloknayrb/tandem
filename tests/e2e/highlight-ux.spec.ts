import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  switchToAnnotationsTab,
} from "./helpers";

/**
 * E2E regression net for issue #768 — two highlight UX bugs.
 *
 * Bug 1 — No visual feedback while text is still selected.
 *   After applying a highlight via the selection popup, the browser's native
 *   ::selection overlay (blue) painted on top of the highlight span, hiding
 *   the new color until the user clicked away. Fix: clear the browser
 *   selection range immediately after `toggleHighlight`.
 *
 * Bug 2 — Clicking highlighted text focuses the wrong annotation.
 *   When a highlight overlaps a Claude comment, ProseMirror nests the
 *   `Decoration.inline()` spans. The previous `closest()` lookup returned
 *   the *innermost* `[data-annotation-id]` ancestor, which depended on
 *   `annotationsMap.forEach()` iteration order — not user intent. Fix:
 *   enumerate every ancestor with `[data-annotation-id]` and pick the
 *   highest priority via `highlight > comment > note`.
 *
 * The tests mirror `toolbar-redesign.spec.ts` — fresh fixture dir per test,
 * MCP control plane for state setup, `tandem_getAnnotations` as the
 * authoritative server-side snapshot for negative assertions.
 */

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" — heading prefix "# " (2 chars), so "Test" spans 2..6
// in flat-text coordinates. Used for Bug 2's Claude comment overlap test.
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

test("#768 Bug 1: highlight applies without lingering browser selection overlay", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);

  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  // The highlight swatch is part of the (default, non-annotate-mode) selection
  // popup; it appears as soon as the selection is non-empty and the popup
  // has been positioned. Use the swatch itself as the visibility proxy —
  // `popup-annotation-input` only mounts inside annotate-mode.
  const yellowSwatch = page.locator("[data-testid='popup-highlight-yellow']");
  await expect(yellowSwatch).toBeVisible({ timeout: 5_000 });
  await yellowSwatch.click();

  // Annotation created.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });

  // The native browser Selection should be empty — our handleHighlight()
  // calls window.getSelection().removeAllRanges() so the highlight color is
  // visually unobstructed and the user gets immediate feedback.
  const selectionTextLen = await page.evaluate(() => {
    const sel = window.getSelection();
    return sel ? sel.toString().length : -1;
  });
  expect(selectionTextLen).toBe(0);
});

test("#768 Bug 2: clicking a highlight inside an overlapping Claude comment focuses the highlight", async ({
  page,
}) => {
  // Open with a Claude comment over the title FIRST so the comment span is
  // the *outer* wrapper when the user-created highlight nests inside it.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Claude comment on title",
    textSnapshot: TITLE_TEXT,
  });

  await page.goto("/");
  await switchToAnnotationsTab(page);

  const editor = page.locator(".tiptap");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });

  // Wait for the Claude comment decoration to mount.
  const commentSpan = page.locator("[data-annotation-id][data-annotation-type='comment']");
  await expect(commentSpan.first()).toBeVisible({ timeout: 10_000 });
  const commentId = await commentSpan.first().getAttribute("data-annotation-id");
  expect(commentId).not.toBeNull();

  // Select the title text in the H1 and apply a yellow highlight via the
  // selection popup. The new highlight covers the same range as the Claude
  // comment, producing nested decoration spans.
  const heading = editor.locator("h1").first();
  await heading.selectText();

  const yellowSwatch = page.locator("[data-testid='popup-highlight-yellow']");
  await expect(yellowSwatch).toBeVisible({ timeout: 5_000 });
  await yellowSwatch.click();

  // Both annotations now exist.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(2, {
    timeout: 10_000,
  });

  // Verify nesting: there are two distinct `[data-annotation-id]` spans
  // overlapping the title. The exact nesting order depends on Y.Map
  // iteration, but both should be findable.
  const highlightSpan = page.locator("[data-annotation-id][data-annotation-type='highlight']");
  await expect(highlightSpan.first()).toBeVisible({ timeout: 5_000 });
  const highlightId = await highlightSpan.first().getAttribute("data-annotation-id");
  expect(highlightId).not.toBeNull();
  expect(highlightId).not.toBe(commentId);

  // Click on the highlighted (and commented) text — the highlight should win
  // the tiebreaker regardless of which span happens to be innermost.
  await highlightSpan.first().click();

  // The active annotation card should be the highlight, not the comment.
  // `tandem-annotation-active` is added by App.svelte's $effect on the
  // matching `[data-annotation-id]` span(s); the side-panel card carries
  // `data-testid="annotation-card-{id}"`.
  const activeCard = page.locator(`[data-testid='annotation-card-${highlightId}']`);
  await expect(activeCard).toBeVisible({ timeout: 5_000 });

  // The comment card should not be the focused one. We assert this by
  // checking that the focused-card CSS state lives on the highlight, not
  // the comment. Implementation detail: SidePanel.svelte scrolls the
  // focused card into view; both cards render in DOM, so we verify by
  // looking at which `[data-annotation-id]` span got `tandem-annotation-active`.
  const activeSpans = page.locator(".tandem-annotation-active");
  await expect(activeSpans.first()).toBeVisible({ timeout: 3_000 });
  const activeAnnotationId = await activeSpans.first().getAttribute("data-annotation-id");
  expect(activeAnnotationId).toBe(highlightId);
});
