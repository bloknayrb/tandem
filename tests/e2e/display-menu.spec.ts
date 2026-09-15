/**
 * The Display menu (#1705 text size, #1706 reading measure): a quick control
 * for two EXISTING settings, reachable from the formatting bar and mirrored in
 * the selection popup's format row.
 *
 * What these pin, against the real app and the real settings store:
 *   - quick → Settings: a pick changes what the editor renders, what is
 *     persisted in `tandem:settings`, and what the Settings modal shows;
 *   - Settings → quick: a modal pick is what the menu shows, across a reload;
 *   - a pick does not remount the editor, move to another document, or reset
 *     the scroll position;
 *   - the popup copy writes on its own when the bar is hidden.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  selectTextStable,
} from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

const MODAL = "[data-testid='settings-modal']";
const BAR = "[data-testid='formatting-bar']";
const POPUP_ROW = "[data-testid='popup-format-row']";

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  // `tall.md` (an H1 plus many short paragraphs) rather than `sample.md`,
  // which is too short to scroll — the scroll-preservation case needs a real
  // scroll offset to lose.
  tmpDir = createFixtureDir("tall.md");
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "tall.md") });
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
}

async function openSettingsModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tandemTest?: { openSettingsModal: () => void } };
    if (!w.__tandemTest?.openSettingsModal) {
      throw new Error("__tandemTest.openSettingsModal is not installed");
    }
    w.__tandemTest.openSettingsModal();
  });
  await expect(page.locator(MODAL)).toBeVisible({ timeout: 5_000 });
}

async function closeSettingsModal(page: Page): Promise<void> {
  await page.locator(MODAL).press("Escape");
  await expect(page.locator(MODAL)).toHaveCount(0);
}

/** Open the Display menu under `scope` and return a locator for one item. */
async function openMenu(page: Page, scope: string): Promise<Locator> {
  const root = page.locator(scope);
  await root.locator("[data-testid='display-menu-trigger']").click();
  const menu = root.locator("[data-testid='display-menu']");
  await expect(menu).toBeVisible();
  return menu;
}

const editorFontSize = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--tandem-editor-font-size").trim(),
  );

const storedSettings = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("tandem:settings") ?? "{}"));

test("quick → Settings: picking Large applies, persists and shows in Settings", async ({
  page,
}) => {
  await boot(page);
  const menu = await openMenu(page, BAR);
  await menu.locator("[data-testid='display-menu-text-size-l']").click();

  await expect.poll(() => editorFontSize(page)).toBe("18px");
  await expect.poll(async () => (await storedSettings(page)).textSize).toBe("l");
  // A pick closes the menu, as a Decorations row does.
  await expect(page.locator(`${BAR} [data-testid='display-menu']`)).toHaveCount(0);

  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-appearance']").click();
  await expect(page.locator("[data-testid='text-size-l-btn']")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("Settings → quick: a modal pick is what the menu shows, across a reload", async ({ page }) => {
  await boot(page);
  await openSettingsModal(page);
  await page.locator("[data-testid='settings-modal-tab-appearance']").click();
  await page.locator("[data-testid='text-size-s-btn']").click();
  await closeSettingsModal(page);

  let menu = await openMenu(page, BAR);
  await expect(menu.locator("[data-testid='display-menu-text-size-s']")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator(`${BAR} [data-testid='display-menu-trigger']`)).toHaveAttribute(
    "aria-label",
    /text Small/,
  );

  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  menu = await openMenu(page, BAR);
  await expect(menu.locator("[data-testid='display-menu-text-size-s']")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

/**
 * Tag the ProseMirror view, scroll, and read the active document id. The tag is
 * the remount discriminator: #1055's per-tab scroll memory restores `scrollTop`
 * across a remount, so scroll alone would not reveal one.
 */
async function markDocumentState(page: Page): Promise<string | null> {
  await page.locator(".tandem-editor").evaluate((el) => {
    (el as HTMLElement & { __g7?: boolean }).__g7 = true;
  });
  const scroller = page.locator(".editor-scroll");
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(400);
  await scroller.evaluate((el) => {
    el.scrollTop = 500;
  });
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  return page.evaluate(() =>
    (
      window as unknown as { __tandemTest: { activeDocumentId: () => string | null } }
    ).__tandemTest.activeDocumentId(),
  );
}

async function expectDocumentStatePreserved(page: Page, docId: string | null): Promise<void> {
  expect(
    await page
      .locator(".tandem-editor")
      .evaluate((el) => (el as HTMLElement & { __g7?: boolean }).__g7 === true),
    "the editor view was remounted",
  ).toBe(true);
  expect(await page.locator(".editor-scroll").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __tandemTest: { activeDocumentId: () => string | null } }
      ).__tandemTest.activeDocumentId(),
    ),
  ).toBe(docId);
}

test("a text-size pick keeps the editor view, the scroll position and the document", async ({
  page,
}) => {
  await boot(page);
  const docId = await markDocumentState(page);
  expect(docId).not.toBeNull();

  const menu = await openMenu(page, BAR);
  await menu.locator("[data-testid='display-menu-text-size-l']").click();
  await expect.poll(() => editorFontSize(page)).toBe("18px");

  await expectDocumentStatePreserved(page, docId);
});

test("bar hidden: the popup's Display menu writes text size on its own", async ({ page }) => {
  await boot(page);
  await page.locator("[data-testid='formatbar-hide-btn']").click();
  await expect(page.locator(BAR)).toHaveCount(0);

  await selectTextStable(page.locator(".tandem-editor p").first());
  await expect(page.locator(".selection-popup")).toBeVisible();

  const menu = await openMenu(page, POPUP_ROW);
  await menu.locator("[data-testid='display-menu-text-size-s']").click();

  // Small is not the default, so this passes only if the popup's write landed.
  await expect.poll(() => editorFontSize(page)).toBe("14px");
  await expect(page.locator(".selection-popup")).toBeVisible();
});
