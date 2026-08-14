import { expect, test } from "@playwright/test";
import path from "path";
import { AUTHORSHIP_TOGGLE_KEY } from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  switchToAnnotationsTab,
} from "./helpers";

/**
 * #1388 — the two client paths that insert Claude's text must attribute it to
 * Claude, not to the user.
 *
 * `Authorship.onTransaction` stamps every local doc-changing transaction, and
 * before this fix it hardcoded `author: "user"`. Accepting a suggestion and
 * inserting a chat message both dispatch exactly such a transaction, so
 * Claude's own words rendered in the user's colour — the precise failure the
 * overlay exists to prevent. `tests/client/authorship-stamp.test.ts` pins the
 * stamp against a live Tiptap editor; this spec covers the half that unit test
 * cannot reach, which is that the entry actually reaches the DOM as a
 * decoration on the inserted text.
 *
 * The overlay is off by default, so each test arms it in `localStorage` BEFORE
 * the app boots — the plugin reads the key once during `init`, not reactively.
 */

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" in flat text: "# " is the heading prefix (2 chars), so
// "Test Document" spans offsets 2–15.
const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";

test.beforeEach(async ({ page }) => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, "true");
  }, AUTHORSHIP_TOGGLE_KEY);
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

/** Authors of every inline authorship decoration currently in the editor. */
async function decoratedAuthors(page: import("@playwright/test").Page): Promise<string[]> {
  return page
    .locator(".tandem-editor [data-tandem-author]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-tandem-author") ?? ""));
}

test("accepting a suggestion attributes the replacement to Claude", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Punchier title",
    textSnapshot: TITLE_TEXT,
    suggestedText: "Rewritten Heading",
  });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });

  await switchToAnnotationsTab(page);
  const acceptBtn = page.locator("[data-testid^='accept-btn-']");
  await expect(acceptBtn.first()).toBeVisible({ timeout: 10_000 });
  await acceptBtn.first().click();

  await expect(editor).toContainText("Rewritten Heading", { timeout: 10_000 });

  const claudeSpan = page.locator(".tandem-editor [data-tandem-author='claude']");
  await expect(claudeSpan.first()).toBeVisible({ timeout: 10_000 });
  await expect(claudeSpan.first()).toContainText("Rewritten Heading");

  // The inversion this fixes would have produced a `"user"` decoration over
  // the same text, so assert on the whole set rather than only on presence.
  expect(await decoratedAuthors(page)).toEqual(["claude"]);
});

test("inserting a Claude chat message attributes it to Claude", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_reply", { text: "Inserted by Claude" });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });

  await page.locator("[data-testid='chat-tab']").click();
  const insertBtn = page.getByRole("button", { name: "Insert into open document" });
  await expect(insertBtn.first()).toBeEnabled({ timeout: 10_000 });
  await insertBtn.first().click();

  const claudeSpan = page.locator(".tandem-editor [data-tandem-author='claude']");
  await expect(claudeSpan.first()).toBeVisible({ timeout: 10_000 });
  await expect(claudeSpan.first()).toContainText("Inserted by Claude");

  expect(await decoratedAuthors(page)).toEqual(["claude"]);
});
