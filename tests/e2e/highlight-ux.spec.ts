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
 *   When a user highlight overlaps a Claude comment on the SAME range,
 *   ProseMirror coalesces the two `Decoration.inline()` decorations into a
 *   SINGLE DOM `<span>` (it does NOT nest them). The span keeps one
 *   `data-annotation-id` / `data-annotation-type` — whichever decoration was
 *   applied last in `buildDecorations`'s `annotationsMap.forEach()` walk wins
 *   the single-valued attributes, but it carries BOTH the highlight and the
 *   comment CSS classes.
 *
 *   The original symptom: clicking the highlight reported the click against
 *   the highlight (the click handler's priority walk picked it correctly), but
 *   the focus immediately bounced back to the Claude comment. Root cause was
 *   in `useAnnotationReview`'s auto-advance `$effect`: it fell back to the
 *   bulk-review target whenever the active id was absent from
 *   `getReviewTargets()`. User highlights (`author === "user"`) are NOT review
 *   targets, so a freshly-clicked highlight was clobbered straight back to the
 *   overlapping comment. Fix: the effect now only falls back when the active
 *   annotation no longer EXISTS as a live pending annotation (deleted /
 *   accepted / dismissed), not merely when it is a non-review-target.
 *
 *   The two Bug-2 cases below cover both directions of the same invariant:
 *   (a) clicking an overlapping highlight focuses it and the focus STICKS;
 *   (b) focusing a highlight, then having a Claude comment land on the same
 *   range via MCP, must NOT steal focus away from the user's highlight.
 *
 * The tests mirror `toolbar-redesign.spec.ts` — fresh fixture dir per test,
 * MCP control plane for state setup, the side-panel annotation card's
 * `aria-current="true"` (set by `AnnotationCard` when `isReviewTarget`, which
 * SidePanel binds to `activeAnnotationId === ann.id`) as the authoritative
 * "this annotation is focused" signal. We deliberately do NOT assert on the
 * editor's `.tandem-annotation-active` class: that class is applied
 * imperatively to ProseMirror-owned decoration spans and is wiped on the next
 * decoration rebuild, so it is not a reliable focus oracle.
 */

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" — heading prefix "# " (2 chars), so "Test Document" spans
// 2..15 in flat-text coordinates. Used for Bug 2's Claude comment overlap test.
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
  // post-A26 (#798) `popup-annotation-input` is always mounted but collapsed
  // (grid-row 0fr) + `inert` in format state, so it's not visible until Annotate.
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

test("#768 Bug 2 (click): clicking a highlight overlapping a Claude comment focuses the highlight and the focus sticks", async ({
  page,
}) => {
  // Open with a Claude comment over the title FIRST, then add the user
  // highlight over the SAME range. ProseMirror coalesces the two inline
  // decorations into ONE span; because the highlight is inserted into the
  // annotations Y.Map SECOND, it wins the single-valued attributes, so the
  // merged span reports `data-annotation-type="highlight"`.
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

  // Wait for the Claude comment decoration to mount, then capture its id.
  const commentSpan = page.locator("[data-annotation-id][data-annotation-type='comment']");
  await expect(commentSpan.first()).toBeVisible({ timeout: 10_000 });
  const commentId = await commentSpan.first().getAttribute("data-annotation-id");
  expect(commentId).not.toBeNull();

  // Select the title text in the H1 and apply a yellow highlight via the
  // selection popup. The new highlight covers the same range as the Claude
  // comment, so the two decorations coalesce into one span.
  const heading = editor.locator("h1").first();
  await heading.selectText();

  const yellowSwatch = page.locator("[data-testid='popup-highlight-yellow']");
  await expect(yellowSwatch).toBeVisible({ timeout: 5_000 });
  await yellowSwatch.click();

  // Both annotations now exist as cards.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(2, {
    timeout: 10_000,
  });

  // The merged span reports the highlight's id/type.
  const highlightSpan = page.locator("[data-annotation-id][data-annotation-type='highlight']");
  await expect(highlightSpan.first()).toBeVisible({ timeout: 5_000 });
  const highlightId = await highlightSpan.first().getAttribute("data-annotation-id");
  expect(highlightId).not.toBeNull();
  expect(highlightId).not.toBe(commentId);

  // Click the highlighted (and commented) text.
  await highlightSpan.first().click();

  // The highlight card must become — and STAY — the focused annotation. Before
  // the #768 fix, the review effect bounced focus back to the overlapping
  // comment because the highlight is not a review target. `aria-current="true"`
  // is set by AnnotationCard whenever the card is the active/review target.
  const highlightCard = page.locator(`[data-testid='annotation-card-${highlightId}']`);
  await expect(highlightCard).toHaveAttribute("aria-current", "true", { timeout: 5_000 });

  // The comment card must NOT be the focused one.
  const commentCard = page.locator(`[data-testid='annotation-card-${commentId}']`);
  await expect(commentCard).not.toHaveAttribute("aria-current", "true");
});

test("#768 Bug 2 (no steal): a new Claude comment on the same range must not steal focus from a clicked highlight", async ({
  page,
}) => {
  // The reverse direction: focus a user highlight first, then introduce a NEW
  // overlapping Claude comment via MCP. The comment is a review target; the
  // highlight is not. The auto-advance review effect re-runs whenever the
  // annotation set changes — it must NOT clobber the user's focused highlight
  // just because a new review target appeared. This is the exact `$effect`
  // regression the #768 fix addresses (full-live-set membership check instead
  // of review-targets membership check).
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await switchToAnnotationsTab(page);

  const editor = page.locator(".tiptap");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });

  // 1) Create and focus the highlight.
  const heading = editor.locator("h1").first();
  await heading.selectText();
  const yellowSwatch = page.locator("[data-testid='popup-highlight-yellow']");
  await expect(yellowSwatch).toBeVisible({ timeout: 5_000 });
  await yellowSwatch.click();

  const highlightSpan = page.locator("[data-annotation-id][data-annotation-type='highlight']");
  await expect(highlightSpan.first()).toBeVisible({ timeout: 10_000 });
  const highlightId = await highlightSpan.first().getAttribute("data-annotation-id");
  expect(highlightId).not.toBeNull();

  await highlightSpan.first().click();
  const highlightCard = page.locator(`[data-testid='annotation-card-${highlightId}']`);
  await expect(highlightCard).toHaveAttribute("aria-current", "true", { timeout: 5_000 });

  // 2) Add a Claude comment over the SAME range via MCP — a brand-new review
  //    target appears in the annotation set.
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Claude comment on title",
    textSnapshot: TITLE_TEXT,
  });

  // Both annotations now exist as cards.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(2, {
    timeout: 10_000,
  });
  const commentSpan = page.locator("[data-annotation-id][data-annotation-type='comment']");
  await expect(commentSpan.first()).toBeVisible({ timeout: 10_000 });
  const commentId = await commentSpan.first().getAttribute("data-annotation-id");
  expect(commentId).not.toBeNull();
  expect(commentId).not.toBe(highlightId);

  // The user's highlight must remain focused; the new comment must not steal it.
  await expect(highlightCard).toHaveAttribute("aria-current", "true");
  const commentCard = page.locator(`[data-testid='annotation-card-${commentId}']`);
  await expect(commentCard).not.toHaveAttribute("aria-current", "true");
});
