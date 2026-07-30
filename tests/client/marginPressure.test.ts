import { describe, expect, it } from "vitest";
import {
  type CardModel,
  CROWD_ENTER_PX,
  CROWD_EXIT_PX,
  estimateHeightPx,
  type PressureInput,
  resolveCrowding,
} from "../../src/client/panels/marginPressure.js";

/**
 * Vertical-pressure resolution (#917). Everything here is pure by design — the
 * whole point of extracting `resolveCrowding` is that the crowd-minimize
 * decision can be exercised without a Tiptap view, a Y.Doc, or a Svelte effect
 * root. The rune wiring in `MarginColumn` is covered by `margin-view.spec.ts`.
 */

const model = (over: Partial<CardModel> = {}): CardModel => ({
  contentLength: 120,
  hasSnippet: true,
  hasSuggestion: false,
  replyCount: 0,
  hasActions: true,
  ...over,
});

const at = (id: string, top: number, over: Partial<CardModel> = {}): PressureInput => ({
  id,
  top,
  model: model(over),
});

describe("estimateHeightPx — model-derived, never measured", () => {
  it("a full card is taller than its compact form", () => {
    const m = model();
    expect(estimateHeightPx(m, "full")).toBeGreaterThan(estimateHeightPx(m, "compact"));
  });

  it("compact keeps the action row, so dropping actions makes it shorter", () => {
    // The action row is what distinguishes `compact` from the narrow-band
    // `clamped` variant, so its contribution to the estimate must be real.
    const withActions = estimateHeightPx(model({ hasActions: true }), "compact");
    const without = estimateHeightPx(model({ hasActions: false }), "compact");
    expect(withActions).toBeGreaterThan(without);
  });

  it("full height grows with content length, and shrinks as the column widens", () => {
    const short = estimateHeightPx(model({ contentLength: 20 }), "full");
    const long = estimateHeightPx(model({ contentLength: 600 }), "full");
    expect(long).toBeGreaterThan(short);

    // The elastic column is the reason this is parameterized: wider cards wrap
    // less, so they are shorter — which is how Part 2 relieves Part 1.
    const narrowCol = estimateHeightPx(model({ contentLength: 600 }), "full", 240);
    const wideCol = estimateHeightPx(model({ contentLength: 600 }), "full", 400);
    expect(wideCol).toBeLessThan(narrowCol);
  });

  it("snippet, suggestion diff and replies each add height at full density only", () => {
    const base = model({ hasSnippet: false, hasSuggestion: false, replyCount: 0 });
    const withSnippet = estimateHeightPx({ ...base, hasSnippet: true }, "full");
    const withDiff = estimateHeightPx({ ...base, hasSuggestion: true }, "full");
    const withReplies = estimateHeightPx({ ...base, replyCount: 3 }, "full");
    const plain = estimateHeightPx(base, "full");
    expect(withSnippet).toBeGreaterThan(plain);
    expect(withDiff).toBeGreaterThan(plain);
    expect(withReplies).toBeGreaterThan(plain);

    // ...and none of them at compact, which hides all three.
    const c = estimateHeightPx(base, "compact");
    expect(estimateHeightPx({ ...base, hasSnippet: true }, "compact")).toBe(c);
    expect(estimateHeightPx({ ...base, replyCount: 3 }, "compact")).toBe(c);
  });

  it("never returns a non-positive or non-finite height, even for degenerate input", () => {
    for (const density of ["full", "compact"] as const) {
      const h = estimateHeightPx(model({ contentLength: 0 }), density, 1);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThan(0);
    }
  });

  it("real full cards land in the 100-300px band the relief loop assumes", () => {
    // Guards the calibration: a constant at the FLOOR of this range was the
    // original design and under-fired, computing zero drift for anchors ~130px
    // apart while reality drifted ~50px per step.
    const typical = estimateHeightPx(model({ contentLength: 160 }), "full", 240);
    expect(typical).toBeGreaterThan(100);
    expect(typical).toBeLessThan(300);
  });
});

