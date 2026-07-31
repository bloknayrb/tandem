import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * A30 "Tab reorder drag" — lift, part, drop.
 *
 * This file is the ONLY place several of the load-bearing pieces can be caught
 * at all. happy-dom has no layout engine, so the component suite runs the
 * degraded (live hit-test) path by construction and its geometry is stubbed;
 * whether a sibling really parts by its neighbour's width, whether the pill
 * really follows the pointer, and whether anything is left stranded on the DOM
 * afterwards are all questions only a browser can answer.
 *
 * Every assertion reads a STEADY state — inline style values, which the handlers
 * write in full immediately and CSS then animates toward, plus computed
 * transition durations, which are not animated. Nothing samples a tween; see
 * tests/e2e/rail-motion.spec.ts for why frame capture is unreliable here.
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

interface WrapperState {
  name: string;
  testid: string;
  left: number;
  width: number;
  transform: string;
  transition: string;
  zIndex: string;
  pillTransform: string;
  transitionDuration: string;
  animations: number;
}

async function readStrip(page: Page): Promise<WrapperState[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".tab-flip")].map((w) => {
      const pill = w.querySelector<HTMLElement>('[role="tab"]');
      const rect = w.getBoundingClientRect();
      return {
        name: w.querySelector("[data-testid^='tab-name-']")?.textContent ?? "",
        testid: pill?.getAttribute("data-testid") ?? "",
        left: rect.left,
        width: rect.width,
        transform: w.style.transform,
        transition: w.style.transition,
        zIndex: w.style.zIndex,
        pillTransform: pill?.style.transform ?? "",
        transitionDuration: getComputedStyle(w).transitionDuration,
        animations: w.getAnimations().length,
      };
    }),
  );
}

/** px out of `translateX(-106.5px)`; NaN when there is no transform at all. */
function translateX(value: string): number {
  const m = /translateX\((-?[\d.]+)px\)/.exec(value);
  return m ? Number.parseFloat(m[1]) : Number.NaN;
}

async function openTwoTabs(page: Page, reducedMotion: "reduce" | "no-preference") {
  await page.emulateMedia({ reducedMotion });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");
  await page.waitForSelector("[data-testid='tab-scroll-container']");
  await expect.poll(() => page.locator(".tab-flip").count(), { timeout: 10_000 }).toBe(2);
  return waitForStableStrip(page);
}

/**
 * Wait until the strip stops moving, then measure.
 *
 * Tab widths are NOT stable at first paint: web fonts are `font-display: swap`,
 * and the adaptive-floor pass re-measures every tab when `document.fonts.ready`
 * resolves — 140.78px before, 142px after, in the run that caught this. Every
 * expectation below is arithmetic on `left`/`width`, so a measurement taken one
 * frame early quietly shifts the whole target (the pointer lands short of the
 * settled midpoint, the slot never flips, and the assertion fails claiming the
 * gap never opened). Awaiting `document.fonts.ready` from the test is NOT
 * enough — that only guarantees the promise resolved, not that Svelte's effect
 * ran and the browser re-laid-out. Compare consecutive samples instead.
 */
async function waitForStableStrip(page: Page): Promise<WrapperState[]> {
  let previous = "";
  return expect
    .poll(
      async () => {
        const current = await readStrip(page);
        const key = JSON.stringify(current.map((t) => [t.left, t.width]));
        const stable = key === previous;
        previous = key;
        return stable;
      },
      { timeout: 10_000, intervals: [120, 120, 120, 250] },
    )
    .toBe(true)
    .then(() => readStrip(page));
}

/** Grab the first tab and drag it past the second tab's midpoint, mouse still down. */
async function dragFirstPastSecond(page: Page, strip: WrapperState[]) {
  const box = await page.locator(`[data-testid="${strip[0].testid}"]`).boundingBox();
  if (!box) throw new Error("dragged tab has no bounding box");
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const endX = strip[1].left + strip[1].width / 2 + 20;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 12 });
  return { startX, endX, y };
}

test("the dragged tab tracks the pointer and its neighbour parts by exactly one slot", async ({
  page,
}) => {
  const before = await openTwoTabs(page, "no-preference");
  const gap = before[1].left - (before[0].left + before[0].width);
  expect(gap).toBeGreaterThan(0);

  const { startX, endX } = await dragFirstPastSecond(page, before);
  const during = await readStrip(page);

  // The dragged wrapper carries the raw pointer travel...
  expect(translateX(during[0].transform)).toBeCloseTo(endX - startX, 0);
  // ...and the neighbour backs up by the dragged tab's own width plus the gap,
  // NOT by its own width — a uniform-step model would get this wrong on a strip
  // with mixed name lengths.
  expect(translateX(during[1].transform)).toBeCloseTo(-(before[0].width + gap), 0);
  // The lift lives on the pill, the track on the wrapper. Both, never one.
  expect(during[0].pillTransform).toContain("translateY(-5px)");
  expect(during[0].pillTransform).toContain("scale(1.04)");
  expect(during[1].pillTransform).toBe("none");
  // The dragged wrapper must carry no transition of its own or it would lag the
  // pointer by a frame budget.
  expect(during[0].transition).toContain("none");

  await page.mouse.up();
});

