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
  // Copy both fixture files into the same temp directory so the relative link resolves
  tmpDir = createFixtureDir("link-source.md", "link-target.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("clicking a relative .md link opens the target file as a new tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "link-source.md") });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText("Link Source");

  // The link text "Open the target document" is rendered as an anchor in the editor
  const link = editor.locator("a", { hasText: "Open the target document" });
  await expect(link).toBeVisible({ timeout: 5_000 });

  // Click the link — it should open link-target.md as a new tab without navigating away
  await link.click();

  // Wait for the new tab to appear in the tab bar
  const targetTabName = page.locator("[data-testid^='tab-name-']", {
    hasText: "link-target.md",
  });
  await expect(targetTabName).toBeVisible({ timeout: 10_000 });

  // The source tab should still be present
  const sourceTabName = page.locator("[data-testid^='tab-name-']", {
    hasText: "link-source.md",
  });
  await expect(sourceTabName).toBeVisible();
});

test("an editor link shows a pointer cursor and a title tooltip with its destination (#996)", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "link-source.md") });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText("Link Source");

  const link = editor.locator("a", { hasText: "Open the target document" });
  await expect(link).toBeVisible({ timeout: 5_000 });

  // The href in the fixture is the relative path "link-target.md".
  await expect(link).toHaveAttribute("href", "link-target.md");
  // Hover affordance: the destination URL is surfaced as a native title tooltip.
  await expect(link).toHaveAttribute("title", "link-target.md");
  // ...and the cursor reads as interactive.
  await expect(link).toHaveCSS("cursor", "pointer");
});

test("a disallowed-scheme link renders inert — no live href, no title (#996 security)", async ({
  page,
}) => {
  // mdast→Y.Doc stores link URLs verbatim (no scheme check), so a .md authored
  // with a javascript: href reaches the editor. The renderHTML override must
  // delegate to the base extension's isAllowedUri guard (which blanks the href)
  // and must NOT mirror the disallowed scheme into a title tooltip.
  const xssDir = createFixtureDir("link-xss.md");
  try {
    await mcp.callTool("tandem_open", { filePath: path.join(xssDir, "link-xss.md") });

    await page.goto("/");
    const editor = page.locator(".tandem-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await expect(editor).toContainText("XSS Link");

    const link = editor.locator("a", { hasText: "click me" });
    await expect(link).toBeVisible({ timeout: 5_000 });

    // The base guard blanks the href; our title-injection must not resurrect it.
    const href = await link.getAttribute("href");
    expect(href ?? "").not.toContain("javascript:");
    const title = await link.getAttribute("title");
    expect(title ?? "").not.toContain("javascript:");
  } finally {
    cleanupFixtureDir(xssDir);
  }
});
