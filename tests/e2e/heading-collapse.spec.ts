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
  tmpDir = createFixtureDir("heading-collapse.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("clicking chevron collapses heading section and persists across reload", async ({
  page,
  context,
}) => {
  const filePath = path.join(tmpDir, "heading-collapse.md");
  await mcp.callTool("tandem_open", { filePath });
  await page.goto("/");

  // Wait for the editor and its headings to render.
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor.locator("h2", { hasText: "First Section" })).toBeVisible();
  await expect(editor.locator("h2", { hasText: "Second Section" })).toBeVisible();

  // Paragraphs immediately following First Section are visible to start.
  const firstSectionContent = editor.locator("p", { hasText: "Content under first section." });
  await expect(firstSectionContent).toBeVisible();

  // Force the first-section chevron to render (CSS opacity 0 until hover/focus
  // hides it from default visibility). The button still exists in the DOM and
  // is clickable.
  const firstChevron = editor
    .locator("h2", { hasText: "First Section" })
    .locator("[data-testid='heading-chevron']");
  await expect(firstChevron).toHaveCount(1);

  // force: true bypasses the auto-actionability checks (opacity:0 makes it
  // "invisible" to Playwright by default).
  await firstChevron.click({ force: true });

  // The First Section's content paragraph should now be hidden (display: none
  // node decoration on the sibling paragraph).
  await expect(firstSectionContent).toBeHidden();

  // Second Section heading and its content should remain visible.
  await expect(editor.locator("h2", { hasText: "Second Section" })).toBeVisible();
  await expect(editor.locator("p", { hasText: "Content under second section." })).toBeVisible();

  // Chevron is now in collapsed state (data attribute flipped + always-visible).
  await expect(firstChevron).toHaveAttribute("data-collapsed", "true");

  // -- Persistence: reload the page and verify the collapse survives --------
  await page.reload();
  await expect(editor).toBeVisible({ timeout: 10_000 });

  const reloadedFirstSection = editor.locator("p", { hasText: "Content under first section." });
  // After reload, the localStorage rehydration should re-apply the collapse.
  await expect(reloadedFirstSection).toBeHidden();

  // Click chevron again to expand and verify toggling works.
  const reloadedChevron = editor
    .locator("h2", { hasText: "First Section" })
    .locator("[data-testid='heading-chevron']");
  await reloadedChevron.click({ force: true });
  await expect(reloadedFirstSection).toBeVisible();
  await expect(reloadedChevron).toHaveAttribute("data-collapsed", "false");

  void context;
});
