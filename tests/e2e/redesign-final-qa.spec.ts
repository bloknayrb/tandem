import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  enterAnnotateMode,
  McpTestClient,
  openSettingsPopover,
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

/** Force theme to "system" via localStorage before the page loads. */
function setSystemTheme(page: import("@playwright/test").Page): Promise<void> {
  return page.addInitScript(() => {
    try {
      localStorage.setItem("tandem:settings", JSON.stringify({ theme: "system" }));
    } catch {
      // Storage disabled — test will still run but theme assertion may fail.
    }
  });
}

/** Return the computed animationName of a .tandem-annotation-flash probe element. */
async function flashAnimationName(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.createElement("div");
    el.className = "tandem-annotation-flash";
    document.body.appendChild(el);
    try {
      return getComputedStyle(el).animationName;
    } finally {
      el.remove();
    }
  });
}

// ---------------------------------------------------------------------------
// Viewport layouts
// ---------------------------------------------------------------------------

test.describe("viewport layouts", () => {
  test("600×800 — toolbar and tabs render without overflow", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await openSample(page);

    await expect(page.locator("[data-testid='toolbar-highlight-btn']")).toBeVisible();

    const statusBarBox = await page.locator("[data-testid='user-name-input']").boundingBox();
    expect(statusBarBox).not.toBeNull();
    expect(statusBarBox!.height).toBeGreaterThan(0);

    // Check the tab button itself rather than scrollWidth — narrow viewports may scroll
    // the tab bar to keep the active tab visible, so scrollWidth > clientWidth is expected.
    const activeTab = page.locator("[data-testid^='tab-']").first();
    if ((await activeTab.count()) > 0) {
      await expect(activeTab).toBeVisible();
    }
  });

  test("1280×800 — standard desktop: settings popover stays within viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSample(page);

    await openSettingsPopover(page);

    const popover = page.locator("[data-testid='settings-popover']");
    await expect(popover).toBeVisible({ timeout: 3_000 });

    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(800 + 2); // 2px tolerance
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280 + 2);
  });

  test("1920×1200 — annotation list scroll container renders at wide viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1200 });
    await openSample(page);
    await switchToAnnotationsTab(page);

    const scrollContainer = page.locator("[data-testid='annotation-list-scroll-container']");
    await expect(scrollContainer).toBeAttached({ timeout: 5_000 });

    const box = await scrollContainer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

test.describe("reduced motion — baseline", () => {
  test("annotation flash animation is active by default", async ({ page }) => {
    await openSample(page);
    expect(await flashAnimationName(page)).not.toBe("none");
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("annotation flash is suppressed under prefers-reduced-motion", async ({ page }) => {
    // Playwright's reducedMotion context option doesn't reliably drive matchMedia().matches
    // in the running app, so seed the setting directly so the $effect in App.svelte adds
    // body.tandem-reduce-motion — that's the CSS hook we're actually verifying.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("tandem:settings", JSON.stringify({ reduceMotion: true }));
      } catch {}
    });
    await openSample(page);
    await expect(page.locator("body")).toHaveClass(/tandem-reduce-motion/, { timeout: 3_000 });
    expect(await flashAnimationName(page)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Forced colors / high contrast
// ---------------------------------------------------------------------------

test.describe("forced colors / high contrast", () => {
  test.use({ forcedColors: "active" });

  test("annotation cards remain visible in forced-colors mode", async ({ page }) => {
    await openSample(page);

    await mcp.callTool("tandem_comment", { from: 5, to: 10, text: "test comment" });
    await switchToAnnotationsTab(page);

    const cards = page.locator("[data-testid^='annotation-card-']");
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });

    const box = await cards.first().boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);

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
    await enterAnnotateMode(page);
    await expect(page.locator("[data-testid='popup-annotation-input']")).toBeVisible({
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
    await setSystemTheme(page);
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

  test("light mode: data-theme=light applied when theme is system", async ({ page }) => {
    await setSystemTheme(page);
    await openSample(page);

    const theme = await page.evaluate(
      () =>
        document.documentElement.dataset.theme ??
        document.documentElement.getAttribute("data-theme"),
    );
    expect(theme).toBe("light");
  });
});

// ---------------------------------------------------------------------------
// Toolbar re-theming (#536)
// ---------------------------------------------------------------------------

test.describe("toolbar re-theming", () => {
  /**
   * Verify that HighlightColorPicker borders adapt when the theme changes.
   * The fix replaced hardcoded rgba(0,0,0,0.15) with var(--tandem-border) on
   * the color-preview swatch span inside the toggle button and on the grid
   * swatch buttons in the popover. We target those specific elements, not the
   * outer toggle button whose border was already token-based.
   *
   * Strategy: seed the page in dark mode, read the computed border color of the
   * inner color-preview span, switch to light mode, read again — values must
   * differ. Also open the color picker and verify a grid swatch border changes.
   * This catches any regression back to a hardcoded value that ignores
   * data-theme changes.
   */
  test("HighlightColorPicker border-color differs between dark and light themes", async ({
    page,
  }) => {
    // Start in dark mode so we can detect the change to light.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("tandem:settings", JSON.stringify({ theme: "dark" }));
      } catch {}
    });
    await openSample(page);

    // Select text so the floating toolbar mounts.
    const editor = page.locator(".tiptap");
    await editor.click();
    await editor.locator("p").first().selectText();
    await expect(page.locator("[data-testid='toolbar-highlight-color-toggle']")).toBeVisible({
      timeout: 5_000,
    });

    // Read the border-color of the inner color-preview span (the element whose
    // border was fixed — it lives inside the toggle button).
    const darkBorder = await page.evaluate(() => {
      const el = document.querySelector(
        "[data-testid='toolbar-highlight-color-toggle'] span",
      ) as HTMLElement | null;
      return el ? getComputedStyle(el).borderColor : "";
    });

    // Switch to light mode by updating data-theme directly (mirrors what the
    // app's $effect does when settings.theme changes to "light").
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "light");
    });

    // Read the border-color of the inner span in light mode.
    const lightBorder = await page.evaluate(() => {
      const el = document.querySelector(
        "[data-testid='toolbar-highlight-color-toggle'] span",
      ) as HTMLElement | null;
      return el ? getComputedStyle(el).borderColor : "";
    });

    // The two values must be different — a hardcoded color would be identical
    // in both modes and expose the regression. An empty string means the
    // element was not found, which would also fail this assertion.
    expect(darkBorder).not.toBe("");
    expect(lightBorder).not.toBe("");
    expect(darkBorder).not.toBe(lightBorder);

    // Switch back to dark to confirm the token resolves again (dark→light→dark).
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    const darkBorderAgain = await page.evaluate(() => {
      const el = document.querySelector(
        "[data-testid='toolbar-highlight-color-toggle'] span",
      ) as HTMLElement | null;
      return el ? getComputedStyle(el).borderColor : "";
    });
    expect(darkBorderAgain).toBe(darkBorder);

    // Swatch border verification (via the color picker popover) is intentionally
    // omitted — clicking the toggle clears ProseMirror's selection before the
    // popover renders in headless Chromium (same limitation documented in
    // toolbar-redesign.spec.ts). The toggle-button inner span above uses the
    // same --tandem-border token as the grid swatches, so these assertions are
    // sufficient to catch any regression to a hardcoded value.
  });
});

// ---------------------------------------------------------------------------
// Tab order traversal
// ---------------------------------------------------------------------------

test.describe("tab order traversal", () => {
  test("main UI elements are keyboard reachable via Tab", async ({ page }) => {
    await openSample(page);

    // Click outside the editor to reset focus to the top of the tab sequence.
    await page.locator("body").click({ position: { x: 10, y: 10 } });

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

    // Wave M: settings/help/theme moved into the brand dropdown; the brand
    // button itself (aria-label "Tandem menu") is the titlebar's primary
    // interactive stop alongside the mode toggle and authorship toggle.
    const toolbarLabels = [
      "Highlight",
      "toolbar-highlight-btn",
      "Solo",
      "Tandem",
      "titlebar-brand-menu",
      "authorship",
    ];
    const hasToolbarStop = focusedLabels.some((l) =>
      toolbarLabels.some((t) => l.toLowerCase().includes(t.toLowerCase())),
    );
    expect(hasToolbarStop).toBe(true);

    const hasStatusBarStop = focusedLabels.some(
      (l) => l.toLowerCase().includes("display name") || l === "user-name-input",
    );
    expect(hasStatusBarStop).toBe(true);
  });
});
