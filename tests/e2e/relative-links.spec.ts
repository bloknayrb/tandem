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

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  // Copy both fixture files into the same temp directory so the relative link resolves
  tmpDir = createFixtureDir("link-source.md", "link-target.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("clicking a relative .md link opens the target file as a new tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "link-source.md") });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText("Link Source");

  // The link text "Open the target document" is rendered as an anchor in the editor
  const link = editor.locator("a", { hasText: "Open the target document" });
  await expect(link).toBeVisible({ timeout: 5_000 });

  // Click the link — it should open link-target.md as a new tab without navigating away
  await link.click();

  // Wait for the new tab to appear in the tab bar
  const targetTabName = page.locator("[data-testid^='tab-name-']", {
    hasText: "link-target.md",
  });
  await expect(targetTabName).toBeVisible({ timeout: 10_000 });

  // The source tab should still be present
  const sourceTabName = page.locator("[data-testid^='tab-name-']", {
    hasText: "link-source.md",
  });
  await expect(sourceTabName).toBeVisible();
});

test("clicking a bare nested relative .md link opens the target as a new tab (#1377)", async ({
  page,
}) => {
  // Only the SOURCE is a fixture; the nested target is written inline so
  // `createFixtureDir` (38 call sites across 35 specs) stays untouched.
  const nestedDir = createFixtureDir("link-source-nested.md");
  try {
    fs.mkdirSync(path.join(nestedDir, "subdir"), { recursive: true });
    // DISTINCT content, not a copy of link-target.md: identical fixture content
    // across tests is what triggers the rename-recovery envelope collision that
    // `cleanupFixtureDir`'s own comment warns about.
    fs.writeFileSync(
      path.join(nestedDir, "subdir", "link-target.md"),
      "# Nested Link Target\n\nReached through a bare nested relative link.\n",
    );
    // NOTE: `cleanupFixtureDir`'s envelope sweep is NON-recursive, so it would
    // not clean an envelope for `subdir/link-target.md`. Harmless here because
    // this test creates no annotations — anyone adding an annotation-creating
    // nested test must fix the sweep first.

    await mcp.callTool("tandem_open", {
      filePath: path.join(nestedDir, "link-source-nested.md"),
    });

    await page.goto("/");
    const editor = page.locator(".tandem-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await expect(editor).toContainText("Nested Link Source");

    const link = editor.locator("a", { hasText: "Open the nested target" });
    await expect(link).toBeVisible({ timeout: 5_000 });

    // The regression assertions: both were empty/absent before #1377 — the
    // base guard blanked the href, and the blanked href also suppressed the
    // #996 tooltip.
    await expect(link).toHaveAttribute("href", "subdir/link-target.md");
    await expect(link).toHaveAttribute("title", "subdir/link-target.md");

    await link.click();

    const targetTabName = page.locator("[data-testid^='tab-name-']", {
      hasText: "link-target.md",
    });
    await expect(targetTabName).toBeVisible({ timeout: 10_000 });

    const sourceTabName = page.locator("[data-testid^='tab-name-']", {
      hasText: "link-source-nested.md",
    });
    await expect(sourceTabName).toBeVisible();
  } finally {
    cleanupFixtureDir(nestedDir);
  }
});

test("an editor link shows a pointer cursor and a title tooltip with its destination (#996)", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "link-source.md") });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText("Link Source");

  const link = editor.locator("a", { hasText: "Open the target document" });
  await expect(link).toBeVisible({ timeout: 5_000 });

  // The href in the fixture is the relative path "link-target.md".
  await expect(link).toHaveAttribute("href", "link-target.md");
  // Hover affordance: the destination URL is surfaced as a native title tooltip.
  await expect(link).toHaveAttribute("title", "link-target.md");
  // ...and the cursor reads as interactive.
  await expect(link).toHaveCSS("cursor", "pointer");
});

