import { expect, type Page, test } from "@playwright/test";
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
  tmpDir = createFixtureDir("sample.md", "sample2.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("tab renders with filename, tooltip shows full path", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");

  // Wait for the sample.md tab by its name content
  const tabName = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  await expect(tabName).toBeVisible();

  // Tooltip should show full file path
  const title = await tabName.getAttribute("title");
  expect(title).toContain("sample.md");
  expect(title).toContain(path.sep); // Should be a full path, not just filename
});

test("tab scroll container exists", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await page.waitForSelector("[data-testid='tab-scroll-container']");

  const container = page.locator("[data-testid='tab-scroll-container']");
  await expect(container).toBeVisible();
});

test("multiple tabs appear", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  // Both our test tabs should be present
  const sample1 = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample1).toBeVisible();
  await expect(sample2).toBeVisible();
});

test("keyboard reorder with Alt+Arrow swaps tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  // Wait for sample2.md tab to appear.
  const sample2Name = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample2Name).toBeVisible();

  // The tab element (role='tab') owns the keyboard handler — focus must land
  // there, not on the inner [tab-name-…] span. Match the drag test pattern below.
  const tabs = page.locator("[data-testid^='tab-'][role='tab']");
  const sample2Tab = tabs.filter({ hasText: "sample2.md" });

  // Get all tab names and find sample2's position. One round trip via
  // `allTextContents()` beats a sequential `nth(i).textContent()` loop.
  const allNames = page.locator("[data-testid^='tab-name-']");
  const initialIdx = (await allNames.allTextContents()).indexOf("sample2.md");
  expect(initialIdx).toBeGreaterThan(0); // sample2 should not be first

  // Click the tab itself, wait for focus to land (auto-retry), then press
  // Alt+ArrowLeft. expect.poll on the post-reorder text absorbs Svelte
  // reactivity → DOM update latency without a fixed sleep.
  await sample2Tab.click();
  await expect(sample2Tab).toBeFocused();
  await page.keyboard.press("Alt+ArrowLeft");

  await expect.poll(async () => allNames.nth(initialIdx - 1).textContent()).toBe("sample2.md");
});

test("mouse drag reorders tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  const tabs = page.locator("[data-testid^='tab-'][role='tab']");
  const sample1Tab = tabs.filter({ hasText: "sample.md" });
  const sample2Tab = tabs.filter({ hasText: "sample2.md" });
  await expect(sample1Tab).toBeVisible();
  await expect(sample2Tab).toBeVisible();

  const allNames = page.locator("[data-testid^='tab-name-']");
  const initial = await allNames.allTextContents();
  const initialS1 = initial.indexOf("sample.md");
  const initialS2 = initial.indexOf("sample2.md");
  expect(initialS1).toBeGreaterThanOrEqual(0);
  expect(initialS2).toBeGreaterThanOrEqual(0);
  const initialDelta = initialS1 - initialS2;

  // Resolve the document ids of the two tabs by reading data-testid off the
  // rendered DOM (the [data-testid^='tab-name-'] descendant lives inside the
  // tab div whose own data-testid is `tab-{id}`).
  const tabIds = await page.evaluate(() => {
    const list: Record<string, string> = {};
    document.querySelectorAll<HTMLElement>("[data-testid^='tab-'][role='tab']").forEach((el) => {
      const tid = el.getAttribute("data-testid") ?? "";
      const id = tid.startsWith("tab-") ? tid.slice("tab-".length) : "";
      const name = el.querySelector("[data-testid^='tab-name-']")?.textContent ?? "";
      if (id && name) list[name] = id;
    });
    return list;
  });
  const s1Id = tabIds["sample.md"];
  const s2Id = tabIds["sample2.md"];
  expect(s1Id).toBeTruthy();
  expect(s2Id).toBeTruthy();

  // Drag the later-positioned tab onto the earlier one — their relative order should flip.
  // Reorder is now driven by POINTER events (DocumentTabs.svelte), not HTML5 DnD: in the
  // Tauri desktop app `dragDropEnabled: true` makes the WebView swallow HTML5 drag events,
  // so the production handlers listen on pointerdown/move/up. Playwright's page.mouse.*
  // synthesizes real pointer events, so a native mouse drag now exercises the real path
  // (it could not with the old HTML5 handlers — see docs/lessons-learned.md #70).
  const activeBefore = await page
    .locator('[data-testid^="tab-"][role="tab"][data-active="true"]')
    .getAttribute("data-testid");

  const [fromId, toId] = initialS1 < initialS2 ? [s2Id, s1Id] : [s1Id, s2Id];
  const fromBox = await page.locator(`[data-testid="tab-${fromId}"]`).boundingBox();
  const toBox = await page.locator(`[data-testid="tab-${toId}"]`).boundingBox();
  if (!fromBox || !toBox) throw new Error("tab bounding boxes not found");

  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  // Multi-step move guarantees pointermove events fire and the 5px threshold is crossed.
  // Drop on the LEFT half of the target so the handler picks side: "left".
  await page.mouse.move(toBox.x + 5, toBox.y + toBox.height / 2, { steps: 12 });
  await page.mouse.up();

  // Assert the signed index delta flipped sign. Robust to extra tabs from session restore.
  await expect
    .poll(async () => {
      const names = await allNames.allTextContents();
      return Math.sign(names.indexOf("sample.md") - names.indexOf("sample2.md"));
    })
    .toBe(-Math.sign(initialDelta));

  // The trailing click after a drag must be suppressed: the active tab should
  // not change just because we dragged a tab.
  const activeAfter = await page
    .locator('[data-testid^="tab-"][role="tab"][data-active="true"]')
    .getAttribute("data-testid");
  expect(activeAfter).toBe(activeBefore);
});

