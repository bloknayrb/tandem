import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for #1396 — the rail drag strip overhung the visible rail.
 *
 * The strip (`{#snippet resizeHandle}` in App.svelte) is a flex SIBLING of
 * `.rail-shell` inside the editor row, which has no `align-items` and therefore
 * stretches every child. Under `stretch`, an item's margins inset its stretched
 * cross size — so while only the shell carried `--tandem-rail-top-clearance` /
 * `--tandem-status-clearance-total`, the strip stretched the full row height and
 * its hover tint painted 52px above and 52-68px below the rail it resizes.
 *
 * The fix is a SHARED declaration, not a copied one, and that is what this file
 * pins. The bottom inset rides `--tandem-space-5`, so it computes to 52/60/68px
 * across compact/cozy/spacious — a second declaration (even a correct-looking
 * one) desyncs the two siblings the moment either token moves. Hence:
 *
 *  - exactly ONE declaration site per token (not one *mention*: counting token
 *    names would forbid the explanatory comments this fix is required to carry,
 *    and index.html:280 shows in-repo how naturally a comment names a token);
 *  - and each declaration's rule must list BOTH classes, so "shared" is proven
 *    rather than asserted. Counting declarations rather than selectors also
 *    leaves room for a legitimate third consumer joining the same rule.
 *
 * Comment spans are stripped BEFORE any analysis. Without that, the selector
 * walk-back would sweep up the comment block sitting between `.banner-stack`'s
 * closing brace and the rule under test — so prose could satisfy the check while
 * the bug was reintroduced. `maskComments` in scripts/check-semantic-tokens.ts
 * does the same job but is not exported; widening that script's public API for
 * one test is not worth it, and inside a `<style>` block `/* … *\/` is the only
 * comment form, so the local four-line strip is sufficient.
 *
 * The rendered geometry (computed margins + box edges matching the shell's) is
 * covered by tests/e2e/rail-resize-handle.spec.ts. This file is the source-level
 * half: it fails in `npm test`, with no browser, if the shape that caused #1396
 * — geometry inlined onto the element — comes back.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const APP_SVELTE = join(ROOT, "src", "client", "App.svelte");

const SHARED_SELECTORS = [".rail-shell", ".rail-resize-handle"] as const;

const src = readFileSync(APP_SVELTE, "utf-8");

/** Strip CSS block comments so commented-out prose can't satisfy or trip a grep. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The component's `<style>` blocks, comments removed. */
function styleBlock(): string {
  const blocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  if (blocks.length === 0) throw new Error("App.svelte has no <style> block");
  return stripCssComments(blocks.join("\n"));
}

/**
 * The selector list of the rule containing `index`, as trimmed entries.
 *
 * Brace scanner, not a CSS parser: the opening brace of the enclosing rule is
 * the last `{` before the declaration, and the selector runs back to whichever
 * comes later — the previous rule's `}` or an enclosing at-rule's `{`.
 */
function enclosingSelectors(css: string, index: number): string[] {
  const open = css.lastIndexOf("{", index);
  expect(open, "declaration should sit inside a rule").toBeGreaterThan(-1);
  const start = Math.max(css.lastIndexOf("}", open), css.lastIndexOf("{", open - 1)) + 1;
  return css
    .slice(start, open)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchIndices(css: string, re: RegExp): number[] {
  return [...css.matchAll(re)].map((m) => m.index as number);
}

describe("#1396 rail clearance is declared once and shared", () => {
  const css = styleBlock();

  const cases: Array<{ token: string; re: RegExp }> = [
    { token: "--tandem-rail-top-clearance", re: /margin-top:\s*var\(--tandem-rail-top-clearance/g },
    {
      token: "--tandem-status-clearance-total",
      re: /margin-bottom:\s*var\(--tandem-status-clearance-total/g,
    },
  ];

  for (const { token, re } of cases) {
    it(`declares ${token} exactly once in App.svelte's stylesheet`, () => {
      expect(matchIndices(css, re)).toHaveLength(1);
    });

    it(`shares the ${token} declaration between the rail shell and the drag strip`, () => {
      const [index] = matchIndices(css, re);
      expect(index, `no declaration of ${token} found`).toBeDefined();
      const selectors = enclosingSelectors(css, index);
      for (const selector of SHARED_SELECTORS) {
        // Exact entry, not `includes`: a partial or prose match must not pass.
        expect(selectors).toContain(selector);
      }
    });
  }
});

describe("#1396 the drag strip carries no inline geometry", () => {
  const start = src.indexOf("{#snippet resizeHandle");
  const end = src.indexOf("{/snippet}", start);
  const snippet = src.slice(start, end);

  it("locates the resizeHandle snippet", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("styles the handle through a class, not an inline style attribute", () => {
    expect(snippet).toContain('class="rail-resize-handle"');
    // An inline `style` is exactly where the missing margins would end up as a
    // second, silently desyncing copy of the clearance policy.
    expect(snippet).not.toContain("style=");
  });

  it("paints the hover tint in CSS, not from inline JS handlers", () => {
    expect(snippet).not.toContain("onmouseenter");
    expect(snippet).not.toContain("onmouseleave");
  });
});
