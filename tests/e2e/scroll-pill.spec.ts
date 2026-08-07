import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * The editor scroll pill: a proximity-faded thumb replacing the native
 * scrollbar, which `scroll-fade.css` hides on `.editor-scroll`.
 *
 * What these tests pin, in order of what would actually break:
 *   1. The thumb appears for a long document and is proportionally sized.
 *   2. Dragging it scrubs the document.
 *   3. Opacity really is a function of cursor distance — the whole point.
 *   4. The setting's OFF state restores the native scrollbar rather than
 *      leaving the editor with no affordance at all.
 *   5. A short document gets no pill, despite `.editor-end-marker`'s 70vh of
 *      trailing whitespace making almost everything technically overflow.
 */

let mcp: McpTestClient;
let tmpDir: string;

const APP_URL = "http://127.0.0.1:5173";

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("tall.md", "sample2.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

/** Seed `tandem:settings` before app boot. Merges onto whatever is there. */
async function seedSettings(
  page: import("@playwright/test").Page,
  patch: Record<string, unknown>,
): Promise<void> {
  await page.addInitScript((p) => {
    const KEY = "tandem:settings";
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    } catch {
      existing = {};
    }
    localStorage.setItem(KEY, JSON.stringify({ ...existing, ...(p as object) }));
  }, patch);
}

const thumbOf = (page: import("@playwright/test").Page) =>
  page.locator("[data-testid='editor-scroll-pill-thumb']");
const scrollerOf = (page: import("@playwright/test").Page) =>
  page.locator("[data-testid='editor-scroll-container']");

/** Current computed opacity of the thumb, as a number. */
async function thumbOpacity(page: import("@playwright/test").Page): Promise<number> {
  return thumbOf(page).evaluate((el) => Number(getComputedStyle(el).opacity));
}

/** Open `tall.md` and wait until the pill is actually painted. */
async function openTall(page: import("@playwright/test").Page, expectPill = true): Promise<void> {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "tall.md") });
  await page.goto(APP_URL);
  const scroller = scrollerOf(page);
  await expect(scroller).toBeVisible();
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(400);
  if (expectPill) {
    await expect
      .poll(async () => thumbOf(page).evaluate((el) => getComputedStyle(el).display))
      .toBe("block");
  }
}

/**
 * Park the cursor far from the pill and wait out the attach flash, so a test
 * measuring the resting opacity isn't racing the announce pulse.
 */
async function settleDim(page: import("@playwright/test").Page, y = 400): Promise<void> {
  await page.mouse.move(40, y);
  await expect.poll(async () => thumbOpacity(page), { timeout: 5_000 }).toBeLessThan(0.05);
}

test("thumb renders for a long document, sized proportionally", async ({ page }) => {
  await openTall(page);
  const thumb = thumbOf(page);

  const track = page.locator("[data-testid='editor-scroll-pill']");
  const trackBox = await track.boundingBox();
  const thumbBox = await thumb.boundingBox();
  expect(trackBox).not.toBeNull();
  expect(thumbBox).not.toBeNull();
  // Proportional, not full-height, and never below the grab-target floor.
  expect(thumbBox?.height).toBeGreaterThanOrEqual(36);
  expect(thumbBox?.height).toBeLessThan((trackBox?.height ?? 0) * 0.9);
});

test("dragging the thumb scrubs the document", async ({ page }) => {
  await openTall(page);
  const scroller = scrollerOf(page);
  const thumb = thumbOf(page);

  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBe(0);

  const box = await thumb.boundingBox();
  expect(box).not.toBeNull();
  const startY = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;

  await page.mouse.move(x, startY);
  await page.mouse.down();
  await page.mouse.move(x, startY + 200, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);

  // The body drag class must not survive the release, or the whole app is
  // left unselectable with a grabbing cursor.
  await expect
    .poll(async () =>
      page.evaluate(() => document.body.classList.contains("tandem-scroll-pill-dragging")),
    )
    .toBe(false);
});

