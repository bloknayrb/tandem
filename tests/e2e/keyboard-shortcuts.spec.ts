import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md", "sample2.md", "link-target.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("Ctrl+W closes the active tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://localhost:5173");

  // Both tabs visible
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();
  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample2).toBeVisible();

  // sample2.md is active by default (last opened). Press Ctrl+W.
  await page.keyboard.press("Control+w");

  // sample2.md tab is gone, sample.md remains.
  await expect(sample2).toHaveCount(0);
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();
});

test("Ctrl+O opens the file dialog", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Dialog absent before the shortcut
  await expect(page.locator("[data-testid='file-open-dialog']")).toHaveCount(0);

  await page.keyboard.press("Control+o");
  await expect(page.locator("[data-testid='file-open-dialog']")).toBeVisible();
});

test("'+' button → Browse opens the file dialog", async ({ page }) => {
  // Guards the post-refactor onRequestOpenDialog plumbing: DocumentTabs no longer
  // renders FileOpenDialog directly, so the existing "+" → Browse path must still
  // reach the lifted dialog rendering in App.svelte.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid='open-file-btn']")).toBeVisible();

  await page.locator("[data-testid='open-file-btn']").click();
  await page.getByRole("menuitem", { name: "Browse files…" }).click();

  await expect(page.locator("[data-testid='file-open-dialog']")).toBeVisible();
});

test("Ctrl+N switches to the Nth tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "link-target.md") });
  await page.goto("http://localhost:5173");

  // Wait for all three tabs.
  await expect(page.locator("[data-testid^='tab-name-']")).toHaveCount(3);

  // Tabs are role="tab" with aria-selected.
  const tabs = page.locator("[role='tab']");

  // Press Ctrl+1 — first tab becomes active.
  await page.keyboard.press("Control+1");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

  // Press Ctrl+2 — second tab.
  await page.keyboard.press("Control+2");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

  // Press Ctrl+9 — clamps to last (3rd) tab.
  await page.keyboard.press("Control+9");
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
});

test("Ctrl+W is ignored while a form input has focus", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Open the find bar and focus its input (an INPUT element).
  await page.keyboard.press("Control+f");
  const findInput = page.locator("[data-testid='find-input']");
  await expect(findInput).toBeVisible();
  await findInput.focus();

  // Press Ctrl+W — the guard should swallow it; tab must still be present.
  await page.keyboard.press("Control+w");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();
});

test("Help modal advertises the new shortcuts", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Open via the title-bar help button — the "?" keyboard shortcut is intentionally
  // suppressed while focus is inside the contenteditable editor.
  await page.locator("[data-testid='titlebar-help-btn']").click();
  const modal = page.locator("[data-testid='help-modal']");
  await expect(modal).toBeVisible();

  await expect(modal.getByText("Close active tab")).toBeVisible();
  await expect(modal.getByText("Open file…")).toBeVisible();
  await expect(modal.getByText("Jump to tab by number")).toBeVisible();
  await expect(modal.getByText("Find in open tabs")).toBeVisible();
  await expect(modal.getByText("Find next match")).toBeVisible();
  await expect(modal.getByText("Find previous match")).toBeVisible();
  await expect(modal.getByText("Toggle Solo / Tandem mode")).toBeVisible();
  await expect(modal.getByText("Toggle left panel")).toBeVisible();
  await expect(modal.getByText("Toggle right panel")).toBeVisible();
  await expect(modal.getByText("Reopen closed tab (this session)")).toBeVisible();
});

test("Ctrl+Shift+F opens the find bar pre-scoped to Open tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']")).toHaveCount(2);

  await page.keyboard.press("Control+Shift+F");
  await expect(page.locator("[data-testid='find-replace-bar']")).toBeVisible();
  await expect(page.locator("[data-testid='find-scope-tabs']")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("Ctrl+Shift+F with one tab open hides scope pills (single-doc fallback)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.keyboard.press("Control+Shift+F");
  await expect(page.locator("[data-testid='find-replace-bar']")).toBeVisible();
  // Scope pills only render when tabs.length > 1 (existing FindReplaceBar guard).
  await expect(page.locator("[data-testid='find-scope-pills']")).toHaveCount(0);
});

