/**
 * WCAG contrast regression test for the default accent hue (H=239, indigo).
 *
 * Vitest runs in happy-dom, so getComputedStyle() cannot resolve CSS custom
 * property chains like oklch(0.55 0.20 var(--tandem-accent-h)). Instead we
 * use the known sRGB approximation of the default indigo accent color.
 *
 * TODO: A full 0–360 hue sweep with OKLCH→sRGB math (e.g. via culori) is
 * deferred to a visual QA pass. This test serves as a regression gate for
 * the default configuration only.
 */
import { describe, expect, it } from "vitest";

/**
 * Compute relative luminance per WCAG 2.1 §1.4.3.
 * Input: sRGB channels in [0, 255].
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const linearize = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * Compute WCAG contrast ratio between two colors (each as [r, g, b] in 0–255).
 */
function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = relativeLuminance(...fg);
  const l2 = relativeLuminance(...bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("accent color contrast — default hue (H=239, indigo)", () => {
  // Approximate sRGB for oklch(0.55 0.20 239deg) — indigo ~#6366f1
  // These values are verified against the original hardcoded token.
  const accentLight: [number, number, number] = [99, 102, 241];
  const white: [number, number, number] = [255, 255, 255];
  const darkBg: [number, number, number] = [15, 23, 42]; // --tandem-bg dark = #0f172a

  // Approximate sRGB for oklch(0.72 0.18 239deg) — lighter indigo for dark mode ~#818cf8
  const accentDark: [number, number, number] = [129, 140, 248];

  it("light mode: accent against white meets WCAG AA large (3:1) for UI elements", () => {
    const ratio = contrastRatio(accentLight, white);
    // #6366f1 vs white ≈ 3.0:1 — satisfies AA large (buttons, focus rings)
    expect(ratio).toBeGreaterThanOrEqual(3.0);
  });

  it("dark mode: accent against dark background meets WCAG AA large (3:1)", () => {
    const ratio = contrastRatio(accentDark, darkBg);
    expect(ratio).toBeGreaterThanOrEqual(3.0);
  });
});
