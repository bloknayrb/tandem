/**
 * Deterministic screenshot capture for docs/screenshots/*.png.
 *
 * Gated behind `SCREENSHOTS=1` so it never runs in CI or `npm run test:e2e`.
 * To regenerate the screenshot set (e.g. after a UI refresh):
 *
 *   SCREENSHOTS=1 npx playwright test screenshots --workers=1
 *
 * Each test writes directly to `docs/screenshots/*.png`. The sample document
 * is `sample/welcome.md`, which ships with the repo, so output is stable
 * across runs as long as that file doesn't change.
 */
import { expect, Page, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { cleanupAllOpenDocuments, McpTestClient, switchToAnnotationsTab } from "./helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const screenshotsDir = path.join(repoRoot, "docs", "screenshots");
const welcomePath = path.join(repoRoot, "sample", "welcome.md");

// Skip the entire file unless explicitly requested.
test.skip(!process.env.SCREENSHOTS, "manual screenshot capture — run with SCREENSHOTS=1 to enable");

let mcp: McpTestClient;

test.beforeAll(() => {
  fs.mkdirSync(screenshotsDir, { recursive: true });
});

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  // Start with a clean slate — close anything previous tests left open.
  await cleanupAllOpenDocuments(mcp);
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
});

/** Open welcome.md and seed a handful of annotations for a realistic shot. */
async function openWithAnnotations() {
  await mcp.callTool("tandem_open", { filePath: welcomePath });

  // Offsets target text in the welcome doc. The sample file is stable across
  // releases, so these ranges are approximate but should land on readable
  // content. Annotations default to the active document.
  await mcp.callTool("tandem_highlight", {
    from: 10,
    to: 24,
    color: "yellow",
    note: "Nice opener",
  });
  await mcp.callTool("tandem_comment", {
    from: 200,
    to: 260,
    text: "Could tighten this — consider dropping the parenthetical.",
  });
  await mcp.callTool("tandem_suggest", {
    from: 400,
    to: 470,
    newText: "The team hit the first two goals early but missed the dashboard deadline.",
    reason: "More concise summary",
  });
}

/** Load the app, wait for the editor + first annotation card, settle animations. */
async function gotoAnnotatedEditor(page: Page) {
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await switchToAnnotationsTab(page);
  await expect(page.locator("[data-testid^='annotation-card-']").first()).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(500);
}

test("01-editor-overview", async ({ page }) => {
  await openWithAnnotations();
  await gotoAnnotatedEditor(page);
  await page.screenshot({
    path: path.join(screenshotsDir, "01-editor-overview.png"),
    fullPage: false,
  });
});

test("03-side-panel", async ({ page }) => {
  await openWithAnnotations();
  await gotoAnnotatedEditor(page);
  // Crop to just the side panel region. The panel is on the right side of
  // the window; compute a bounding box from the first annotation card's
  // ancestor container.
  const panel = page.locator("[data-testid^='annotation-card-']").first();
  const box = await panel.boundingBox();
  if (!box) throw new Error("Could not measure side panel bounds");
  // Capture a 420px-wide vertical slice anchored to the right edge of the viewport.
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("No viewport");
  const panelWidth = 420;
  await page.screenshot({
    path: path.join(screenshotsDir, "03-side-panel.png"),
    clip: {
      x: viewport.width - panelWidth,
      y: 0,
      width: panelWidth,
      height: viewport.height,
    },
  });
});

test("04-toolbar-actions", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: welcomePath });
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  // Select some text in the first paragraph to reveal the annotation toolbar.
  await page.evaluate(() => {
    const pm = document.querySelector(".ProseMirror");
    if (!pm) return;
    const firstPara = pm.querySelector("p");
    if (!firstPara) return;
    const range = document.createRange();
    const textNode = firstPara.firstChild;
    if (!textNode) return;
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(30, textNode.textContent?.length ?? 0));
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    pm.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(300);
  // Full-viewport screenshot so the toolbar + selection are both in frame.
  await page.screenshot({
    path: path.join(screenshotsDir, "04-toolbar-actions.png"),
    fullPage: false,
  });
});

test("09-settings-popover", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: welcomePath });
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-testid='settings-btn']").click();
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 3_000 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(screenshotsDir, "09-settings-popover.png"),
    fullPage: false,
  });
});
