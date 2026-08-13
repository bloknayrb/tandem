import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { styleBlocks } from "../helpers/css-source";

/**
 * Regression guard for #1396 — the rail drag strip overhung the visible rail.
 *
 * The mechanic (flex `stretch` + margins) is documented on the shared
 * `.rail-shell, .rail-resize-handle` rule in App.svelte; this file pins the
 * shape of that fix rather than re-explaining it.
 *
 * What it pins, and why each half matters:
 *
 *  - The clearance is declared ONCE per token, in a rule listing BOTH classes,
 *    so "shared" is proven rather than asserted. Counting *declarations* rather
 *    than token mentions leaves the explanatory comments alone and leaves room
 *    for a legitimate third consumer joining the same rule.
 *  - The strip carries no inline geometry. This is the more valuable half: an
 *    inline `style` attribute is structurally unreachable by any stylesheet
 *    rule, which is why the strip could not be covered by its neighbour's
 *    clearance policy and why its colour crossfade sat unguarded by both
 *    reduce-motion rules. One cause, two bugs.
 *
 * The rendered geometry lives in tests/e2e/rail-resize-handle.spec.ts, and that
 * spec states the actual invariant ("the strip's edges coincide with its
 * rail's") in a structure-independent way. This file is the fast source-level
 * half: it fails in `npm test`, with no browser.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const APP_SVELTE = join(ROOT, "src", "client", "App.svelte");

const SHARED_SELECTORS = [".rail-shell", ".rail-resize-handle"];

describe("#1396 rail clearance is declared once and shared", () => {
  // Flat rule scan. `[^{}]*` bodies naturally skip an at-rule wrapper and match
  // the inner rule, so a declaration moved inside `@media` is still found.
  const rules = [...styleBlocks(APP_SVELTE).matchAll(/([^{}]+)\{([^{}]*)\}/g)];

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
      const declaring = rules.filter((r) => re.test(r[2]));
      expect(declaring).toHaveLength(1);

      const selectors = declaring[0][1].split(",").map((s) => s.trim());
      // Exact entries, not `includes`: a partial or prose match must not pass.
      expect(selectors).toEqual(expect.arrayContaining(SHARED_SELECTORS));
    });
  }
});

describe("#1396 the drag strip carries no inline geometry", () => {
  const src = readFileSync(APP_SVELTE, "utf-8");
  const start = src.indexOf("{#snippet resizeHandle");
  const end = src.indexOf("{/snippet}", start);
  const snippet = src.slice(start, end);

  it("styles the handle through a class, not an inline style attribute", () => {
    expect(start).toBeGreaterThan(-1);
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
