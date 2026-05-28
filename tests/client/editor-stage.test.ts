import { describe, expect, it } from "vitest";
import {
  MARGIN_VIEW_RESERVE_PER_SIDE_PX,
  MIN_EDITOR_WIDTH_PX,
  narrowThresholdPx,
  nextNarrowSticky,
  stageLayerStyle,
} from "../../src/client/layout/editor-stage.svelte.js";

/**
 * Editor stage model (Phase 3.5). The rune-based `createEditorStageModel`
 * needs a Svelte effect root + live settings/layout stores, so it's exercised
 * via Playwright (`margin-view.spec.ts`). The pure layout primitives —
 * `stageLayerStyle`, `nextNarrowSticky`, `narrowThresholdPx` — are unit-tested
 * here. `stageLayerStyle` in particular encodes the per-side-reserve fix
 * (defect #1): reserve must be taken ONLY on a side that actually renders a
 * margin, so the matrix below is the regression guard for that.
 */

describe("stageLayerStyle — docx keeps its legacy path", () => {
  it("docx + margins on → position: relative (not a grid)", () => {
    const s = stageLayerStyle({
      isDocx: true,
      effectivelyOn: true,
      leftVisible: true,
      rightVisible: true,
      measure: "100%",
    });
    expect(s).toBe("position: relative;");
  });

  it("docx + margins off → display: contents", () => {
    const s = stageLayerStyle({
      isDocx: true,
      effectivelyOn: false,
      leftVisible: false,
      rightVisible: false,
      measure: "100%",
    });
    expect(s).toBe("display: contents;");
  });
});

describe("stageLayerStyle — non-docx grid reserves per side (defect #1)", () => {
  const reserve = `${MARGIN_VIEW_RESERVE_PER_SIDE_PX}px`; // "272px"

  it("both margins hidden → both tracks 0 (no phantom reserve)", () => {
    const s = stageLayerStyle({
      isDocx: false,
      effectivelyOn: false,
      leftVisible: false,
      rightVisible: false,
      measure: "100%",
    });
    expect(s).toContain("display: grid;");
    expect(s).toContain("--margin-left-track: 0px;");
    expect(s).toContain("--margin-right-track: 0px;");
  });

  it("both margins shown → both tracks reserve the per-side width", () => {
    const s = stageLayerStyle({
      isDocx: false,
      effectivelyOn: true,
      leftVisible: true,
      rightVisible: true,
      measure: "100%",
    });
    expect(s).toContain(`--margin-left-track: ${reserve};`);
    expect(s).toContain(`--margin-right-track: ${reserve};`);
  });

  it("only left margin shown (right rail open) → only left reserves", () => {
    const s = stageLayerStyle({
      isDocx: false,
      effectivelyOn: true,
      leftVisible: true,
      rightVisible: false,
      measure: "100%",
    });
    expect(s).toContain(`--margin-left-track: ${reserve};`);
    expect(s).toContain("--margin-right-track: 0px;");
  });

  it("only right margin shown (left rail open) → only right reserves", () => {
    const s = stageLayerStyle({
      isDocx: false,
      effectivelyOn: true,
      leftVisible: false,
      rightVisible: true,
      measure: "100%",
    });
    expect(s).toContain("--margin-left-track: 0px;");
    expect(s).toContain(`--margin-right-track: ${reserve};`);
  });

  it("threads the reading measure into --editor-measure", () => {
    const s = stageLayerStyle({
      isDocx: false,
      effectivelyOn: true,
      leftVisible: false,
      rightVisible: false,
      measure: "68%",
    });
    expect(s).toContain("--editor-measure: 68%;");
    // Content track is minmax(0, measure) so it can shrink under tight space
    // rather than overflow when margins + gutters consume the row.
    expect(s).toContain("minmax(0, var(--editor-measure))");
  });
});

describe("nextNarrowSticky — hysteresis deadband", () => {
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
    // A drag that overshoots the threshold by < H must not flip back.
    expect(nextNarrowSticky(true, T + 10, T, H)).toBe(true);
    expect(nextNarrowSticky(false, T + 10, T, H)).toBe(false);
    // Exactly at the threshold is inside the band (entry is strict `< T`).
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
