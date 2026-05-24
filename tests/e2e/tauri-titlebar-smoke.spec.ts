/**
 * Tauri-only smoke test: clicking titlebar buttons fires their handlers.
 *
 * Background: PR #765 Wave G regressed the titlebar by moving
 * `data-tauri-drag-region` onto the root, turning every action button into a
 * drag-region descendant. The OS then treated button clicks as
 * window-drag-grabs and they never reached the WebView. The regression was
 * caught by visual review, but only after multiple reviewer-agent false
 * negatives (issue #767 for context).
 *
 * This spec is the automated catch: in the Tauri WebView path, each titlebar
 * button must observably toggle state. The browser-mode CI path can't validate
 * the drag-region behaviour (only the Tauri WebView interprets
 * `data-tauri-drag-region`), so the spec skips when `TANDEM_TAURI_SIDECAR !==
 * "1"`. Wiring this into a Tauri CI matrix is tracked in the issue thread.
 *
 * NOTE: this Linux container can't validate the Tauri WebView path. A
 * maintainer must add a Tauri matrix entry to CI for the spec to provide its
 * intended coverage; until then it SKIPs cleanly in browser-mode CI.
 */
import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

test.describe("Tauri titlebar button smoke test", () => {
  test.skip(process.env.TANDEM_TAURI_SIDECAR !== "1", "Tauri-only smoke test");

  let mcp: McpTestClient;
  let tmpDir: string;

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

  test("titlebar-toggle-left click toggles the left panel", async ({ page }) => {
    await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
    await page.goto("http://127.0.0.1:5173");
    await expect(
      page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" }),
    ).toBeVisible();

    // Left panel visibility is observable via the resize handle: it renders
    // only while the rail is visible, mirroring the existing
    // keyboard-shortcuts spec's Alt+Shift+Left assertion (lines 213–240).
    const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
    const initialCount = await leftHandle.count();

    const toggle = page.locator("[data-testid='titlebar-toggle-left']");
    await expect(toggle).toBeVisible();
    await toggle.click();

    // If the click reached the WebView, visibility flipped. If the drag region
    // swallowed the click (the regression we're catching), count stays the same.
    await expect.poll(async () => leftHandle.count()).not.toBe(initialCount);

    // Toggle back so the second click round-trips state cleanly.
    await toggle.click();
    await expect.poll(async () => leftHandle.count()).toBe(initialCount);
  });

  test("titlebar-toggle-right click toggles the right panel", async ({ page }) => {
    await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
    await page.goto("http://127.0.0.1:5173");
    await expect(
      page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" }),
    ).toBeVisible();

    // Right panel uses `panel-resize-handle` (no `right-` prefix) per
    // keyboard-shortcuts.spec.ts lines 242–263.
    const rightHandle = page.locator("[data-testid='panel-resize-handle']");
    const initialCount = await rightHandle.count();

    const toggle = page.locator("[data-testid='titlebar-toggle-right']");
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect.poll(async () => rightHandle.count()).not.toBe(initialCount);

    await toggle.click();
    await expect.poll(async () => rightHandle.count()).toBe(initialCount);
  });

  test("titlebar-theme-toggle click flips data-theme on documentElement", async ({ page }) => {
    await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
    await page.goto("http://127.0.0.1:5173");
    await expect(
      page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" }),
    ).toBeVisible();

    const readTheme = () =>
      page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const before = await readTheme();

    const toggle = page.locator("[data-testid='titlebar-theme-toggle']");
    await expect(toggle).toBeVisible();
    await toggle.click();

    // useTheme.svelte.ts writes `data-theme` synchronously inside the effect,
    // but Svelte 5's flush is microtask-scheduled. Poll instead of asserting
    // immediately so the test isn't racy.
    await expect.poll(readTheme).not.toBe(before);
  });

  test("titlebar-help-btn click opens the help modal", async ({ page }) => {
    await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
    await page.goto("http://127.0.0.1:5173");
    await expect(
      page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" }),
    ).toBeVisible();

    await expect(page.locator("[data-testid='help-modal']")).toHaveCount(0);

    const helpBtn = page.locator("[data-testid='titlebar-help-btn']");
    await expect(helpBtn).toBeVisible();
    await helpBtn.click();

    await expect(page.locator("[data-testid='help-modal']")).toBeVisible({ timeout: 3_000 });
  });

  test("toolbar-authorship-toggle click flips aria-pressed", async ({ page }) => {
    await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
    await page.goto("http://127.0.0.1:5173");
    await expect(
      page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" }),
    ).toBeVisible();

    const toggle = page.locator("[data-testid='toolbar-authorship-toggle']");
    await expect(toggle).toBeVisible();
    const before = await toggle.getAttribute("aria-pressed");

    await toggle.click();

    await expect.poll(() => toggle.getAttribute("aria-pressed")).not.toBe(before);
  });
});
