import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRulesBySelector, styleBlocks } from "../helpers/css-source";

/**
 * Document headings must inherit the user's editor font from `.tandem-editor`,
 * so no heading rule may name a family: H1/H2 once used the serif
 * `--tandem-h1-font` / `--tandem-h2-font` roles, so choosing Sans left them
 * serif. The positive control keeps a renamed selector from passing over an
 * empty set.
 */

const EDITOR_CSS = join(import.meta.dirname, "..", "..", "src", "client", "editor", "editor.css");

const HEADING_SELECTOR = /^\.tandem-editor h[1-6]$/;

const familyOf = (body: string): string | undefined =>
  body
    .split(";")
    .map((d) => d.trim())
    .find((d) => /^font(-family)?\s*:/.test(d));

describe("editor headings use the user's editor font", () => {
  const headingRules = cssRulesBySelector(styleBlocks(EDITOR_CSS)).filter((r) =>
    r.selectors.some((s) => HEADING_SELECTOR.test(s)),
  );

  it("finds the h1 and h2 rules (positive control)", () => {
    const selectors = headingRules.flatMap((r) => r.selectors);
    expect(selectors).toContain(".tandem-editor h1");
    expect(selectors).toContain(".tandem-editor h2");
  });

  it("no heading rule sets its own font family", () => {
    for (const r of headingRules) {
      expect(familyOf(r.body), r.selectors.join(", ")).toBeUndefined();
    }
  });
});
