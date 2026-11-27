import { expect, type Page, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * ADR-057 PR 3, end to end: both answers to the "changed on disk" banner leave
 * the other side in Version history.
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

/** Open the sample, type an unsaved edit the server holds, then rewrite the file on disk. */
async function raiseConflict(page: Page, typed: string): Promise<string> {
  const filePath = path.join(tmpDir, "sample.md");
  await mcp.callTool("tandem_open", { filePath });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(` ${typed}`);
  // The disk write must land after the server holds the edit, or the watcher
  // reloads silently instead of raising the conflict.
  await expect
    .poll(async () => {
      const r = (await mcp.callTool("tandem_getTextContent", {})) as { data?: { text?: string } };
      return r.data?.text ?? "";
    })
    .toContain(typed);
  fs.writeFileSync(filePath, "# Replaced\n\nThe external version.\n");
  await expect(page.getByTestId("external-conflict-banner")).toBeVisible({ timeout: 10_000 });
  return filePath;
}

async function openVersionHistory(page: Page) {
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("Version history");
  await page.keyboard.press("Enter");
  const modal = page.getByTestId("version-history-modal");
  await expect(modal).toBeVisible();
  return modal;
}

test("Reload from file keeps the unsaved edits in Version history", async ({ page }) => {
  await raiseConflict(page, "RELOAD DISCARDS THIS");
  await expect(page.getByTestId("external-conflict-banner")).toContainText(
    "reloading keeps your unsaved edits in Version history",
  );

  await page.getByTestId("external-conflict-reload-btn").click();
  const editor = page.locator(".tiptap");
  await expect(editor).toContainText("The external version.", { timeout: 10_000 });
  await expect(editor).not.toContainText("RELOAD DISCARDS THIS");
  await expect(page.getByTestId("external-conflict-banner")).toBeHidden();
  // The user's own choice raises no kept-edits banner.
  await expect(page.getByTestId("kept-edits-banner")).toBeHidden();

  const modal = await openVersionHistory(page);
  const first = modal.getByTestId("version-history-row").first();
  await expect(first).toContainText("Your unsaved edits");
  await first.getByTestId("version-history-restore").click();
  await first.getByTestId("version-history-confirm").click();
  await expect(editor).toContainText("RELOAD DISCARDS THIS", { timeout: 10_000 });
});

test("Keep my edits keeps the version on disk in Version history", async ({ page }) => {
  await raiseConflict(page, "KEEP THESE WORDS");

  await page.getByTestId("external-conflict-keep-btn").click();
  await expect(page.getByTestId("external-conflict-banner")).toBeHidden({ timeout: 10_000 });
  const editor = page.locator(".tiptap");
  await expect(editor).toContainText("KEEP THESE WORDS");

  const modal = await openVersionHistory(page);
  await expect(
    modal.getByTestId("version-history-row").filter({ hasText: "File on disk" }).first(),
  ).toBeVisible();
});

test("Compare shows the file on disk against the document before choosing", async ({ page }) => {
  await raiseConflict(page, "MY COMPARE EDIT");

  await page.getByTestId("external-conflict-compare-btn").click();
  const modal = page.getByTestId("compare-modal");
  await expect(modal).toBeVisible();
  // The disk's line is only in the other version; the typed edit only in the document now.
  await expect(
    modal.locator("[data-testid='diff-line'][data-kind='remove']").filter({
      hasText: "The external version.",
    }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    modal.locator("[data-testid='diff-line'][data-kind='add']").filter({
      hasText: "MY COMPARE EDIT",
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  // Nothing was resolved by looking.
  await expect(page.getByTestId("external-conflict-banner")).toBeVisible();
});
