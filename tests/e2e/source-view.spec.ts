/**
 * E2E tests for the raw-markdown source view / edit mode (#1021).
 *
 * The title-bar `</>` toggle swaps the active .md document between the WYSIWYG
 * editor and an editable markdown-source textarea. Editing the source and
 * exiting round-trips the text back through the parser and persists to disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { cleanupAllOpenDocuments, cleanupFixtureDir, McpTestClient } from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;
let filePath: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-sourceview-"));
  filePath = path.join(tmpDir, "doc.md");
  fs.writeFileSync(filePath, "# Source Title\n\nThe original paragraph body.\n", "utf-8");
  await mcp.callTool("tandem_open", { filePath });
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("toggle reveals editable markdown source, edit round-trips to the editor", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  // The source toggle is visible for an editable .md document.
  const toggle = page.getByTestId("titlebar-source-toggle");
  await expect(toggle).toBeVisible();

  // Enter source view — the textarea appears with the literal markdown.
  await toggle.click();
  const textarea = page.getByTestId("source-view-textarea");
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue(/# Source Title/);
  await expect(textarea).toHaveValue(/The original paragraph body\./);

  // Edit the source and return to the WYSIWYG editor.
  await textarea.fill("# Source Title\n\nA brand new paragraph from source mode.\n");
  await page.getByTestId("source-view-exit-btn").click();

  // The formatted editor is back and reflects the edited content.
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });
  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText("A brand new paragraph from source mode.");
  await expect(editor).not.toContainText("The original paragraph body.");
});

test("entering source view with no edits restores the editor unchanged", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  await page.getByTestId("titlebar-source-toggle").click();
  await expect(page.getByTestId("source-view-textarea")).toBeVisible();

  // Exit without editing — the toggle flips back to formatted view.
  await page.getByTestId("source-view-exit-btn").click();
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("The original paragraph body.");
});

test("Ctrl+S in source view commits the edit and does not write stale content to disk", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  await page.getByTestId("titlebar-source-toggle").click();
  const textarea = page.getByTestId("source-view-textarea");
  await expect(textarea).toBeVisible();

  // Edit the source, then commit via Ctrl+S (NOT the exit button).
  await textarea.fill("# Source Title\n\nCommitted via Ctrl+S.\n");
  await textarea.press("ControlOrMeta+s");

  // Regression guard for the must-fix: Ctrl+S must commit only (write the NEW
  // content). Before the fix it also bubbled to the global `save` shortcut,
  // which wrote the STALE Y.Doc — so disk could transiently hold the original
  // paragraph. With the fix, disk deterministically converges to the new body.
  await expect
    .poll(() => fs.readFileSync(filePath, "utf-8"), { timeout: 10_000 })
    .toContain("Committed via Ctrl+S.");
  expect(fs.readFileSync(filePath, "utf-8")).not.toContain("The original paragraph body.");
});

test("uncommitted source edits survive a tab switch and back", async ({ page }) => {
  // Second doc so we can switch away from the source-view tab and back.
  const filePath2 = path.join(tmpDir, "doc2.md");
  fs.writeFileSync(filePath2, "# Second\n\nSecond doc body.\n", "utf-8");
  await mcp.callTool("tandem_open", { filePath: filePath2 });

  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  const inactiveTab = page.locator("[data-testid^='tab-'][role='tab'][data-active='false']");

  // Switch to the first doc, enter source view, and make an uncommitted edit.
  await inactiveTab.first().click();
  await page.getByTestId("titlebar-source-toggle").click();
  const textarea = page.getByTestId("source-view-textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill("# Source Title\n\nUNCOMMITTED DRAFT TEXT.\n");

  // Switch away to the other doc (WYSIWYG), then back.
  await inactiveTab.first().click();
  await expect(page.locator(".tandem-editor")).toBeVisible();
  await inactiveTab.first().click();

  // The draft is restored, not re-fetched from disk.
  const restored = page.getByTestId("source-view-textarea");
  await expect(restored).toBeVisible();
  await expect(restored).toHaveValue(/UNCOMMITTED DRAFT TEXT\./);
});

test("closing a tab with uncommitted source edits prompts before discarding", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  await page.getByTestId("titlebar-source-toggle").click();
  const textarea = page.getByTestId("source-view-textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill("# Source Title\n\nUnsaved edit.\n");

  // Dismiss the confirm — the tab (and the source view) must stay open.
  let dialogMessage = "";
  page.once("dialog", (dialog) => {
    dialogMessage = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "Close doc.md" }).click();

  expect(dialogMessage).toContain("unsaved markdown-source edits");
  await expect(page.getByTestId("source-view-textarea")).toBeVisible();
});
