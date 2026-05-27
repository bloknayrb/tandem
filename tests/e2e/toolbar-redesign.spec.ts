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

/**
 * E2E smoke for the post-PR-#474 (ADR-027) toolbar redesign. Acts as a
 * regression net for #480 — the "Note button creates an empty annotation
 * on click" bug — and locks in toolbar control enumeration so future
 * refactors don't silently drop a button.
 *
 * Reference: `.pipeline-state/issue-484/plan.md`. Selection idiom mirrors
 * `settings-and-filters.spec.ts` (`editor.locator("p").first().selectText()`).
 *
 * Negative-assertion strategy: tests that assert "no annotation was created"
 * dual-assert — `tandem_getAnnotations` is the authoritative server-side
 * snapshot (Hocuspocus latency can mask a slow-to-render card and produce
 * false-pass DOM checks); `toHaveCount(0)` with a 2s window is a UI sanity
 * layer.
 */

let mcp: McpTestClient;
let tmpDir: string;

type AnnotationRecord = { type?: string; audience?: string; content?: string };
type AnnotationsResponse = {
  data?: { annotations?: AnnotationRecord[] };
};

async function getAnnotationCount(): Promise<number> {
  const res = (await mcp.callTool("tandem_getAnnotations", {})) as AnnotationsResponse;
  return res?.data?.annotations?.length ?? 0;
}

/** First annotation as the server sees it — used for seam-level type/audience
 * assertions (the authoritative privacy-boundary check). */
async function firstAnnotation(): Promise<AnnotationRecord | undefined> {
  const res = (await mcp.callTool("tandem_getAnnotations", {})) as AnnotationsResponse;
  return res?.data?.annotations?.[0];
}

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  // Avoid `sample/welcome.md` — its tutorial annotations would contaminate
  // the side-panel card count and break the negative assertions below.
  tmpDir = createFixtureDir("sample.md");
});

test.afterEach(async () => {
  // Each test must leave: no annotations, no open tabs, no localStorage drift.
  // cleanupAllOpenDocuments closes every tab the server thinks is open, which
  // also drops in-memory annotations for those docs. The temp fixture dir is
  // unique per test, so disk state is isolated.
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("toolbar renders all expected controls", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await expect(page.locator("[data-testid='toolbar-highlight-btn']")).toBeVisible();
  await expect(page.locator("[data-testid='titlebar-brand-menu']")).toBeVisible();
  // Authorship is no longer a standalone toggle — it lives inside the
  // Decorations split button in the formatting bar (eye = mute, caret = rows).
  await expect(page.locator("[data-testid='decorations-menu']")).toBeVisible();
});

test("highlight quick-action is disabled with no selection", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // No selection → highlight button (the only selection-gated static control) is disabled.
  await expect(page.locator("[data-testid='toolbar-highlight-btn']")).toBeDisabled();
});

test("selection lights up annotation entry-points", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  await expect(page.locator("[data-testid='toolbar-highlight-btn']")).toBeEnabled({
    timeout: 3_000,
  });
  // Wave M: selection opens the action surface; Annotate reveals the textarea.
  await openAnnotatePopup(page);
  await expect(page.locator("[data-testid='popup-note-submit']")).toBeVisible();
});

test("floating selection toolbar stays within a short viewport", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.setViewportSize({ width: 1024, height: 360 });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });

  await editor.click();
  await editor.locator("p").first().selectText();

  // Wait for the toolbar to mount before measuring its position — on a short
  // viewport the toolbar can lag the selection event by a frame or two under CI.
  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(toolbar).toBeVisible({ timeout: 5_000 });
  // Confirm interactive state before reading boundingBox(). The Annotate
  // button lives on the action surface that mounts on selection (Wave M).
  await expect(page.locator("[data-testid='popup-annotate-btn']")).toBeVisible({
    timeout: 5_000,
  });

  const box = await toolbar.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(48);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
});

test("floating selection toolbar exposes first-pass formatting actions", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });

  await editor.click();
  await editor.locator("p").first().selectText();

  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(toolbar).toBeVisible({ timeout: 5_000 });
  // 1.11: the popup is now the FULL format set (mirrors the formatting bar) over
  // the annotate pill. The format pill reuses FormattingToolbar (variant=popup),
  // so Strike/Code/Link — previously removed from the popup — are now present.
  // Undo/Redo are intentionally omitted in popup mode (they stay on the bar).
  await expect(toolbar.getByRole("button", { name: "B", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "I", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "S", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Link" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Bullet list" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: /Highlight / })).toHaveCount(4);
  await expect(toolbar.getByRole("button", { name: "Undo" })).toHaveCount(0);
  // The Decorations control is mirrored into the popup so it stays reachable
  // when the formatting bar is hidden (one component, two mount points).
  await expect(toolbar.locator("[data-testid='decorations-menu']")).toBeVisible();
  // Annotate mode swaps the pills for the note popover.
  await openAnnotatePopup(page);
  await expect(toolbar.getByRole("button", { name: "Send to Claude (Ctrl+Enter)" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Note to self (Alt+Enter)" })).toBeVisible();
});

test("floating selection toolbar dismisses with Escape", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });

  await editor.click();
  await editor.locator("p").first().selectText();

  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(toolbar).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeHidden({ timeout: 3_000 });
});

