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
  // Wait for CONTENT, not just the mount. `.tandem-editor` is the ProseMirror
  // contenteditable and it mounts before the Y.Doc syncs over Hocuspocus, so
  // `locator("p").first()` can otherwise resolve to an empty placeholder — the
  // selection then covers nothing, `canHighlight` stays false, and the
  // selection-gated controls never enable. Every other spec in this suite waits
  // on text for the same reason.
  await expect(page.locator(".tandem-editor")).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await expect(page.locator("[data-testid='formatting-bar']")).toBeVisible({ timeout: 10_000 });
}

/** Computed z-index of the bar's fixed wrapper — the element the lift applies to. */
async function wrapZIndex(page: import("@playwright/test").Page): Promise<string> {
  return page
    .locator("[data-testid='formatting-bar-wrap']")
    .evaluate((el) => getComputedStyle(el).zIndex);
}

/** Resolve a design token to its numeric value so assertions never hardcode one. */
async function tokenValue(page: import("@playwright/test").Page, name: string): Promise<string> {
  return page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

/**
 * Does this element actually receive clicks at its own centre? The load-bearing
 * assertion for #1302: a clipped element still reports a non-empty box, so
 * `toBeVisible()` passes on a popover the user can neither see nor click.
 */
async function ownsItsPixels(locator: import("@playwright/test").Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });
}

/**
 * The same property at all four corners of the passed element's owning dialog —
 * for wide popovers where only an edge is clipped and a centre hit test passes.
 * The dialog is resolved with `closest()` from the passed element rather than
 * located independently: `LinkEditor` has three mount sites on one page (the
 * persistent bar, the selection popup, the editor's context menu), so a bare
 * `[role='dialog']` locator would be ambiguous.
 */
async function ownsItsCorners(locator: import("@playwright/test").Locator): Promise<boolean> {
  return locator.evaluate((el) => {
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
  expect(await ownsItsPixels(item)).toBe(true);

  // And the menu must sit inside the viewport, not off the bottom/right edge.
  const inViewport = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth
    );
  });
  expect(inViewport).toBe(true);

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

  // The click is a prerequisite, not decoration: ProseMirror's DOMObserver
  // ignores `selectionchange` unless the view owns focus, so without it
  // `editor.state.selection` stays empty and the selection-gated controls never
  // enable. Same pairing as accessibility.spec.ts and six other specs.
  await editor.click();
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
    expect(await ownsItsPixels(control), `${id} is not clickable`).toBe(true);
  }

  // Deliberately NOT asserting that a highlight gets applied here.
  // toolbar-redesign.spec.ts documents the same ROOT CAUSE surfacing one step
  // later — headless ProseMirror loses the selection around a synthesised click,
  // which there costs the follow-up swatch click and here would cost the
  // trigger's own mousedown. Either way the apply-a-color flow is out of reach
  // in headless CI. That limitation is orthogonal to #1302: this bug is about
  // the popover's geometry, and the assertions above test exactly that. The
  // recolor behaviour itself is covered by tests/client/highlight-toggle.test.ts.
});

test("link editor in the persistent bar is not clipped by the format track", async ({ page }) => {
  await openFixture(page);

  const bar = page.locator("[data-testid='formatting-bar']");
  const editor = page.locator(".tandem-editor");

  await editor.click();
  await editor.locator("p").first().selectText();
  // Dispatched for the same reason as the color toggle above. Precedent:
  // accessibility.spec.ts drives this exact button the same way.
  await bar
    .getByRole("button", { name: "Link", exact: true })
    .dispatchEvent("mousedown", { bubbles: true, cancelable: true });

  const input = bar.locator("[data-testid='toolbar-link-input']");
  await expect(input).toBeVisible();

  // The dialog must own every one of its own corners. Hit-testing beats
  // comparing rects against clipping ancestors because a rect comparison would
  // have to re-derive which ancestors actually clip this element — the very
  // logic under test — whereas a hit test reports what the user experiences and
  // stays correct however the fix is implemented.
  expect(await ownsItsCorners(input)).toBe(true);

  // Escape must still dismiss it (the wrapper keydown handler).
  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
});

test("bar lifts above the selection popup only while a popover is open", async ({ page }) => {
  await openFixture(page);

  const bar = page.locator("[data-testid='formatting-bar']");
  const editor = page.locator(".tandem-editor");

  // Asserted as a PAIR. A rule that lifted unconditionally would satisfy a
  // lift-only check while leaving the bar floating over unrelated chrome, so the
  // closed state is as load-bearing as the open one.
  const sticky = await tokenValue(page, "--tandem-z-sticky");
  const toast = await tokenValue(page, "--tandem-z-toast");
  const modal = await tokenValue(page, "--tandem-z-modal");
  expect(Number(toast)).toBeGreaterThan(Number(modal));

  await editor.locator("p").first().click();
  expect(await wrapZIndex(page), "closed: bar must not outrank the popup").toBe(sticky);

  await bar.getByRole("button", { name: "Heading", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Heading level" })).toBeVisible();
  expect(await wrapZIndex(page), "heading menu open: bar must lift").toBe(toast);

  // Dismissed by clicking away, not Escape. The trigger's mousedown calls
  // preventDefault so the editor keeps focus and the ProseMirror selection
  // survives — which also means the wrapper's Escape keydown never fires for a
  // mouse-opened menu. clickOutside is the dismissal path that actually applies
  // here, and releasing the lift on close is the half being asserted.
  await editor.locator("p").first().click();
  await expect(page.getByRole("menu", { name: "Heading level" })).toBeHidden();
  expect(await wrapZIndex(page), "closed again: lift must release").toBe(sticky);

  // The refactor's whole claim is that the lift keys on `aria-expanded` and so
  // covers every popover the bar owns, not an enumerated list. Prove it on a
  // second, independently-implemented one (Decorations lives OUTSIDE the clipped
  // track, so it exercises a different DOM path to the same rule).
  await bar.locator("[data-testid='decorations-menu-caret']").click();
  await expect(page.locator("[data-testid='decorations-menu']")).toBeVisible();
  expect(await wrapZIndex(page), "decorations menu open: bar must lift").toBe(toast);
});

test("format track truncates rather than wrapping, and never scrolls", async ({ page }) => {
  await openFixture(page);

  // The changed declaration is `overflow-x: clip` in place of `overflow: hidden`.
  // Truncation is the property `hidden` was there for, so it needs its own net —
  // every other test here would stay green if the bar started wrapping into two
  // rows or grew a scrollbar. `scrollLeft` is the one observable that actually
  // distinguishes `clip` from `hidden`: both truncate, only `hidden` scrolls.
  const track = page.locator("[data-testid='formatting-bar-track']");
  const singleRowHeight = await track.evaluate((el) => el.getBoundingClientRect().height);

  await page.setViewportSize({ width: 640, height: 800 });
  await expect(page.locator("[data-testid='formatting-bar']")).toBeVisible();

  const narrow = await track.evaluate((el) => {
    const before = el.scrollLeft;
    el.scrollLeft = 9999;
    const scrolled = el.scrollLeft;
    el.scrollLeft = before;
    return {
      truncated: el.scrollWidth > el.clientWidth + 1,
      scrollable: scrolled > 0,
      height: el.getBoundingClientRect().height,
    };
  });

  expect(narrow.truncated, "track should overflow its box at 640px").toBe(true);
  expect(narrow.scrollable, "clip must not create a scroll container").toBe(false);
  expect(narrow.height, "track must truncate, not wrap to a second row").toBeCloseTo(
    singleRowHeight,
    0,
  );
});
