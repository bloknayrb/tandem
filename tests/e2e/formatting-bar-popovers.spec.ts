import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * Regression net for #1302 — popovers owned by the PERSISTENT formatting bar
 * (`data-testid="formatting-bar"`) were rendered inside an `overflow: hidden`
 * track (`FormattingBar.svelte`), which clipped them out of existence: the
 * trigger fired and `aria-expanded` flipped, but the menu painted below the
 * track's clip edge and `elementFromPoint` at a menu item resolved to the
 * editor underneath, so clicks moved the caret instead of applying the format.
 *
 * Why this file exists at all: the only pre-existing coverage of the heading
 * dropdown (`toolbar-redesign.spec.ts`) drives the SELECTION POPUP variant,
 * whose ancestors drop their clip (`Toolbar.svelte`) — so it passed throughout.
 * These tests deliberately scope every locator to the persistent bar.
 *
 * The hit-test assertions are the load-bearing ones, and they are written to
 * outlive the implementation. A visibility check alone would NOT have caught
 * the original bug: an element clipped by an ancestor's overflow still reports
 * a non-empty box, so `toBeVisible` passes on a popover the user cannot see or
 * click. Asserting that a hit test at the element's own coordinates resolves
 * back to that element is the property that actually matters, and it holds
 * regardless of whether the fix is a CSS axis split or JS repositioning.
 */

let mcp: McpTestClient;
let tmpDir: string;

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

/** Open the fixture and wait for the editor + persistent bar to be live. */
async function openFixture(page: import("@playwright/test").Page) {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-testid='formatting-bar']")).toBeVisible({ timeout: 10_000 });
}

test("heading dropdown in the persistent bar is visible and clickable", async ({ page }) => {
  await openFixture(page);

  const bar = page.locator("[data-testid='formatting-bar']");
  const editor = page.locator(".tandem-editor");

  // Put the caret in the first paragraph so toggleHeading has a target.
  await editor.locator("p").first().click();

  // The trigger renders a serif "H" glyph but carries the accessible name
  // "Heading" (see FormattingToolbar) — match the name, not the glyph.
  await bar.getByRole("button", { name: "Heading", exact: true }).click();

  const menu = page.getByRole("menu", { name: "Heading level" });
  await expect(menu).toBeVisible();

  const item = menu.getByRole("menuitemradio", { name: "Heading 2" });
  await expect(item).toBeVisible();

  // The regression assertion: the menu item must actually own its own pixels.
  // Before the fix this resolved to the editor's scroll container.
  const ownsItsPixels = await item.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });
  expect(ownsItsPixels).toBe(true);

  // And the menu must sit inside the viewport, not off the bottom/right edge.
  const inViewport = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth
    );
  });
  expect(inViewport).toBe(true);

  // The bar must outrank the selection popup while a popover is open, or the
  // menu paints behind it (#1024/#1036). The lift keys on `aria-expanded`, so
  // it covers every popover in the bar rather than an enumerated list.
  const lifted = await page.locator(".tandem-fmtbar-wrap").evaluate((el) => {
    const z = getComputedStyle(el).zIndex;
    const popupZ = getComputedStyle(document.documentElement).getPropertyValue("--tandem-z-modal");
    return Number(z) > Number(popupZ.trim());
  });
  expect(lifted).toBe(true);

  // Clicking it applies the format — the end-to-end proof.
  await item.click();
  await expect(editor.locator("h2", { hasText: "first paragraph" })).toBeVisible({
    timeout: 3_000,
  });
});

test("highlight color picker in the persistent bar is visible and clickable", async ({ page }) => {
  await openFixture(page);

  const bar = page.locator("[data-testid='formatting-bar']");
  const editor = page.locator(".tandem-editor");

  // The color toggle is disabled without a selection (canHighlight).
  await editor.locator("p").first().selectText();

  const toggle = bar.locator("[data-testid='toolbar-highlight-color-toggle']");
  await expect(toggle).toBeEnabled();

  // Dispatched rather than `.click()`. This control is `disabled` without a
  // selection, and in headless ProseMirror drops the selection between
  // Playwright's actionability check and its synthesised click — a disabled
  // button then fires no mousedown at all, so the panel never opens. That is
  // the same limitation toolbar-redesign.spec.ts documents for this flow. A
  // dispatched mousedown reproduces the user's gesture without the focus
  // round-trip that loses the selection, and it exercises the real handler.
  await toggle.dispatchEvent("mousedown");

  // Assert EVERY swatch plus the close button, not just one. This popover sits
  // flush against the track's right edge, so a left-aligned popover overhangs
  // the horizontal clip and loses its rightmost controls specifically — pink
  // and close were unclickable while yellow/green/blue were fine. A single
  // swatch check would have passed straight through that.
  for (const id of [
    "toolbar-highlight-color-yellow",
    "toolbar-highlight-color-green",
    "toolbar-highlight-color-blue",
    "toolbar-highlight-color-pink",
    "color-picker-close",
  ]) {
    const control = page.locator(`[data-testid='${id}']`);
    await expect(control).toBeVisible();
    const ownsItsPixels = await control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    });
    expect(ownsItsPixels, `${id} is not clickable`).toBe(true);
  }

  // Deliberately NOT asserting that a highlight gets applied here.
  // toolbar-redesign.spec.ts documents that clicking the color toggle makes
  // ProseMirror clear the text selection before the swatch panel renders, which
  // puts the apply-a-color flow out of reach in headless CI regardless of
  // `preventDefault`. That limitation is orthogonal to #1302: this bug is about
  // the popover's geometry, and the assertions above test exactly that. The
  // recolor behaviour itself is covered by tests/client/highlight-toggle.test.ts.
});

test("link editor in the persistent bar is not clipped by the format track", async ({ page }) => {
  await openFixture(page);

  const bar = page.locator("[data-testid='formatting-bar']");
  const editor = page.locator(".tandem-editor");

  await editor.locator("p").first().selectText();
  // Dispatched for the same reason as the color toggle above: the Link control
  // is disabled without a selection, and headless loses the selection during
  // Playwright's click synthesis.
  await bar.getByRole("button", { name: "Link", exact: true }).dispatchEvent("mousedown");

  const input = bar.locator("[data-testid='toolbar-link-input']");
  await expect(input).toBeVisible();

  // The dialog must own every one of its own corners. Hit-testing (rather than
  // comparing rects against clipping ancestors) is what stays correct after the
  // fix: a `position: fixed` popover legitimately extends past an ancestor's
  // overflow box without being clipped by it, so a rect comparison would report
  // a false failure while a hit test reports the truth the user experiences.
  const ownsItsCorners = await input.evaluate((el) => {
    const dialog = el.closest("[role='dialog']") as HTMLElement | null;
    if (!dialog) return false;
    const d = dialog.getBoundingClientRect();
    const inset = 4;
    const corners: Array<[number, number]> = [
      [d.left + inset, d.top + inset],
      [d.right - inset, d.top + inset],
      [d.left + inset, d.bottom - inset],
      [d.right - inset, d.bottom - inset],
    ];
    return corners.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && dialog.contains(hit);
    });
  });
  expect(ownsItsCorners).toBe(true);

  // Escape must still dismiss it (the wrapper keydown handler).
  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
});