test("open file button is always visible", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await page.waitForSelector("[data-testid='open-file-btn']");

  const openBtn = page.locator("[data-testid='open-file-btn']");
  await expect(openBtn).toBeVisible();
});

/**
 * The tab strip's sizing contract (#1250, then the `uniformTabWidth` setting).
 * Three review passes agreed on a mechanism that turned out to be wrong, and
 * only measurement caught it — see lesson 85 in docs/lessons-learned.md — so
 * both modes get a real guard.
 *
 * The fixture deliberately MIXES name lengths. An earlier version opened twelve
 * near-identical names, which cannot express width dispersion: a uniformity
 * check passes trivially in both modes, so the assertion that actually
 * distinguishes them was unavailable.
 *
 * `.tab-flip` and `.title-bar-actions` are matched by class, not testid: both
 * are structural boxes owned by the components under test with no user-facing
 * identity of their own, and a testid on either would exist solely for this
 * assertion.
 */
const FLOOR_PX = 142;

/** Long names rest at the 240px name cap; the two short ones are the dispersion probe. */
const FIXTURE_NAMES = [
  ...Array.from({ length: 10 }, (_, i) => `tandem-ink-email-runbook-${i + 1}.md`),
  "ab.md",
  "notes.md",
];

async function openFixtureTabs(page: Page, uniform: boolean) {
  // `tabEnter`/`tabExit` animate `width` and inject `min-width: 0`, so a pill
  // measured mid-transition reports a collapsing box rather than its resting
  // size. Zeroing both durations makes these measurements deterministic instead
  // of merely slow. `motionOff()` reads this same media query.
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const name of FIXTURE_NAMES) {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, `# ${name}\n\nSizing fixture.\n`);
    await mcp.callTool("tandem_open", { filePath });
  }

  // Seed the setting before first paint. `schemaVersion` must be the CURRENT
  // one: seed it lower and loadSettings migrates (fine), but seed it higher and
  // the whole run silently goes `_readOnly`.
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(
        key as string,
        JSON.stringify({ schemaVersion: 18, uniformTabWidth: value }),
      );
    },
    ["tandem:settings", uniform],
  );

  await page.goto("http://127.0.0.1:5173");
  await page.waitForSelector("[data-testid='tab-scroll-container']");
  await expect
    .poll(() => page.locator(".tab-flip").count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(FIXTURE_NAMES.length);
}

