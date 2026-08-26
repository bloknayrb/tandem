import { describe, expect, it } from "vitest";
import {
  MARGIN_TRACK_GEOMETRY,
  MARGIN_VIEW_COLUMN_WIDTH_PX,
  MARGIN_VIEW_HYSTERESIS_PX,
  MARGIN_VIEW_RESERVE_PER_SIDE_PX,
  type MarginMode,
  MIN_EDITOR_WIDTH_PX,
  marginModeThresholds,
  marginReserveMaxPx,
  marginReservePx,
  narrowThresholdPx,
  nextMarginMode,
  nextNarrowSticky,
  resolveBaseMode,
  resolveSideMode,
  stageLayerStyle,
} from "../../src/client/layout/editor-stage.svelte.js";

/**
 * Editor stage model (Phase 3.5). The rune-based `createEditorStageModel`
 * needs a Svelte effect root + live stores, so the width-hysteresis `$effect`
 * and the live presence-collapse wiring are exercised via Playwright
 * (`margin-view.spec.ts`). Everything pure — the geometry table, the threshold
 * + mode-continuum math, the base/side mode resolution, and `stageLayerStyle`
 * — is unit-tested here. The mode-resolution chain (widthMode → baseMode →
 * leftMode/rightMode) was deliberately extracted into pure helpers so the
 * branching is testable without a mount.
 */

describe("MARGIN_TRACK_GEOMETRY — geometry table is the source of truth", () => {
  it("full mode matches the exported full-mode constants", () => {
    expect(MARGIN_TRACK_GEOMETRY.full.column).toBe(MARGIN_VIEW_COLUMN_WIDTH_PX);
    expect(marginReservePx(MARGIN_TRACK_GEOMETRY.full)).toBe(MARGIN_VIEW_RESERVE_PER_SIDE_PX);
  });

  it("non-off modes reserve column + inset + gap; off is all-zero", () => {
    for (const mode of ["full", "narrow", "stub"] as const) {
      const g = MARGIN_TRACK_GEOMETRY[mode];
      expect(marginReservePx(g)).toBe(g.column + g.inset + g.gap);
      expect(g.column).toBeGreaterThan(0);
    }
    // `maxColumn: 0` is part of the invariant, not incidental: a nonzero
    // ceiling would let a presence-collapsed side reserve phantom width again.
    expect(MARGIN_TRACK_GEOMETRY.off).toEqual({
      column: 0,
      maxColumn: 0,
      inset: 0,
      gap: 0,
    });
    expect(marginReservePx(MARGIN_TRACK_GEOMETRY.off)).toBe(0);
    expect(marginReserveMaxPx(MARGIN_TRACK_GEOMETRY.off)).toBe(0);
  });

  it("the reserve identity holds for every mode — MarginColumn's calc() depends on it", () => {
    // `MarginColumn` derives its leader inset as `100% - gap` and its column
    // width as `100% - inset - gap` against the track box. Both are correct ONLY
    // because the track is exactly `column + inset + gap`. If a future geometry
    // tweak breaks this identity the CSS silently desyncs from the table.
    for (const mode of ["full", "narrow", "stub", "off"] as const) {
      const g = MARGIN_TRACK_GEOMETRY[mode];
      expect(marginReservePx(g) - g.inset - g.gap).toBe(g.column);
      expect(marginReserveMaxPx(g) - g.inset - g.gap).toBe(g.maxColumn);
    }
  });

  it("maxColumn is never below column; stub and off are inelastic", () => {
    for (const mode of ["full", "narrow", "stub", "off"] as const) {
      const g = MARGIN_TRACK_GEOMETRY[mode];
      expect(g.maxColumn).toBeGreaterThanOrEqual(g.column);
    }
    // A 28px pip and a collapsed track have nothing to gain from extra width.
    expect(MARGIN_TRACK_GEOMETRY.stub.maxColumn).toBe(MARGIN_TRACK_GEOMETRY.stub.column);
    expect(MARGIN_TRACK_GEOMETRY.off.maxColumn).toBe(MARGIN_TRACK_GEOMETRY.off.column);
    // Elastic modes genuinely grow.
    expect(MARGIN_TRACK_GEOMETRY.full.maxColumn).toBeGreaterThan(MARGIN_TRACK_GEOMETRY.full.column);
    expect(MARGIN_TRACK_GEOMETRY.narrow.maxColumn).toBeGreaterThan(
      MARGIN_TRACK_GEOMETRY.narrow.column,
    );
  });

  it("elasticity does not move the mode ladder — thresholds budget from the base", () => {
    // The hysteresis ladder must key on `marginReservePx`, never the max;
    // otherwise growing a track could step the mode, which could regrow the
    // track. `t1` is the anchor: 2 * 272 + rails + 480.
    expect(marginModeThresholds(0).t1).toBe(2 * marginReservePx(MARGIN_TRACK_GEOMETRY.full) + 480);
    expect(marginModeThresholds(0).t2).toBe(
      2 * marginReservePx(MARGIN_TRACK_GEOMETRY.narrow) + 480,
    );
  });

  it("reserves descend full > narrow > stub > off (monotonic 272/192/60/0)", () => {
    const r = (m: MarginMode) => marginReservePx(MARGIN_TRACK_GEOMETRY[m]);
    expect(r("full")).toBe(272);
    expect(r("narrow")).toBe(192);
    expect(r("stub")).toBe(60);
    expect(r("off")).toBe(0);
    expect(r("full")).toBeGreaterThan(r("narrow"));
    expect(r("narrow")).toBeGreaterThan(r("stub"));
    expect(r("stub")).toBeGreaterThan(r("off"));
  });
});

