/**
 * Geometry + opacity math for the editor scroll pill.
 *
 * These are the functions the drag handler and the per-frame opacity write
 * depend on, so every degenerate input (no overflow, zero-height track, thumb
 * filling the track, pointer outside the window) gets pinned here rather than
 * discovered as a divide-by-zero in the browser.
 */

import { describe, expect, it } from "vitest";
import {
  clampThumbTop,
  composeOpacity,
  FAR_PX,
  FLASH_FADE_MS,
  FLASH_HOLD_MS,
  flashOpacity,
  MIN_THUMB_PX,
  NEAR_PX,
  proximityOpacity,
  rectDistance,
  scrollTopForThumbTop,
  thumbMetrics,
} from "../../src/client/editor/scroll-pill.js";

describe("thumbMetrics", () => {
  it("returns null when the content does not overflow", () => {
    expect(
      thumbMetrics({ scrollTop: 0, scrollHeight: 800, clientHeight: 800, trackHeight: 700 }),
    ).toBeNull();
  });

  it("treats sub-pixel overflow as no overflow (matches scrollFade's 1px slack)", () => {
    expect(
      thumbMetrics({ scrollTop: 0, scrollHeight: 800.4, clientHeight: 800, trackHeight: 700 }),
    ).toBeNull();
  });

  it("returns null for a zero-height track", () => {
    expect(
      thumbMetrics({ scrollTop: 0, scrollHeight: 5000, clientHeight: 800, trackHeight: 0 }),
    ).toBeNull();
  });

  it("sizes the thumb proportionally to the visible fraction", () => {
    // Half the document visible → half the track.
    const m = thumbMetrics({
      scrollTop: 0,
      scrollHeight: 1600,
      clientHeight: 800,
      trackHeight: 600,
    });
    expect(m?.height).toBeCloseTo(300);
  });

  it("clamps a tiny proportional thumb up to the minimum", () => {
    // 800 / 100000 of a 600px track is ~4.8px — unusable as a grab target.
    const m = thumbMetrics({
      scrollTop: 0,
      scrollHeight: 100_000,
      clientHeight: 800,
      trackHeight: 600,
    });
    expect(m?.height).toBe(MIN_THUMB_PX);
  });

  it("never lets the minimum push the thumb past the track height", () => {
    const trackHeight = 20; // shorter than MIN_THUMB_PX
    const m = thumbMetrics({ scrollTop: 0, scrollHeight: 100_000, clientHeight: 800, trackHeight });
    expect(m?.height).toBe(trackHeight);
    expect(m?.top).toBe(0);
  });

  it("puts the thumb at the top of the track at scrollTop 0", () => {
    const m = thumbMetrics({
      scrollTop: 0,
      scrollHeight: 5000,
      clientHeight: 800,
      trackHeight: 600,
    });
    expect(m?.top).toBe(0);
  });

  it.each([
    { why: "at max scroll", scrollTop: 4200 },
    { why: "and stays there when over-scrolled (rubber-band)", scrollTop: 99_999 },
  ])("puts the thumb flush with the track bottom $why", ({ scrollTop }) => {
    const m = thumbMetrics({ scrollTop, scrollHeight: 5000, clientHeight: 800, trackHeight: 600 });
    expect(m).not.toBeNull();
    expect(
      (m as { top: number; height: number }).top + (m as { height: number }).height,
    ).toBeCloseTo(600);
  });
});

