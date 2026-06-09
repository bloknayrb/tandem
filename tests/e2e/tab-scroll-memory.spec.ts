import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

// #1055: switching away from a tab and back should restore that tab's vertical
// scroll position instead of jumping to the top. The `.editor-scroll` container
// (data-testid="editor-scroll-container") is always-mounted across tab switches,
// so this exercises the per-tab scroll-memory map + restore-on-switch effect.

let mcp: McpTestClient;
let tmpDir: string;

const APP_URL = "http://127.0.0.1:5173";

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  // `tall.md` is long enough to overflow the editor; `sample2.md` is the
  // second tab we switch to and back from.
  tmpDir = createFixtureDir("tall.md", "sample2.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

/** Locate a tab (role='tab') by its visible filename. */
function tabByName(page: import("@playwright/test").Page, name: string) {
  return page.locator("[data-testid^='tab-'][role='tab']").filter({ hasText: name });
}

test("scroll position is restored after switching tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "tall.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto(APP_URL);

  // Activate the tall document and wait for it to render + overflow.
  const tallTab = tabByName(page, "tall.md");
  await expect(tallTab).toBeVisible();
  await tallTab.click();

  const scroller = page.locator("[data-testid='editor-scroll-container']");
  await expect(scroller).toBeVisible();

  // Wait until the content is tall enough to scroll meaningfully.
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(400);

  // Scroll the tall document down by a fixed amount and confirm it took.
  const TARGET = 600;
  await scroller.evaluate((el, top) => {
    el.scrollTop = top;
  }, TARGET);
  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);
  const savedTop = await scroller.evaluate((el) => el.scrollTop);

  // Switch to the second tab, then back to the tall document.
  const otherTab = tabByName(page, "sample2.md");
  await expect(otherTab).toBeVisible();
  await otherTab.click();
  // The second doc is short — its scroll position is effectively 0.
  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(50);

  await tallTab.click();

  // Back on the tall document, the previous scroll position is restored
  // (within a small tolerance for sub-pixel rounding / layout reflow).
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollTop), { timeout: 5_000 })
    .toBeGreaterThan(savedTop - 50);
});
