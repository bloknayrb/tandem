import { expect, type Page, test } from "@playwright/test";

/**
 * ModeToggle sliding-thumb geometry (#1383, #1384).
 *
 * This is the only gate that can see the thing the two issues are actually
 * about. `mode-toggle-thumb-contract.test.ts` pins the CSS *shape* and
 * `css-pipeline-contract.test.ts` pins what lightningcss does to it, but
 * neither can measure a box: no vitest project in this repo has a layout
 * engine, so `getBoundingClientRect` returns zeros there.
 *
 * Measured under the shipped SN Pro face:
 *
 *                              before          after
 *   solo segment               50.53px         67.83px
 *   tandem segment             67.83px         67.83px   (equal by construction)
 *   thumb                      59.17px         67.83px
 *   thumb vs active button     up to 8.64px    0.00 on all four edges
 *   label ink vs thumb centre  4.32px          0.00
 *
 * `flex: 1 1 0` never equalized the segments — a flex item's automatic minimum
 * size is its min-content size, so "Tandem" (one unbreakable word) kept its
 * natural width and "Solo" took the remainder. The half-width thumb then
 * matched neither, which is #1384; the label looking off-centre is that same
 * mismatch seen from the user's side (#1383), because the button is invisible
 * and the pill is what the eye reads.
 *
 * No document fixture: the toggle lives in the title bar and renders without
 * one. Opening a fixture over MCP was measured at ~1.3s per test for geometry
 * that is byte-identical either way.
 */

test.describe.configure({ timeout: 90_000 });

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator("[data-testid='mode-toggle']").waitFor({ state: "visible", timeout: 10_000 });
  // SN Pro ships `font-display: swap` (index.html), and the swap CHANGES these
  // metrics — measured 50.00 -> 50.53 on the solo segment, 123.39 -> 124.36 on
  // the track. Every assertion below uses an absolute px tolerance and
  // `expect.poll` re-evaluates, so a pre-swap sample and a post-swap sample
  // would be describing two different layouts.
  await page.evaluate(() => document.fonts.ready);
}

type Geometry = {
  soloW: number;
  tandemW: number;
  dL: number;
  dR: number;
  dT: number;
  dB: number;
  inkDelta: number;
};

/**
 * All measurements in one round trip, taken against whichever button is
 * currently pressed, so the same helper covers `.thumb` and `.thumb.tandem`.
 */
function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const q = <T extends Element>(sel: string): T => {
      const el = document.querySelector<T>(sel);
      if (!el) throw new Error(`missing ${sel}`);
      return el;
    };
    const thumb = q<HTMLElement>(".mode-toggle .thumb");
    const solo = q<HTMLElement>("[data-testid='mode-solo-btn']");
    const tandem = q<HTMLElement>("[data-testid='mode-tandem-btn']");
    const active = tandem.getAttribute("aria-pressed") === "true" ? tandem : solo;

    const t = thumb.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    // A Range over the button's contents is the label's INK box — the button's
    // own box is padded and is not what the eye compares against the pill.
    const range = document.createRange();
    range.selectNodeContents(active);
    const ink = range.getBoundingClientRect();

    return {
      soloW: solo.getBoundingClientRect().width,
      tandemW: tandem.getBoundingClientRect().width,
      dL: t.left - a.left,
      dR: t.right - a.right,
      dT: t.top - a.top,
      dB: t.bottom - a.bottom,
      inkDelta: (ink.left + ink.right) / 2 - (t.left + t.right) / 2,
    };
  });
}

/**
 * Polls, so the 220ms slide settles without a bare sleep. Asserted as a single
 * object so a failure reports all four edges at once — a thumb that is off on
 * `left` and `right` by the same amount is a translate bug, while one off on
 * `right` alone is a sizing bug, and that distinction is the whole diagnosis.
 */