describe("marginModeThresholds — ordered bands, t1 delegates to narrowThreshold", () => {
  it.each([0, 300, 600])("t1 > t2 > t3 with rails=%i px", (rails) => {
    const { t1, t2, t3 } = marginModeThresholds(rails);
    expect(t1).toBeGreaterThan(t2);
    expect(t2).toBeGreaterThan(t3);
  });

  it.each([0, 300, 600])("t1 === narrowThresholdPx(rails=%i)", (rails) => {
    expect(marginModeThresholds(rails).t1).toBe(narrowThresholdPx(rails));
  });

  it.each([0, 300, 600])("every band gap exceeds the hysteresis (rails=%i)", (rails) => {
    const { t1, t2, t3 } = marginModeThresholds(rails);
    // Non-overlapping deadbands require each gap > hysteresis (a fast drag
    // through a boundary must not flicker between adjacent modes).
    expect(t1 - t2).toBeGreaterThan(MARGIN_VIEW_HYSTERESIS_PX);
    expect(t2 - t3).toBeGreaterThan(MARGIN_VIEW_HYSTERESIS_PX);
  });

  it("matches the documented values at rails=0 (272/192/60 reserves)", () => {
    expect(marginModeThresholds(0)).toEqual({
      t1: 2 * 272 + MIN_EDITOR_WIDTH_PX, // 1024
      t2: 2 * 192 + MIN_EDITOR_WIDTH_PX, // 864
      t3: 2 * 60 + MIN_EDITOR_WIDTH_PX, // 600
    });
  });
});

