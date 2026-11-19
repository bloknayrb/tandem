/**
 * Visible focus and forced colours on the local-model surfaces (#1123,
 * ADR-039 item 27; the brief's A6 and A8). Read from the components' own
 * `<style>` blocks (comments stripped, CRLF normalised), because what is under
 * test is the authored rule: happy-dom computes no `:focus-visible`, no
 * outline and no forced-colours media.
 *
 *  - No `:focus-visible` (or `:focus`) rule on these controls removes the
 *    outline, in any form: focus shown only as a colour is erased by forced
 *    colours.
 *  - The add-model window's close button and fields, and the first-run
 *    window's close button, draw `2px solid var(--tandem-accent)` on
 *    `:focus-visible`.
 *  - The first-run window's refused Save says so in forced colours.
 *  - "Who answers your chat": the checked fill lives in a class (an inline
 *    one would beat the forced-colours rule), the ring is inset, and the
 *    checked radio's ring and fill are restated for forced colours.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CssRule, cssRulesBySelector, styleBlocks } from "../helpers/css-source";

const ROOT = join(import.meta.dirname, "..", "..");
const WINDOW = join(ROOT, "src/client/components/ModelEditModal.svelte");
const PICKER = join(ROOT, "src/client/components/FirstRunModelPickerModal.svelte");
const TAB = join(ROOT, "src/client/components/settings-tabs/SettingsModelsTab.svelte");
const FORCED = "@media (forced-colors: active)";

const rulesOf = (file: string) => cssRulesBySelector(styleBlocks(file).replace(/\r\n/g, "\n"));
const decls = (rule: CssRule) =>
  new Map(
    rule.body
      .split("; ")
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(":");
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()] as const;
      }),
  );
/** Rules whose selector list holds exactly `selector`, inside `atRule` (or none). */
const find = (rules: CssRule[], selector: string, atRule: string | null = null) =>
  rules.filter(
    (r) =>
      r.selectors.includes(selector) &&
      (atRule === null ? r.atRules.length === 0 : r.atRules.includes(atRule)),
  );

/** An outline that removes the ring, in any spelling. */
const KILLS_OUTLINE = (d: Map<string, string>) =>
  /^(none|0|0px)\b/.test(d.get("outline") ?? "x") ||
  d.get("outline-style") === "none" ||
  /^(0|0px)$/.test(d.get("outline-width") ?? "x");

describe("no focus rule removes the outline (A6, A8)", () => {
  for (const file of [WINDOW, PICKER, TAB]) {
    it(file.split("/").pop() as string, () => {
      const focusRules = rulesOf(file).filter((r) => r.selectors.some((s) => /:focus/.test(s)));
      expect(focusRules.length).toBeGreaterThan(0);
      for (const r of focusRules) {
        expect(KILLS_OUTLINE(decls(r)), `${r.selectors.join(", ")} { ${r.body} }`).toBe(false);
      }
    });
  }

  it("no bare rule on the three controls removes it either", () => {
    for (const [file, selector] of [
      [WINDOW, ".mem-close"],
      [WINDOW, ".mem-input"],
      [PICKER, ".frm-close"],
    ] as const) {
      for (const r of rulesOf(file).filter((r) => r.selectors.includes(selector))) {
        expect(KILLS_OUTLINE(decls(r)), `${selector} { ${r.body} }`).toBe(false);
      }
    }
  });
});

describe("A6: the ring on the windows' close buttons and fields", () => {
  for (const [file, selector] of [
    [WINDOW, ".mem-close:focus-visible"],
    [WINDOW, ".mem-input:focus-visible"],
    [PICKER, ".frm-close:focus-visible"],
  ] as const) {
    it(selector, () => {
      const rules = find(rulesOf(file), selector);
      expect(rules).toHaveLength(1);
      const d = decls(rules[0]);
      expect(d.get("outline")).toBe("2px solid var(--tandem-accent)");
      expect(d.get("outline-offset")).toBe("1px");
    });
  }

  it("the first-run window's refused Save is GrayText in forced colours (and only there)", () => {
    const rules = rulesOf(PICKER);
    const forced = find(rules, '.frm-btn-primary[aria-disabled="true"]:not(:disabled)', FORCED);
    expect(forced).toHaveLength(1);
    expect(decls(forced[0]).get("color")).toBe("GrayText");
    expect(decls(forced[0]).get("border")).toBe("1px solid GrayText");
  });
});

describe('A8: "Who answers your chat" shows state and focus by more than colour', () => {
  const rules = rulesOf(TAB);
  const one = (selector: string, atRule: string | null = null) => {
    const found = find(rules, selector, atRule);
    expect(found, `${atRule ?? ""} ${selector}`).toHaveLength(1);
    return decls(found[0]);
  };

  it("the checked fill is the class's, outside forced colours", () => {
    const d = one('.answerer-radio[aria-checked="true"]');
    expect(d.get("background")).toBe("var(--tandem-accent)");
    expect(d.get("color")).toBe("var(--tandem-accent-fg)");
  });

  it("the ring is inset (a negative offset), so the group's overflow cannot clip it", () => {
    const d = one(".answerer-radio:focus-visible");
    expect(d.get("outline")).toBe("2px solid var(--tandem-accent)");
    expect(d.get("outline-offset")).toMatch(/^-\d/);
  });

  it("the checked radio's ring takes its text colour (accent on accent is 1:1)", () => {
    expect(one('.answerer-radio[aria-checked="true"]:focus-visible').get("outline-color")).toBe(
      "var(--tandem-accent-fg)",
    );
  });

  it("in forced colours the checked radio is Highlight / HighlightText, and its ring HighlightText", () => {
    const d = one('.answerer-radio[aria-checked="true"]', FORCED);
    expect(d.get("forced-color-adjust")).toBe("none");
    expect(d.get("background")).toBe("Highlight");
    expect(d.get("color")).toBe("HighlightText");
    expect(
      one('.answerer-radio[aria-checked="true"]:focus-visible', FORCED).get("outline-color"),
    ).toBe("HighlightText");
  });

  it("no radio's inline style sets a background or a colour (it would beat the forced-colours rule)", () => {
    const whole = readFileSync(TAB, "utf-8").replace(/\r\n/g, "\n");
    const src = whole.slice(whole.indexOf("</script>")); // the markup
    // From the radio's role to its label: the tag holds `=>` arrows, so a
    // `[^>]*` scan would stop inside it and see no style at all.
    const start = src.indexOf('role="radio"');
    expect(src.indexOf('role="radio"', start + 1)).toBe(-1); // the {#each} renders both
    const tag = src.slice(start, src.indexOf("{label}", start));
    expect(tag).toContain('class="answerer-radio"');
    const style = /\bstyle="([^"]*)"/.exec(tag)?.[1];
    expect(style, "the radio's inline style").toBeTruthy();
    expect(style).not.toMatch(/(^|[;\s])background\s*:/);
    expect(style).not.toMatch(/(^|[;\s])color\s*:/);
    expect(style).toMatch(/cursor:/); // read the real attribute, not an empty one
  });
});
