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

type AnnotationsResponse = {
  data?: { annotations?: unknown[] };
};

async function getAnnotationCount(): Promise<number> {
  const res = (await mcp.callTool("tandem_getAnnotations", {})) as AnnotationsResponse;
  return res?.data?.annotations?.length ?? 0;
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
  await expect(page.locator("[data-testid='toolbar-comment-btn']")).toBeVisible();
  await expect(page.locator("[data-testid='toolbar-note-btn']")).toBeVisible();
  await expect(page.locator("[data-testid='settings-btn']")).toBeVisible();
});

test("annotation buttons are disabled with no selection", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // No selection → buttons must report disabled (Playwright reads the native
  // `disabled` attribute; ToolbarButton sets it directly).
  await expect(page.locator("[data-testid='toolbar-highlight-btn']")).toBeDisabled();
  await expect(page.locator("[data-testid='toolbar-comment-btn']")).toBeDisabled();
  await expect(page.locator("[data-testid='toolbar-note-btn']")).toBeDisabled();
});

test("annotation buttons enable after text selection", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  // Wait for the doc to actually load — `.tiptap` mounts before content does.
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();

  // `hasSelection` is wired to Tiptap's synchronous `selectionUpdate` event
  // (no dwell gating involved), so auto-wait on `:not([disabled])` is safe.
  await expect(page.locator("[data-testid='toolbar-highlight-btn']")).toBeEnabled({
    timeout: 3_000,
  });
  await expect(page.locator("[data-testid='toolbar-comment-btn']")).toBeEnabled({
    timeout: 3_000,
  });
  await expect(page.locator("[data-testid='toolbar-note-btn']")).toBeEnabled({
    timeout: 3_000,
  });
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
  // Confirm interactive state before reading boundingBox().
  await expect(page.locator("[data-testid='toolbar-comment-btn']")).toBeEnabled({
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
  await expect(page.locator("[data-testid='toolbar-comment-btn']")).toBeEnabled({
    timeout: 5_000,
  });
  await expect(toolbar.getByRole("button", { name: "Bold" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Italic" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Strike" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Code" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Link" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: /Highlight / })).toHaveCount(4);
  await expect(toolbar.getByRole("button", { name: "Comment on selection" })).toBeVisible();
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
  await page.waitForFunction(() =>
    (window.getSelection()?.toString() ?? "").includes("first paragraph"),
  );

  const commentBtn = page.locator("[data-testid='toolbar-comment-btn']");
  await expect(commentBtn).toBeEnabled({ timeout: 3_000 });
  await commentBtn.click();

  const input = page.locator("[data-testid='toolbar-comment-input']");
  await expect(input).toBeVisible({ timeout: 2_000 });
  await input.fill("test comment");
  await input.press("Enter");

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
  await page.waitForFunction(() =>
    (window.getSelection()?.toString() ?? "").includes("first paragraph"),
  );

  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(toolbar).toBeVisible({ timeout: 10_000 });
  const noteBtn = page.locator("[data-testid='toolbar-note-btn']");
  await expect(noteBtn).toBeEnabled({ timeout: 5_000 });
  await noteBtn.click();

  const input = page.locator("[data-testid='toolbar-note-input']");
  await expect(input).toBeVisible({ timeout: 2_000 });
  await input.fill("test note");
  await input.press("Enter");

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(page.locator("[data-testid^='annotation-card-']").first()).toContainText(
    "test note",
  );
});

test("#480 regression — clicking Note opens input instead of creating an empty annotation", async ({
  page,
}) => {
  // The original #480 bug was: clicking Note immediately created a
  // `(no note)` annotation with no chance to type. The fix (df6c2b2) made
  // Note mirror Comment by opening an inline input first. This test pins
  // that contract: after clicking Note, an input must appear AND no
  // annotation must exist yet. Dual-assert: server snapshot is the
  // authoritative truth (Hocuspocus latency can mask a slow card render
  // and produce false-pass DOM checks); `toHaveCount(0)` is a UI sanity
  // layer. Empty notes ARE allowed on submit per #480 fix; we don't
  // exercise that branch here.
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
  const noteBtn = page.locator("[data-testid='toolbar-note-btn']");
  await expect(noteBtn).toBeEnabled({ timeout: 5_000 });
  await noteBtn.click();

  // Input mounts → confirms the inline-flow path, not the regressed
  // immediate-create path.
  const input = page.locator("[data-testid='toolbar-note-input']");
  await expect(input).toBeVisible({ timeout: 2_000 });

  // No annotation yet — this is the actual #480 invariant.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(0, {
    timeout: 2_000,
  });
  expect(await getAnnotationCount()).toBe(0);
});

