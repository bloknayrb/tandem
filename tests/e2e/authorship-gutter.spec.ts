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
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

/**
 * Regression guard for the per-paragraph authorship gutter (#518B).
 *
 * The gutter is a `position: absolute` `::before` thread that must anchor to
 * its own block. The rule granting blocks that positioning context once used a
 * `.tandem-editor .ProseMirror p` descendant selector — but Tiptap stacks both
 * `tandem-editor` and `ProseMirror` classes on a SINGLE node, so the selector
 * matched nothing. Non-empty blocks fell back to `position: static`, the gutter
 * anchored to the ~500px `.tandem-editor` body, and rendered as a full-height
 * bar down the editor. (Empty paragraphs hid it via their own `p.is-empty`
 * `position: relative`, so it only surfaced once real text was typed.)
 *
 * Asserting non-empty blocks keep `position: relative` locks the root-cause
 * invariant: the gutter anchors to its block, not the editor body.
 */
test("non-empty editor blocks keep a positioning context for the authorship gutter", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText("Test Document", { timeout: 10_000 });

  const headingPosition = await editor
    .locator("h1")
    .first()
    .evaluate((el) => getComputedStyle(el).position);
  expect(headingPosition).toBe("relative");

  const paragraphPosition = await editor
    .locator("p")
    .first()
    .evaluate((el) => getComputedStyle(el).position);
  expect(paragraphPosition).toBe("relative");
});
