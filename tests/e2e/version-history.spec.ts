import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * ADR-057 PR 2, end to end: a Claude force-open discards the user's unsaved
 * edits, the kept-edits banner says so, the Version history lists them, and
 * restoring them brings the text back and clears the banner.
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

test("a Claude force-open's kept edits show a banner and come back from Version history", async ({
  page,
}) => {
  const filePath = path.join(tmpDir, "sample.md");
  await mcp.callTool("tandem_open", { filePath });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });

  // Unsaved edits in the editor.
  await editor.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" MY UNSAVED WORDS");
  await expect(editor).toContainText("MY UNSAVED WORDS");

  // Someone else rewrites the file; Claude reloads it from disk.
  fs.writeFileSync(filePath, "# Replaced\n\nThe external version.\n");
  const opened = (await mcp.callTool("tandem_open", { filePath, force: true })) as {
    data?: { backupKept?: { name: string } };
  };
  expect(opened.data?.backupKept?.name).toMatch(/-unsaved\.md$/);
  await expect(editor).toContainText("The external version.", { timeout: 10_000 });
  await expect(editor).not.toContainText("MY UNSAVED WORDS");

  // The durable banner, and its way into the Version history.
  const banner = page.getByTestId("kept-edits-banner");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("kept-edits-banner-view").click();

  const modal = page.getByTestId("version-history-modal");
  await expect(modal).toBeVisible();
  const first = modal.getByTestId("version-history-row").first();
  await expect(first).toContainText("Your unsaved edits");
  await first.getByTestId("version-history-restore").click();
  await first.getByTestId("version-history-confirm").click();

  await expect(modal).toBeHidden({ timeout: 10_000 });
  await expect(editor).toContainText("MY UNSAVED WORDS", { timeout: 10_000 });
  // Restoring the kept edits acknowledges them: the banner goes.
  await expect(banner).toBeHidden({ timeout: 10_000 });
});

test("Dismiss hides the banner until Claude keeps edits again", async ({ page }) => {
  const filePath = path.join(tmpDir, "sample.md");
  await mcp.callTool("tandem_open", { filePath });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" EDITS ONE");
  await expect(editor).toContainText("EDITS ONE");

  await mcp.callTool("tandem_open", { filePath, force: true });
  const banner = page.getByTestId("kept-edits-banner");
  await expect(banner).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("kept-edits-banner-dismiss").click();
  await expect(banner).toBeHidden({ timeout: 10_000 });

  // A reload of the page does not bring it back: the dismissal is on the server.
  await page.reload();
  await expect(editor.locator("p").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1_000);
  await expect(banner).toBeHidden();
});