test("Comment flow creates a comment annotation", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  // Wave M: selection shows the action surface; click Annotate for the textarea.
  await openAnnotatePopup(page);
  const input = page.locator("[data-testid='popup-annotation-input']");
  await input.fill("test comment");
  await page.locator("[data-testid='popup-comment-submit']").click();

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(page.locator("[data-testid^='annotation-card-']").first()).toContainText(
    "test comment",
  );
});

test("Note flow creates a note annotation", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  // Wave M: selection shows the action surface; click Annotate for the textarea.
  await openAnnotatePopup(page);
  const input = page.locator("[data-testid='popup-annotation-input']");
  await input.fill("test note");
  await page.locator("[data-testid='popup-note-submit']").click();

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(page.locator("[data-testid^='annotation-card-']").first()).toContainText(
    "test note",
  );
});

test("#480 regression — popup appears on selection without creating an annotation", async ({
  page,
}) => {
  // AR3 redesign: the unified popup appears immediately on text selection.
  // No annotation should be created just by selecting text — the user must
  // explicitly submit via "Comment" or "Note to self". This replaces the old
  // invariant (click Note → input appears, no annotation yet) with the new one
  // (select text → popup appears, no annotation yet).
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  // Popup action surface appears — but no annotation is created just by
  // selecting text. (Wave M: textarea lives behind the Annotate button, but
  // the #480 contract is about the action surface itself appearing.)
  await expect(page.locator("[data-testid='popup-annotate-btn']")).toBeVisible({
    timeout: 3_000,
  });

  // No annotation yet — under AR3's unified popup, selecting text shows the
  // popup but never auto-creates an annotation (the original #480 contract still holds)
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(0, {
    timeout: 2_000,
  });
  expect(await getAnnotationCount()).toBe(0);
});

test("Comment submit is disabled when textarea is empty (no annotation created)", async ({
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

  // Popup appears — Comment button should be disabled when textarea is empty
  await openAnnotatePopup(page);
  await expect(page.locator("[data-testid='popup-comment-submit']")).toBeDisabled({
    timeout: 2_000,
  });

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(0, {
    timeout: 2_000,
  });
  expect(await getAnnotationCount()).toBe(0);
});

test("plain Enter in popup textarea inserts a newline and creates no annotation", async ({
  page,
}) => {
  // 1.11 keybinding override: plain Enter is a newline (no submit). Both
  // submits are modifier-gated, so a reflexive Enter can never persist anything.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  await openAnnotatePopup(page);
  const input = page.locator("[data-testid='popup-annotation-input']");
  await input.fill("line one");
  await input.press("Enter");

  // No annotation — plain Enter does not submit.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(0, {
    timeout: 2_000,
  });
  expect(await getAnnotationCount()).toBe(0);
  // And the textarea gained a newline.
  expect(await input.inputValue()).toContain("\n");
});

test("Ctrl+Enter submits as Comment (outbound to Claude)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  await openAnnotatePopup(page);
  const input = page.locator("[data-testid='popup-annotation-input']");
  await input.fill("ctrl enter comment");
  await input.press("ControlOrMeta+Enter");

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(page.locator("[data-testid^='annotation-card-']").first()).toContainText(
    "ctrl enter comment",
  );
  // Seam-level assertion: Claude sees it (comments are outbound). The comment,
  // not the note, is what crosses to Claude's MCP read.
  expect(await getAnnotationCount()).toBe(1);
  const created = await firstAnnotation();
  expect(created?.type).toBe("comment");
});

test("Alt+Enter submits as Note — visible to the user, invisible to Claude", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  await openAnnotatePopup(page);
  const input = page.locator("[data-testid='popup-annotation-input']");
  await input.fill("alt enter note");
  await input.press("Alt+Enter");

  // The note IS created and shows in the user's own side panel…
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(page.locator("[data-testid^='annotation-card-']").first()).toContainText(
    "alt enter note",
  );
  // …but ADR-027: a private note is stripped from `tandem_getAnnotations`, so
  // Claude never sees it. This is the privacy boundary — the note never crosses.
  expect(await getAnnotationCount()).toBe(0);
});