test("a disallowed-scheme link renders inert — no live href, no title (#996 security)", async ({
  page,
}) => {
  // mdast→Y.Doc stores link URLs verbatim (no scheme check), so a .md authored
  // with a javascript: href reaches the editor. The renderHTML override must
  // delegate to the base extension's blanking branch, which runs against the
  // CONFIGURED `isAllowedUri` (`ctx.defaultValidate(url) ||
  // isSchemelessPathHref(url)`, #1377). A `javascript:` href satisfies neither
  // half: the scheme fails `defaultValidate`, and its colon precedes any `/`,
  // `#` or `?`, so `hasSchemePrefix` sees a scheme. The override must also NOT
  // mirror the disallowed scheme into a title tooltip.
  const xssDir = createFixtureDir("link-xss.md");
  try {
    await mcp.callTool("tandem_open", { filePath: path.join(xssDir, "link-xss.md") });

    await page.goto("/");
    const editor = page.locator(".tandem-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await expect(editor).toContainText("XSS Link");

    const link = editor.locator("a", { hasText: "click me" });
    await expect(link).toBeVisible({ timeout: 5_000 });

    // The base guard blanks the href; our title-injection must not resurrect it.
    const href = await link.getAttribute("href");
    expect(href ?? "").not.toContain("javascript:");
    const title = await link.getAttribute("title");
    expect(title ?? "").not.toContain("javascript:");
  } finally {
    cleanupFixtureDir(xssDir);
  }
});

test("a link that renders live but cannot be opened SAYS so (#1377 render/click gap)", async ({
  page,
}) => {
  // #1377 widened the RENDER boundary without widening the click boundary, so
  // an href can be live — pointer cursor, tooltip naming a destination — and
  // still be refused on click. Before this test the refusal was a
  // `console.warn`, which is not a channel in the primary distribution: the
  // Tauri release build ships no `devtools` feature, and `diagnostics.ts` has
  // no console ring buffer, so it reached neither the user nor a bug report.
  //
  // `report.docx` is the shape that will actually bite: .docx is first-class
  // in drag-drop, the file dialog and `tandem_open`, but excluded from
  // INTERNAL_LINK_EXTS (see #1421).
  const dir = createFixtureDir("link-unopenable.md");
  try {
    await mcp.callTool("tandem_open", { filePath: path.join(dir, "link-unopenable.md") });

    await page.goto("/");
    const editor = page.locator(".tandem-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await expect(editor).toContainText("Unopenable Link");

    // Precondition: the link really did render live. If this ever fails the
    // test is passing vacuously — there would be no gap left to report.
    const link = editor.locator("a", { hasText: "the quarterly report" });
    await expect(link).toBeVisible({ timeout: 5_000 });
    await expect(link).toHaveAttribute("href", "report.docx");
    await expect(link).toHaveAttribute("title", "report.docx");

    await link.click();

    // The refusal reaches the activity tray, which persists to localStorage and
    // therefore survives into a bug report — unlike a console warn.
    const pill = page.getByTestId("activity-pill");
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await pill.click();

    const tray = page.getByTestId("activity-tray");
    await expect(tray).toBeVisible({ timeout: 5_000 });
    await expect(tray).toContainText("report.docx");

    // And it did NOT open a tab.
    await expect(
      page.locator("[data-testid^='tab-name-']", { hasText: "report.docx" }),
    ).toHaveCount(0);
  } finally {
    cleanupFixtureDir(dir);
  }
});

test("a cross-host-shaped href renders inert — no live href, no title (#1420)", async ({
  page,
}) => {
  // `/\evil.com/x.md` renders live on master: the configured guard is
  // `defaultValidate(url) || isSchemelessPathHref(url)`, and `defaultValidate`
  // accepts a leading `/` via its `[^a-z]` alternative WITHOUT looking at what
  // follows — so the `||` short-circuits the (correct) rejection away. A
  // browser resolves the result to `http://evil.com/x.md`.
  //
  // mdast→Y.Doc stores link URLs verbatim (`mdast-ydoc.ts` writes
  // `href: node.url` with no sanitization), so opening a crafted `.md` is the
  // delivery path — the dominant untrusted-content surface for this app.
  const dir = createFixtureDir("link-crosshost.md");
  try {
    await mcp.callTool("tandem_open", { filePath: path.join(dir, "link-crosshost.md") });

    await page.goto("/");
    const editor = page.locator(".tandem-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await expect(editor).toContainText("Cross-Host Link");

    const link = editor.locator("a", { hasText: "click me" });
    await expect(link).toBeVisible({ timeout: 5_000 });

    // The render-time veto blanks it, and the title-injection must not
    // resurrect it into a tooltip advertising the destination.
    expect(await link.getAttribute("href")).toBe("");
    expect(await link.getAttribute("title")).toBeNull();
  } finally {
    cleanupFixtureDir(dir);
  }
});

test("middle-clicking a relative link routes through the intercept (#1420)", async ({ page }) => {
  // NOTE ON WHAT THIS DOES AND DOES NOT PROVE. Chromium already suppresses the
  // middle-click navigation inside a `contenteditable`, so "no popup opened" is
  // NOT load-bearing here — it holds on master too. What this asserts is that
  // the `auxclick` gesture now reaches `openHref` at all: on master no
  // `auxclick` listener existed, so no Tandem tab opened. The read-only test
  // below is the one that proves `preventDefault()` suppresses anything.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "link-source.md") });

  await page.goto("/");
  const editor = page.locator(".tandem-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText("Link Source");

  const link = editor.locator("a", { hasText: "Open the target document" });
  await expect(link).toBeVisible({ timeout: 5_000 });

  await link.click({ button: "middle" });

  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "link-target.md" }),
  ).toBeVisible({ timeout: 10_000 });
});

test("middle-clicking a link in a READ-ONLY document does not navigate away (#1420)", async ({
  page,
  context,
}) => {
  // THE LOAD-BEARING ROW. Chromium raises the middle-click default action only
  // outside a `contenteditable`, and Tandem's editor is
  // `contenteditable={String(view.editable)}` — so the reproducible surface is
  // the READ-ONLY editor: View Changelog, upgrade-opens-CHANGELOG.md,
  // `upload://` files, and any `POST /api/open {readOnly:true}`. That is also
  // the surface most likely to be carrying externally-authored content.
  //
  // Measured on master: middle-click in a non-editable editor opens a popup
  // (a real navigation to the resolved URL); with a `preventDefault()` listener
  // it drops to zero.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "link-source.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // Re-open read-only through the same route the View Changelog button uses.
  const status = await page.evaluate(
    async (fp) => {
      const res = await fetch("http://127.0.0.1:3479/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: fp, readOnly: true, force: false }),
      });
      return res.status;
    },
    path.join(tmpDir, "link-source.md"),
  );
  expect(status).toBe(200);

  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText("Link Source");
  // Precondition: without this the test would pass vacuously against an
  // editable document, where Chromium suppresses the default action anyway.
  await expect
    .poll(async () => editor.getAttribute("contenteditable"), { timeout: 10_000 })
    .toBe("false");

  const link = editor.locator("a", { hasText: "Open the target document" });
  await expect(link).toBeVisible({ timeout: 5_000 });

  // Collect any popup the browser opens on its own. Asserted BEFORE the
  // Tandem-tab assertion on purpose: if the tab check came first it would fail
  // first under a regression, and this clause — the one that actually proves
  // `preventDefault()` suppressed a navigation — would never be reached.
  const popups: string[] = [];
  context.on("page", (opened) => popups.push(opened.url()));

  await link.click({ button: "middle" });

  // Bounded settle: this asserts that something did NOT happen, so there is no
  // state to poll for. Measured without the `auxclick` handler, Chromium opens
  // the popup well inside this window.
  await page.waitForTimeout(2_000);
  expect(popups, "middle click must not open a browser tab").toEqual([]);
  expect(page.url()).toContain("127.0.0.1");

  // And the gesture did open a Tandem tab instead.
  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "link-target.md" }),
  ).toBeVisible({ timeout: 10_000 });
});
