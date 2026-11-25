/**
 * Closing a scratchpad with unsaved content must WAIT for the "Close it
 * anyway?" answer.
 *
 * In the desktop app `tauri-plugin-dialog` replaces `window.confirm` with an
 * async function. The close funnel read its result as a value, so the pending
 * Promise counted as OK: the tab closed (and its recovery copy was discarded)
 * before the dialog even appeared, and Cancel did nothing. A browser's own
 * `confirm` is synchronous, so this spec installs the desktop shape: an async
 * `window.confirm` whose answer the test controls.
 */

import { expect, type Page, test } from "@playwright/test";
import path from "path";
import { E2E_MCP_PORT } from "../../scripts/test-ports.js";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

const API_BASE = `http://127.0.0.1:${E2E_MCP_PORT}/api`;
const SCRATCHPAD_TAB = "[data-testid^='tab-name-']";

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async ({ page }) => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  // The desktop shape: confirm resolves a Promise. The answer is read when the
  // dialog "closes", so a spec can flip it between gestures.
  await page.addInitScript(() => {
    const w = window as unknown as { __confirmAnswer: boolean; __confirmCalls: number };
    w.__confirmAnswer = false;
    w.__confirmCalls = 0;
    window.confirm = (async () => {
      w.__confirmCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return w.__confirmAnswer;
    }) as unknown as typeof window.confirm;
  });
});

test.afterEach(async ({ page }) => {
  try {
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("tandem:scratchpad:")) localStorage.removeItem(key);
      }
    });
  } catch {
    // Page may not be navigated yet if the test failed during setup.
  }
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

async function openDirtyScratchpad(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });
  await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );
  const tabName = page.locator(SCRATCHPAD_TAB, { hasText: "Scratchpad.md" });
  await expect(tabName).toBeVisible({ timeout: 5_000 });
  await tabName.click();
  await page.locator(".tandem-editor").click();
  await page.keyboard.type("keep me");
  // The unsaved flag is set by the same debounced flush that writes the
  // recovery copy, so the copy existing means the close will prompt.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Object.keys(localStorage).some(
            (k) =>
              k.startsWith("tandem:scratchpad:") &&
              (localStorage.getItem(k) ?? "").includes("keep me"),
          ),
        ),
      { timeout: 5_000 },
    )
    .toBe(true);
}

const confirmCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __confirmCalls: number }).__confirmCalls);

test("Ctrl+W: Cancel keeps the scratchpad open, OK closes it", async ({ page }) => {
  await openDirtyScratchpad(page);
  const tabName = page.locator(SCRATCHPAD_TAB, { hasText: "Scratchpad.md" });

  await page.keyboard.press("Control+w");
  await expect.poll(() => confirmCalls(page)).toBe(1);
  // Let the dialog answer (Cancel) and any wrongly-issued close land.
  await page.waitForTimeout(500);
  await expect(tabName).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __confirmAnswer: boolean }).__confirmAnswer = true;
  });
  await page.locator(".tandem-editor").click();
  await page.keyboard.press("Control+w");
  await expect.poll(() => confirmCalls(page)).toBe(2);
  await expect(tabName).not.toBeAttached({ timeout: 5_000 });
});

test("the tab's X: Cancel keeps the scratchpad open, and the X still works after it", async ({
  page,
}) => {
  await openDirtyScratchpad(page);
  const tabName = page.locator(SCRATCHPAD_TAB, { hasText: "Scratchpad.md" });
  const closeButton = page
    .locator("[role='tab']")
    .filter({ has: tabName })
    .locator("button")
    .first();

  await closeButton.click();
  await expect.poll(() => confirmCalls(page)).toBe(1);
  await page.waitForTimeout(500);
  await expect(tabName).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __confirmAnswer: boolean }).__confirmAnswer = true;
  });
  await closeButton.click();
  await expect.poll(() => confirmCalls(page)).toBe(2);
  await expect(tabName).not.toBeAttached({ timeout: 5_000 });
});
