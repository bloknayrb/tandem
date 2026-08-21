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
 * #1447 — an MCP edit that lands BEFORE any browser attaches must still show
 * the tab's unsaved dot.
 *
 * The component tests cover the client half by handing `TabItem` a ydoc with the
 * mirror already set. Neither half's unit tests can see the thing that actually
 * broke: whether the server's dirty flag reaches a freshly attached client at
 * all. That crosses `documents/dirty.ts` → `documentMeta` → Hocuspocus sync →
 * the tab's 500 ms arm window, and every link was individually fine while the
 * chain was not — the client reset to a literal `false` when it armed, so a
 * pre-attach edit was absorbed into the clean baseline.
 *
 * The second assertion is the one that discriminates: the dot can be present
 * transiently and then be wiped when the arm timer fires. It must survive that.
 */
test.setTimeout(90_000);

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir();
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("a pre-attach MCP edit shows an unsaved dot on the tab", async ({ page }) => {
  const file = path.join(tmpDir, "preattach.md");
  fs.writeFileSync(file, "# Heading\n\nOriginal sentence here.\n", "utf8");

  // Everything up to `page.goto` happens with no browser attached — that is the
  // whole scenario, so the open and the edit must both precede it.
  const open = (await mcp.callTool("tandem_open", { filePath: file })) as {
    data: { documentId: string };
  };
  const docId = open.data.documentId;
  const text = (await mcp.callTool("tandem_getTextContent", { documentId: docId })) as {
    data: { text: string };
  };
  const start = text.data.text.indexOf("Original");
  expect(start).toBeGreaterThan(-1);
  await mcp.callTool("tandem_edit", {
    documentId: docId,
    from: start,
    to: start + "Original".length,
    newText: "REWRITTEN",
  });

  await page.goto("/");

  const dot = page.locator(`[data-testid='unsaved-indicator-${docId}'] .dot`);
  await expect(dot).toBeVisible({ timeout: 20_000 });
  // Past the arm window, which is where the pre-fix client blanked it.
  await page.waitForTimeout(2000);
  await expect(dot).toBeVisible();
});
