import { expect, test } from "@playwright/test";
import path from "path";
import { AUTHORSHIP_TOGGLE_KEY, TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
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
 * Arming the overlay takes TWO writes, not one. The plugin reads
 * `AUTHORSHIP_TOGGLE_KEY` once during `init` (not reactively), so it has to be
 * set before the app boots — but writing only that key is inert: settings-store
 * creation calls `mirrorDecorationKeys(loaded)`, which unconditionally
 * re-derives the key from the settings blob (`showAuthorship && !muted`) before
 * the editor is constructed. So seed the blob as well. Both defaults happen to
 * be favourable today; `showAuthorship` has already been flipped once (#442),
 * and if it flips again these tests would fail on a bare visibility timeout
 * while the setup read as though it had prevented exactly that.
 */

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" in flat text: "# " is the heading prefix (2 chars), so
// "Test Document" spans offsets 2–15.
const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";
/** What the user types, asserted by TEXT — see the comment at its use site. */
const USER_TYPED = " and the user typed this";

test.beforeEach(async ({ page }) => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await page.addInitScript(
    (keys) => {
      window.localStorage.setItem(
        keys.settings,
        JSON.stringify({ showAuthorship: true, decorationsMuted: false }),
      );
      window.localStorage.setItem(keys.toggle, "true");
    },
    { settings: TANDEM_SETTINGS_KEY, toggle: AUTHORSHIP_TOGGLE_KEY },
  );
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

  // Type as the user BEFORE the accept, and the order is the point of the test.
  //
  // This used to be the other way round, with a comment explaining that typing
  // first would make the accept shift the user entry's frozen flat range and
  // land the assertion in the #1471 drift. That workaround dodged the only
  // scenario worth running end to end: the accept rewrites the TITLE, which
  // sits before this text, so every offset under the user's entry moves. With
  // client stamps CRDT-anchored (#1471 gap 1) the entry follows its own
  // characters instead, and this is the only place a server-minted and a
  // client-minted anchor coexist in one real document.
  await editor.locator("p").last().click();
  await page.keyboard.type(USER_TYPED);

  const userSpan = page.locator(`.tandem-editor [data-tandem-author='user']`);
  await expect(userSpan.first()).toBeVisible({ timeout: 10_000 });

  await switchToAnnotationsTab(page);
  const acceptBtn = page.locator("[data-testid^='accept-btn-']");
  // Pin the cardinality: `accept-btn-` is a prefix match, so `.first()` would
  // silently pick an arbitrary card the day a second annotation exists.
  await expect(acceptBtn).toHaveCount(1, { timeout: 10_000 });
  await acceptBtn.click();

  await expect(editor).toContainText("Rewritten Heading", { timeout: 10_000 });

  // The document now holds BOTH authors at once — the state #1388 was actually
  // reported in, and the only one that can tell that fix apart from an
  // over-correction stamping everything `"claude"`.
  const claudeSpan = page.locator(".tandem-editor [data-tandem-author='claude']");
  await expect(claudeSpan.first()).toBeVisible({ timeout: 10_000 });
  await expect(claudeSpan.first()).toContainText("Rewritten Heading");

  const authors = await decoratedAuthors(page);
  expect(authors).toContain("claude");
  expect(authors).toContain("user");

  // ASSERTING ON SPAN TEXT, which the workaround also forbade. Attribute values
  // alone would still pass if the user's decoration had slid onto Claude's new
  // heading — which is exactly what #1471 did, and exactly what #1388 is about.
  // The text is what makes this a regression test rather than a smoke test.
  //
  // Over the CONCATENATION of the user spans, not any single one. The stamp
  // path writes one authorship entry per doc-changing transaction, so typing
  // this string produces one entry — and one `Decoration.inline`, and one
  // `<span>` — PER KEYSTROKE. A `.last()` assertion here fails against the
  // final character alone, which is how this was first written and is worth
  // recording rather than quietly working around: it is the unbounded map
  // growth the code comments describe, visible in the DOM. Concatenating is
  // also the form that keeps holding if consecutive same-author stamps are
  // ever coalesced.
  const userText = (
    await page
      .locator(`.tandem-editor [data-tandem-author='user']`)
      .evaluateAll((els) => els.map((el) => el.textContent ?? ""))
  ).join("");
  expect(userText).toContain(USER_TYPED.trim());
});

test("inserting a Claude chat message attributes it to Claude", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_reply", { text: "Inserted by Claude" });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });

  await page.locator("[data-testid='chat-tab']").click();
  // Chat lives in the ctrl doc and is server-lifetime — `cleanupAllOpenDocuments`
  // closes documents, nothing clears chat — so pin the count rather than taking
  // `.first()`. If another spec ever posts chat text before this one runs, an
  // unpinned locator would insert THAT string and fail below as though
  // attribution were broken.
  const insertBtn = page.getByRole("button", { name: "Insert into open document" });
  await expect(insertBtn).toHaveCount(1, { timeout: 10_000 });
  await expect(insertBtn).toBeEnabled({ timeout: 10_000 });
  await insertBtn.click();

  const claudeSpan = page.locator(".tandem-editor [data-tandem-author='claude']");
  await expect(claudeSpan.first()).toBeVisible({ timeout: 10_000 });
  await expect(claudeSpan.first()).toContainText("Inserted by Claude");

  // Nothing here is user-authored, so no `"user"` decoration may exist. Not an
  // exact-set assertion: `Decoration.inline` emits one span per text node, so a
  // fixture that ever splits across nodes would red for a rendering-chunk
  // reason rather than an attribution one.
  const authors = await decoratedAuthors(page);
  expect(authors).toContain("claude");
  expect(authors).not.toContain("user");
});
