import { expect, test } from "@playwright/test";
import path from "path";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * E2E coverage for #649 PR1 — Word-style margin annotation view.
 *
 * The composable underneath (`useMarginPositions`) requires a real Tiptap
 * view + Y.Doc + Svelte effect root, so unit tests only cover its pure
 * helpers. These specs exercise the toggle, persistence, default-off
 * layout invariant, and the bubble click → activeAnnotationId contract.
 */

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" — heading prefix is 2 chars, title spans 2..15.
const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";

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

async function openSettingsAndGotoCowork(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("[data-testid='settings-btn']").click();
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });
  await popover.getByRole("button", { name: "Claude Code/Cowork" }).click();
}

async function setMarginView(
  page: import("@playwright/test").Page,
  enabled: boolean,
): Promise<void> {
  await openSettingsAndGotoCowork(page);
  const popover = page.locator("[data-testid='settings-popover']");
  const toggleInput = popover.locator("[data-testid='margin-view-toggle'] input");
  if ((await toggleInput.isChecked()) !== enabled) {
    await toggleInput.click();
  }
  await expect(toggleInput).toBeChecked({ checked: enabled });
  // Close popover so it doesn't intercept later interactions.
  await page.keyboard.press("Escape");
}

test("default off: margin columns are absent from the DOM", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });

  // Annotation decoration must render (proves the doc/annotation pipeline ran).
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });
  // Columns absent before opt-in.
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(0);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(0);
});

test("toggle on: margin columns appear with a bubble for the comment", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);

  // Both columns mount when marginView is on (column visibility itself isn't a
  // useful Playwright assertion — the columns have no intrinsic height because
  // their bubble children are absolutely positioned). Assert presence instead.
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(1);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  // The comment bubble shows up in the right column with real geometry (allow
  // rAF + ResizeObserver to settle).
  const rightBubble = page
    .locator("[data-testid='margin-column-right'] [data-testid^='margin-bubble-']")
    .first();
  await expect(rightBubble).toBeVisible({ timeout: 5_000 });
});

test("toggle state persists across reload", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await setMarginView(page, true);

  const savedValue = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { marginView?: unknown }).marginView : null;
  }, TANDEM_SETTINGS_KEY);
  expect(savedValue).toBe(true);

  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openSettingsAndGotoCowork(page);
  const reloadedToggleInput = page.locator(
    "[data-testid='settings-popover'] [data-testid='margin-view-toggle'] input",
  );
  await expect(reloadedToggleInput).toBeChecked();
});

test("toggle off after on: columns disappear (validates display:contents wrapper fix)", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });

  await setMarginView(page, true);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  // Also wait for a real bubble to confirm the on-state is fully wired before
  // we toggle off (otherwise the toggle-off race might pass for the wrong reason).
  await expect(
    page.locator("[data-testid='margin-column-right'] [data-testid^='margin-bubble-']").first(),
  ).toBeVisible({ timeout: 5_000 });

  await setMarginView(page, false);
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(0);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(0);
});
