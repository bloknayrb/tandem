import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRulesBySelector, styleBlocks } from "../helpers/css-source.js";

/**
 * `markdown-body.css` carried two band-aids for #1639's unbalanced block markup,
 * and both are now gone. Nothing else reads this file.
 *
 * Without this suite the "the band-aids are gone and `> :first-child` is present
 * and correct" gate was satisfied by reading the diff, so a later edit could
 * re-add one silently — and neither of the other two gates can see it. happy-dom
 * has no layout, and the E2E rail-fit gate measures `scrollWidth > clientWidth`,
 * which is right-side overflow only: a list marker clipped on the LEFT by the
 * clamped card's `overflow: clip` is invisible to both.
 *
 * `styleBlocks` strips comments, so prose describing a deleted rule cannot
 * satisfy or trip any scan below.
 */
const CSS_PATH = join(__dirname, "../../src/client/panels/markdown-body.css");
const RULES = cssRulesBySelector(styleBlocks(CSS_PATH));

function rulesFor(selector: string) {
  return RULES.filter((rule) => rule.selectors.includes(selector));
}

describe("markdown-body.css — the #1639 band-aids are gone and the real rules are present", () => {
  it("has no `p:empty` rule", () => {
    // The stray empty paragraph this hid came from the `</p><p>` pair straddling
    // a fenced block's placeholder. Balanced assembly emits no empty `<p>` at
    // all, so a re-added rule would be hiding a defect rather than a symptom.
    for (const rule of RULES) {
      expect(rule.selectors).not.toContain(".tandem-markdown p:empty");
    }
  });

  it("declares `> :first-child { margin-top: 0 }` exactly once", () => {
    // The rule the old comment forbade, because it selected paragraph TWO while
    // paragraph one was a bare text node.
    const first = rulesFor(".tandem-markdown > :first-child");

    expect(first).toHaveLength(1);
    expect(first[0]?.body).toMatch(/(?:^|[;\s])margin-top:\s*0(?:[;\s]|$)/);
  });

  it("indents the list from the `ul`, by value", () => {
    // Pinned BY VALUE deliberately. A value-free "declares padding-inline-start"
    // check passes on `padding-inline-start: 0` — precisely the state this rule
    // exists to prevent, because `index.html`'s verbatim `* { padding: 0 }`
    // means a `<ul>` takes no UA indent and `list-style: disc` then paints its
    // markers outside the content box. Nothing else in the repo can see that.
    const ul = rulesFor(".tandem-markdown ul");

    expect(ul).toHaveLength(1);
    expect(ul[0]?.body).toMatch(/(?:^|[;\s])padding-inline-start:\s*1\.25em(?:[;\s]|$)/);
  });

  it("does not also indent the `li`, which would double it", () => {
    const li = rulesFor(".tandem-markdown li");

    expect(li).toHaveLength(1);
    expect(li[0]?.body).not.toMatch(/(?:^|[;\s])margin-left:/);
  });
});
