import { expect, type Page, test } from "@playwright/test";
import { nextFrames } from "./helpers";

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
 * No document fixture: the toggle lives in the title bar, above the
 * `{#if !yjsSync.ready}` split, and TitleBar renders it on `tandemMode` alone.
 * Opening a fixture over MCP was measured at ~1.3s per test for geometry that is
 * byte-identical either way. `boot()` deliberately does NOT wait on
 * `.tandem-editor` — that class needs an open document, so waiting on it would
 * couple every test here to the 400ms auto-scratchpad debounce for no signal.
 */

test.describe.configure({ timeout: 90_000 });

async function boot(page: Page) {
  await page.goto("/");
  await page.locator("[data-testid='mode-toggle']").waitFor({ state: "visible", timeout: 15_000 });
  // SN Pro ships `font-display: swap` (index.html), and the swap CHANGES these
  // metrics: the segments are sized from label text, so every width here moves
  // when the face does. Every assertion below uses an absolute px tolerance and
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
  thumbH: number;
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
      thumbH: t.height,
      inkDelta: (ink.left + ink.right) / 2 - (t.left + t.right) / 2,
    };
  });
}

/**
 * Polls, so the 220ms slide settles without a bare sleep. Asserted as a single
 * object so a failure reports all four edges at once — a thumb off on `left` and
 * `right` by the same amount is a translate bug, one off on `right` alone is a
 * sizing bug, and that distinction is the whole diagnosis.
 *
 * `inkDelta` rides along for #1383. The label is always centred in its BUTTON,
 * so under symmetric padding it equals -(dL+dR)/2 and cannot fail while the
 * edges hold — except when `justify-content: center` is removed, which the edge
 * deltas cannot see.
 *
 * That sensitivity is ONE-SIDED, and it decides which call site matters. The
 * column width is the TANDEM button's max-content, so "Tandem"'s ink already
 * fills its content box and its `inkDelta` stays ~0 however the label is
 * justified. Only "Solo" has slack. Drop the solo call and #1383 coverage goes
 * with it.
 */
