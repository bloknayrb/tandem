import { describe, expect, it } from "vitest";
import {
  assessIncompleteNode,
  checkIncompleteBaseline,
  colorContrastNodeCount,
  compositeOver,
  contrastRatio,
  describeVerdict,
  type IncompleteNodeSample,
  incompleteMessageKey,
  paintedPair,
  type Rgba,
  requiredRatio,
  staleWaivers,
} from "../e2e/axe-incomplete.js";

/**
 * The pure half of #1721's count pin. The E2E loop only ever calls these two
 * functions, so this is where "the gate actually goes red" is proved — a green
 * `accessibility.spec.ts` run proves nothing about a comparator that can never
 * fail.
 *
 * Each case kills a specific wrong implementation, named inline.
 */
describe("checkIncompleteBaseline", () => {
  const baseline = { "dark / annotation card": 4 };

  it("returns a message naming the key when observed exceeds the baseline", () => {
    const msg = checkIncompleteBaseline("dark / annotation card", 5, baseline);
    expect(msg).toContain("dark / annotation card");
    expect(msg).toContain("5");
  });

  it("returns null at exactly the baseline, and below it", () => {
    // Without the equal case a `>=` typo passes the red case above and then
    // quietly reds every surface on the first real run.
    expect(checkIncompleteBaseline("dark / annotation card", 4, baseline)).toBeNull();
    expect(checkIncompleteBaseline("dark / annotation card", 0, baseline)).toBeNull();
  });

  it("appends the caller's context to a failure without changing the verdict", () => {
    // The context carries "seeded on browser X, running on Y" into the message so
    // a red on the required `check` job is triaged before the number is raised.
    // A context argument that could flip a verdict would be a second gate hiding
    // inside a message, so both halves are asserted: it shows up on a red, and it
    // cannot turn a green into a red.
    const msg = checkIncompleteBaseline("dark / annotation card", 5, baseline, "Seeded on X.");
    expect(msg).toContain("Seeded on X.");
    expect(
      checkIncompleteBaseline("dark / annotation card", 4, baseline, "Seeded on X."),
    ).toBeNull();
  });

  it("fails closed on a key with no baseline row", () => {
    // Observed is 0 deliberately: this kills `baseline[key] ?? 0` alongside
    // `?? Infinity` and an early `if (baseline[key] === undefined) return null`.
    // Without it, a surface added to SURFACES runs permanently unmeasured while
    // the required `check` job stays green — the same
    // unasserted-by-construction gap #1721 is filed about.
    const msg = checkIncompleteBaseline("dark / a surface with no baseline row", 0, {});
    expect(msg).toContain("dark / a surface with no baseline row");
  });
});

describe("colorContrastNodeCount", () => {
  it("counts the color-contrast entry's NODES, and 0 when the rule is absent", () => {
    // A count-of-entries implementation returns 1 for both of these.
    expect(colorContrastNodeCount([{ id: "aria-valid-attr", nodes: [{}, {}] }])).toBe(0);
    expect(colorContrastNodeCount([{ id: "color-contrast", nodes: [{}, {}, {}] }])).toBe(3);
  });
});

/**
 * The per-node half (#1721 options 1/2). The E2E loop hands every
 * color-contrast `incomplete` node to `assessIncompleteNode`, so the gate's
 * ability to go red lives here.
 */