describe("scrollTopForThumbTop", () => {
  const geo = { scrollHeight: 5000, clientHeight: 800, trackHeight: 600 };

  it.each([
    { why: "no trailing spacer", spacer: undefined, max: 4200 },
    // With a spacer the drag path must land on the SAME extent the render path
    // used, or dragging to the bottom would disagree with where the thumb is.
    { why: "with a trailing spacer", spacer: 630, max: 3570 },
  ])("round-trips against thumbMetrics — $why", ({ spacer, max }) => {
    for (const scrollTop of [0, 137, 1000, 2500, max]) {
      const m = thumbMetrics({ ...geo, scrollTop, trailingSpacerPx: spacer });
      expect(m).not.toBeNull();
      const back = scrollTopForThumbTop((m as { top: number }).top, {
        ...geo,
        trailingSpacerPx: spacer,
        thumbHeight: (m as { height: number }).height,
      });
      expect(back).toBeCloseTo(scrollTop, 5);
    }
  });

  it("clamps below zero and above max scroll", () => {
    const thumbHeight = 96;
    expect(scrollTopForThumbTop(-500, { ...geo, thumbHeight })).toBe(0);
    expect(scrollTopForThumbTop(99_999, { ...geo, thumbHeight })).toBe(4200);
  });

  it("returns 0 rather than dividing by zero when the thumb fills the track", () => {
    expect(scrollTopForThumbTop(10, { ...geo, thumbHeight: 600 })).toBe(0);
  });

  it("returns 0 when there is nothing to scroll", () => {
    expect(
      scrollTopForThumbTop(50, {
        trackHeight: 600,
        thumbHeight: 100,
        scrollHeight: 800,
        clientHeight: 800,
      }),
    ).toBe(0);
  });
});

describe("clampThumbTop", () => {
  it("clamps into the track", () => {
    expect(clampThumbTop(-10, { trackHeight: 600, thumbHeight: 100 })).toBe(0);
    expect(clampThumbTop(9999, { trackHeight: 600, thumbHeight: 100 })).toBe(500);
    expect(clampThumbTop(250, { trackHeight: 600, thumbHeight: 100 })).toBe(250);
  });

  it("pins to 0 when the thumb fills the track", () => {
    expect(clampThumbTop(200, { trackHeight: 600, thumbHeight: 600 })).toBe(0);
  });

  it("maps one frozen thumb position onto a growing document", () => {
    // A drag freezes its geometry at pointerdown, so the thumb stays put under
    // the cursor while content grows (image decode, annotations mounting) —
    // only the scroll offset that position maps to is allowed to move.
    const frozen = { trackHeight: 600, thumbHeight: 120, scrollHeight: 5000, clientHeight: 800 };
    const grabbedTop = clampThumbTop(300, frozen);

    expect(scrollTopForThumbTop(grabbedTop, frozen)).toBeCloseTo((300 / 480) * 4200);
    expect(scrollTopForThumbTop(grabbedTop, { ...frozen, scrollHeight: 8000 })).toBeCloseTo(
      (300 / 480) * 7200,
    );
  });
});

describe("rectDistance", () => {
  const rect = { left: 100, top: 200, right: 110, bottom: 400 };

  it("is zero inside the rect", () => {
    expect(rectDistance(105, 300, rect)).toBe(0);
  });

  it("measures straight out from an edge, not from the center", () => {
    // Level with the middle of a tall thumb, 40px to its left.
    expect(rectDistance(60, 300, rect)).toBe(40);
  });

  it("measures to the nearest corner when diagonal", () => {
    expect(rectDistance(97, 196, rect)).toBeCloseTo(5); // 3-4-5
  });

  it("measures from the flank of a tall thumb, not its midpoint", () => {
    // Same 40px horizontal gap, but near the thumb's top edge. A
    // distance-to-center metric would report far more than 40 here.
    expect(rectDistance(60, 210, rect)).toBe(40);
  });
});

