import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

/** Write a fixture with an h3 nested inside an h2 section, then a sibling h2. */
function fsWriteNested(filePath: string): void {
  fs.writeFileSync(
    filePath,
    [
      "# Title",
      "",
      "## Parent",
      "",
      "Parent intro paragraph.",
      "",
      "### Child",
      "",
      "Child paragraph content.",
      "",
      "## Sibling",
      "",
      "Sibling section content.",
      "",
    ].join("\n"),
  );
}

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

test("clicking chevron collapses heading section and persists across reload", async ({ page }) => {
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
});

test("editing a collapsed heading's text keeps the section collapsed (#815 HIGH)", async ({
  page,
}) => {
  const filePath = path.join(tmpDir, "heading-collapse.md");
  await mcp.callTool("tandem_open", { filePath });
  await page.goto("/");

  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  const firstHeading = editor.locator("h2", { hasText: "First Section" });
  await expect(firstHeading).toBeVisible();

  const firstSectionContent = editor.locator("p", { hasText: "Content under first section." });
  await expect(firstSectionContent).toBeVisible();

  // Collapse the First Section.
  const firstChevron = firstHeading.locator("[data-testid='heading-chevron']");
  await firstChevron.click({ force: true });
  await expect(firstSectionContent).toBeHidden();

  // Edit the heading text: click at the end of the heading and type. This
  // re-hashes the heading. The OLD behavior wiped persistence + re-expanded;
  // the fix migrates the collapsed entry to the new hash so it stays collapsed.
  await firstHeading.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Renamed");

  // Heading text updated...
  await expect(editor.locator("h2", { hasText: "First Section Renamed" })).toBeVisible();
  // ...and the section is STILL collapsed (content paragraph remains hidden).
  await expect(firstSectionContent).toBeHidden();

  // The chevron on the renamed heading reports collapsed state.
  const renamedChevron = editor
    .locator("h2", { hasText: "First Section Renamed" })
    .locator("[data-testid='heading-chevron']");
  await expect(renamedChevron).toHaveAttribute("data-collapsed", "true");
});

test("collapse survives a force:true reload (Y.Doc swap in place)", async ({ page }) => {
  const filePath = path.join(tmpDir, "heading-collapse.md");
  await mcp.callTool("tandem_open", { filePath });
  await page.goto("/");

  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor.locator("h2", { hasText: "Second Section" })).toBeVisible();

  const secondSectionContent = editor.locator("p", { hasText: "Content under second section." });
  await expect(secondSectionContent).toBeVisible();

  // Collapse Second Section.
  const secondChevron = editor
    .locator("h2", { hasText: "Second Section" })
    .locator("[data-testid='heading-chevron']");
  await secondChevron.click({ force: true });
  await expect(secondSectionContent).toBeHidden();

  // force:true clears + repopulates the Y.Doc IN PLACE (no page reload). The
  // plugin's rehydrate guard exists precisely for this content re-arrival path.
  await mcp.callTool("tandem_open", { filePath, force: true });

  // After the in-place swap, the section should re-collapse from localStorage.
  await expect(secondSectionContent).toBeHidden();
  await expect(
    editor.locator("h2", { hasText: "Second Section" }).locator("[data-testid='heading-chevron']"),
  ).toHaveAttribute("data-collapsed", "true");
});

test("collapsing an h2 hides an intervening h3 (nested-level collapse)", async ({ page }) => {
  // A dedicated fixture with an h3 nested inside an h2 section.
  const nestedPath = path.join(tmpDir, "nested.md");
  fsWriteNested(nestedPath);
  await mcp.callTool("tandem_open", { filePath: nestedPath });
  await page.goto("/");

  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor.locator("h2", { hasText: "Parent" })).toBeVisible();
  await expect(editor.locator("h3", { hasText: "Child" })).toBeVisible();

  const childSubheading = editor.locator("h3", { hasText: "Child" });
  const afterParent = editor.locator("h2", { hasText: "Sibling" });
  await expect(afterParent).toBeVisible();

  // Collapse the Parent (h2). Everything up to the next same-or-higher heading
  // (the h2 "Sibling") should hide — including the intervening h3 "Child".
  const parentChevron = editor
    .locator("h2", { hasText: "Parent" })
    .locator("[data-testid='heading-chevron']");
  await parentChevron.click({ force: true });

  await expect(childSubheading).toBeHidden();
  // The next same-level heading stays visible.
  await expect(afterParent).toBeVisible();
});