async function expectThumbFlush(page: Page, label: string) {
  await expect
    .poll(
      async () => {
        const g = await measure(page);
        const off = (["dL", "dR", "dT", "dB"] as const)
          .filter((k) => Math.abs(g[k]) >= 0.5)
          .map((k) => `${k}=${g[k].toFixed(2)}`);
        // #1383 rides along: the label is always centred in its BUTTON, so with
        // symmetric padding the ink delta is -(dL+dR)/2 and cannot fail while
        // the edges hold — EXCEPT if `justify-content: center` is removed, which
        // is a real #1383-shaped regression the edge deltas would not see.
        if (Math.abs(g.inkDelta) >= 0.75) off.push(`inkDelta=${g.inkDelta.toFixed(2)}`);
        return off;
      },
      {
        timeout: 5_000,
        message:
          `${label}: the sliding pill does not cover the selected segment (#1384). ` +
          `The thumb is placed into grid area 1/1/2/2 of the track, so any non-zero edge ` +
          `delta means the segments are no longer equal columns or the placement was lost.`,
      },
    )
    .toEqual([]);
}

test("the segments are equal and the pill covers the selected one (tandem default)", async ({
  page,
}) => {
  await boot(page);

  // The root cause, asserted first so a regression names itself rather than
  // only reporting its symptom.
  const g = await measure(page);
  expect(
    Math.abs(g.soloW - g.tandemW),
    `#1383/#1384 root cause: solo=${g.soloW.toFixed(2)} tandem=${g.tandemW.toFixed(2)}. ` +
      `The thumb IS the track's first column, so unequal segments put it on a segment of a ` +
      `different width. \`flex: 1 1 0\` never produced equal columns, because a flex item ` +
      `cannot be squeezed below its own min-content width.`,
  ).toBeLessThan(0.5);
  // Guards against a "pass" where both segments collapsed to nothing.
  expect(g.soloW).toBeGreaterThan(10);

  await expect(page.locator("[data-testid='mode-tandem-btn']")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Before the fix this failed by ~8.6px on the LEFT: the thumb was a half of
  // the track, translated by its own width, landing inside the wider segment.
  await expectThumbFlush(page, "tandem (resting state)");
});

test("the pill covers the selected segment after switching to solo, and back", async ({ page }) => {
  await boot(page);

  await page.locator("[data-testid='mode-solo-btn']").click();
  await expect(page.locator("[data-testid='mode-solo-btn']")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Before the fix this failed by ~8.6px on the RIGHT — the untranslated thumb
  // overhung the narrower "Solo" segment.
  await expectThumbFlush(page, "solo");

  await page.locator("[data-testid='mode-tandem-btn']").click();
  await expect(page.locator("[data-testid='mode-tandem-btn']")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Re-asserted after an actual slide, so `.thumb.tandem`'s translate is
  // covered independently of the resting state it happens to share.
  await expectThumbFlush(page, "tandem (after a slide)");
});

test("the widened toggle still fits a narrow viewport", async ({ page }) => {
  // Equalizing the segments widens the control by ~17.3px ("Solo" grew to match
  // "Tandem"), and the toggle sits at the right-hand end of the title bar.
  //
  // SCOPE: this covers the BROWSER layout only. `isTauriRuntime()` is false
  // here, so `.title-bar-mode` never gets `.native-window-row` and the three
  // native window-control buttons plus `.title-bar-spacer-sm` are not rendered
  // at all. The desktop row is the TIGHTER case and is the row this control was
  // deliberately pinned into — it is covered by the manual `cargo tauri dev`
  // step, not by this assertion. Do not read this as pinning the desktop case.
  await boot(page);
  await page.setViewportSize({ width: 600, height: 800 });

  const fits = await page.evaluate(() => {
    const el = document.querySelector(".mode-toggle");
    if (!el) throw new Error("missing .mode-toggle");
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      width: window.innerWidth,
      visible: r.width > 0 && r.height > 0,
    };
  });

  expect(fits.visible, "the toggle collapsed to zero at 600px").toBe(true);
  expect(
    fits.right,
    `the toggle overflows the 600px viewport (right edge ${fits.right.toFixed(1)} of ${fits.width})`,
  ).toBeLessThanOrEqual(fits.width);
});
