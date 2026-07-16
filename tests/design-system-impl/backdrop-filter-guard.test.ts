import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * backdrop-filter regression gate.
 *
 * The selection popup shipped a stray frosted-glass rectangle for two months,
 * visible ONLY in production builds. Two facts combined to cause it:
 *
 *  1. `.tandem-floating-pill` (index.html) carried `backdrop-filter: blur(8px)`.
 *     Every consumer of that recipe has an opaque `--tandem-surface` background
 *     that hides the blur — except the selection-popup SHELL, which is
 *     deliberately transparent (the A8 two-pill design). There the blur painted
 *     across the shell's whole box, including the dead space beside the
 *     narrower Annotate capsule.
 *  2. The shell's scoped `backdrop-filter: none` reset, which was supposed to
 *     cancel it, did not survive minification. lightningcss (Vite's default CSS
 *     minifier) collapses a `backdrop-filter` + `-webkit-backdrop-filter` pair
 *     into the `-webkit-` form ALONE — it does this regardless of configured
 *     browser targets, and for any value, not just `none`. Chromium does not
 *     treat `-webkit-backdrop-filter` as an alias of the standard property, so
 *     the surviving declaration is inert there and the reset evaporated.
 *     That minifier hazard is tracked in #1188.
 *
 * Dev never reproduced it: unminified CSS keeps the reset, so the popup looked
 * correct in `npm run dev` and broke only in the packaged app.
 *
 * These two gates are source-level (no build required, so they stay fast):
 * one pins the specific regression, the other forbids the fragile pattern.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf-8");
const CLIENT_ROOT = join(ROOT, "src", "client");

/** Strip CSS block comments so commented-out prose can't trip the greps. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Body of the first `.tandem-floating-pill { ... }` block in index.html. */
function floatingPillBlock(): string {
  const m = INDEX_HTML.match(/\.tandem-floating-pill\s*\{([\s\S]*?)\n\s*\}/m);
  if (!m) throw new Error(".tandem-floating-pill block not found in index.html");
  return stripCssComments(m[1]);
}

describe(".tandem-floating-pill declares no backdrop-filter", () => {
  it("carries neither the standard nor the -webkit- property", () => {
    // The recipe reaches one transparent consumer (the selection-popup shell),
    // so a blur here is a visible bug there — and it buys nothing on the opaque
    // consumers, whose --tandem-surface background occludes it entirely.
    expect(floatingPillBlock()).not.toMatch(/backdrop-filter\s*:/);
  });

  it("still carries the chrome the recipe exists to provide", () => {
    // Guards against the gate above being "passed" by deleting the whole rule.
    const block = floatingPillBlock();
    expect(block).toMatch(/background\s*:/);
    expect(block).toMatch(/border\s*:/);
    expect(block).toMatch(/box-shadow\s*:/);
  });
});

/** Every file whose CSS is processed by Vite's minifier. */
function bundledCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) bundledCssFiles(full, out);
    else if (full.endsWith(".svelte") || full.endsWith(".css")) out.push(full);
  }
  return out;
}

/**
 * Only `<style>` blocks go through the minifier. An inline `style="..."`
 * attribute is emitted verbatim, so it is exempt (CommandPalette's palette
 * scrim legitimately blurs a translucent backdrop that way).
 */
function styleBlocks(file: string): string {
  const src = readFileSync(file, "utf-8");
  if (file.endsWith(".css")) return stripCssComments(src);
  return stripCssComments(
    [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n"),
  );
}

describe("no bundled CSS relies on a prefixed backdrop-filter pair", () => {
  it("declares no -webkit-backdrop-filter in any <style> block", () => {
    // lightningcss collapses `backdrop-filter` + `-webkit-backdrop-filter` to
    // the -webkit- form alone, which Chromium ignores. So in minifier-processed
    // CSS the prefixed twin is never a safe companion — it silently converts
    // the pair into a declaration that does nothing on our primary target
    // (WebView2/Chromium). Write the standard property alone, or nothing.
    const offenders = bundledCssFiles(CLIENT_ROOT)
      .filter((f) => /-webkit-backdrop-filter\s*:/.test(styleBlocks(f)))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