test("thumb stays lit under the cursor after a drag is released", async ({ page }) => {
  // Regression: the drag path pins opacity to 1 while dragging, so the pointer
  // cache was left at the pointerdown coordinate. On release the pin dropped
  // and distance was measured from where the drag STARTED — several hundred px
  // away — so the pill vanished with the cursor sitting directly on it.
  await openTall(page);
  const thumb = thumbOf(page);

  const box = await thumb.boundingBox();
  expect(box).not.toBeNull();
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const startY = (box?.y ?? 0) + (box?.height ?? 0) / 2;

  await page.mouse.move(x, startY);
  await page.mouse.down();
  await page.mouse.move(x, startY + 400, { steps: 12 });
  await page.mouse.up();

  // Wait past the post-release scroll flash — it lights the pill for ~1.1s
  // regardless of the pointer cache, and would mask the bug entirely. What is
  // under test is the state AFTER the flash: the cursor has not moved since
  // release and is still sitting on the thumb, so proximity alone must hold it
  // lit. With a stale cache the pill goes dark here.
  await page.waitForTimeout(1400);
  expect(await thumbOpacity(page)).toBeGreaterThan(0.9);
});

test("reduce motion keeps the scroll indicator, without the fade ramp", async ({ page }) => {
  // Regression: suppressing the flash under reduce-motion left this cohort with
  // no scroll feedback at all, since the native bar is hidden while the pill is
  // on. Reduce-motion drops the easing, not the information.
  await seedSettings(page, { reduceMotion: true });
  await openTall(page);

  await page.mouse.move(40, 400);
  await scrollerOf(page).evaluate((el) => {
    el.scrollTop = 500;
  });
  await expect.poll(async () => thumbOpacity(page)).toBeGreaterThan(0.9);
  // Still self-terminating — the step function cuts at the hold boundary.
  await expect.poll(async () => thumbOpacity(page), { timeout: 5_000 }).toBeLessThan(0.05);
});

test("opacity falls off with cursor distance and recovers on approach", async ({ page }) => {
  await openTall(page);
  const thumb = thumbOf(page);

  const box = await thumb.boundingBox();
  expect(box).not.toBeNull();
  const thumbX = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const thumbY = (box?.y ?? 0) + (box?.height ?? 0) / 2;

  await settleDim(page, thumbY);

  // Approach: on the thumb it must be fully lit.
  await page.mouse.move(thumbX, thumbY);
  await expect.poll(async () => thumbOpacity(page)).toBeGreaterThan(0.9);

  // Mid-range sits strictly between the two — this is the fade, not a
  // two-state show/hide.
  await page.mouse.move(thumbX - 150, thumbY);
  await expect.poll(async () => thumbOpacity(page)).toBeGreaterThan(0.02);
  await expect.poll(async () => thumbOpacity(page)).toBeLessThan(0.9);
});

test("scrolling flashes the thumb even with the cursor far away", async ({ page }) => {
  await openTall(page);
  await settleDim(page);

  await scrollerOf(page).evaluate((el) => {
    el.scrollTop = 500;
  });
  await expect.poll(async () => thumbOpacity(page)).toBeGreaterThan(0.5);
  // …and decays back down on its own, with no further events to drive it.
  await expect.poll(async () => thumbOpacity(page), { timeout: 5_000 }).toBeLessThan(0.05);
});

test("setting off hides the pill AND restores the native scrollbar", async ({ page }) => {
  // The regression this guards: `scroll-fade.css` hides the native bar on this
  // element, so a pill-off state that did not restore it would leave the editor
  // with no scroll affordance whatsoever — the bug the pill exists to fix.
  await seedSettings(page, { scrollPill: false });
  await openTall(page, false);

  await expect
    .poll(async () => thumbOf(page).evaluate((el) => getComputedStyle(el).display))
    .toBe("none");

  const scroller = scrollerOf(page);
  await expect(scroller).not.toHaveClass(/tandem-scroll-pill-host/);
  await expect
    .poll(async () => scroller.evaluate((el) => getComputedStyle(el).scrollbarWidth))
    .not.toBe("none");
});

test("no pill for a short document, despite the 70vh end marker", async ({ page }) => {
  // `.editor-end-marker` adds 70vh of deliberate blank scroll room, so raw
  // `scrollHeight > clientHeight` is true for almost any file. The pill must
  // measure the DOCUMENT, not the scrollable extent.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto(APP_URL);
  await expect(scrollerOf(page)).toBeVisible();

  // The raw extent does overflow — that is precisely why the correction exists.
  await expect
    .poll(async () => scrollerOf(page).evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(0);

  await expect
    .poll(async () => thumbOf(page).evaluate((el) => getComputedStyle(el).display), {
      timeout: 5_000,
    })
    .toBe("none");
});