describe("nextMarginMode — continuum bands + hysteresis + multi-band clamp", () => {
  const T = marginModeThresholds(0); // { t1: 1024, t2: 864, t3: 600 }
  const H = MARGIN_VIEW_HYSTERESIS_PX; // 32

  // why: each row names the equivalence class the width falls in, so a missing
  // band shows up as a missing row.
  it.each<{ prev: MarginMode; w: number; expected: MarginMode; why: string }>([
    { prev: "full", w: T.t1 + 1, expected: "full", why: "above t1 → full" },
    { prev: "full", w: T.t1 - 1, expected: "narrow", why: "below t1 → step to narrow" },
    { prev: "narrow", w: T.t2 - 1, expected: "stub", why: "below t2 → step to stub" },
    { prev: "stub", w: T.t3 - 1, expected: "off", why: "below t3 → off" },
    { prev: "stub", w: T.t3 + 1, expected: "stub", why: "just above t3 → stub" },
    // multi-band jumps clamp in BOTH directions
    { prev: "full", w: T.t3 - 1, expected: "off", why: "huge→tiny clamps straight to off" },
    { prev: "off", w: T.t1 + H + 1, expected: "full", why: "tiny→huge clamps straight to full" },
    // hysteresis deadband holds the prior mode
    { prev: "narrow", w: T.t1 + 5, expected: "narrow", why: "in t1 deadband (<t1+H) holds prev" },
    { prev: "full", w: T.t1 + 5, expected: "full", why: "in t1 deadband holds prev (other side)" },
    { prev: "stub", w: T.t2 + 5, expected: "stub", why: "in t2 deadband holds prev" },
    { prev: "narrow", w: T.t1 + H + 1, expected: "full", why: "cleared t1+H → widen to full" },
  ])("prev=$prev w=$w → $expected ($why)", ({ prev, w, expected }) => {
    expect(nextMarginMode(prev, w, T, H)).toBe(expected);
  });

  it("at exactly t1 the deadband holds prev (entry is strict <)", () => {
    expect(nextMarginMode("full", T.t1, T, H)).toBe("full");
    expect(nextMarginMode("narrow", T.t1, T, H)).toBe("narrow");
  });

  // docx equivalence: docx margins are on iff `widthMode === "full"`, and that
  // must flip at the SAME width (and hysteresis) the legacy `nextNarrowSticky`
  // flipped on↔off. This locks the byte-identical-docx-behavior claim directly,
  // rather than relying on walking the algebra by hand. `prev` maps:
  // full ⇄ !narrow(false); any narrower mode ⇄ narrow(true).
  it.each([
    { w: T.t1 - 1, why: "below t1: docx off / narrowSticky narrow" },
    { w: T.t1, why: "at t1 (strict-< entry): both hold prev" },
    { w: T.t1 + 5, why: "in deadband: both hold prev" },
    { w: T.t1 + H + 1, why: "cleared t1+H: docx full / narrowSticky wide" },
  ])("docx on === !narrowSticky at w=$w ($why)", ({ w }) => {
    for (const startFull of [true, false]) {
      const modePrev: MarginMode = startFull ? "full" : "narrow";
      const docxOn = nextMarginMode(modePrev, w, T, H) === "full";
      const narrowWide = !nextNarrowSticky(!startFull, w, T.t1, H);
      expect(docxOn).toBe(narrowWide);
    }
  });
});

describe("resolveBaseMode — docx full|off cliff vs non-docx continuum", () => {
  it.each<{ widthMode: MarginMode }>([
    { widthMode: "full" },
    { widthMode: "narrow" },
    { widthMode: "stub" },
    { widthMode: "off" },
  ])("non-docx passes widthMode=$widthMode through when margin view on", ({ widthMode }) => {
    expect(resolveBaseMode(false, true, widthMode)).toBe(widthMode);
  });

  it("non-docx → off when margin view is off, regardless of widthMode", () => {
    expect(resolveBaseMode(false, false, "full")).toBe("off");
  });

  it("docx is full only when widthMode permits full margins, else off", () => {
    expect(resolveBaseMode(true, true, "full")).toBe("full");
    expect(resolveBaseMode(true, true, "narrow")).toBe("off"); // never narrow/stub
    expect(resolveBaseMode(true, true, "stub")).toBe("off");
    expect(resolveBaseMode(true, true, "off")).toBe("off");
    expect(resolveBaseMode(true, false, "full")).toBe("off"); // margin view off
  });
});

describe("resolveSideMode — presence-collapse (non-docx) vs docx exemption", () => {
  // why: presence asymmetry is the ONE sanctioned per-side divergence.
  it.each<{
    base: MarginMode;
    isDocx: boolean;
    hasPending: boolean;
    expected: MarginMode;
    why: string;
  }>([
    {
      base: "full",
      isDocx: false,
      hasPending: true,
      expected: "full",
      why: "non-docx, has pending → keep",
    },
    {
      base: "full",
      isDocx: false,
      hasPending: false,
      expected: "off",
      why: "non-docx, empty → collapse",
    },
    {
      base: "narrow",
      isDocx: false,
      hasPending: false,
      expected: "off",
      why: "collapse from any base",
    },
    { base: "off", isDocx: false, hasPending: true, expected: "off", why: "base off stays off" },
    {
      base: "full",
      isDocx: true,
      hasPending: false,
      expected: "full",
      why: "docx exempt — no collapse",
    },
    { base: "off", isDocx: true, hasPending: true, expected: "off", why: "docx follows base only" },
  ])("base=$base docx=$isDocx pending=$hasPending → $expected ($why)", ({
    base,
    isDocx,
    hasPending,
    expected,
  }) => {
    expect(resolveSideMode(base, isDocx, hasPending)).toBe(expected);
  });

  it("non-docx full mode: the four presence combos (both/left/right/neither)", () => {
    const base: MarginMode = "full";
    // both pending
    expect(resolveSideMode(base, false, true)).toBe("full");
    // left-only: left keeps, right collapses
    expect([resolveSideMode(base, false, true), resolveSideMode(base, false, false)]).toEqual([
      "full",
      "off",
    ]);
    // neither: both off
    expect(resolveSideMode(base, false, false)).toBe("off");
  });
});

