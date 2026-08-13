import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRulesBySelector, styleBlocks } from "../helpers/css-source";

/**
 * Regression guard for #1396 — the rail drag strip overhung the visible rail.
 *
 * The mechanic (the editor row sets no `align-items`, so it stretches its
 * children, and under stretch an item's margins inset its stretched cross size)
 * is documented on the shared `.rail-shell, .rail-resize-handle` rule in
 * App.svelte; this file pins the shape of that fix rather than re-explaining it.
 *
 * What it pins, and why each half matters:
 *
 *  - The clearance is declared ONCE per token, in a rule listing BOTH classes,
 *    and the strip gets no margin of its own anywhere else — including as a
 *    hardcoded literal, which is the copy a `var()`-shaped check would miss and
 *    the one a human is most likely to write.
 *  - The strip carries no inline geometry. This is the more valuable half: an
 *    inline `style` attribute is structurally unreachable by any stylesheet
 *    rule, which is why the strip could not be covered by its neighbour's
 *    clearance policy and why its colour crossfade sat unguarded by both
 *    reduce-motion rules. One cause, two bugs.
 *  - The hover tint and focus ring EXIST. Both are stylesheet rules that were
 *    ported from (or added alongside) inline JS handlers, and asserting only the
 *    handlers' absence would let the port be deleted with both suites green.
 *
 * The rendered geometry lives in tests/e2e/rail-resize-handle.spec.ts, and that
 * spec states the actual invariant ("the strip's edges coincide with its
 * rail's") in a structure-independent way. This file is the fast source-level
 * half: it fails in `npm test`, with no browser.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const APP_SVELTE = join(ROOT, "src", "client", "App.svelte");

const SHELL = ".rail-shell";
const STRIP = ".rail-resize-handle";

const css = styleBlocks(APP_SVELTE);
const rules = cssRulesBySelector(css);

describe("#1396 rail clearance is declared once and shared", () => {
  const cases = [
    { token: "--tandem-rail-top-clearance", re: /margin-top:\s*var\(--tandem-rail-top-clearance/ },
    {
      token: "--tandem-status-clearance-total",
      re: /margin-bottom:\s*var\(--tandem-status-clearance-total/,
    },
  ];

  for (const { token, re } of cases) {
    // If a structural fix ever moves this clearance onto a wrapper element,
    // this assertion is SUPERSEDED, not violated — delete the block rather than
    // re-satisfying it. The geometry invariant lives in the E2E spec.
    it(`declares ${token} once in App.svelte, shared by the shell and the strip`, () => {
      const declaring = rules.filter((r) => re.test(r.body));
      expect(declaring).toHaveLength(1);
      // Exact entries, not `includes`: a partial or prose match must not pass.
      expect(declaring[0].selectors).toEqual(expect.arrayContaining([SHELL, STRIP]));
    });
  }

  // The above counts `var()` declarations, so a hardcoded copy — `margin-bottom:
  // 60px` on the strip alone — slips past it AND past the E2E spec, which runs
  // at the cozy density where the token also resolves to 60. It would overhang
  // by 8px at compact and spacious: the original bug, at two densities of three.
  it("gives the strip no vertical margin outside the shared rule", () => {
    const offenders = rules.filter(
      (r) =>
        r.selectors.some((s) => s.startsWith(STRIP)) &&
        !r.selectors.includes(SHELL) &&
        /margin(-top|-bottom)?:/.test(r.body),
    );
    expect(offenders.map((o) => o.selectors.join(", "))).toEqual([]);
  });
});

describe("#1396 the strip's chrome lives in the stylesheet", () => {
  const src = readFileSync(APP_SVELTE, "utf-8");
  const start = src.indexOf("{#snippet resizeHandle");
  const end = src.indexOf("{/snippet}", start);

  // Guarded in its own test AND asserted before every slice-dependent one: a
  // missing anchor yields start === -1, and `slice(-1, …)` returns "" — on which
  // every `not.toContain` passes vacuously.
  it("locates the resizeHandle snippet", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("styles the handle through a class, not an inline style attribute", () => {
    expect(start).toBeGreaterThan(-1);
    const snippet = src.slice(start, end);
    expect(snippet).toContain('class="rail-resize-handle"');
    // An inline `style` is exactly where the missing margins would end up as a
    // second, silently desyncing copy of the clearance policy.
    expect(snippet).not.toContain("style=");
  });

  it("paints the hover tint in CSS, not from inline JS handlers", () => {
    expect(start).toBeGreaterThan(-1);
    const snippet = src.slice(start, end);
    expect(snippet).not.toContain("onmouseenter");
    expect(snippet).not.toContain("onmouseleave");

    // …and the CSS the handlers were replaced by actually exists. Without this,
    // deleting the rule leaves a 4px transparent strip with no affordance and
    // every suite green.
    const hover = rules.find((r) => r.selectors.includes(`${STRIP}:hover`));
    expect(hover?.body).toMatch(/background:/);
  });

  // Not a port — the strip previously relied on the UA ring. Pinned because it
  // is keyboard-operable (role="slider", tabindex="0", arrow/Home/End handlers).
  it("gives the keyboard-operable strip a focus indicator", () => {
    const focus = rules.find((r) => r.selectors.includes(`${STRIP}:focus-visible`));
    expect(focus?.body).toMatch(/background:/);
  });
});
