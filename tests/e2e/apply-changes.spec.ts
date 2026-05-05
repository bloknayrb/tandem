import { expect, test } from "@playwright/test";
import path from "path";
import { cleanupAllOpenDocuments, cleanupFixtureDir, createFixtureDir, McpTestClient, switchToAnnotationsTab } from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("single-paragraph.docx");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("accepted docx annotations can be applied as tracked changes", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "single-paragraph.docx") });
  await mcp.callTool("tandem_comment", {
    from: 0,
    to: 7,
    text: "Capitalize this if needed",
    textSnapshot: "Walking",
  });

  page.on("dialog", async (dialog) => {
    if (dialog.type() === "confirm") await dialog.accept();
    else await dialog.dismiss();
  });

  await page.goto("/");
  await switchToAnnotationsTab(page);
  await expect(page.locator("[data-testid^='accept-btn-']").first()).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-testid^='accept-btn-']").first().click();

  const applyButton = page.locator("[data-testid='apply-changes-btn']");
  await expect(applyButton).toBeVisible();
  await expect(applyButton).toBeEnabled();
});