describe("stageLayerStyle — docx keeps its legacy path", () => {
  it("docx + margins on → position: relative (not a grid)", () => {
    const s = stageLayerStyle({
      isDocx: true,
      effectivelyOn: true,
      leftReservePx: MARGIN_VIEW_RESERVE_PER_SIDE_PX,
      rightReservePx: MARGIN_VIEW_RESERVE_PER_SIDE_PX,
      // Unread by the docx branch (it returns before touching these), but the
      // input type requires them.
      leftReserveMaxPx: 0,
      rightReserveMaxPx: 0,
      measure: "100%",
    });
    expect(s).toBe("position: relative;");
  });

  it("docx + margins off → display: contents", () => {
    const s = stageLayerStyle({
      isDocx: true,
      effectivelyOn: false,
      leftReservePx: 0,
      rightReservePx: 0,
      leftReserveMaxPx: 0,
      rightReserveMaxPx: 0,
      measure: "100%",
    });
    expect(s).toBe("display: contents;");
  });
});

describe("stageLayerStyle — non-docx grid reserves per side (defect #1 + continuum)", () => {
  const full = MARGIN_VIEW_RESERVE_PER_SIDE_PX; // 272
  const fullMax = marginReserveMaxPx(MARGIN_TRACK_GEOMETRY.full); // 432
  const narrow = marginReservePx(MARGIN_TRACK_GEOMETRY.narrow); // 192
  const narrowMax = marginReserveMaxPx(MARGIN_TRACK_GEOMETRY.narrow); // 272

  /** Non-docx stage style with sensible defaults, so each test states only what it varies. */
  const grid = (over: Partial<Parameters<typeof stageLayerStyle>[0]> = {}) =>
    stageLayerStyle({
      isDocx: false,
      effectivelyOn: true,
      leftReservePx: 0,
      rightReservePx: 0,
      leftReserveMaxPx: 0,
      rightReserveMaxPx: 0,
      measure: "100%",
      ...over,
    });

  it("both tracks 0 → no phantom reserve (both sides off / empty)", () => {
    const s = grid({ effectivelyOn: false });
    expect(s).toContain("display: grid;");
    expect(s).toContain("--margin-left-track: 0px;");
    expect(s).toContain("--margin-right-track: 0px;");
    expect(s).toContain("--margin-left-track-max: 0px;");
    expect(s).toContain("--margin-right-track-max: 0px;");
  });

  it("both sides full → both tracks reserve the full per-side width", () => {
    const s = grid({
      leftReservePx: full,
      rightReservePx: full,
      leftReserveMaxPx: fullMax,
      rightReserveMaxPx: fullMax,
    });
    expect(s).toContain(`--margin-left-track: ${full}px;`);
    expect(s).toContain(`--margin-right-track: ${full}px;`);
    expect(s).toContain(`--margin-left-track-max: ${fullMax}px;`);
    expect(s).toContain(`--margin-right-track-max: ${fullMax}px;`);
  });

  it("asymmetric: left full, right empty-collapsed → left 272px, right 0px", () => {
    const s = grid({ leftReservePx: full, leftReserveMaxPx: fullMax });
    expect(s).toContain(`--margin-left-track: ${full}px;`);
    expect(s).toContain("--margin-right-track: 0px;");
    expect(s).toContain(`--margin-left-track-max: ${fullMax}px;`);
    // An empty-collapsed side must not reserve phantom width via its ceiling.
    expect(s).toContain("--margin-right-track-max: 0px;");
  });

  it("narrow mode → both tracks reserve the narrow width (192px)", () => {
    const s = grid({
      leftReservePx: narrow,
      rightReservePx: narrow,
      leftReserveMaxPx: narrowMax,
      rightReserveMaxPx: narrowMax,
    });
    expect(s).toContain(`--margin-left-track: ${narrow}px;`);
    expect(s).toContain(`--margin-right-track: ${narrow}px;`);
    expect(s).toContain(`--margin-left-track-max: ${narrowMax}px;`);
  });

  it("threads the reading measure into --editor-measure", () => {
    const s = grid({ measure: "68%" });
    expect(s).toContain("--editor-measure: 68%;");
    // Content track is minmax(0, measure) so it can shrink under tight space
    // rather than overflow when margins + gutters consume the row.
    expect(s).toContain("minmax(0, var(--editor-measure))");
  });

  it("margin tracks are elastic via a surplus-limited clamp(), per side", () => {
    // The clamp is load-bearing, NOT decoration. A plain minmax(base, max) lets
    // Grid's Maximize-Tracks step grow the margins at the CONTENT track's
    // expense (measured in Chromium: content 556px → 236px at a 1100px stage).
    // Capping the ceiling at the surplus `(100% - measure) / 2` makes the max
    // collapse onto the base wherever there is no surplus, so the track is
    // fixed at exactly today's value and the content track never moves.
    const s = grid({
      leftReservePx: full,
      rightReservePx: full,
      leftReserveMaxPx: fullMax,
      rightReserveMaxPx: fullMax,
      measure: "68ch",
    });
    for (const side of ["left", "right"] as const) {
      expect(s).toContain(
        `minmax(var(--margin-${side}-track), clamp(var(--margin-${side}-track), ` +
          `(100% - var(--editor-measure)) / 2, var(--margin-${side}-track-max)))`,
      );
    }
    // The ceiling must never be expressed as anything but the surplus — doing so
    // would let track width move the content width, which reaches coordsAtPos
    // and closes a real cycle back into the crowding verdict.
    expect(s).not.toContain(`minmax(var(--margin-left-track), var(--margin-left-track-max))`);
  });

  it("track order stays [gutter, left, content, right, gutter] with the elastic tracks", () => {
    // INVARIANT 5's sibling: the bubble-offset math assumes margins are columns
    // 2 and 4 around a column-3 content track.
    const s = grid({ leftReservePx: full, leftReserveMaxPx: fullMax });
    const cols = s.slice(s.indexOf("grid-template-columns:"));
    const iGutter = cols.indexOf("minmax(0, 1fr)");
    const iLeft = cols.indexOf("--margin-left-track");
    const iContent = cols.indexOf("minmax(0, var(--editor-measure))");
    const iRight = cols.indexOf("--margin-right-track");
    const iGutter2 = cols.lastIndexOf("minmax(0, 1fr)");
    expect(iGutter).toBeLessThan(iLeft);
    expect(iLeft).toBeLessThan(iContent);
    expect(iContent).toBeLessThan(iRight);
    expect(iRight).toBeLessThan(iGutter2);
  });
});

