import { test, expect } from "@playwright/test";
import path from "path";
import { McpTestClient, createFixtureDir, cleanupFixtureDir } from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md", "sample2.md");
});

test.afterEach(async () => {
  try {
    const status = (await mcp.callTool("tandem_status")) as {
      data?: { openDocuments?: Array<{ documentId: string }> };
    };
    const docs = status?.data?.openDocuments ?? [];
    await Promise.all(docs.map((d) => mcp.callTool("tandem_close", { documentId: d.documentId })));
  } catch {
    // Server may have shut down
  }
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("tab renders with filename, tooltip shows full path", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");

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
  await page.goto("http://localhost:5173");
  await page.waitForSelector("[data-testid='tab-scroll-container']");

  const container = page.locator("[data-testid='tab-scroll-container']");
  await expect(container).toBeVisible();
});

test("multiple tabs appear", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://localhost:5173");

  // Both our test tabs should be present
  const sample1 = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample1).toBeVisible();
  await expect(sample2).toBeVisible();
});

test("keyboard reorder with Alt+Arrow swaps tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://localhost:5173");

  // Wait for sample2.md tab to appear
  const sample2Name = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample2Name).toBeVisible();

  // Get all tab names and find sample2's position
  const allNames = page.locator("[data-testid^='tab-name-']");
  const count = await allNames.count();
  let initialIdx = -1;
  for (let i = 0; i < count; i++) {
    const text = await allNames.nth(i).textContent();
    if (text === "sample2.md") {
      initialIdx = i;
      break;
    }
  }
  expect(initialIdx).toBeGreaterThan(0); // sample2 should not be first

  // Click the sample2 tab to focus it, then press Alt+ArrowLeft
  await sample2Name.click();
  await page.waitForTimeout(100);
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForTimeout(300);

  // sample2 should now be one position earlier
  const newText = await allNames.nth(initialIdx - 1).textContent();
  expect(newText).toBe("sample2.md");
});

test("open file button is always visible", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://localhost:5173");
  await page.waitForSelector("[data-testid='open-file-btn']");

  const openBtn = page.locator("[data-testid='open-file-btn']");
  await expect(openBtn).toBeVisible();
});
