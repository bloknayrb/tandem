import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * E2E coverage for the a7 new-tab launcher (sub-PR 1.9b). The launcher replaced
 * the single-column recents dropdown — no prior E2E existed, so this is net-new.
 * Exercises: two-column structure, search auto-focus, client-side filtering and
 * the no-match state, New Scratchpad (preserved behavior), Escape dismissal, and
 * the conditional "Reopen last closed" action (hidden until a real-file tab is
 * closed; the in-session closed-tab stack ignores scratchpad/upload paths).
 */

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md", "sample2.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

const OPEN_BTN = "[data-testid='open-file-btn']";
const SEARCH = "[data-testid='new-tab-search']";
const MENU = "[role='dialog'][aria-label='New tab']";

/** Seed two distinctive recents so filter assertions are deterministic. */
async function seedRecents(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "tandem:recentFiles",
      JSON.stringify([
        { path: "~/fixtures/alpha-launcher.md", openedAt: Date.now() - 3_600_000 },
        { path: "~/fixtures/beta-launcher.txt", openedAt: Date.now() - 7_200_000 },
      ]),
    );
  });
}

test("launcher opens with search, the New Scratchpad action, and Browse", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.locator(OPEN_BTN).click();

  await expect(page.locator(SEARCH)).toBeVisible();
  await expect(page.locator("[data-testid='palette-item-new-scratchpad']")).toBeVisible();
  await expect(page.locator("[data-testid='new-tab-browse']")).toBeVisible();
  // The search input is auto-focused on open (matches the command palette).
  await expect(page.locator(SEARCH)).toBeFocused();
});

test("search filters recents and shows the no-match state", async ({ page }) => {
  await seedRecents(page);
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.locator(OPEN_BTN).click();
  // Both seeded recents are present before filtering.
  await expect(page.locator(MENU, { hasText: "alpha-launcher.md" })).toBeVisible();
  await expect(page.locator(MENU, { hasText: "beta-launcher.txt" })).toBeVisible();

  // Typing narrows to the matching entry only.
  await page.locator(SEARCH).fill("alpha-launcher");
  await expect(page.locator(MENU, { hasText: "alpha-launcher.md" })).toBeVisible();
  await expect(page.locator(MENU, { hasText: "beta-launcher.txt" })).toHaveCount(0);

  // A query that matches nothing shows the no-match state.
  await page.locator(SEARCH).fill("zzz-no-such-file");
  await expect(page.locator("[data-testid='new-tab-no-match']")).toBeVisible();
});

test("New Scratchpad action creates a scratchpad tab", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.locator(OPEN_BTN).click();
  await page.locator("[data-testid='palette-item-new-scratchpad']").click();

  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).toBeVisible({ timeout: 5_000 });
});

test("Escape dismisses the launcher", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.locator(OPEN_BTN).click();
  await expect(page.locator(MENU)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(MENU)).toHaveCount(0);
});

test("opens to the right instead of spilling off the left edge", async ({ page }) => {
  // The title-bar tab strip left-justifies against the brand cluster, so with a single
  // tab the `+` sits near the left edge. The menu (460px) would clip off-screen growing
  // left, so the morph must flip its anchor and grow RIGHT instead.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  await page.locator(OPEN_BTN).click();
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();

  // The shell flipped its anchor to grow rightward...
  await expect(page.locator(".nt-morph.grow-right")).toBeVisible();
  // ...and the menu never spills past the left viewport edge.
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
});

test("Reopen last closed is hidden until a real-file tab is closed", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" })).toBeVisible();

  // Nothing closed yet → the action is absent.
  await page.locator(OPEN_BTN).click();
  await expect(page.locator("[data-testid='new-tab-reopen-closed']")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Close the active real-file tab (sample2.md). Ctrl+W records it on the stack.
  await page.keyboard.press("Control+w");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" })).toHaveCount(
    0,
  );

  // Reopen-closed now appears, and clicking it brings sample2.md back.
  await page.locator(OPEN_BTN).click();
  const reopen = page.locator("[data-testid='new-tab-reopen-closed']");
  await expect(reopen).toBeVisible();
  await reopen.click();
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" })).toBeVisible({
    timeout: 5_000,
  });
});