describe("nextNarrowSticky — retained 2-way reference / regression anchor", () => {
  const T = 1000;
  const H = 32;

  it("below threshold → narrow (true) regardless of prior", () => {
    expect(nextNarrowSticky(false, T - 1, T, H)).toBe(true);
    expect(nextNarrowSticky(true, T - 1, T, H)).toBe(true);
  });

  it("above threshold + hysteresis → wide (false) regardless of prior", () => {
    expect(nextNarrowSticky(true, T + H + 1, T, H)).toBe(false);
    expect(nextNarrowSticky(false, T + H + 1, T, H)).toBe(false);
  });

  it("inside the deadband → holds the prior value (no flicker)", () => {
    expect(nextNarrowSticky(true, T + 10, T, H)).toBe(true);
    expect(nextNarrowSticky(false, T + 10, T, H)).toBe(false);
    expect(nextNarrowSticky(true, T, T, H)).toBe(true);
    expect(nextNarrowSticky(false, T, T, H)).toBe(false);
  });
});

describe("narrowThresholdPx — both-sides reserve + rails + min editor", () => {
  it("with no rails open", () => {
    expect(narrowThresholdPx(0)).toBe(2 * MARGIN_VIEW_RESERVE_PER_SIDE_PX + MIN_EDITOR_WIDTH_PX);
  });

  it("adds the open-rail width", () => {
    expect(narrowThresholdPx(300)).toBe(
      2 * MARGIN_VIEW_RESERVE_PER_SIDE_PX + 300 + MIN_EDITOR_WIDTH_PX,
    );
  });
});