test("the drop commits the reorder and strands nothing on the DOM", async ({ page }) => {
  const before = await openTwoTabs(page, "no-preference");
  const firstName = before[0].name;
  const secondName = before[1].name;

  await dragFirstPastSecond(page, before);
  await page.mouse.up();

  // Order flipped...
  await expect
    .poll(async () => (await readStrip(page)).map((t) => t.name))
    .toEqual([secondName, firstName]);

  // ...and the transform layer is gone: no transform, no leftover transition
  // declaration (which would keep `fix()` from pinning a tab closed later), no
  // orphaned stacking-context bump.
  await expect
    .poll(
      async () => {
        const after = await readStrip(page);
        return after.every(
          (t) =>
            t.transform === "" &&
            t.transition === "" &&
            t.zIndex === "" &&
            t.pillTransform === "none",
        );
      },
      { timeout: 3_000 },
    )
    .toBe(true);
});

test("a tab re-grabbed straight after a drop still follows the pointer", async ({ page }) => {
  // The precedence fix: a running Web Animation outranks normal-priority inline
  // style, so without releasing animation control at threshold-crossing a tab
  // grabbed while its 200ms flip settle is still playing would not move at all.
  // Best-effort on timing — if the round trips below happen to exceed 200ms the
  // settle has already finished and the assertion is merely true rather than
  // discriminating. The `animations` check holds either way and is the direct
  // statement of the fix.
  const before = await openTwoTabs(page, "no-preference");
  await dragFirstPastSecond(page, before);
  await page.mouse.up();

  const settled = await readStrip(page);
  const box = await page.locator(`[data-testid="${settled[1].testid}"]`).boundingBox();
  if (!box) throw new Error("re-grab target has no bounding box");
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + 60, y, { steps: 6 });

  const during = await readStrip(page);
  const dragged = during.find((t) => t.testid === settled[1].testid);
  expect(dragged).toBeDefined();
  expect(dragged?.animations).toBe(0);
  expect(translateX(dragged?.transform ?? "")).toBeCloseTo(60, 0);

  await page.keyboard.press("Escape");
  await page.mouse.up();
});

test("reduced motion still opens the gap, just instantly", async ({ page }) => {
  // A30: "position is information, not decoration". Magnitudes are unchanged
  // under reduced motion; only the durations are zeroed.
  const before = await openTwoTabs(page, "reduce");
  const gap = before[1].left - (before[0].left + before[0].width);

  await dragFirstPastSecond(page, before);
  const during = await readStrip(page);

  expect(translateX(during[1].transform)).toBeCloseTo(-(before[0].width + gap), 0);
  expect(during[1].transitionDuration).toBe("0s");

  await page.mouse.up();
});

test("Escape mid-drag cancels without committing and without stranding anything", async ({
  page,
}) => {
  const before = await openTwoTabs(page, "no-preference");
  const names = before.map((t) => t.name);

  await dragFirstPastSecond(page, before);
  expect(translateX((await readStrip(page))[1].transform)).toBeLessThan(0);

  await page.keyboard.press("Escape");
  await page.mouse.up();

  await expect
    .poll(
      async () => {
        const after = await readStrip(page);
        return {
          names: after.map((t) => t.name),
          clean: after.every(
            (t) =>
              t.transform === "" &&
              t.transition === "" &&
              t.zIndex === "" &&
              t.pillTransform === "none",
          ),
        };
      },
      { timeout: 3_000 },
    )
    .toEqual({ names, clean: true });
});

test("the reorder moves the existing element rather than remounting it", async ({ page }) => {
  // The each block is keyed on tab.id and the transforms live on the wrapper, so
  // a drop must never tear a tab down and rebuild it — that would drop the
  // editor's Y.Doc binding along with it. An ad-hoc dataset stamp is the only
  // probe that can tell "the same node moved" from "a fresh node appeared".
  const before = await openTwoTabs(page, "no-preference");
  await page.evaluate((testid) => {
    document
      .querySelector<HTMLElement>(`[data-testid="${testid}"]`)
      ?.setAttribute("data-a30-probe", "1");
  }, before[0].testid);

  await dragFirstPastSecond(page, before);
  await page.mouse.up();

  await expect
    .poll(async () => (await readStrip(page)).map((t) => t.name))
    .toEqual([before[1].name, before[0].name]);
  await expect(page.locator(`[data-testid="${before[0].testid}"][data-a30-probe="1"]`)).toHaveCount(
    1,
  );
});