test("Comment empty submit cancels (no annotation created)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.click();
  await editor.locator("p").first().selectText();
  await page.waitForFunction(() =>
    (window.getSelection()?.toString() ?? "").includes("first paragraph"),
  );

  const commentBtn = page.locator("[data-testid='toolbar-comment-btn']");
  await expect(commentBtn).toBeEnabled({ timeout: 3_000 });
  await commentBtn.click();

  const input = page.locator("[data-testid='toolbar-comment-input']");
  await expect(input).toBeVisible({ timeout: 2_000 });
  await input.press("Enter");

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(0, {
    timeout: 2_000,
  });
  expect(await getAnnotationCount()).toBe(0);
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

test("Escape cancels Note input without creating annotation", async ({ page }) => {
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
  const noteBtn = page.locator("[data-testid='toolbar-note-btn']");
  await expect(noteBtn).toBeEnabled({ timeout: 5_000 });
  await noteBtn.click();

  const input = page.locator("[data-testid='toolbar-note-input']");
  await expect(input).toBeVisible({ timeout: 2_000 });
  await input.fill("draft");
  await input.press("Escape");
  await expect(input).toBeHidden({ timeout: 5_000 });

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(0, {
    timeout: 2_000,
  });
  expect(await getAnnotationCount()).toBe(0);
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
  await page.waitForFunction(() =>
    (window.getSelection()?.toString() ?? "").includes("first paragraph"),
  );

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
  await page.waitForFunction(() =>
    (window.getSelection()?.toString() ?? "").includes("first paragraph"),
  );
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
  await page.waitForFunction(() =>
    (window.getSelection()?.toString() ?? "").includes("first paragraph"),
  );
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
  await page.waitForFunction(() => (window.getSelection()?.toString() ?? "").length > 0);
  await expect(highlightBtn).toBeEnabled({ timeout: 3_000 });
  await highlightBtn.click();

  // Two separate annotations.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(2, {
    timeout: 10_000,
  });
  expect(await getAnnotationCount()).toBe(2);
});

// These four tests verify keyboard behaviour for the floating selection mini-toolbar
// (role="toolbar" aria-label="Selection tools"). Focus is placed on the first button
// directly — this tests within-toolbar keyboard navigation, not the tab-to-toolbar path
// (which depends on DOM order and varies by layout). APG Toolbar Pattern §3 classifies
// roving-tabindex as MAY for transient toolbars; Tab/Shift+Tab + Escape-to-close is
// fully compliant.

/** Open the file, select the first paragraph, and wait for the mini-toolbar Bold button. */
async function openAndWaitForToolbar(page: import("@playwright/test").Page) {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", { timeout: 10_000 });
  await editor.click();
  await editor.locator("p").first().selectText();
  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });
  await expect(toolbar).toBeVisible({ timeout: 5_000 });
  await expect(toolbar.getByRole("button", { name: "Bold" })).toBeVisible({ timeout: 3_000 });
  return { editor, toolbar };
}

/** Return the aria-label of the currently focused element. */
async function getFocusedLabel(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
}

test("Tab from selection moves focus through mini-toolbar buttons in DOM order", async ({
  page,
}) => {
  const { toolbar } = await openAndWaitForToolbar(page);

  await toolbar.getByRole("button", { name: "Bold" }).focus();
  expect(await getFocusedLabel(page)).toBe("Bold");

  await page.keyboard.press("Tab");
  const secondFocused = await getFocusedLabel(page);
  expect(secondFocused).toBeTruthy();
  expect(secondFocused).not.toBe("Bold");

  const inToolbar = await page.evaluate(
    () =>
      document.activeElement?.closest('[role="toolbar"][aria-label="Selection tools"]') !== null,
  );
  expect(inToolbar).toBe(true);
});

test("Shift+Tab cycles backwards through mini-toolbar buttons", async ({ page }) => {
  const { toolbar } = await openAndWaitForToolbar(page);

  // Focus Bold, Tab to Italic, Shift+Tab back to Bold.
  await toolbar.getByRole("button", { name: "Bold" }).focus();
  await page.keyboard.press("Tab");
  expect(await getFocusedLabel(page)).not.toBe("Bold");

  await page.keyboard.press("Shift+Tab");
  expect(await getFocusedLabel(page)).toBe("Bold");
});

test("Enter activates the focused mini-toolbar Bold button", async ({ page }) => {
  const { editor, toolbar } = await openAndWaitForToolbar(page);

  // Enter on a focused button fires onclick with detail===0, which toggleBold.
  await toolbar.getByRole("button", { name: "Bold" }).focus();
  await page.keyboard.press("Enter");

  await expect(editor.locator("strong")).toContainText("first paragraph", { timeout: 3_000 });
});

test("Escape closes the mini-toolbar and returns focus to the editor", async ({ page }) => {
  const { editor, toolbar } = await openAndWaitForToolbar(page);

  await toolbar.getByRole("button", { name: "Bold" }).focus();
  await page.keyboard.press("Escape");

  await expect(toolbar).toBeHidden({ timeout: 3_000 });
  await expect(editor).toBeFocused({ timeout: 2_000 });
});
