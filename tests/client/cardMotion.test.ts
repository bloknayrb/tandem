import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  barIn,
  barOut,
  cardEnter,
  cardExit,
  cardFlyToMargin,
  registerFlySource,
  tabEnter,
  tabExit,
} from "../../src/client/panels/cardMotion";

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

// s3 tab-close transition. Pure-config coverage; the horizontal collapse itself
// is exercised functionally by the existing Ctrl+W tab-close E2E specs (which run
// with motion on by Playwright default).
describe("tabExit", () => {
  it("collapses immediately under reduce-motion (motion.md: no slide)", () => {
    expect(tabExit(el(), { reduceMotion: true })).toEqual({ duration: 0 });
  });

  it("returns a real inline-axis collapse with motion allowed", () => {
    const cfg = tabExit(el(), { reduceMotion: false });
    expect(cfg.duration).toBe(200);
    expect(typeof cfg.easing).toBe("function");
    const present = cfg.css!(1, 0);
    const gone = cfg.css!(0, 1);
    expect(present).toContain("opacity:1");
    expect(gone).toContain("opacity:0");
    // collapses width (not height) so adjacent tabs reflow on the inline axis,
    // with min-width:0 to defeat the tab's content min-width and clip (not scroll).
    expect(present).toContain("width:");
    expect(present).toContain("min-width:0");
    expect(present).toContain("overflow:clip");
    // inert while leaving: a click on the collapsing tab would switch to a dead
    // id (already gone from tabsState) and wipe the editor; it also drops the
    // node from elementFromPoint, hardening the drag drop-target path.
    expect(present).toContain("pointer-events:none");
  });

  it("uses the ease-out curve", () => {
    const { easing } = tabExit(el(), {});
    expect(easing!(0)).toBe(0);
    expect(easing!(1)).toBe(1);
    expect(easing!(0.5)).toBeGreaterThan(0.5); // front-loaded
  });
});

describe("tabEnter", () => {
  it("unrolls immediately under reduce-motion (motion.md: no slide)", () => {
    expect(tabEnter(el(), { reduceMotion: true })).toEqual({ duration: 0 });
  });

  it("returns a real inline-axis unroll with motion allowed", () => {
    const cfg = tabEnter(el(), { reduceMotion: false });
    // A touch longer than the 200ms exit (settles in rather than snapping shut).
    expect(cfg.duration).toBe(220);
    expect(typeof cfg.easing).toBe("function");
    const present = cfg.css!(1, 0);
    const absent = cfg.css!(0, 1);
    expect(present).toContain("opacity:1");
    expect(absent).toContain("opacity:0");
    // unrolls width (not height) so adjacent tabs glide right to make room,
    // with min-width:0 to defeat the name span's width floor and clip the unroll.
    expect(present).toContain("width:");
    expect(present).toContain("min-width:0");
    expect(present).toContain("overflow:clip");
    // UNLIKE tabExit: an entering tab is interactive — it must NOT go inert,
    // or a click landing mid-unroll on a freshly-opened tab would be swallowed.
    expect(present).not.toContain("pointer-events:none");
  });

  it("uses the ease-out curve", () => {
    const { easing } = tabEnter(el(), {});
    expect(easing!(0)).toBe(0);
    expect(easing!(1)).toBe(1);
    expect(easing!(0.5)).toBeGreaterThan(0.5); // front-loaded
  });
});

// A27 fly-to-margin. The Map-presence gate is the load-bearing guarantee that
// ONLY the just-submitted card flies (every other mount has no source → no-op),
// so most of the coverage is that gate + the delete-on-read / TTL hygiene that
// keeps the module-level ledger from stranding a source. Fake timers so the
// 1000ms TTL backstop can't dangle across tests.
describe("cardFlyToMargin / registerFlySource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // A node whose resolved slot (destination) is a known rect, so the FLIP delta
  // is deterministic (happy-dom's getBoundingClientRect returns zeros otherwise).
  function nodeAt(left: number, top: number): HTMLElement {
    const node = el();
    node.getBoundingClientRect = () =>
      ({ left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top }) as DOMRect;
    return node;
  }

  function rect(left: number, top: number): DOMRect {
    return { left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top } as DOMRect;
  }

  it("is a no-op when the id has no registered source (every non-submit mount)", () => {
    // Initial load, tab switch, scroll/filter re-render all land here.
    expect(cardFlyToMargin(nodeAt(0, 0), { id: "never-registered" })).toEqual({ duration: 0 });
  });

  it("flies from the registered popover footprint to the slot (identity at settle)", () => {
    // Popover at (500, 120); card slot at (900, 300) → delta (-400, -180).
    registerFlySource("a1", rect(500, 120));
    const cfg = cardFlyToMargin(nodeAt(900, 300), { id: "a1" });
    expect(cfg.duration).toBe(480);
    expect(typeof cfg.easing).toBe("function");
    // u=1 (start): sits over the popover footprint via the full delta.
    expect(cfg.css!(0, 1)).toContain("translate(-400px, -180px)");
    // t=1 (settled): rests at identity in its slot.
    expect(cfg.css!(1, 0)).toContain("translate(0px, 0px)");
    // fades in (floored so it stays visible while flying).
    expect(cfg.css!(0, 1)).toContain("opacity:0.2");
    expect(cfg.css!(1, 0)).toContain("opacity:1");
  });

  it("consumes the source on read so a second mount can't re-fly the same id", () => {
    registerFlySource("a2", rect(0, 0));
    expect(cardFlyToMargin(nodeAt(10, 10), { id: "a2" }).duration).toBe(480);
    // The source is deleted on read — a re-render mount no-ops.
    expect(cardFlyToMargin(nodeAt(10, 10), { id: "a2" })).toEqual({ duration: 0 });
  });

  it("no-ops under reduce-motion but STILL consumes the source (can't strand)", () => {
    registerFlySource("a3", rect(0, 0));
    expect(cardFlyToMargin(nodeAt(10, 10), { id: "a3", reduceMotion: true })).toEqual({
      duration: 0,
    });
    // Source was consumed before the gate, so a later non-reduced mount won't fly a stale card.
    expect(cardFlyToMargin(nodeAt(10, 10), { id: "a3" })).toEqual({ duration: 0 });
  });

  it("GCs an unconsumed source after the TTL (card never mounted → graceful no-fly)", () => {
    registerFlySource("a4", rect(0, 0));
    vi.advanceTimersByTime(1000);
    // The backstop fired; a (very late) mount finds no source and snaps instead of flying.
    expect(cardFlyToMargin(nodeAt(10, 10), { id: "a4" })).toEqual({ duration: 0 });
  });
});
