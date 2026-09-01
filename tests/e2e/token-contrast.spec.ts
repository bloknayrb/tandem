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

/** De-emphasis ladder rungs, darkest to lightest. */
const TIERS = ["fg", "fg-muted", "fg-subtle", "fg-faint"];

/**
 * Every surface token the ladder can render text on — neutrals AND tints. The
 * tinted half is the part that matters: see the loop below.
 */
const SURFACES = [
  "bg",
  "surface",
  "surface-muted",
  "surface-sunk",
  "accent-bg",
  "author-user-bg",
  "author-claude-bg",
  // Currently `var(--tandem-surface-muted)`, already swept two entries up, so
  // this adds no new number today. It is here because the alias is the thing
  // that could change: give imports their own tint and the sweep must follow
  // without anyone remembering to come back. An unswept pair is
  // indistinguishable from a passing one, which is the whole argument for this
  // list being wide.
  "author-import-bg",
  "success-bg",
  "warning-bg",
  "error-bg",
  "info-bg",
  "suggestion-bg",
];

/**
 * Ladder × surface pairs that are below AA and are deliberately left that way,
 * keyed `${theme}/${tier} on ${surface}`.
 *
 * A waiver is not an omission: the numbers and the reason are here, in the file,
 * next to the loop, because the whole argument for widening the surface list is
 * that a silently unswept pair is indistinguishable from a passing one. All four
 * are dark-theme; light and warm clear 4.5 on every pair (warm's minima are the
 * tightest at 6.67 / 5.74 / 4.73, all on warm `--tandem-surface-sunk`).
 *
 * Retuning `--tandem-info-bg` would close three of these, and is worth doing —
 * it just reaches into every info banner, which is wider than an accessibility
 * gate should go. Tracked as follow-up, not silently dropped.
 */
const LADDER_WAIVERS: Record<string, string> = {
  "dark/fg-muted on info-bg":
    "4.10:1 — no component pairs a de-emphasis tier with the dark info fill (#0c4a6e). Do not introduce one without retuning the surface.",
  "dark/fg-subtle on info-bg":
    "3.54:1 — same surface, same reason. --tandem-info-fg-strong is what info banners actually use for text.",
  "dark/fg-faint on info-bg":
    "3.16:1 — same surface, same reason. Recorded in index.html's --tandem-fg-faint comment.",
};

type Pair = { name: string; fg: string; bg: string; min: number };

async function measure(page: Page, theme: string): Promise<Array<Pair & { ratio: number }>> {
  return page.evaluate(
    ({ families, t, TIERS, SURFACES }) => {
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

      // The de-emphasis ladder against every surface it renders text on —
      // INCLUDING the tinted ones.
      //
      // The authorship tints are in this list because leaving them out is how a
      // real failure shipped: annotation cards are painted with
      // `--tandem-author-{user,claude}-bg`, and `.ach-time`
      // (AnnotationCardHeader) renders `fg-faint` on top of one. In dark that
      // measured 4.44:1 and only an axe scan caught it — after the token's own
      // comment had already claimed the ladder was AA "on the surfaces it
      // renders text on (worst 4.58 on accent-bg)". That claim swept
      // bg/surface/surface-sunk only, so it was not merely incomplete: it named
      // the wrong surface. index.html's comment also names `--tandem-accent-bg`
      // as dark's binding constraint, and that surface was outside the
      // instrument too.
      //
      // The lesson generalises past this one pair: a hand-written list of
      // "surfaces text renders on" drifts the moment a component paints a new
      // background, and a comment asserting a ratio cannot notice. Anything
      // that becomes a card/row/banner fill belongs in SURFACES.
      for (const tier of TIERS) {
        for (const surface of SURFACES) {
          add(`${tier} on ${surface}`, `--tandem-${tier}`, `--tandem-${surface}`, 4.5);
        }
      }

      return out;
    },
    { families: FAMILIES as unknown as string[], t: theme, TIERS, SURFACES },
  );
}

for (const theme of THEMES) {
  test(`semantic token pairs meet WCAG AA — ${theme}`, async ({ page }) => {
    await page.goto("/");
    await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 15_000 });

    const results = await measure(page, theme);

    // Guard against the silent-success mode: if resolution broke, `results`
    // would be empty and every assertion below would vacuously pass. Expected
    // count is 59: 11 family rows (6 families × 2, minus `suggestion: fg on
    // solid fill` — `--tandem-suggestion-fg` is intentionally not defined, and
    // `add` skips undefined tokens) + 48 ladder rows (4 tiers × 12 surfaces).
    expect(results.length).toBeGreaterThan(50);

    // A waiver key that no longer names a measured pair is the real rot mode:
    // rename a surface token and the exclusion silently stops applying to
    // anything, so fail loudly on that. A waived pair that has *started*
    // passing is a palette improvement, not a defect — warn, don't fail, or the
    // next PR that fixes --tandem-info-bg turns this suite red for succeeding.
    const measured = new Set(results.map((r) => `${theme}/${r.name}`));
    const orphanedWaivers = Object.keys(LADDER_WAIVERS).filter(
      (k) => k.startsWith(`${theme}/`) && !measured.has(k),
    );
    expect(
      orphanedWaivers,
      `waiver keys that no longer match any measured pair (token renamed?)`,
    ).toEqual([]);

    for (const r of results) {
      const key = `${theme}/${r.name}`;
      if (LADDER_WAIVERS[key] && r.ratio >= r.min) {
        console.warn(
          `[token-contrast] stale waiver — ${key} now measures ${r.ratio}:1; remove it.`,
        );
      }
    }

    const failures = results
      .filter((r) => r.ratio < r.min && !LADDER_WAIVERS[`${theme}/${r.name}`])
      .map((r) => `${r.name}: ${r.ratio}:1 (needs ${r.min}:1) — ${r.fg} on ${r.bg}`);

    expect(failures, `${theme} theme token pairs below their WCAG threshold`).toEqual([]);
  });
}
