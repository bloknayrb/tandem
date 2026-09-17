import { describe, expect, it } from "vitest";
import { checkIncompleteBaseline, colorContrastNodeCount } from "../e2e/axe-incomplete.js";

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
