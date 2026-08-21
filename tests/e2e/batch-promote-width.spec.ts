import { expect, test } from "@playwright/test";
import path from "path";
import { PANEL_MIN_WIDTH } from "../../src/client/panel-layout";
import { PANEL_WIDTH_KEY } from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  switchToAnnotationsTab,
} from "./helpers";

/**
 * The batch-promote confirm row must fit the rail it lives in (#1444).
 *
 * This exists because the confirm gate shipped without anyone measuring it, and
 * the failure is silent in every way that matters. `BatchPromoteBar` is
 * `position: sticky; top: 0` — but not `left: 0` — inside a scroll container
 * that sets `overflow-y: auto`, which makes `overflow-x` compute to `auto` too.
 * So a row too wide for the rail does not clip visibly or throw: it slides the
 * commit button out past the right edge, reachable only by scrolling a bar that
 * is pinned to the top and looks complete. Nothing in the DOM is wrong, no
 * assertion elsewhere fails, and axe has nothing to say about it.
 *
 * Measured on the version that introduced the gate: at the rail's 200px minimum
 * the confirm row ran 105-141px past the edge at every density and the commit
 * button itself sat 17-41px outside it; at the 300px default it still overran
 * by 5-41px. The fix swaps the whole row (dropping the count and Clear, as
 * BulkActions does) and lets the sentence wrap instead of shove.
 *
 * The assertions are deliberately about geometry rather than a pixel budget —
 * a height limit would fail the moment the copy or the density scale changed,
 * while "the button the user must press is inside the panel" stays true for any
 * future layout that is not broken.
 */

test.setTimeout(90_000);

let mcp: McpTestClient;
let tmpDir: string;

const DOCX_FIXTURE = "reviewer-comments.docx";

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir(DOCX_FIXTURE);
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

// Spacious is the worst case (largest gaps and padding), and the minimum rail
// width is the tightest surface a user can actually produce by dragging.
for (const density of ["cozy", "spacious"]) {
  test(`confirm row fits the minimum-width rail (${density})`, async ({ page }) => {
    await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, DOCX_FIXTURE) });
    await page.addInitScript(([key, width]) => localStorage.setItem(key as string, String(width)), [
      PANEL_WIDTH_KEY,
      PANEL_MIN_WIDTH,
    ] as [string, number]);
    await page.goto("/");
    await page.evaluate((d) => document.documentElement.setAttribute("data-density", d), density);
    await switchToAnnotationsTab(page);

    const checkboxes = page.locator("[data-testid^='annotation-select-checkbox-']");
    await expect(checkboxes).toHaveCount(2, { timeout: 25_000 });
    for (let i = 0; i < 2; i++) await checkboxes.nth(i).check();

    await expect(page.locator("[data-testid='batch-promote-bar']")).toBeVisible();
    await page.locator("[data-testid='batch-promote-confirm']").click();
    const commit = page.locator("[data-testid='batch-promote-commit']");
    await expect(commit).toBeVisible();

    const geometry = await commit.evaluate((btn) => {
      const bar = btn.closest("[data-testid='batch-promote-bar']") as HTMLElement;
      const scroller = bar.parentElement as HTMLElement;
      const b = btn.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      return {
        barWidth: Math.round(bar.getBoundingClientRect().width),
        railWidth: scroller.clientWidth,
        commitOverhang: Math.round(b.right - s.right),
      };
    });

    expect(
      geometry.barWidth,
      "the confirm row is wider than the rail — it will overflow horizontally",
    ).toBeLessThanOrEqual(geometry.railWidth);
    expect(
      geometry.commitOverhang,
      "the commit button sits past the rail's right edge, behind a horizontal scroll",
    ).toBeLessThanOrEqual(0);
  });
}
