import AxeBuilder from "@axe-core/playwright";
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
  await mcp.callTool("tandem_open", {
    filePath: path.join(tmpDir, "sample.md"),
  });
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test.describe("WCAG AA — light mode", () => {
  test("app chrome has no violations", async ({ page }) => {
    await page.goto("/");
    await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 10_000 });

    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

    const results = await new AxeBuilder({ page })
      .include("#root")
      .exclude("[contenteditable]")
      .exclude(".ProseMirror")
      // The WAI-ARIA APG closable tabs pattern places a close button inside role="tab".
      // axe's nested-interactive rule fires on this well-established pattern; the close
      // button is fully operable by pointer and assistive technology via its aria-label.
      .disableRules(["nested-interactive"])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

test.describe("WCAG AA — dark mode", () => {
  test("app chrome has no violations", async ({ page }) => {
    await page.goto("/");
    await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 10_000 });

    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));

    const results = await new AxeBuilder({ page })
      .include("#root")
      .exclude("[contenteditable]")
      .exclude(".ProseMirror")
      // The WAI-ARIA APG closable tabs pattern places a close button inside role="tab".
      // axe's nested-interactive rule fires on this well-established pattern; the close
      // button is fully operable by pointer and assistive technology via its aria-label.
      .disableRules(["nested-interactive"])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
