import { expect, test } from "@playwright/test";
import path from "path";
import { cleanupAllOpenDocuments, McpTestClient } from "./helpers";

let mcp: McpTestClient;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
});

test("welcome document shows tutorial and can walk through its steps", async ({ page }) => {
  await mcp.callTool("tandem_open", {
    filePath: path.join(process.cwd(), "sample", "welcome.md"),
  });

  await page.goto("/");
  const tutorial = page.locator("[data-testid='onboarding-tutorial']");
  await expect(tutorial).toBeVisible({ timeout: 10_000 });

  await expect(tutorial).toContainText("Review an annotation");
  await page.locator("[data-testid='tutorial-next-btn']").click();
  await expect(tutorial).toContainText("Ask a question");
  await page.locator("[data-testid='tutorial-next-btn']").click();
  await expect(tutorial).toContainText("Make an edit");
  await page.locator("[data-testid='tutorial-next-btn']").click();
  await expect(tutorial).toContainText("You're ready!");
});
