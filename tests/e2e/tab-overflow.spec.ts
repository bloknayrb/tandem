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
  tmpDir = createFixtureDir("sample.md", "sample2.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("tab renders with filename, tooltip shows full path", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");

  // Wait for the sample.md tab by its name content
  const tabName = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  await expect(tabName).toBeVisible();

  // Tooltip should show full file path
  const title = await tabName.getAttribute("title");
  expect(title).toContain("sample.md");
  expect(title).toContain(path.sep); // Should be a full path, not just filename
});

test("tab scroll container exists", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await page.waitForSelector("[data-testid='tab-scroll-container']");

  const container = page.locator("[data-testid='tab-scroll-container']");
  await expect(container).toBeVisible();
});

test("multiple tabs appear", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  // Both our test tabs should be present
  const sample1 = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample1).toBeVisible();
  await expect(sample2).toBeVisible();
});

test("keyboard reorder with Alt+Arrow swaps tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  // Wait for sample2.md tab to appear.
  const sample2Name = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample2Name).toBeVisible();

  // The tab element (role='tab') owns the keyboard handler — focus must land
  // there, not on the inner [tab-name-…] span. Match the drag test pattern below.
  const tabs = page.locator("[data-testid^='tab-'][role='tab']");
  const sample2Tab = tabs.filter({ hasText: "sample2.md" });

  // Get all tab names and find sample2's position. One round trip via
  // `allTextContents()` beats a sequential `nth(i).textContent()` loop.
  const allNames = page.locator("[data-testid^='tab-name-']");
  const initialIdx = (await allNames.allTextContents()).indexOf("sample2.md");
  expect(initialIdx).toBeGreaterThan(0); // sample2 should not be first

  // Click the tab itself, wait for focus to land (auto-retry), then press
  // Alt+ArrowLeft. expect.poll on the post-reorder text absorbs Svelte
  // reactivity → DOM update latency without a fixed sleep.
  await sample2Tab.click();
  await expect(sample2Tab).toBeFocused();
  await page.keyboard.press("Alt+ArrowLeft");

  await expect.poll(async () => allNames.nth(initialIdx - 1).textContent()).toBe("sample2.md");
});

test("mouse drag reorders tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  const tabs = page.locator("[data-testid^='tab-'][role='tab']");
  const sample1Tab = tabs.filter({ hasText: "sample.md" });
  const sample2Tab = tabs.filter({ hasText: "sample2.md" });
  await expect(sample1Tab).toBeVisible();
  await expect(sample2Tab).toBeVisible();

  const allNames = page.locator("[data-testid^='tab-name-']");
  const initial = await allNames.allTextContents();
  const initialS1 = initial.indexOf("sample.md");
  const initialS2 = initial.indexOf("sample2.md");
  expect(initialS1).toBeGreaterThanOrEqual(0);
  expect(initialS2).toBeGreaterThanOrEqual(0);
  const initialDelta = initialS1 - initialS2;

  // Resolve the document ids of the two tabs by reading data-testid off the
  // rendered DOM (the [data-testid^='tab-name-'] descendant lives inside the
  // tab div whose own data-testid is `tab-{id}`).
  const tabIds = await page.evaluate(() => {
    const list: Record<string, string> = {};
    document.querySelectorAll<HTMLElement>("[data-testid^='tab-'][role='tab']").forEach((el) => {
      const tid = el.getAttribute("data-testid") ?? "";
      const id = tid.startsWith("tab-") ? tid.slice("tab-".length) : "";
      const name = el.querySelector("[data-testid^='tab-name-']")?.textContent ?? "";
      if (id && name) list[name] = id;
    });
    return list;
  });
  const s1Id = tabIds["sample.md"];
  const s2Id = tabIds["sample2.md"];
  expect(s1Id).toBeTruthy();
  expect(s2Id).toBeTruthy();

  // Drag the later-positioned tab onto the earlier one — their relative order should flip.
  // Reorder is now driven by POINTER events (DocumentTabs.svelte), not HTML5 DnD: in the
  // Tauri desktop app `dragDropEnabled: true` makes the WebView swallow HTML5 drag events,
  // so the production handlers listen on pointerdown/move/up. Playwright's page.mouse.*
  // synthesizes real pointer events, so a native mouse drag now exercises the real path
  // (it could not with the old HTML5 handlers — see docs/lessons-learned.md #70).
  const activeBefore = await page
    .locator('[data-testid^="tab-"][role="tab"][data-active="true"]')
    .getAttribute("data-testid");

  const [fromId, toId] = initialS1 < initialS2 ? [s2Id, s1Id] : [s1Id, s2Id];
  const fromBox = await page.locator(`[data-testid="tab-${fromId}"]`).boundingBox();
  const toBox = await page.locator(`[data-testid="tab-${toId}"]`).boundingBox();
  if (!fromBox || !toBox) throw new Error("tab bounding boxes not found");

  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  // Multi-step move guarantees pointermove events fire and the 5px threshold is crossed.
  // Drop on the LEFT half of the target so the handler picks side: "left".
  await page.mouse.move(toBox.x + 5, toBox.y + toBox.height / 2, { steps: 12 });
  await page.mouse.up();

  // Assert the signed index delta flipped sign. Robust to extra tabs from session restore.
  await expect
    .poll(async () => {
      const names = await allNames.allTextContents();
      return Math.sign(names.indexOf("sample.md") - names.indexOf("sample2.md"));
    })
    .toBe(-Math.sign(initialDelta));

  // The trailing click after a drag must be suppressed: the active tab should
  // not change just because we dragged a tab.
  const activeAfter = await page
    .locator('[data-testid^="tab-"][role="tab"][data-active="true"]')
    .getAttribute("data-testid");
  expect(activeAfter).toBe(activeBefore);
});

test("open file button is always visible", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await page.waitForSelector("[data-testid='open-file-btn']");

  const openBtn = page.locator("[data-testid='open-file-btn']");
  await expect(openBtn).toBeVisible();
});