test("Ctrl+G with no active query opens the find bar", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await expect(page.locator("[data-testid='find-replace-bar']")).toHaveCount(0);
  await page.keyboard.press("Control+g");
  await expect(page.locator("[data-testid='find-replace-bar']")).toBeVisible();
});

// Notes on coverage scope:
// - The "no active query → open find bar" smart-fallback above is the
//   regression-risk behavior unique to this PR.
// - "Ctrl+G with active query advances to the next match" is exercised in unit
//   tests via `shouldDispatchFindNav` (the only logic the keydown branch adds
//   on top of Tiptap's own `findNext` command). End-to-end assertion through
//   Yjs + ProseMirror + the find-replace plugin proved too brittle for stable
//   CI — match-count timing depends on collab-extension sync internals.
// - The "Ctrl+G is ignored when a form input has focus" guard is covered by
//   the existing "Ctrl+W is ignored" test (same shouldIgnoreShortcut helper).

test("Ctrl+Shift+M toggles solo / tandem mode", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Default mode is tandem.
  const tandemBtn = page.locator("[data-testid='mode-tandem-btn']");
  const soloBtn = page.locator("[data-testid='mode-solo-btn']");
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Control+Shift+M");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "true");
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Control+Shift+M");
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
});

test("Ctrl+\\ toggles the left panel", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Capture initial left-panel visibility via the resize-handle testid.
  const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
  const initial = await leftHandle.count();

  await page.keyboard.press("Control+\\");
  await expect.poll(async () => leftHandle.count()).not.toBe(initial);

  await page.keyboard.press("Control+\\");
  await expect.poll(async () => leftHandle.count()).toBe(initial);
});

test("Ctrl+Shift+\\ toggles the right panel", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  const rightHandle = page.locator("[data-testid='panel-resize-handle']");
  const initial = await rightHandle.count();

  await page.keyboard.press("Control+Shift+\\");
  await expect.poll(async () => rightHandle.count()).not.toBe(initial);

  await page.keyboard.press("Control+Shift+\\");
  await expect.poll(async () => rightHandle.count()).toBe(initial);
});

test("Ctrl+Alt+T reopens the most recently closed tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://localhost:5173");

  const sample = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample).toBeVisible();
  await expect(sample2).toBeVisible();

  // Close active tab (sample2.md is last-opened, so it's active).
  await page.keyboard.press("Control+w");
  await expect(sample2).toHaveCount(0);

  // Reopen via Ctrl+Alt+T.
  await page.keyboard.press("Control+Alt+t");
  await expect(sample2).toBeVisible();
});

test("Ctrl+Alt+T no-ops when no tabs have been closed", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // No tabs closed yet — pressing the shortcut should be a silent no-op.
  await page.keyboard.press("Control+Alt+t");
  await expect(page.locator("[data-testid^='tab-name-']")).toHaveCount(1);
  expect(errors).toHaveLength(0);
});

test("Ctrl+Alt+T after closing via the X button (DocumentTabs path) reopens", async ({ page }) => {
  // Verifies that closeTabAndRecord wraps the DocumentTabs onTabClose prop, not
  // just the Ctrl+W keydown branch.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://localhost:5173");

  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample2).toBeVisible();

  // Click the X button on sample2's tab. The TabItem renders a close button
  // inside the tab; locate it relative to the tab-name span's tab container.
  // (Per CLAUDE.md the tab itself has data-testid="tab-{id}", and the close
  //  button is inside it with role="button" / appropriate aria.)
  const sample2Tab = page.locator("[role='tab']").filter({ has: sample2 });
  // The close button is the only button inside the tab item.
  await sample2Tab.locator("button").first().click();
  await expect(sample2).toHaveCount(0);

  await page.keyboard.press("Control+Alt+t");
  await expect(sample2).toBeVisible();
});