async function measureTabStrip(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, width: b.width };
    };
    const scroller = document.querySelector("[data-testid='tab-scroll-container']") as HTMLElement;
    const actions = document.querySelector(".title-bar-actions") as HTMLElement;
    return {
      overflowing: scroller.scrollWidth > scroller.clientWidth,
      scrollerClass: scroller.className,
      actions: box(actions)!,
      viewportWidth: document.documentElement.clientWidth,
      tabs: [...document.querySelectorAll<HTMLElement>(".tab-flip")].map((wrapper) => {
        const pill = wrapper.firstElementChild as HTMLElement;
        // Null while a tab is renaming — the span is swapped for an input.
        const name = pill.querySelector("[data-testid^='tab-name-']");
        return {
          uniform: wrapper.classList.contains("uniform"),
          wrapper: box(wrapper)!,
          pill: box(pill)!,
          name: box(name),
          close: box(pill.querySelector("button[aria-label^='Close']"))!,
        };
      }),
    };
  });
}

/** Shared by both modes: nothing escapes its pill, and the actions cluster survives. */
function assertNothingSpills(measured: Awaited<ReturnType<typeof measureTabStrip>>) {
  for (const tab of measured.tabs) {
    // 0.5px for subpixel flex rounding.
    if (tab.name) {
      expect(tab.name.left).toBeGreaterThanOrEqual(tab.pill.left - 0.5);
      expect(tab.name.right).toBeLessThanOrEqual(tab.pill.right + 0.5);
    }
    expect(tab.close.left).toBeGreaterThanOrEqual(tab.pill.left - 0.5);
    expect(tab.close.right).toBeLessThanOrEqual(tab.pill.right + 0.5);
  }
  // The center cluster is the only shrinkable item in the title-bar row, so a
  // crowded strip must never push the actions cluster off-screen.
  expect(measured.actions.width).toBeGreaterThan(0);
  expect(measured.actions.left).toBeGreaterThanOrEqual(-0.5);
  expect(measured.actions.right).toBeLessThanOrEqual(measured.viewportWidth + 0.5);
}

test("uniform mode: every tab is the same width, and the strip still scrolls", async ({ page }) => {
  await openFixtureTabs(page, true);
  const measured = await measureTabStrip(page);

  expect(measured.tabs.every((t) => t.uniform)).toBe(true);

  // Guard against `flex-grow` filling the scroller exactly: if it ever does,
  // scrollWidth === clientWidth, updateScrollState never fires, and the mask
  // fade plus horizontal scroll disappear permanently (lesson 85).
  expect(measured.overflowing).toBe(true);
  expect(measured.scrollerClass).toMatch(/has-overflow|overflow-left|overflow-right/);

  const widths = measured.tabs.map((t) => t.wrapper.width);
  // The whole point of the mode: a 2-character name and a 28-character name
  // occupy identical space. Also the regression detector for a name-span-based
  // pin, which left read-only and renaming tabs 80-145px wider than the rest.
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  expect(Math.max(...widths)).toBeCloseTo(FLOOR_PX, 0);

  assertNothingSpills(measured);
});

test("adaptive mode: tabs size to their own name, and long ones still compress", async ({
  page,
}) => {
  await openFixtureTabs(page, false);
  const measured = await measureTabStrip(page);

  expect(measured.tabs.some((t) => t.uniform)).toBe(false);

  // Still overflows — otherwise the floor assertions below are vacuous.
  expect(measured.overflowing).toBe(true);
  expect(measured.scrollerClass).toMatch(/has-overflow|overflow-left|overflow-right/);

  const widths = measured.tabs.map((t) => t.wrapper.width);
  // THE assertion for this mode. The bug being fixed was every tab landing on
  // the floor regardless of its name, which reads as "all tabs are identical".
  expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(15);

  for (const tab of measured.tabs) {
    // Upper bound is the no-compression regression detector: the
    // shipped-then-reverted shape left a long name pinned at 259px. It is also
    // the adaptive ceiling — a tab is never wider than the uniform width once
    // the strip is crowded.
    expect(tab.wrapper.width).toBeLessThanOrEqual(FLOOR_PX + 0.5);
    // Lower bound: a tab may be narrower than the floor ONLY because its own
    // name needs less. It may never be narrower than its own chrome, which is
    // what would make the close button collide with the name.
    expect(tab.wrapper.width).toBeGreaterThan(60);
  }

  // A short name must not be truncated — that is what distinguishes this mode
  // from a uniformly-floored strip, where `ab.md` is padded out to 142px.
  const shortest = measured.tabs.reduce((a, b) => (a.wrapper.width <= b.wrapper.width ? a : b));
  expect(shortest.wrapper.width).toBeLessThan(FLOOR_PX - 5);

  assertNothingSpills(measured);
});
