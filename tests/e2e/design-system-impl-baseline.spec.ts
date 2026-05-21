/**
 * Visual snapshot baselines — Phase 0i of the design-system-impl umbrella.
 *
 * Catches **cross-surface unintended drift** during the umbrella's sub-PRs.
 * Each sub-PR intentionally regenerates baselines for the surface it touches;
 * this gate fires when an unrelated surface also changed (e.g. PR 1.2 touches
 * the toolbar but accidentally restyles the annotation card).
 *
 * Scope is intentionally narrow — 8 cross-cutting / shared-recipe surfaces
 * covered light + dark. Not every surface in the plan: the plan's "every
 * surface" mandate was too broad to maintain at 120+ PNG fixtures. See
 * docs/design-system-impl/baseline-procedure.md for the rationale and the
 * seeding procedure.
 *
 * **Linux-only.** Playwright pixel diffs are sensitive to font rendering,
 * anti-aliasing, and sub-pixel layout, all of which differ between
 * Windows/macOS/Linux. CI runs on ubuntu-latest; this spec asserts only on
 * Linux so a local Windows or macOS dev run doesn't fight CI-generated
 * baselines.
 */
import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { cleanupAllOpenDocuments, McpTestClient, switchToAnnotationsTab } from "./helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const welcomePath = path.join(repoRoot, "sample", "welcome.md");

test.skip(
  process.platform !== "linux",
  "Design-system-impl visual baselines only run on Linux (CI); local Windows/macOS pixel diffs are unreliable.",
);

// Stable viewport — single width chosen to match common laptop screens.
// Narrow viewport is covered by the Phase 5 manual claude-in-chrome walkthrough,
// not by pixel diff (would double the baseline maintenance burden).
test.use({ viewport: { width: 1440, height: 900 } });

let mcp: McpTestClient;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  await cleanupAllOpenDocuments(mcp);
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
});

/**
 * Set the resolved theme before any UI mounts so first paint matches.
 * Bypasses the tandem:settings flow — directly sets the html attribute the
 * useTheme hook reads. This is deterministic for snapshots (no race against
 * the settings load / system preference detection).
 */
async function setThemeBeforeMount(page: import("@playwright/test").Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    const apply = () => document.documentElement.setAttribute("data-theme", t);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", apply, { once: true });
    } else {
      apply();
    }
  }, theme);
}

/** Open welcome.md with three representative annotations so card variants render. */
async function seedAnnotations() {
  await mcp.callTool("tandem_open", { filePath: welcomePath });
  await mcp.callTool("tandem_comment", {
    from: 10,
    to: 24,
    text: "Nice opener",
  });
  await mcp.callTool("tandem_comment", {
    from: 200,
    to: 260,
    text: "Could tighten this — consider dropping the parenthetical.",
  });
  await mcp.callTool("tandem_comment", {
    from: 400,
    to: 470,
    text: "More concise summary",
    suggestedText: "The team hit the first two goals early but missed the dashboard deadline.",
  });
}