describe("resolveCrowding — verdict from raw tops + model only", () => {
  it("takes no measured height in its signature (the cycle guard)", () => {
    // This is the actual enforcement of the one-way flow documented in
    // marginPressure.ts. `PressureInput` is {id, top, model} — if a future edit
    // adds a measured `height`, this fails and the reviewer reads the header.
    const input = at("a", 0);
    expect(Object.keys(input).sort()).toEqual(["id", "model", "top"]);
    expect(Object.keys(input)).not.toContain("height");
  });

  it("returns nothing for an empty set", () => {
    expect(resolveCrowding([]).size).toBe(0);
  });

  it("a lone bubble is never crowded", () => {
    expect(resolveCrowding([at("a", 100)]).size).toBe(0);
  });

  it("well-separated bubbles stay full — the no-false-positive case", () => {
    // 600px apart: no card estimate comes close, so nothing should minimize.
    const out = resolveCrowding([at("a", 0), at("b", 600), at("c", 1200)]);
    expect(out.size).toBe(0);
  });

  it("two bubbles on the same line minimize", () => {
    // Identical tops always overlap by a full card height, well past the enter
    // threshold. This is the case Bryan's screenshot shows and the case that
    // legitimately changes the shipped C-2 expectation.
    const out = resolveCrowding([at("a", 300), at("b", 300)]);
    expect(out.size).toBeGreaterThan(0);
  });

  it("minimizes only the culprit, not the whole run", () => {
    // One very long comment at the top pushes its neighbour off-anchor; the
    // others are far apart and fine. Run-wide marking (the original design)
    // would clamp all three because drift is monotone within a run. The relief
    // loop should minimize the tall card and stop.
    const bubbles = [at("tall", 0, { contentLength: 900 }), at("pushed", 200), at("distant", 800)];
    const out = resolveCrowding(bubbles);
    expect(out.has("tall")).toBe(true);
    expect(out.has("distant")).toBe(false);
    expect(out.size).toBeLessThan(bubbles.length);
  });

  it("compresses a long cluster fully when even compact cards cannot fit", () => {
    // Ten anchors 100px apart: a compact card is ~109px including the gap, so
    // drift still accumulates and every bubble legitimately minimizes. This is
    // best-effort, not over-minimizing — contrast the culprit case above.
    const bubbles = Array.from({ length: 10 }, (_, i) => at(`n${i}`, i * 100));
    expect(resolveCrowding(bubbles).size).toBe(bubbles.length);
  });

  it("relieves crowding — after minimizing, no card exceeds the enter threshold", () => {
    // The loop's post-condition, stated directly: given enough compressibility
    // the final layout should be within tolerance everywhere.
    const bubbles = Array.from({ length: 4 }, (_, i) => at(`n${i}`, i * 140));
    const crowded = resolveCrowding(bubbles);

    // Re-simulate with the verdict applied and check residual drift.
    let cursor = Number.NEGATIVE_INFINITY;
    let worst = 0;
    for (const b of bubbles) {
      const place = Math.max(b.top, cursor);
      worst = Math.max(worst, place - b.top);
      const density = crowded.has(b.id) ? "compact" : "full";
      cursor = place + estimateHeightPx(b.model, density) + 6;
    }
    expect(worst).toBeLessThanOrEqual(CROWD_ENTER_PX);
  });

  it("does not abandon bubbles below an unsatisfiable violation", () => {
    // Regression: the relief loop originally stopped at the FIRST violation it
    // could not fix. Five bubbles 40px apart minimized only the top two and left
    // the remaining three rendering FULL while drifted 458px — the exact failure
    // this feature exists to prevent. Every bubble in an unsatisfiable cluster
    // must compress as far as it can.
    const bubbles = Array.from({ length: 5 }, (_, i) => at(`n${i}`, i * 40));
    const out = resolveCrowding(bubbles);
    expect(out.size).toBe(bubbles.length);
  });

  it("minimizes every bubble when they all share one anchor line", () => {
    const bubbles = Array.from({ length: 5 }, (_, i) => at(`n${i}`, 200));
    expect(resolveCrowding(bubbles).size).toBe(bubbles.length);
  });

  it("cannot be relieved past all-minimized, and terminates", () => {
    // 20 annotations on one line is unsatisfiable — compact cards still don't
    // fit in zero space. The loop must halt rather than spin.
    const bubbles = Array.from({ length: 20 }, (_, i) => at(`n${i}`, 500));
    const out = resolveCrowding(bubbles);
    expect(out.size).toBeLessThanOrEqual(bubbles.length);
    // Every id returned must be a real input id (no phantom entries).
    for (const id of out) expect(bubbles.some((b) => b.id === id)).toBe(true);
  });

  it("skips non-finite tops without throwing or emitting them", () => {
    const out = resolveCrowding([
      at("ok", 0),
      { ...at("nan", Number.NaN) },
      { ...at("inf", Number.POSITIVE_INFINITY) },
    ]);
    expect(out.has("nan")).toBe(false);
    expect(out.has("inf")).toBe(false);
  });

  it("is order-independent — input order does not change the verdict", () => {
    const a = [at("x", 0), at("y", 60), at("z", 120)];
    const forward = resolveCrowding(a);
    const reversed = resolveCrowding([...a].reverse());
    expect([...forward].sort()).toEqual([...reversed].sort());
  });

  it("is deterministic across repeated calls with the same input", () => {
    const bubbles = [at("a", 0), at("b", 90), at("c", 150), at("d", 500)];
    const first = resolveCrowding(bubbles);
    const second = resolveCrowding(bubbles);
    expect([...first].sort()).toEqual([...second].sort());
  });
});

