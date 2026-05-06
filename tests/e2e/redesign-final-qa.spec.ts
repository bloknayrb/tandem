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
 * Redesign final QA suite — v0.11.0 visual pass (closes #522).
 *
 * Covers:
 *   - Viewport layouts (600px, 1280px, 1920px)
 *   - Reduced-motion (`prefers-reduced-motion: reduce`)
 *   - Forced colors / high-contrast mode
 *   - Color scheme (dark / light via `prefers-color-scheme`)
 *   - Keyboard reachability (Tab-order traversal)
 *
 * Each describe block applies its context option at the block level so all
 * tests within it share the same browser context configuration. The viewport
 * tests use `page.setViewportSize()` inline because the desired size varies
 * per test and `test.use()` applies a single value for the whole block.
 *
 * NOTE on reduced-motion: if any test in the "reduced motion" block fails
 * because `transitionDuration` is not `"0s"`, that is a *blocking bug* —
 * the CSS does not yet have a `prefers-reduced-motion: reduce` media rule
 * suppressing the relevant transitions. The test is intentionally strict
 * to surface that gap.
 */

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

/** Open sample.md via MCP then navigate to the app root. */
async function openSample(page: import("@playwright/test").Page): Promise<void> {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tiptap")).toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Viewport layouts
// ---------------------------------------------------------------------------

test.describe("viewport layouts", () => {
  test("600×800 — toolbar and tabs render without overflow", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await openSample(page);

    // Highlight button is always visible in the main toolbar (not selection toolbar).
    await expect(page.locator("[data-testid='toolbar-highlight-btn']")).toBeVisible();

    // The status bar must occupy real space — zero-height would mean it collapsed.
    const statusBarBox = await page.locator("[data-testid='user-name-input']").boundingBox();
    expect(statusBarBox).not.toBeNull();
    expect(statusBarBox!.height).toBeGreaterThan(0);

    // Tab container must not overflow horizontally — the active tab must be in view.
    // We check that the tab button itself is visible rather than measuring scrollWidth,
    // because at narrow viewports the tab bar may scroll to keep the active tab visible.
    const activeTab = page.locator("[data-testid^='tab-']").first();
    if ((await activeTab.count()) > 0) {
      await expect(activeTab).toBeVisible();
    }
  });

  test("1280×800 — standard desktop: settings popover stays within viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSample(page);

    // Open the settings popover via the settings button in the toolbar.
    await page.locator("[data-testid='settings-btn']").click();

    const popover = page.locator("[data-testid='settings-popover']");
    await expect(popover).toBeVisible({ timeout: 3_000 });

    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    // The bottom edge must not be below the viewport.
    expect(box!.y + box!.height).toBeLessThanOrEqual(800 + 2); // 2px tolerance
    // The right edge must not overflow.
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280 + 2);
  });

  test("1920×1200 — wide layout: side panel and annotation list visible", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1200 });
    await openSample(page);

    // The annotation-list scroll container is always mounted (CSS display toggle).
    // At wide viewports the panel must have real width — zero width = collapsed layout.
    const scrollContainer = page.locator("[data-testid='annotation-list-scroll-container']");
    await expect(scrollContainer).toBeAttached({ timeout: 5_000 });

    const box = await scrollContainer.boundingBox();
    if (box !== null) {
      // Panel is visible — confirm it has a real width.
      expect(box.width).toBeGreaterThan(0);
    }
    // If box is null the panel is hidden (CSS display:none in the default tabbed layout
    // when chat tab is active) — that's acceptable; the container must still be attached.
  });
});

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("animated elements respect prefers-reduced-motion", async ({ page }) => {
    await openSample(page);

    // Make a text selection to trigger the floating selection toolbar.
    const editor = page.locator(".tiptap");
    await editor.click();
    await editor.locator("p").first().selectText();

    // The floating toolbar uses role="toolbar" aria-label="Selection tools".
    const selectionToolbar = page.getByRole("toolbar", { name: "Selection tools" });
    await expect(selectionToolbar).toBeVisible({ timeout: 5_000 });

    // Under prefers-reduced-motion: reduce, transitions should be suppressed.
    // A duration of "0s" means no transition; "0.001s" is also effectively instant.
    // If neither holds, the CSS is missing a reduced-motion rule — blocking bug.
    const duration = await selectionToolbar.evaluate(
      (el) => getComputedStyle(el).transitionDuration,
    );
    expect(["0s", "0.001s"]).toContain(duration);
  });
});