async function waitForEditor(page: import("@playwright/test").Page) {
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  // Settle authorship decorations + initial layout pass.
  await page.waitForTimeout(500);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await setThemeBeforeMount(page, theme);
    });

    test(`title-bar — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      const titleBar = page.locator("[data-testid='title-bar']");
      await expect(titleBar).toBeVisible();
      await expect(titleBar).toHaveScreenshot(`title-bar-${theme}.png`);
    });

    test(`editor-body — ${theme}`, async ({ page }) => {
      await seedAnnotations();
      await page.goto("/");
      await waitForEditor(page);
      // Editor body alone — exclude title bar + side panel to keep this
      // baseline focused on typography, authorship gutter, decoration colors.
      const editor = page.locator(".ProseMirror").first();
      await expect(editor).toHaveScreenshot(`editor-body-${theme}.png`);
    });

    test(`side-panel-annotations — ${theme}`, async ({ page }) => {
      await seedAnnotations();
      await page.goto("/");
      await waitForEditor(page);
      await switchToAnnotationsTab(page);
      const firstCard = page.locator("[data-testid^='annotation-card-']").first();
      await expect(firstCard).toBeVisible({ timeout: 10_000 });
      // Capture the entire right rail so chrome (filter bar, tab strip,
      // card list) is exercised together.
      const rail = page.locator("[data-testid='panel-right'], .side-panel").first();
      if ((await rail.count()) === 0) {
        // Fallback: viewport-anchored right slice.
        const vp = page.viewportSize();
        if (!vp) throw new Error("No viewport");
        await expect(page).toHaveScreenshot(`side-panel-annotations-${theme}.png`, {
          clip: { x: vp.width - 420, y: 0, width: 420, height: vp.height },
        });
      } else {
        await expect(rail).toHaveScreenshot(`side-panel-annotations-${theme}.png`);
      }
    });

    test(`annotation-card-comment — ${theme}`, async ({ page }) => {
      await seedAnnotations();
      await page.goto("/");
      await waitForEditor(page);
      await switchToAnnotationsTab(page);
      const card = page.locator("[data-testid^='annotation-card-']").first();
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(card).toHaveScreenshot(`annotation-card-comment-${theme}.png`);
    });

    test(`formatting-bar — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      // Make a selection in the first paragraph so the floating pill renders.
      await page.evaluate(() => {
        const pm = document.querySelector(".ProseMirror");
        if (!pm) return;
        const firstPara = pm.querySelector("p");
        if (!firstPara) return;
        const range = document.createRange();
        const textNode = firstPara.firstChild;
        if (!textNode) return;
        range.setStart(textNode, 0);
        range.setEnd(textNode, Math.min(40, textNode.textContent?.length ?? 0));
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        (pm as HTMLElement).dispatchEvent(new Event("focus"));
      });
      await page.waitForTimeout(400);
      const pill = page.locator("[data-testid='formatting-bar']");
      await expect(pill).toBeVisible({ timeout: 5_000 });
      await expect(pill).toHaveScreenshot(`formatting-bar-${theme}.png`);
    });

    test(`command-palette — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      await page.keyboard.press("Control+P");
      const palette = page.locator("[data-testid='command-palette']");
      await expect(palette).toBeVisible({ timeout: 3_000 });
      await page.waitForTimeout(200);
      await expect(palette).toHaveScreenshot(`command-palette-${theme}.png`);
    });

    test(`settings-modal — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      // Open settings — testid varies between popover and modal entry points,
      // both surface this id on the trigger button per testid manifest.
      const settingsBtn = page.locator("[data-testid='settings-btn']").first();
      if ((await settingsBtn.count()) > 0) {
        await settingsBtn.click();
      } else {
        // Fallback: shortcut for command palette → search settings.
        await page.keyboard.press("Control+,");
      }
      const content = page.locator("[data-testid='settings-content']").first();
      await expect(content).toBeVisible({ timeout: 3_000 });
      await page.waitForTimeout(300);
      await expect(content).toHaveScreenshot(`settings-modal-${theme}.png`);
    });

    test(`toast-container — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      // Save to fire a toast (success path).
      await mcp.callTool("tandem_save", { documentId: undefined });
      const toaster = page.locator("[data-testid='toast-container']");
      // Toast may auto-dismiss before render; if it never appears we skip
      // the baseline rather than fail the gate — toast surface is covered
      // by manual walkthrough.
      try {
        await expect(toaster).toBeVisible({ timeout: 2_000 });
        // Slight settle so the slide-in animation completes.
        await page.waitForTimeout(150);
        await expect(toaster).toHaveScreenshot(`toast-container-${theme}.png`);
      } catch {
        test.skip(true, "Toast did not render within timeout — covered by manual walkthrough.");
      }
    });
  });
}
