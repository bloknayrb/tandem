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