test("empty Alt+Enter / Ctrl+Enter create nothing (guard on both submit paths)", async ({
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

  await openAnnotatePopup(page);
  const input = page.locator("[data-testid='popup-annotation-input']");
  await input.press("Alt+Enter");
  await input.press("ControlOrMeta+Enter");

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(0, {
    timeout: 2_000,
  });
  expect(await getAnnotationCount()).toBe(0);
  // Both submit buttons are disabled when empty.
  await expect(page.locator("[data-testid='popup-note-submit']")).toBeDisabled();
  await expect(page.locator("[data-testid='popup-comment-submit']")).toBeDisabled();
});

test("formatting from the popup survives the click, then Annotate produces a correct comment", async ({
  page,
}) => {
  // crdt plan-review (MED): a format button in the popup must NOT collapse the
  // selection / dismiss the popup. And a structural command (heading) shifts
  // flat offsets by its prefix — the annotation created afterward must still
  // resolve. (The format pill and the textarea are separate modes, so the real
  // sequence is format-FIRST, then Annotate — not format-during-annotate.)
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(toolbar).toBeVisible({ timeout: 5_000 });

  // Apply Heading 2 via the popup's format pill (open the H dropdown, pick H2).
  await toolbar.getByRole("button", { name: "H", exact: true }).click();
  await toolbar.getByRole("menuitem", { name: "Heading 2" }).click();
  // The heading applied to the selected paragraph, and the popup did NOT
  // dismiss (selection survived the format click). Scope to the selected text —
  // the fixture already contains other h2 headings.
  await expect(editor.locator("h2", { hasText: "first paragraph" })).toBeVisible({
    timeout: 3_000,
  });
  await expect(page.locator("[data-testid='popup-annotate-btn']")).toBeVisible({ timeout: 3_000 });

  // Now annotate the (heading-prefix-shifted) selection and send to Claude.
  await openAnnotatePopup(page);
  const input = page.locator("[data-testid='popup-annotation-input']");
  await input.fill("after heading");
  await input.press("ControlOrMeta+Enter");

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });
  expect(await getAnnotationCount()).toBe(1);
});

test("popup textarea and submit buttons are visible after Annotate click", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(toolbar).toBeVisible({ timeout: 5_000 });
  // Wave M: textarea + submit buttons live behind the Annotate button.
  await openAnnotatePopup(page);
  await expect(page.locator("[data-testid='popup-note-submit']")).toBeVisible();
  await expect(page.locator("[data-testid='popup-comment-submit']")).toBeVisible();
});

test("Highlight quick-action creates a highlight annotation", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const selectionToolbar = page.getByRole("toolbar", { name: "Selection tools" });
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();
  await expect(selectionToolbar).toBeVisible({ timeout: 5_000 });

  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(toolbar).toBeVisible({ timeout: 10_000 });
  const highlightBtn = page.locator("[data-testid='toolbar-highlight-btn']");
  await expect(highlightBtn).toBeEnabled({ timeout: 3_000 });
  await highlightBtn.click();

  // Highlights have no input flow; one annotation should appear.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });
});

test("Escape dismisses the popup without creating an annotation", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(toolbar).toBeVisible({ timeout: 10_000 });

  // Type in the popup textarea, then Escape
  await openAnnotatePopup(page);
  const input = page.locator("[data-testid='popup-annotation-input']");
  await input.fill("draft");
  await input.press("Escape");

  // Popup should dismiss
  await expect(toolbar).toBeHidden({ timeout: 5_000 });

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(0, {
    timeout: 2_000,
  });
  expect(await getAnnotationCount()).toBe(0);
});

test("Shift+Enter inserts a newline in the textarea without submitting", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  await openAnnotatePopup(page);
  const input = page.locator("[data-testid='popup-annotation-input']");
  await input.fill("line one");
  await input.press("Shift+Enter");

  // Shift+Enter inserts a newline — no annotation should be created
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(0, {
    timeout: 2_000,
  });
  expect(await getAnnotationCount()).toBe(0);

  // And the textarea value should contain a newline
  const value = await input.inputValue();
  expect(value).toContain("\n");
});

test("suppressSelectionToolbar hides the popup when the find bar is open", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  // Wave M: the popup's action surface is what mounts on selection.
  const popup = page.locator("[data-testid='popup-annotate-btn']");
  await expect(popup).toBeVisible({ timeout: 3_000 });

  // Open the find bar — App.svelte sets suppressSelectionToolbar when findBarOpen
  await page.keyboard.press("Control+f");
  await expect(page.locator("[data-testid='find-replace-bar']")).toBeVisible({ timeout: 3_000 });
  await expect(popup).toBeHidden({ timeout: 2_000 });
});

