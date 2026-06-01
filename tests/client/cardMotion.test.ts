import { describe, expect, it } from "vitest";
import { barIn, barOut, cardEnter, cardExit } from "../../src/client/panels/cardMotion";

// A4/A1/A10 rail card transitions (Phase 4 / #798). These exercise the pure
// decision logic (enabled gate, reduced-motion gate, exit-direction read-and-
// clear, easing curve endpoints) — the visual collapse itself is verified in
// the browser, not here (frozen capture clock makes mid-transition snapshots
// unreliable).

function el(): HTMLElement {
  return document.createElement("div");
}

describe("cardEnter", () => {
  it("is a no-op when not enabled (resolved / margin cards)", () => {
    expect(cardEnter(el(), { enabled: false })).toEqual({ duration: 0 });
  });

  it("is a no-op under the reduce-motion setting", () => {
    expect(cardEnter(el(), { enabled: true, reduceMotion: true })).toEqual({ duration: 0 });
  });

  it("returns a real transition when enabled and motion is allowed", () => {
    const cfg = cardEnter(el(), { enabled: true, reduceMotion: false });
    expect(cfg.duration).toBeGreaterThan(0);
    expect(typeof cfg.easing).toBe("function");
    // present state (t=1) is fully opaque; absent state (t=0) is transparent.
    const present = cfg.css!(1, 0);
    const absent = cfg.css!(0, 1);
    expect(present).toContain("opacity:1");
    expect(absent).toContain("opacity:0");
    // collapse is clipped + border-box so the height math is exact.
    expect(present).toContain("overflow:clip");
    expect(present).toContain("box-sizing:border-box");
  });

  it("uses an ease-out curve pinned at both endpoints", () => {
    const { easing } = cardEnter(el(), { enabled: true });
    expect(easing!(0)).toBe(0);
    expect(easing!(1)).toBe(1);
    // ease-out: front-loaded, so progress at the midpoint is already past half.
    expect(easing!(0.5)).toBeGreaterThan(0.5);
    // monotonic non-decreasing across the unit interval.
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const v = easing!(i / 10);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("cardExit", () => {
  it("settles upward on accept", () => {
    const modes = new Map<string, "accept" | "dismiss">([["a1", "accept"]]);
    const cfg = cardExit(el(), { enabled: true, id: "a1", modes });
    expect(cfg.css!(0.5, 0.5)).toContain("translateY");
  });

  it("slides right + scales on dismiss", () => {
    const modes = new Map<string, "accept" | "dismiss">([["a2", "dismiss"]]);
    const cfg = cardExit(el(), { enabled: true, id: "a2", modes });
    const mid = cfg.css!(0.5, 0.5);
    expect(mid).toContain("translateX");
    expect(mid).toContain("scale");
  });

  it("uses a neutral fade when there is no exit stamp (filtered out, removed)", () => {
    const cfg = cardExit(el(), { enabled: true, id: "nope", modes: new Map() });
    expect(cfg.css!(0.5, 0.5)).toContain("transform:none");
  });

  it("reads and CLEARS the exit stamp so the Map never holds a stale direction", () => {
    const modes = new Map<string, "accept" | "dismiss">([["a3", "accept"]]);
    cardExit(el(), { enabled: true, id: "a3", modes });
    expect(modes.has("a3")).toBe(false);
  });

  it("still clears the stamp on the reduced-motion no-op path", () => {
    const modes = new Map<string, "accept" | "dismiss">([["a4", "dismiss"]]);
    const cfg = cardExit(el(), { enabled: true, reduceMotion: true, id: "a4", modes });
    expect(cfg).toEqual({ duration: 0 });
    expect(modes.has("a4")).toBe(false);
  });
});

// A24/A25 chrome-bar transitions (batch-promote bar, bulk-actions bar). Same
// pure-logic coverage as the card transitions; the visual slide is the human
// spot-check (Svelte runs these on WAAPI, not CSS keyframes, so no animationstart).
describe("barIn", () => {
  it("is a no-op under the reduce-motion setting", () => {
    expect(barIn(el(), { reduceMotion: true })).toEqual({ duration: 0 });
  });

  it("returns a real transition with motion allowed", () => {
    const cfg = barIn(el(), { reduceMotion: false });
    expect(cfg.duration).toBe(280);
    expect(typeof cfg.easing).toBe("function");
    const present = cfg.css!(1, 0);
    const absent = cfg.css!(0, 1);
    expect(present).toContain("opacity:1");
    expect(absent).toContain("opacity:0");
    // height collapses with the bar so siblings reflow (no snap, M1 fix).
    expect(present).toContain("overflow:clip");
    expect(present).toContain("box-sizing:border-box");
    // slides down into place from above.
    expect(absent).toContain("translateY(-8px)");
    expect(present).toContain("translateY(0px)");
  });

  it("uses the ease-out curve, pinned at both endpoints", () => {
    const { easing } = barIn(el(), {});
    expect(easing!(0)).toBe(0);
    expect(easing!(1)).toBe(1);
    expect(easing!(0.5)).toBeGreaterThan(0.5); // front-loaded
  });
});

describe("barOut", () => {
  it("is a no-op under the reduce-motion setting", () => {
    expect(barOut(el(), { reduceMotion: true })).toEqual({ duration: 0 });
  });

  it("defaults to a 200ms exit (batch bar)", () => {
    expect(barOut(el(), {}).duration).toBe(200);
  });

  it("honours the exitMs param (180ms snappier bulk exit)", () => {
    expect(barOut(el(), { exitMs: 180 }).duration).toBe(180);
  });

  it("exits on the ease-standard curve — front-loaded but distinct from ease-out", () => {
    const outMid = barOut(el(), {}).easing!(0.5);
    const inMid = barIn(el(), {}).easing!(0.5);
    // Both curves are front-loaded (past halfway at the midpoint)...
    expect(outMid).toBeGreaterThan(0.5);
    // ...but ease-out leads ease-standard, so they are genuinely two curves (M2).
    expect(inMid).toBeGreaterThan(outMid);
  });
});
