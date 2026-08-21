import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRulesBySelector, styleBlocks } from "../helpers/css-source";

/**
 * The Claude focus decoration must OUT-SPECIFY the editor's own block styling.
 *
 * `buildAwarenessDecorations` walks `doc.forEach`, which yields TOP-LEVEL nodes —
 * blockquotes, lists and code blocks as readily as paragraphs — and attaches
 * `.tandem-claude-focus` to whichever one Claude is looking at. So the focus
 * rule competes with `editor.css`'s own element rules for the same properties:
 * `.tandem-editor blockquote` declares `border-left` and `padding`, and
 * `.tandem-editor ul, .tandem-editor ol` declare `padding-left`. Both are
 * (0,1,1).
 *
 * #1530 moved the focus tint, rail and indent off an inline `style` on the
 * decoration spec and into this stylesheet. An inline `style` wins
 * unconditionally; a class does not. A bare `.tandem-claude-focus` is (0,1,0),
 * so on a focused blockquote the coral rail was replaced by the grey quote rail
 * and the 8px indent by `1em`, and on a focused list the indent was lost — while
 * the background tint and the `::before` gutter rail kept rendering, which is
 * why it degraded quietly enough to ship.
 *
 * This file is the source-level gate: it recomputes specificity from the
 * authored selectors rather than trusting a prefix string, and it DERIVES the
 * competitors from the file instead of listing them, so a new element rule that
 * out-specifies the focus rule reds here rather than silently winning in a
 * browser. A positive-control assertion pins that the derivation actually found
 * the blockquote and list rules — a specificity check over an empty competitor
 * set passes vacuously.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const EDITOR_CSS = join(ROOT, "src", "client", "editor", "editor.css");

const FOCUS_CLASS = "tandem-claude-focus";

/**
 * Block-level element names a ProseMirror TOP-LEVEL node can render as, and so
 * the element selectors the focus decoration can find itself competing with.
 * `p` is here for completeness; the bugs were on `blockquote`, `ul` and `ol`.
 */
const TOP_LEVEL_TAGS = [
  "p",
  "blockquote",
  "ul",
  "ol",
  "pre",
  "table",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
];

/**
 * Longhands the focus rule declares, mapped to every property that can override
 * them. The shorthand entries are the load-bearing half: `.tandem-editor
 * blockquote`'s conflict with `padding-left` is written as `padding`, and a
 * longhand-only comparison would report no competitor at all.
 */
const CONFLICTS: Record<string, string[]> = {
  background: ["background", "background-color"],
  "border-left": [
    "border-left",
    "border",
    "border-left-width",
    "border-left-color",
    "border-left-style",
  ],
  "padding-left": ["padding-left", "padding", "padding-inline", "padding-inline-start"],
};

/** `a: b; c: d` -> `["a", "c"]`. `body` is authored text, not normalized. */
const declaredProps = (body: string): string[] =>
  body
    .split(";")
    .map((decl) => decl.split(":")[0]?.trim().toLowerCase() ?? "")
    .filter(Boolean);

/**
 * CSS specificity as a single comparable number, `ids*10000 + classes*100 +
 * types`. Adequate for this file's selectors, which use no `:is()`/`:where()`
 * and no `:not()` — if one appears, this needs the real algorithm rather than a
 * larger regex.
 */
function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const pseudoElements = selector.match(/::[a-zA-Z-]+/g) ?? [];
  const rest = selector.replace(/::[a-zA-Z-]+/g, " ");
  const classes =
    (rest.match(/\.[\w-]+/g) ?? []).length +
    (rest.match(/\[[^\]]*\]/g) ?? []).length +
    (rest.match(/:[a-zA-Z-]+(?:\([^)]*\))?/g) ?? []).length;
  const types =
    (
      rest
        .replace(/\.[\w-]+|\[[^\]]*\]|:[a-zA-Z-]+(?:\([^)]*\))?/g, " ")
        .match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/g) ?? []
    ).length + pseudoElements.length;
  return ids * 10000 + classes * 100 + types;
}

const css = styleBlocks(EDITOR_CSS);
const rules = cssRulesBySelector(css);

/** The focus rule proper — the one declaring the tint/rail/indent, not `::before`. */
const focusRules = rules.filter(
  (rule) =>
    // The `::before` rail and the two reduced-motion guards carry the class
    // too; only this rule declares properties that can be out-specified.
    rule.fullSelectors.some((sel) => sel.includes(FOCUS_CLASS) && !sel.includes("::")) &&
    declaredProps(rule.body).some((prop) => prop in CONFLICTS),
);

describe("`.tandem-claude-focus` out-specifies the editor's own block rules", () => {
  it("declares the tint, rail and indent in exactly one rule", () => {
    expect(focusRules.map((r) => r.fullSelectors.join(", "))).toHaveLength(1);
  });

  const focus = focusRules[0];

  it("declares each property this test knows how to compare", () => {
    // Sanity anchor: if the rule stops declaring these, the comparison below is
    // asking about properties nobody sets and would pass on nothing.
    expect(
      declaredProps(focus.body)
        .filter((p) => p in CONFLICTS)
        .sort(),
    ).toEqual(["background", "border-left", "padding-left"]);
  });

  /**
   * Every OTHER rule in the file that (a) can match a top-level block inside
   * the editor and (b) declares something that would override one of the focus
   * rule's properties.
   */
  const competitors = rules.filter((rule) => {
    if (rule === focus) return false;
    const props = declaredProps(rule.body);
    const conflicts = Object.entries(CONFLICTS).filter(
      ([own, overriders]) =>
        declaredProps(focus.body).includes(own) && props.some((p) => overriders.includes(p)),
    );
    if (conflicts.length === 0) return false;
    return rule.fullSelectors.some((sel) => {
      if (sel.includes("::")) return false;
      const last =
        sel
          .trim()
          .split(/[\s>]+/)
          .pop() ?? "";
      return TOP_LEVEL_TAGS.includes(last.toLowerCase());
    });
  });

  it("finds the blockquote and list rules that caused #1530's regression", () => {
    // Positive control. An empty competitor set satisfies the check below
    // vacuously, so the derivation must be shown to have found the two rules the
    // bug was actually about before its verdict means anything.
    const found = competitors.flatMap((r) => r.fullSelectors);
    expect(found).toContain(".tandem-editor blockquote");
    expect(found).toContain(".tandem-editor ul");
    expect(found).toContain(".tandem-editor ol");
  });

  it.each(
    competitors.flatMap((rule) => rule.fullSelectors.map((sel) => [sel, rule] as const)),
  )("beats `%s`", (sel, rule) => {
    const focusMin = Math.min(...focus.fullSelectors.map(specificity));
    expect(
      focusMin,
      `\`${focus.fullSelectors.join(", ")}\` (${focusMin}) must out-specify \`${sel}\` ` +
        `(${specificity(sel)}), which declares \`${rule.body}\`. The focus decoration lands on ` +
        "TOP-LEVEL nodes, so it sits on blockquotes and lists too, and CSS resolves this by " +
        "specificity — source order never enters into it. Raise the focus selector (another " +
        "ancestor class), do not reach for `!important` or move the values back inline.",
    ).toBeGreaterThan(specificity(sel));
  });
});
