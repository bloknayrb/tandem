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
 *   the new color until the user clicked away. Fix: collapse the ProseMirror
 *   selection (`editor.chain().setTextSelection(to).run()`) immediately after
 *   `toggleHighlight`; clearing the native browser selection range falls out
 *   as a side effect of collapsing the PM selection.
 *
 * Bug 2 — Clicking highlighted text focuses the wrong annotation.
 *   When a highlight overlaps a Claude comment, ProseMirror nests the
 *   `Decoration.inline()` spans. The previous `closest()` lookup returned
 *   the *innermost* `[data-annotation-id]` ancestor, which depended on
 *   `annotationsMap.forEach()` iteration order — not user intent. Fix:
 *   enumerate every ancestor with `[data-annotation-id]` and pick the
 *   highest priority via `highlight > comment > note`.
 *
 *   buildDecorations iterates `annotationsMap.forEach()` in Y.Map insertion
 *   order, and ProseMirror renders the earlier-inserted overlapping inline
 *   decoration as the OUTER span. The two Bug-2 cases below cover BOTH nesting
 *   orders: comment-outer/highlight-inner (where `closest()` alone already
 *   returns the highlight) and highlight-outer/comment-inner (where `closest()`
 *   returns the comment and the priority walk MUST override it). A third case
 *   covers the `?? -1` / `NEGATIVE_INFINITY`-seed fallback for an id-bearing
 *   element whose `data-annotation-type` is unknown to the priority table.
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

  // The native browser Selection should be empty — handleHighlight() collapses
  // the ProseMirror selection via `editor.chain().setTextSelection(to).run()`,
  // and collapsing the PM selection clears the underlying native browser range
  // as a side effect, so the highlight color is visually unobstructed and the
  // user gets immediate feedback.
  const selectionTextLen = await page.evaluate(() => {
    const sel = window.getSelection();
    return sel ? sel.toString().length : -1;
  });
  expect(selectionTextLen).toBe(0);
});

test("#768 Bug 2 (comment outer): clicking a highlight nested inside an overlapping Claude comment focuses the highlight", async ({
  page,
}) => {
  // Open with a Claude comment over the title FIRST so the comment span is
  // the *outer* wrapper when the user-created highlight nests inside it.
  // In this nesting, clicking the highlight makes `closest()` already return
  // the highlight — so this case alone does NOT exercise the priority walk
  // overriding `closest()`. The reverse-nesting case below covers that.
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

test("#768 Bug 2 (highlight outer): clicking a comment nested inside an overlapping highlight still focuses the highlight", async ({
  page,
}) => {
  // This is the nesting order the tiebreaker actually exists to fix. The
  // user-created highlight is inserted into the annotations Y.Map FIRST, so
  // buildDecorations renders it as the *outer* span; the Claude comment added
  // SECOND nests inside as the innermost span. Clicking the comment text makes
  // `closest("[data-annotation-id]")` return the COMMENT — so without the
  // `highlight > comment` priority walk, the comment would win and the wrong
  // annotation would focus. The walk must climb to the outer highlight.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await switchToAnnotationsTab(page);

  const editor = page.locator(".tiptap");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });

  // 1) Create the highlight FIRST via the selection popup (earliest insertion
  //    → outer span).
  const heading = editor.locator("h1").first();
  await heading.selectText();
  const yellowSwatch = page.locator("[data-testid='popup-highlight-yellow']");
  await expect(yellowSwatch).toBeVisible({ timeout: 5_000 });
  await yellowSwatch.click();

  const highlightSpan = page.locator("[data-annotation-id][data-annotation-type='highlight']");
  await expect(highlightSpan.first()).toBeVisible({ timeout: 10_000 });
  const highlightId = await highlightSpan.first().getAttribute("data-annotation-id");
  expect(highlightId).not.toBeNull();

  // 2) Add the Claude comment over the SAME range SECOND (later insertion →
  //    inner/nested span).
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Claude comment on title",
    textSnapshot: TITLE_TEXT,
  });

  const commentSpan = page.locator("[data-annotation-id][data-annotation-type='comment']");
  await expect(commentSpan.first()).toBeVisible({ timeout: 10_000 });
  const commentId = await commentSpan.first().getAttribute("data-annotation-id");
  expect(commentId).not.toBeNull();
  expect(commentId).not.toBe(highlightId);

  // Both annotations now exist.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(2, {
    timeout: 10_000,
  });

  // Click the INNER comment span — `closest()` resolves to the comment, so the
  // priority walk must override it and focus the outer highlight instead.
  await commentSpan.first().click();

  // The focused annotation must be the highlight, proving the `>`-priority walk
  // overrode `closest()`'s innermost (comment) result.
  const activeSpans = page.locator(".tandem-annotation-active");
  await expect(activeSpans.first()).toBeVisible({ timeout: 3_000 });
  const activeAnnotationId = await activeSpans.first().getAttribute("data-annotation-id");
  expect(activeAnnotationId).toBe(highlightId);

  const activeCard = page.locator(`[data-testid='annotation-card-${highlightId}']`);
  await expect(activeCard).toBeVisible({ timeout: 5_000 });
});

test("#768 Bug 2 (unknown type): clicking an id-bearing span with an unknown annotation type still focuses it", async ({
  page,
}) => {
  // The priority walk seeds `bestPriority` at `Number.NEGATIVE_INFINITY` and
  // maps unknown/missing `data-annotation-type` values to `-1` via `?? -1`.
  // This guarantees an id-bearing element whose type the priority table does
  // not recognise (e.g. a future annotation type) still beats the
  // "no match" seed and focuses, preserving the innermost-fallback behavior.
  // We exercise that branch by stripping `data-annotation-type` off a real
  // comment span (no Y.Doc transaction fires, so buildDecorations does not
  // rebuild the decoration before the click), then clicking it.
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

  const commentSpan = page.locator("[data-annotation-id][data-annotation-type='comment']");
  await expect(commentSpan.first()).toBeVisible({ timeout: 10_000 });
  const commentId = await commentSpan.first().getAttribute("data-annotation-id");
  expect(commentId).not.toBeNull();

  // Strip the type attribute so the priority table no longer recognises it.
  // The element keeps its `data-annotation-id`, exercising the `?? -1` /
  // NEGATIVE_INFINITY-seed fallback in the click handler's priority walk.
  await page.evaluate((id) => {
    document
      .querySelectorAll(`[data-annotation-id="${id}"]`)
      .forEach((el) => el.removeAttribute("data-annotation-type"));
  }, commentId as string);

  // The span no longer matches the typed locator, but still bears the id.
  const untypedSpan = page.locator(
    `[data-annotation-id="${commentId}"]:not([data-annotation-type])`,
  );
  await expect(untypedSpan.first()).toBeVisible({ timeout: 3_000 });

  await untypedSpan.first().click();

  // Even with an unknown type, the id-bearing span wins over "no match" and
  // focuses — `tandem-annotation-active` lands on the matching span and the
  // side-panel card is visible.
  const activeSpans = page.locator(".tandem-annotation-active");
  await expect(activeSpans.first()).toBeVisible({ timeout: 3_000 });
  const activeAnnotationId = await activeSpans.first().getAttribute("data-annotation-id");
  expect(activeAnnotationId).toBe(commentId);

  const activeCard = page.locator(`[data-testid='annotation-card-${commentId}']`);
  await expect(activeCard).toBeVisible({ timeout: 5_000 });
});