describe("resolveCrowding — hysteresis band", () => {
  it("holds a previously-crowded card inside the band instead of flapping", () => {
    // Drift between EXIT and ENTER: a fresh evaluation would not enter, but a
    // card already crowded must stay crowded. Without this, a keystroke that
    // rewraps a line (~24px, over half the tolerance) flips the verdict at full
    // amplitude and every flip costs a visible settle.
    const spacing = 40;
    const bubbles = [at("a", 0), at("b", spacing), at("c", spacing * 2)];

    const cold = resolveCrowding(bubbles, new Set());
    const warm = resolveCrowding(bubbles, new Set(["a", "b", "c"]));
    // Warm start can only ever be a superset — the band adds stickiness, never
    // removes a verdict the cold pass reached.
    for (const id of cold) expect(warm.has(id)).toBe(true);
    expect(warm.size).toBeGreaterThanOrEqual(cold.size);
  });

  it("releases a card once drift falls below the exit threshold", () => {
    // Far apart → zero drift → well under EXIT, so a stale pin from a previous
    // crowded layout must clear.
    const roomy = [at("a", 0), at("b", 900)];
    const out = resolveCrowding(roomy, new Set(["a", "b"]));
    expect(out.size).toBe(0);
  });

  it("keeps EXIT strictly below ENTER, or the band inverts", () => {
    expect(CROWD_EXIT_PX).toBeLessThan(CROWD_ENTER_PX);
  });

  it("converges — feeding the verdict back in reaches a fixed point", () => {
    // The stability property the whole design rests on: because the verdict is
    // computed from RAW tops (which card density cannot move), iterating must
    // settle rather than oscillate.
    const bubbles = Array.from({ length: 6 }, (_, i) => at(`n${i}`, i * 90));
    let prev = new Set<string>();
    let next = resolveCrowding(bubbles, prev);
    for (let i = 0; i < 5; i++) {
      prev = next;
      next = resolveCrowding(bubbles, prev);
      if ([...next].sort().join() === [...prev].sort().join()) break;
    }
    expect([...next].sort()).toEqual([...prev].sort());
  });
});
