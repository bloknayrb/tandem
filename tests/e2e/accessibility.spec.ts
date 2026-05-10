import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

// ---------------------------------------------------------------------------
// Manual-review gap: axe excludes [contenteditable] / .ProseMirror
// ---------------------------------------------------------------------------
// The following surfaces are NOT audited by these tests and require manual
// dark-mode contrast review:
//   - Authorship color decorations (--tandem-author-user / --tandem-author-claude)
//     rendered as inline text-color via data-tandem-author attributes inside the
//     ProseMirror contenteditable.
//   - Annotation underline decorations (highlight, comment, note) rendered as
//     ProseMirror decorations on contenteditable text.
//   - Highlight-on-text contrast (colored backgrounds behind body copy) — covered
//     by `--tandem-highlight-*` tokens but not testable via axe on contenteditable.
// These three cases depend on document content and decoration state that axe
// cannot reach; they must be verified visually or via computed-style probes that
// trigger real content rendering.
// ---------------------------------------------------------------------------

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

  test("link input dialog has no violations", async ({ page }) => {
    await page.goto("/");
    const editor = page.locator(".tiptap");
    await expect(editor.locator("p").first()).toContainText("first paragraph", {
      timeout: 10_000,
    });

    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

    // Click inside the editor so the formatting toolbar Link button is enabled.
    await editor.click();
    await editor.locator("p").first().selectText();

    // Open the inline link input by mousedown on the Link button in FormattingToolbar.
    // We use dispatchEvent so that Tiptap's selection does not clear before the
    // popover renders (mirrors the onMouseDown handler's e.preventDefault() path).
    const linkBtn = page.locator("[data-testid='formatting-bar'] [aria-label='Link']").first();
    await linkBtn.dispatchEvent("mousedown", { bubbles: true, cancelable: true });

    await expect(page.locator("[data-testid='toolbar-link-input']")).toBeVisible({
      timeout: 3_000,
    });

    const results = await new AxeBuilder({ page })
      .include("#root")
      .exclude("[contenteditable]")
      .exclude(".ProseMirror")
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

  test("link input dialog has no violations", async ({ page }) => {
    await page.goto("/");
    const editor = page.locator(".tiptap");
    await expect(editor.locator("p").first()).toContainText("first paragraph", {
      timeout: 10_000,
    });

    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));

    await editor.click();
    await editor.locator("p").first().selectText();

    const linkBtn = page.locator("[data-testid='formatting-bar'] [aria-label='Link']").first();
    await linkBtn.dispatchEvent("mousedown", { bubbles: true, cancelable: true });

    await expect(page.locator("[data-testid='toolbar-link-input']")).toBeVisible({
      timeout: 3_000,
    });

    const results = await new AxeBuilder({ page })
      .include("#root")
      .exclude("[contenteditable]")
      .exclude(".ProseMirror")
      .disableRules(["nested-interactive"])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
