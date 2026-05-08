import { expect, test } from "@playwright/test";
import path from "path";
import { LEFT_PANEL_WIDTH_KEY, PANEL_WIDTH_KEY } from "../../src/shared/constants";
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
  tmpDir = createFixtureDir("sample.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

async function dragHandleBy(
  page: Parameters<typeof test>[0]["page"],
  handleTestId: string,
  deltaX: number,
): Promise<void> {
  const handle = page.locator(`[data-testid='${handleTestId}']`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`resize handle ${handleTestId} has no bounding box`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + deltaX, cy, { steps: 10 });
  await page.mouse.up();
}

// Layout-mode (tabbed/tabbed-left/three-panel) removed in PR #580. See issue #581.
test.skip("panel resize persists localStorage keys and keyboard Home/End works", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await page.locator("[data-testid='settings-btn']").click();
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await page.keyboard.press("Escape");

  await page.evaluate(
    ([leftKey, rightKey]) => {
      localStorage.removeItem(leftKey);
      localStorage.removeItem(rightKey);
    },
    [LEFT_PANEL_WIDTH_KEY, PANEL_WIDTH_KEY],
  );
  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await dragHandleBy(page, "left-panel-resize-handle", 80);
  await dragHandleBy(page, "right-panel-resize-handle", 80);

  const widthsAfterDrag = await page.evaluate(
    ([leftKey, rightKey]) => ({
      left: Number(localStorage.getItem(leftKey)),
      right: Number(localStorage.getItem(rightKey)),
    }),
    [LEFT_PANEL_WIDTH_KEY, PANEL_WIDTH_KEY],
  );
  expect(widthsAfterDrag.left).toBeGreaterThanOrEqual(370);
  expect(widthsAfterDrag.right).toBeGreaterThanOrEqual(200);

  const rightHandle = page.locator("[data-testid='right-panel-resize-handle']");
  await rightHandle.focus();
  await page.keyboard.press("Home");
  expect(await page.evaluate((k) => Number(localStorage.getItem(k)), PANEL_WIDTH_KEY)).toBe(200);
  await page.keyboard.press("End");
  expect(await page.evaluate((k) => Number(localStorage.getItem(k)), PANEL_WIDTH_KEY)).toBe(600);
});