test("popup highlight button creates a highlight annotation", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  // Wave M: highlight swatches live in the action surface (not annotate mode),
  // so we just need the popup to be mounted. The Annotate button is the
  // visibility sentinel for the action surface.
  await expect(page.locator("[data-testid='popup-annotate-btn']")).toBeVisible({
    timeout: 3_000,
  });

  // Click the yellow highlight swatch inside the popup (distinct from FormattingBar path)
  await page.locator("[data-testid='popup-highlight-yellow']").click();

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });
  expect(await getAnnotationCount()).toBe(1);
});

test("highlight same range twice removes highlight (toggle off)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  const highlightBtn = page.locator("[data-testid='toolbar-highlight-btn']");
  await expect(highlightBtn).toBeEnabled({ timeout: 3_000 });
  await highlightBtn.click();

  // One annotation after first click.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });
  expect(await getAnnotationCount()).toBe(1);

  // Re-select the same text and click highlight again — should toggle off.
  await editor.click();
  await editor.locator("p").first().selectText();
  await expect(highlightBtn).toBeEnabled({ timeout: 3_000 });
  await highlightBtn.click();

  // Toggle off: zero annotations.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(0, {
    timeout: 10_000,
  });
  expect(await getAnnotationCount()).toBe(0);
});

// "highlight same range with different color replaces the highlight (recolor)" is NOT
// tested via E2E. The color-picker open flow requires clicking the toggle button, which
// causes ProseMirror to clear the text selection before the swatch panel renders —
// making `toolbar-highlight-color-blue` unreachable in headless CI regardless of
// `e.preventDefault()` on the toggle's mousedown handler.
//
// The recolor logic is fully covered by the unit test in
// `tests/client/highlight-toggle.test.ts`:
//   "same range + different color — recolors, returns 'recolored', exactly 1 annotation with new color"

test("highlights on different ranges produce two separate annotations", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });

  // Highlight first paragraph.
  await editor.click();
  await editor.locator("p").first().selectText();
  const highlightBtn = page.locator("[data-testid='toolbar-highlight-btn']");
  await expect(highlightBtn).toBeEnabled({ timeout: 3_000 });
  await highlightBtn.click();
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });

  // Highlight a different paragraph (section one content).
  const secondPara = editor.locator("p").nth(1);
  await secondPara.click();
  await secondPara.selectText();
  await expect(highlightBtn).toBeEnabled({ timeout: 3_000 });
  await highlightBtn.click();

  // Two separate annotations.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(2, {
    timeout: 10_000,
  });
  expect(await getAnnotationCount()).toBe(2);
});

// These tests verify keyboard behaviour for the floating selection popup
// (role="toolbar" aria-label="Selection tools"). 1.11: the popup is now the
// full format set (FormattingToolbar variant="popup") over the annotate pill,
// not the old 2-button mini-toolbar — so these assert surface-agnostic
// navigation (Tab stays within the toolbar; Escape closes + returns focus)
// rather than the retired Bold/Italic-specific contract. APG Toolbar Pattern
// §3 classifies roving-tabindex as MAY for transient toolbars; Tab/Shift+Tab +
// Escape-to-close is compliant. (Per-button Enter/Space activation of the
// reused FormattingToolbar controls is tracked as a separate follow-up — the
// bar component is mouse-+-shortcut-operable today; Ctrl+B etc. cover the
// keyboard workflow.)

/** Open the file, select the first paragraph, and wait for the popup format pill. */
async function openAndWaitForToolbar(page: import("@playwright/test").Page) {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", { timeout: 10_000 });
  await editor.click();
  await editor.locator("p").first().selectText();
  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(toolbar).toBeVisible({ timeout: 5_000 });
  await expect(toolbar.getByRole("button", { name: "B", exact: true })).toBeVisible({
    timeout: 3_000,
  });
  return { editor, toolbar };
}

test("selection popup keeps Tab focus within its own controls", async ({ page }) => {
  const { toolbar } = await openAndWaitForToolbar(page);

  // Start on the Bold ("B") control, Tab once — focus must land on another
  // control and stay inside the popup (it must not escape to the document).
  await toolbar.getByRole("button", { name: "B", exact: true }).focus();
  await page.keyboard.press("Tab");

  const inToolbar = await page.evaluate(
    () =>
      document.activeElement?.closest('[role="toolbar"][aria-label="Selection tools"]') !== null,
  );
  expect(inToolbar).toBe(true);
});

test("Escape closes the selection popup and returns focus to the editor", async ({ page }) => {
  const { editor, toolbar } = await openAndWaitForToolbar(page);

  await toolbar.getByRole("button", { name: "B", exact: true }).focus();
  await page.keyboard.press("Escape");

  await expect(toolbar).toBeHidden({ timeout: 3_000 });
  await expect(editor).toBeFocused({ timeout: 2_000 });
});