describe("compositeOver / paintedPair", () => {
  const white: Rgba = [255, 255, 255, 1];
  const black: Rgba = [0, 0, 0, 1];
  const clear: Rgba = [0, 0, 0, 0];

  it("composites a translucent source over an opaque ground", () => {
    expect(compositeOver([0, 0, 0, 0.5], white)).toEqual([127.5, 127.5, 127.5, 1]);
    expect(compositeOver(clear, white)).toEqual(white);
  });

  it("fades an ancestor's own fill together with the text under group opacity", () => {
    // A 50%-opacity ancestor painting black, with black text in it, over the
    // white canvas: text and ground are BOTH mid-grey, i.e. no contrast at all.
    // Folding the opacity into the text alpha alone (the shortcut) would leave
    // the ground black and the text grey — a contrast that is not on screen.
    const { text, ground } = paintedPair({
      fg: black,
      layers: [
        { bg: white, opacity: 1 },
        { bg: black, opacity: 0.5 },
        { bg: clear, opacity: 1 },
      ],
    });
    expect(contrastRatio(text, ground)).toBe(1);
  });

  it("fades the text alone when only the text's element is translucent", () => {
    const { text, ground } = paintedPair({
      fg: black,
      layers: [
        { bg: white, opacity: 1 },
        { bg: clear, opacity: 0.5 },
      ],
    });
    expect(ground).toEqual(white);
    expect(text.slice(0, 3)).toEqual([127.5, 127.5, 127.5]);
  });
});

describe("requiredRatio", () => {
  const base = { fontSizePx: 13, fontWeight: 400 };
  it("asks 4.5:1 of normal text, including a single letter", () => {
    expect(requiredRatio({ ...base, text: "Message saved." })).toBe(4.5);
    // axe's `shortTextContent` bucket: a letter is text, not a symbol.
    expect(requiredRatio({ ...base, text: "B" })).toBe(4.5);
    expect(requiredRatio({ ...base, text: "H1" })).toBe(4.5);
  });
  it("asks 3:1 of pictographic-symbol text (SC 1.4.11) and of large text", () => {
    expect(requiredRatio({ ...base, text: "⇅" })).toBe(3);
    expect(requiredRatio({ ...base, text: "▾" })).toBe(3);
    // ↑ and ↓ are Unicode Sm, not So — the Arrows block is admitted explicitly.
    expect(requiredRatio({ ...base, text: "↑↓" })).toBe(3);
    expect(requiredRatio({ text: "Heading", fontSizePx: 24, fontWeight: 400 })).toBe(3);
    expect(requiredRatio({ text: "Heading", fontSizePx: 18.66, fontWeight: 700 })).toBe(3);
    expect(requiredRatio({ text: "Heading", fontSizePx: 18.66, fontWeight: 600 })).toBe(4.5);
  });
  it("keeps 4.5:1 for math symbols, punctuation and empty text", () => {
    // `+`, `×` read as text; and an empty string must not pass as a "glyph" —
    // that was how a node whose text sits in a child would get the lower bar.
    expect(requiredRatio({ ...base, text: "+" })).toBe(4.5);
    expect(requiredRatio({ ...base, text: "×" })).toBe(4.5);
    expect(requiredRatio({ ...base, text: "…" })).toBe(4.5);
    expect(requiredRatio({ ...base, text: "" })).toBe(4.5);
  });
});

