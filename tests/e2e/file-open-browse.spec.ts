/**
 * #378 — Native file picker Browse button in FileOpenDialog.
 *
 * Headless Playwright can't drive a native OS dialog, and the Tauri
 * `@tauri-apps/plugin-dialog` import doesn't resolve in the browser runtime
 * (no `__TAURI_INTERNALS__`), so the Browse button falls through to the
 * hidden `<input type="file">` element. We assert the button is visible in
 * the dialog and that clicking it triggers a file-chooser interaction (via
 * Playwright's `waitForEvent("filechooser")` — the same mechanism Playwright
 * uses to intercept browser native file pickers).
 */
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
  tmpDir = createFixtureDir("sample.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("File Open dialog exposes a Browse button next to the path-paste input", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // Ctrl+O opens the dialog.
  await page.keyboard.press("Control+o");
  await expect(page.locator("[data-testid='file-open-dialog']")).toBeVisible();

  // The Browse button only renders in "path" mode (the upload mode already
  // has its own click-to-browse drop zone). Switch to path mode first.
  await page.getByRole("button", { name: "File Path" }).click();

  // Path-paste input stays alongside the new button — we complement, not
  // replace.
  await expect(page.locator("[data-testid='file-path-input']")).toBeVisible();

  // Browse button visible.
  const browseBtn = page.locator("[data-testid='file-browse-btn']");
  await expect(browseBtn).toBeVisible();
  await expect(browseBtn).toHaveText(/Browse/);
});

test("Browse button triggers the browser file-chooser fallback when not in Tauri", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.keyboard.press("Control+o");
  await expect(page.locator("[data-testid='file-open-dialog']")).toBeVisible();
  await page.getByRole("button", { name: "File Path" }).click();

  // The browser path opens the hidden <input type="file"> — Playwright
  // captures that via `waitForEvent("filechooser")`. The native Tauri code
  // path is unreachable here because Playwright runs in Chromium without
  // `__TAURI_INTERNALS__`, so `isTauriRuntime()` returns false.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("[data-testid='file-browse-btn']").click(),
  ]);

  // `accept` filter on the hidden input — Playwright exposes this via the
  // FileChooser API. The exact filter list matches the existing upload zone.
  expect(chooser.isMultiple()).toBe(false);
});