describe("proximityOpacity", () => {
  it("is fully lit at and inside the near radius", () => {
    expect(proximityOpacity(0)).toBe(1);
    expect(proximityOpacity(NEAR_PX)).toBe(1);
  });

  it("is fully transparent at and beyond the far radius", () => {
    expect(proximityOpacity(FAR_PX)).toBe(0);
    expect(proximityOpacity(FAR_PX + 1000)).toBe(0);
  });

  it("treats an absent pointer (Infinity) as fully transparent", () => {
    expect(proximityOpacity(Number.POSITIVE_INFINITY)).toBe(0);
    expect(proximityOpacity(Number.NaN)).toBe(0);
  });

  it("decreases monotonically across the ramp", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let d = NEAR_PX; d <= FAR_PX; d += 8) {
      const v = proximityOpacity(d);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("trailing-spacer correction (.editor-end-marker)", () => {
  // `.editor-end-marker` is 70vh of deliberate trailing whitespace (App.svelte)
  // so the outline's last heading can pin to the top of the viewport. Counting
  // it as document length is the difference between a pill that means something
  // and one that appears on every file.
  const VIEWPORT = 900;
  const CLIENT = 856; // viewport minus chrome
  const MARKER = Math.round(0.7 * VIEWPORT); // 70vh

  it("does not report overflow for a document that only the spacer makes tall", () => {
    // A short note: ~300px of content, plus ~100px of padding, plus the 630px
    // marker = 1030px in a 856px viewport. Real content is nowhere near a
    // screenful, but the raw scroll extent overflows by 174px.
    const scrollHeight = 300 + 100 + MARKER;
    expect(
      thumbMetrics({
        scrollTop: 0,
        scrollHeight,
        clientHeight: CLIENT,
        trackHeight: 600,
        trailingSpacerPx: MARKER,
      }),
    ).toBeNull();
    // Without the correction this is the bug: a pill on a five-line note.
    expect(
      thumbMetrics({ scrollTop: 0, scrollHeight, clientHeight: CLIENT, trackHeight: 600 }),
    ).not.toBeNull();
  });

  it("sizes the thumb against document length, not scrollable extent", () => {
    // 3000px of real content + the marker. The thumb should read
    // 856/3000 ≈ 29% of the track, not 856/3630 ≈ 24%.
    const m = thumbMetrics({
      scrollTop: 0,
      scrollHeight: 3000 + MARKER,
      clientHeight: CLIENT,
      trackHeight: 600,
      trailingSpacerPx: MARKER,
    });
    expect(m?.height).toBeCloseTo(600 * (CLIENT / 3000), 4);
  });

  it("pins the thumb at the track bottom through the trailing whitespace", () => {
    // Documented consequence: the thumb tracks the DOCUMENT, so wheeling on
    // into the blank tail leaves it parked at the bottom rather than crawling.
    const geo = {
      scrollHeight: 3000 + MARKER,
      clientHeight: CLIENT,
      trackHeight: 600,
      trailingSpacerPx: MARKER,
    };
    const atDocEnd = thumbMetrics({ ...geo, scrollTop: 3000 - CLIENT });
    const deepInSpacer = thumbMetrics({ ...geo, scrollTop: 3000 - CLIENT + 400 });
    expect(atDocEnd?.top).toBeCloseTo(600 - (atDocEnd?.height ?? 0), 4);
    expect(deepInSpacer?.top).toBeCloseTo(atDocEnd?.top ?? -1, 4);
  });

  it("never lets the spacer subtraction invert the extent", () => {
    // Spacer larger than the whole scroll extent (a stale measurement taken
    // mid-relayout) must degrade to "no overflow", not to a negative extent
    // that would flip the thumb.
    expect(
      thumbMetrics({
        scrollTop: 0,
        scrollHeight: 900,
        clientHeight: 856,
        trackHeight: 600,
        trailingSpacerPx: 5000,
      }),
    ).toBeNull();
  });
});

describe("flashOpacity", () => {
  it("holds at full strength through the hold window", () => {
    expect(flashOpacity(0)).toBe(1);
    expect(flashOpacity(FLASH_HOLD_MS)).toBe(1);
  });

  it("decays to zero across the fade window", () => {
    expect(flashOpacity(FLASH_HOLD_MS + FLASH_FADE_MS / 2)).toBeCloseTo(1 / 2);
    expect(flashOpacity(FLASH_HOLD_MS + FLASH_FADE_MS)).toBe(0);
    expect(flashOpacity(FLASH_HOLD_MS + FLASH_FADE_MS + 10_000)).toBe(0);
  });
});

describe("composeOpacity", () => {
  it("pins to 1 while dragging, regardless of distance", () => {
    // The drag path stops updating the pointer cache, so proximity goes stale
    // mid-scrub; this pin is what keeps the thumb solid under the cursor.
    expect(composeOpacity({ proximity: 0, flash: 0, dragging: true })).toBe(1);
  });

  it("needs no hover term — a pointer on the thumb is already at distance 0", () => {
    expect(proximityOpacity(0)).toBe(1);
  });

  it("takes the stronger of proximity and flash, so neither can dim the other", () => {
    expect(composeOpacity({ proximity: 0.5, flash: 0.2, dragging: false })).toBe(0.5);
    expect(composeOpacity({ proximity: 0.1, flash: 0.4, dragging: false })).toBe(0.4);
  });
});