describe("assessIncompleteNode", () => {
  const sample = (over: Partial<IncompleteNodeSample> = {}): IncompleteNodeSample => ({
    target: ".x",
    messageKey: "nonBmp",
    text: "▾",
    fg: [118, 118, 118, 1],
    layers: [{ bg: [255, 255, 255, 1], opacity: 1 }],
    fontSizePx: 9,
    fontWeight: 400,
    unresolvable: [],
    coveredBy: null,
    descriptor: '[data-testid="t"] <span> "▾"',
    ...over,
  });

  it("passes a node that measures at or above what it owes", () => {
    expect(assessIncompleteNode("light / s", sample(), undefined)).toMatchObject({
      kind: "measured",
      required: 3,
    });
  });

  it("fails a glyph that measures below 3:1, naming the node and the ratio", () => {
    // The regression #1721 is about: before this gate, a node already in the
    // incomplete bucket could fade to anything and the run stayed green.
    const v = assessIncompleteNode("light / s", sample({ fg: [200, 200, 200, 1] }), undefined);
    expect(v.kind).toBe("failure");
    expect(v.kind === "failure" && v.message).toContain('[data-testid="t"]');
    expect(v.kind === "failure" && v.message).toMatch(/measures 1\.\d+:1, needs 3:1/);
  });

  it("compares the unrounded ratio, so a near miss that rounds up still fails", () => {
    // rgb(118,119,118) on white is 4.496:1 — it displays as 4.5 and owes 4.5.
    const v = assessIncompleteNode(
      "light / s",
      sample({ text: "B", fg: [118, 119, 118, 1] }),
      undefined,
    );
    expect(v.kind).toBe("failure");
    expect(v.kind === "failure" && v.message).toContain("measures 4.49:1, needs 4.5:1");
  });

  it("does not let a `g` flag on a shared waiver RegExp alternate its verdict", () => {
    const waiver = { reason: "behind a modal scrim", expect: /^painted over by <div\.scrim>$/g };
    const s = sample({ unresolvable: ["painted over by <div.scrim>"] });
    expect(assessIncompleteNode("light / s", s, waiver).kind).toBe("waived");
    expect(assessIncompleteNode("dark / s", s, waiver).kind).toBe("waived");
  });

  it("fails CLOSED on an unmeasurable node with no waiver", () => {
    const v = assessIncompleteNode(
      "light / s",
      sample({ unresolvable: ["painted over by <div.scrim>"] }),
      undefined,
    );
    expect(v.kind).toBe("failure");
  });

  it("lets a waiver excuse only an unmeasurable node, never a measured failure", () => {
    const waiver = { reason: "behind a modal scrim", expect: /^painted over by <div\.scrim>$/ };
    expect(
      assessIncompleteNode(
        "light / s",
        sample({ unresolvable: ["painted over by <div.scrim>"] }),
        waiver,
      ).kind,
    ).toBe("waived");
    // A waiver that could excuse a measured failure would BE the gate.
    expect(assessIncompleteNode("light / s", sample({ fg: [200, 200, 200, 1] }), waiver).kind).toBe(
      "failure",
    );
  });

  it("fails a waived node that gains a reason its waiver does not name", () => {
    // A background image added later to a waived node is a new question.
    const waiver = { reason: "behind a modal scrim", expect: /^painted over by <div\.scrim>$/ };
    const v = assessIncompleteNode(
      "light / s",
      sample({ unresolvable: ["painted over by <div.scrim>", "background-image on <div.card>"] }),
      waiver,
    );
    expect(v.kind).toBe("failure");
    expect(v.kind === "failure" && v.message).toContain("background-image on <div.card>");
    expect(v.kind === "failure" && v.message).not.toContain("painted over by");
  });

  it("reports a pixel-proven covered node as covered, not as a pass", () => {
    expect(
      assessIncompleteNode("light / s", sample({ coveredBy: "<div.popover>" }), undefined),
    ).toEqual({ kind: "covered", by: "<div.popover>" });
  });
});

describe("staleWaivers", () => {
  it("names the waivers that excused nothing in this run", () => {
    const waivers = { a: { reason: "r", expect: /x/ }, b: { reason: "r", expect: /x/ } };
    expect(staleWaivers(waivers, new Set(["a"]))).toEqual(["b"]);
    expect(staleWaivers({}, new Set())).toEqual([]);
  });
});

describe("describeVerdict", () => {
  it("renders each verdict kind", () => {
    expect(describeVerdict({ kind: "measured", ratio: 3.36, required: 3 })).toBe("3.36:1 ≥ 3:1");
    expect(describeVerdict({ kind: "covered", by: "<div.p>" })).toBe("covered by <div.p>");
    expect(describeVerdict({ kind: "waived", reason: "r" })).toBe("waived — r");
    expect(describeVerdict({ kind: "failure", message: "m" })).toBe("m");
  });
});

describe("incompleteMessageKey", () => {
  it("reads axe's messageKey from the first check that carries one", () => {
    expect(
      incompleteMessageKey({ any: [{ data: null }, { data: { messageKey: "nonBmp" } }] }),
    ).toBe("nonBmp");
    expect(incompleteMessageKey({ any: [{ data: { fgColor: "#000" } }] })).toBeNull();
  });
});
