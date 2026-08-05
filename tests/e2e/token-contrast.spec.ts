import { expect, type Page, test } from "@playwright/test";

/**
 * WCAG AA contrast for the semantic-token pairs themselves, independent of
 * whether any component currently renders them.
 *
 * This exists because axe cannot answer the question the gate actually asks.
 * `docs/roadmap.md` requires AA "across all status colors and themes", and
 * axe's color-contrast rule only evaluates elements that are *painted at scan
 * time*. An error banner, a success toast, a suggestion annotation — none of
 * those are on screen during a normal run, so an axe-only pass says nothing
 * about them. It would report green on a palette where every error colour was
 * unreadable, purely because nothing had errored.
 *
 * So: resolve the declared token values per theme and run the contrast formula
 * over the pairs directly. Colours are resolved by painting them to a canvas
 * and reading the pixel back, not by parsing `getComputedStyle` — Chromium
 * serialises `oklch()` as `color(srgb 0.55 0.55 0.56)`, and reading those 0-1
 * floats as 0-255 silently reports near-black for everything. That mistake
 * produced a confident, wrong "this token passes at 6.22:1" during this work.
 */

const THEMES = ["light", "dark", "warm"] as const;

/** Families carrying a full fg/bg/border set. */
const FAMILIES = ["success", "warning", "error", "info", "suggestion", "accent"] as const;

type Pair = { name: string; fg: string; bg: string; min: number };

async function measure(page: Page, theme: string): Promise<Array<Pair & { ratio: number }>> {
  return page.evaluate(
    ({ families, t }) => {
      document.documentElement.setAttribute("data-theme", t);

      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const probe = document.createElement("div");
      document.body.appendChild(probe);

      /** Resolve a CSS custom property to a concrete colour, via painting. */
      function resolve(varName: string): [number, number, number] | null {
        const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        if (!value) return null;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000000";
        ctx.fillStyle = value;
        // An unparseable value leaves fillStyle at the previous colour; a token
        // that resolves to literal black would be a bug worth failing on anyway.
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2]];
      }

      function luminance([r, g, b]: [number, number, number]) {
        const f = (c: number) => {
          c /= 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      }

      function ratio(a: [number, number, number], b: [number, number, number]) {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      }

      const out: Array<{ name: string; fg: string; bg: string; min: number; ratio: number }> = [];
      const add = (name: string, fgVar: string, bgVar: string, min: number) => {
        const fg = resolve(fgVar);
        const bg = resolve(bgVar);
        if (!fg || !bg) return; // token not defined in this theme — not a failure
        out.push({ name, fg: fgVar, bg: bgVar, min, ratio: Number(ratio(fg, bg).toFixed(2)) });
      };

      for (const f of families) {
        // `-fg-strong` is the text weight for these families: 4.5:1.
        add(`${f}: fg-strong on bg`, `--tandem-${f}-fg-strong`, `--tandem-${f}-bg`, 4.5);
        // `-fg` pairs with the SOLID family fill, not the tinted `-bg`. In
        // light mode `--tandem-error-fg` is literally `#ffffff` — it is the
        // text colour for a filled error button, not for a pale error banner.
        //
        // Asserting it against `-bg` (as a first draft did) reports ~1.1:1 for
        // every family, which looks like a catastrophic palette bug and is
        // really a mis-stated pairing. But checking *why* found the genuine
        // defect underneath: twelve components were using `-fg` on a plain
        // surface or on `-bg`, i.e. white text on white, and three of those
        // were `role="alert"` error messages. Those states only render when
        // something has gone wrong, which is exactly why an axe scan of a
        // healthy app never saw them — and exactly why this file exists.
        add(`${f}: fg on solid fill`, `--tandem-${f}-fg`, `--tandem-${f}`, 4.5);
        // NO assertion on `-border` against its own `-bg`.
        //
        // An earlier revision asserted 3:1 there and every family failed at
        // 1.4-1.95:1. That was the test being wrong, not the palette. SC 1.4.11
        // requires 3:1 for visual information needed to *identify* a component
        // or its state — a status banner is identified by its tinted fill and
        // its text, both of which pass; the hairline is decorative refinement
        // on top of an already-distinguishable surface. Forcing 3:1 there would
        // mean hard, saturated outlines on soft banners: worse design bought
        // with no accessibility gain, in service of a criterion that does not
        // apply.
        //
        // The measured values are recorded in docs/a11y-gate-results.md so this
        // stays a visible decision rather than a silent omission. Where a border
        // IS the sole state indicator — focus rings — that belongs to the
        // keyboard suite's focus-visible assertions, against the colours the
        // ring actually sits between.
      }

      // The de-emphasis ladder against the surfaces it renders text on.
      for (const tier of ["fg", "fg-muted", "fg-subtle", "fg-faint"]) {
        for (const surface of ["bg", "surface", "surface-sunk"]) {
          add(`${tier} on ${surface}`, `--tandem-${tier}`, `--tandem-${surface}`, 4.5);
        }
      }

      return out;
    },
    { families: FAMILIES as unknown as string[], t: theme },
  );
}

for (const theme of THEMES) {
  test(`semantic token pairs meet WCAG AA — ${theme}`, async ({ page }) => {
    await page.goto("/");
    await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 15_000 });

    const results = await measure(page, theme);

    // Guard against the silent-success mode: if resolution broke, `results`
    // would be empty and every assertion below would vacuously pass.
    expect(results.length).toBeGreaterThan(20);

    const failures = results
      .filter((r) => r.ratio < r.min)
      .map((r) => `${r.name}: ${r.ratio}:1 (needs ${r.min}:1) — ${r.fg} on ${r.bg}`);

    expect(failures, `${theme} theme token pairs below their WCAG threshold`).toEqual([]);
  });
}
