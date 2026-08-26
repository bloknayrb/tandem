import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openAnnotatePopup,
  selectTextStable,
} from "./helpers";

/**
 * E2E coverage for #1626 part 1 — markdown in annotation bodies.
 *
 * This suite exists because the risk is a LAYOUT risk, and layout is the one
 * thing the unit tests cannot see. `tests/client/annotation-body.test.ts` runs
 * under happy-dom, where every element has zero width and `scrollWidth` is
 * meaningless — so it can prove the right markup is produced and nothing at all
 * about whether a `<pre>` fits in a 280px rail.
 *
 * The specific hazard: a fenced code block has UA `white-space: pre`, so a long
 * unwrapped line pushes its container arbitrarily wide. Inside the annotation
 * rail that spills past the column edge — the same failure the stub-band gate in
 * `margin-view.spec.ts` was written for, arriving by a new route. The existing
 * gates cannot catch it because no annotation in any other spec contains
 * markdown.
 */

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" — the heading prefix is 2 chars, so the title spans 2..15.
const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";

// A fenced block whose single line is far wider than any rail, plus an unbroken
// token — the two shapes that overflow for different reasons (`white-space: pre`
// and a word with no break opportunity).
const MARKDOWN_BODY = [
  "Here is a **suggested** change:",
  "",
  "```ts",
  "const veryLongIdentifier = someFunction(withAnArgument, andAnother, andYetAnotherOne);",
  "```",
  "",
  // An explicit `[label](url)` — this renderer does NOT autolink a bare URL, so
  // writing one here would silently yield no anchor and the link assertion
  // below would hang rather than fail on the thing it is about.
  "See [the docs](https://example.test/a/very/long/path/that/will/not/wrap/at/all).",
  "",
  // A bare unbroken token as well: it overflows for a different reason than the
  // fenced block (no break opportunity, rather than `white-space: pre`).
  "https://example.test/another/extremely/long/unbroken/token/with/no/spaces/in/it",
].join("\n");

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

test("a claude comment renders markdown and still fits its column", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: MARKDOWN_BODY,
    textSnapshot: TITLE_TEXT,
  });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });

  const card = page.locator("[data-testid^='annotation-card-']").first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  // 1. The markdown actually rendered — otherwise the fit assertions below pass
  //    trivially on plain text, which is the wrong fix for the right reason.
  await expect(card.locator(".tandem-markdown pre code")).toBeVisible({ timeout: 5_000 });
  await expect(card.locator(".tandem-markdown strong")).toHaveText("suggested");

  // 2. THE GATE: no horizontal spill. `scrollWidth > clientWidth` is the overflow
  //    signature; 1px absorbs sub-pixel rounding. Asserted on the card, not on
  //    the `<pre>` — the block is allowed to scroll inside itself
  //    (`overflow-x: auto`), it just must not widen the card.
  const fit = await card.evaluate((el) => ({
    scrollWidth: (el as HTMLElement).scrollWidth,
    clientWidth: (el as HTMLElement).clientWidth,
  }));
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 1);

  // 3. The link is styled from a theme token rather than the UA's untokened
  //    blue. `markdown-body.css` had no `a` rule before #1626 — a defect that
  //    was live in chat too.
  const linkColor = await card
    .locator(".tandem-markdown a")
    .evaluate((el) => getComputedStyle(el).color);
  const bodyAccent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--tandem-accent").trim(),
  );
  expect(bodyAccent).not.toBe("");
  expect(linkColor).not.toBe("rgb(0, 0, 238)"); // the UA default
});

test("a user comment with the same text renders as literal prose", async ({ page }) => {
  // The gate is on AUTHOR, and it is the half that is easy to lose: rendering
  // everyone's markdown would silently reformat text a user typed by hand.
  //
  // Written through the real popup rather than seeded over MCP, because an MCP
  // write is Claude-authored by construction — there is no way to ask the server
  // for a user-authored annotation, and faking one would test a state the app
  // cannot reach.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });

  const editor = page.locator(".tiptap");
  await editor.click();
  await selectTextStable(editor.locator("p").first());
  await openAnnotatePopup(page);
  await page.locator("[data-testid='popup-annotation-input']").fill("**not bold** and `not code`");
  await page.locator("[data-testid='popup-comment-submit']").click();

  const card = page.locator("[data-testid^='annotation-card-']").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("**not bold**", { timeout: 5_000 });
  await expect(card.locator(".tandem-markdown")).toHaveCount(0);
});
