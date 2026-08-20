import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  RAIL_HANDLE_TESTID,
  type RailSide,
  setRailVisible,
} from "./helpers";

/**
 * #1426 — the rail must render at the width the drag sets, while the drag is happening.
 *
 * `.rail-shell` carries a 360ms width ease (#798, for open/close). The drag writes
 * `width` continuously, so before the fix every one of those writes was *animated*: the
 * rendered width trailed the requested width for as long as the drag lasted, and the
 * strip slid out from under the pointer. Measured on the unfixed build, mid-drag:
 *
 *   inline 345px → offsetWidth 308      inline 375px → offsetWidth 325
 *   inline 390px → offsetWidth 344      ...then 390 ≈390ms after release
 *
 * Two properties distinguish that from every other candidate cause (scrollbar, flex
 * squeeze, border/padding), and this spec asserts both:
 *
 *   1. the discrepancy exists DURING the drag — a measurement taken only after
 *      `mouse.up()` sees the settled value and passes on the broken build;
 *   2. it RESOLVES on its own at rest — which is what makes it a transition rather
 *      than a layout error.
 *
 * Motion must be ON for this to mean anything: under `prefers-reduced-motion: reduce`
 * the ease is already `none` and there is nothing to catch. Playwright's default is
 * `no-preference` (verified in this harness — `matchMedia(...).matches === false` and
 * the computed transition is the live 0.36s ease), so the default config is correct;
 * it is stated explicitly here so a future global override cannot quietly void the spec.
 */

test.use({ reducedMotion: "no-preference" });

let mcp: McpTestClient;
let tmpDir: string;

const SHELL_SELECTOR: Record<RailSide, string> = {
  left: ".rail-shell-left",
  right: ".rail-shell-right",
};

/** Read the requested width against the two rendered widths, in one round trip. */
async function readWidths(page: import("@playwright/test").Page, side: RailSide) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    return {
      inline: Number.parseFloat(el.style.width),
      offset: el.offsetWidth,
      rect: el.getBoundingClientRect().width,
    };
  }, SHELL_SELECTOR[side]);
}

test.beforeEach(async ({ page }) => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

for (const side of ["left", "right"] as RailSide[]) {
  test(`${side} rail renders at the dragged width while dragging`, async ({ page }) => {
    await setRailVisible(page, side, true);

    // `setRailVisible` toggles the rail open, which runs the same 360ms width ease this
    // spec is about. Wait for it to finish first — otherwise sample 0 catches the OPEN
    // animation mid-flight (measured ~197px against a requested 300px) and the spec
    // fails on the fixed build for a reason that has nothing to do with dragging.
    await expect
      .poll(
        async () => {
          const w = await readWidths(page, side);
          return w ? Math.abs(w.rect - w.inline) <= 1.5 : null;
        },
        { timeout: 5_000 },
      )
      .toBe(true);

    const handle = page.locator(`[data-testid='${RAIL_HANDLE_TESTID[side]}']`);
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const startX = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // Left rail: drag right = wider. Right rail: drag left = wider.
    const dir = side === "left" ? 1 : -1;

    await page.mouse.move(startX, y);
    await page.mouse.down();

    // Multi-step, and measured BETWEEN steps — a single move-then-measure can settle
    // inside the step and mask the lag.
    const midDrag: Array<{ inline: number; offset: number; rect: number }> = [];
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(startX + dir * i * 15, y);
      const w = await readWidths(page, side);
      expect(w).not.toBeNull();
      if (w) midDrag.push(w);
    }
    await page.mouse.up();

    // The invariant. 1.5px absorbs sub-pixel rounding between the inline value and
    // the rendered box; the defect was 15-50px, so this cannot pass on a lagging build.
    for (const [i, w] of midDrag.entries()) {
      expect(
        Math.abs(w.rect - w.inline),
        `sample ${i}: rendered ${w.rect} vs requested ${w.inline} mid-drag`,
      ).toBeLessThanOrEqual(1.5);
    }

    // And the width the drag asked for is the width that persists.
    const settled = await readWidths(page, side);
    expect(settled).not.toBeNull();
    if (settled) {
      expect(Math.abs(settled.rect - settled.inline)).toBeLessThanOrEqual(1.5);
      expect(settled.inline).toBeGreaterThan(0);
    }
  });
}