async function expectThumbFlush(page: Page, label: string) {
  await expect
    .poll(
      async () => {
        const g = await measure(page);
        const off = (["dL", "dR", "dT", "dB"] as const)
          .filter((k) => Math.abs(g[k]) >= 0.5)
          .map((k) => `${k}=${g[k].toFixed(2)}`);
        if (Math.abs(g.inkDelta) >= 0.75) off.push(`inkDelta=${g.inkDelta.toFixed(2)}`);
        return off;
      },
      {
        timeout: 5_000,
        message:
          `${label}: the pill does not cover the selected segment (#1384). An \`inkDelta\` ` +
          `entry with all four edges flush is the other defect instead (#1383) — the pill is ` +
          `right and the LABEL is off-centre in it; check \`justify-content\`.`,
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
      `different width. \`flex: 1 1 0\` never produced equal columns: a flex item's automatic ` +
      `minimum size is its min-content size, so "Tandem" was clamped up to its natural width. ` +
      `(That is a property of \`min-width: auto\`, not of flexbox — \`flex: 1 1 0\` plus ` +
      `\`min-width: 0\` does equalize. The grid form is preferred, not forced.)`,
  ).toBeLessThan(0.5);
  // Guards against a "pass" where both segments collapsed to nothing.
  expect(g.soloW).toBeGreaterThan(10);

  // The only assertion in this file that reads an ABSOLUTE height. Everything
  // else is a thumb-vs-button delta, so the pill and the button could grow
  // together and every delta would stay 0.00. ModeToggle.svelte's button padding
  // and its `line-height: normal` are a matched pair — the padding is trimmed to
  // offset the taller line box — and changing one without the other moves this
  // height while disturbing no delta in the file.
  expect(
    Math.abs(g.thumbH - 20),
    `the pill is ${g.thumbH.toFixed(2)}px tall; it should hold ~20px under the shipped SN Pro ` +
      `face. If this drifted, the button's vertical padding and \`line-height\` were changed ` +
      `independently of each other — see ModeToggle.svelte.`,
  ).toBeLessThan(2);

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

/**
 * The narrowest track that still holds the pill's guarantee, DERIVED from the
 * shipped CSS rather than transcribed from it.
 *
 * Deriving it is the point. This boundary has been stated as a literal three
 * times — "~60px" twice in prose, then a worked sum that added to 34 while
 * claiming 62 — and each time the figure was admissible under whatever rule was
 * in force and wrong anyway. A comment cannot be made to add up; this can.
 *
 * `box-sizing: border-box` is global (index.html), so `max-width` clamps the
 * BORDER box: the track's own padding and border sit inside the cap, and each
 * button floors at its own horizontal padding because its content box cannot go
 * below zero. Two buttons, because both columns must fit — the missing half of
 * the sum this replaces.
 */
async function paddingFloor(page: Page): Promise<number> {
  const floor = await page.evaluate(() => {
    const track = document.querySelector<HTMLElement>(".mode-toggle");
    if (!track) throw new Error("missing .mode-toggle");
    const buttons = [...track.querySelectorAll<HTMLElement>("button")];
    if (buttons.length !== 2) throw new Error(`expected 2 segments, found ${buttons.length}`);
    const px = (v: string) => Number.parseFloat(v) || 0;
    const sides = (el: Element) => {
      const s = getComputedStyle(el);
      return (
        px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth)
      );
    };
    return sides(track) + buttons.reduce((sum, b) => sum + sides(b), 0);
  });
  // A zeroed floor would make both assertions below meaningless rather than
  // failing: capping at ~0 collapses everything flush. An over-large one needs
  // no guard — it produces no effective cap, `dR` stays 0, and the boundary
  // test's own "too small" assertion fails with a better diagnosis than a
  // transcribed ceiling could give.
  expect(floor, "derived padding floor is implausible — did the query desync?").toBeGreaterThan(20);
  return floor;
}

/** Force a track width the real layout cannot produce. Repeatable within a page. */
async function setTrackCap(page: Page, px: number) {
  await page.evaluate((cap) => {
    let tag = document.getElementById("e2e-track-cap") as HTMLStyleElement | null;
    if (!tag) {
      tag = document.createElement("style");
      tag.id = "e2e-track-cap";
      document.head.appendChild(tag);
    }
    tag.textContent = `.mode-toggle { max-width: ${cap}px }`;
  }, px);
}

test("the columns stay equal when the track is forced to compress", async ({ page }) => {
  // `minmax(0, 1fr)` versus a bare `1fr` is the most-argued decision in this fix,
  // and NOTHING in the shipped layout exercises it: `.title-bar-mode` is
  // `flex: 0 0 auto`, so it overflows rather than compresses at any viewport,
  // and `.title-bar-center` carries `min-width: 0` and takes the shrink instead.
  // The regime is therefore injected rather than reached.
  //
  // That is not a hypothetical: it is a unit test of a CSS mechanism, run here
  // because Playwright is the only layout engine in the repo. The source scan in
  // mode-toggle-thumb-contract.test.ts pins the spelling of the guard; nothing
  // but this can observe that it works.
  await boot(page);

  // Mid-range, then the floor itself — the two ends of the range the guarantee
  // covers. A bare `1fr` floors each column at min-content and fails both.
  for (const cap of [120, await paddingFloor(page)]) {
    await setTrackCap(page, cap);
    const g = await measure(page);
    expect(
      Math.abs(g.soloW - g.tandemW),
      `capped at ${cap}px: solo=${g.soloW.toFixed(2)} tandem=${g.tandemW.toFixed(2)}. Unequal ` +
        `columns put the thumb — which IS column 1 — on a segment of a different width (#1384). ` +
        `A bare \`1fr\` reopens exactly this.`,
    ).toBeLessThan(0.5);
    // Equal columns are necessary but not sufficient: a `min-width` on the
    // button keeps the COLUMNS equal while the button outgrows the column the
    // thumb is placed into, so only the flush check sees that one.
    await expectThumbFlush(page, `capped at ${cap}px`);
  }
});

test("the pill's guarantee ends at the padding floor, not below it", async ({ page }) => {
  // The guarantee holds over a RANGE, and this asserts where the range ends so
  // that no comment has to narrate it. Both `ModeToggle.svelte` and
  // derived-spec.md previously carried a "~60px" figure; it was derivable and
  // not derived, and it was wrong.
  //
  // Below the floor the buttons stop shrinking while the columns keep going, so
  // the thumb — which tracks the COLUMN — becomes narrower than the button it is
  // supposed to cover. `paddingFloor()` computes where that starts, so a padding
  // change moves this test with it instead of silently invalidating it.
  await boot(page);

  const floor = await paddingFloor(page);

  await setTrackCap(page, floor);
  await expectThumbFlush(page, `at the ${floor}px floor`);

  await setTrackCap(page, floor - 1);
  const below = await measure(page);
  // Bounded on BOTH sides, because `< -0.25` alone is satisfied by any breakage
  // at all — remove `inset: 0` and the thumb renders 0x0 for a dR near -55,
  // which would read as this test passing. One pixel off the floor splits across
  // two columns, so the intended desync is half a pixel and nothing else is.
  //
  // The upper bound is -0.25 rather than -0.5 only to leave rounding room; the
  // lower is -0.75, which keeps the band narrower than the half-pixel claim is
  // wide. A wider band would let a sub-pixel error in the derivation satisfy
  // both this and `expectThumbFlush`'s |d| < 0.5 at the same time.
  const why =
    `one pixel below the floor the pill should be about half a pixel narrower than its ` +
    `button (got ${below.dR.toFixed(2)}). Too small: the floor moved, and since it is now ` +
    `derived that means the box model changed, not the padding. Too large: the thumb is ` +
    `mis-sized for a reason that has nothing to do with the floor.`;
  expect(below.dR, why).toBeLessThan(-0.25);
  expect(below.dR, why).toBeGreaterThan(-0.75);
});

test("the widened toggle still fits a narrow viewport", async ({ page }) => {
  // Equalizing the segments widened the control ("Solo" grew to match "Tandem"),
  // and the toggle sits at the right-hand end of the title bar.
  //
  // 360px, not 600px: the toggle cannot shrink (see above) and neither can the
  // brand cluster or the row padding, so the tab strip absorbs all remaining
  // shrink. Those fixed costs leave enough slack at 600px that the widening this
  // guards could grow many times over before the assertion fired, which made it
  // read as coverage it was not providing. 360px is the narrowest viewport worth
  // supporting, so it is the honest place to ask the question.
  //
  // SCOPE: this covers the BROWSER layout only. `isTauriRuntime()` is false
  // here, so `.title-bar-mode` never gets `.native-window-row` and the three
  // native window-control buttons plus `.title-bar-spacer-sm` are not rendered
  // at all. The desktop row is the TIGHTER case and is the row this control was
  // deliberately pinned into — it is covered by the manual `cargo tauri dev`
  // step, not by this assertion. Do not read this as pinning the desktop case.
  await boot(page);
  await page.setViewportSize({ width: 360, height: 800 });
  // Without this the sample can predate the resize, and since the assertion is
  // `right <= innerWidth`, a stale WIDE-viewport reading passes vacuously — the
  // test would go green having never measured the 360px layout.
  await nextFrames(page);

  const fits = await page.evaluate(() => {
    const el = document.querySelector(".mode-toggle");
    if (!el) throw new Error("missing .mode-toggle");
    const r = el.getBoundingClientRect();
    return { right: r.right, width: window.innerWidth, visible: r.width > 0 && r.height > 0 };
  });

  expect(fits.visible, "the toggle collapsed to zero at 360px").toBe(true);
  expect(
    fits.right,
    `the toggle overflows the 360px viewport (right edge ${fits.right.toFixed(1)} of ${fits.width})`,
  ).toBeLessThanOrEqual(fits.width);
});