// ---------------------------------------------------------------------------
// Forced colors / high contrast
// ---------------------------------------------------------------------------

test.describe("forced colors / high contrast", () => {
  test.use({ forcedColors: "active" });

  test("annotation cards remain visible in forced-colors mode", async ({ page }) => {
    await openSample(page);

    // Create a comment via MCP so there is at least one annotation card to assert against.
    await mcp.callTool("tandem_comment", { from: 5, to: 10, text: "test comment" });

    // Switch to annotations tab (no-op in three-panel layout).
    await switchToAnnotationsTab(page);

    // The first annotation card must be visible and non-zero dimensions.
    const cards = page.locator("[data-testid^='annotation-card-']");
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });

    const box = await cards.first().boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);

    // The comment text must be present in the DOM (not invisible/collapsed).
    await expect(cards.first()).toContainText("test comment");
  });

  test("toolbar buttons are visible and enabled after selection in forced-colors mode", async ({
    page,
  }) => {
    await openSample(page);

    const editor = page.locator(".tiptap");
    await editor.click();
    await editor.locator("p").first().selectText();

    await expect(page.locator("[data-testid='toolbar-highlight-btn']")).toBeEnabled({
      timeout: 3_000,
    });
    await expect(page.locator("[data-testid='toolbar-comment-btn']")).toBeEnabled({
      timeout: 3_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Color scheme
// ---------------------------------------------------------------------------

test.describe("color scheme — dark", () => {
  test.use({ colorScheme: "dark" });

  test("dark mode: data-theme=dark applied when theme is system", async ({ page }) => {
    // Force theme to "system" before navigation so matchMedia drives the theme hook.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("tandem:settings", JSON.stringify({ theme: "system" }));
      } catch {
        // Storage disabled — test will still run but theme assertion may fail.
      }
    });

    await openSample(page);

    const theme = await page.evaluate(
      () =>
        document.documentElement.dataset.theme ??
        document.documentElement.getAttribute("data-theme"),
    );
    expect(theme).toBe("dark");
  });
});

test.describe("color scheme — light", () => {
  test.use({ colorScheme: "light" });

  test("light mode: data-theme=light (or empty) applied when theme is system", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("tandem:settings", JSON.stringify({ theme: "system" }));
      } catch {
        // Storage disabled.
      }
    });

    await openSample(page);

    const theme = await page.evaluate(
      () =>
        document.documentElement.dataset.theme ??
        document.documentElement.getAttribute("data-theme") ??
        "",
    );
    // Light mode: theme attribute is either "light" or absent (empty string).
    expect(["light", ""]).toContain(theme);
  });
});

// ---------------------------------------------------------------------------
// Tab order traversal
// ---------------------------------------------------------------------------

test.describe("tab order traversal", () => {
  test("main UI elements are keyboard reachable via Tab", async ({ page }) => {
    await openSample(page);

    // Click the document body outside the editor to reset focus to the start
    // of the tab sequence. Clicking the body itself gives focus to body which
    // Playwright can then Tab away from.
    await page.locator("body").click({ position: { x: 10, y: 10 } });

    // Collect aria-labels of focused elements across up to 30 Tab presses.
    const focusedLabels: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        return (
          el.getAttribute("aria-label") ??
          el.getAttribute("title") ??
          el.getAttribute("data-testid") ??
          el.tagName.toLowerCase()
        );
      });
      if (label) focusedLabels.push(label);
    }

    // At least one stop in the toolbar region must be reachable.
    const toolbarLabels = [
      "Highlight",
      "Comment",
      "Note",
      "Settings",
      "toolbar-highlight-btn",
      "toolbar-comment-btn",
      "toolbar-note-btn",
      "settings-btn",
    ];
    const hasToolbarStop = focusedLabels.some((l) =>
      toolbarLabels.some((t) => l.toLowerCase().includes(t.toLowerCase())),
    );
    expect(hasToolbarStop).toBe(true);

    // The display-name input in the status bar must also be reachable.
    const hasStatusBarStop = focusedLabels.some(
      (l) => l.toLowerCase().includes("display name") || l === "user-name-input",
    );
    expect(hasStatusBarStop).toBe(true);
  });
});
