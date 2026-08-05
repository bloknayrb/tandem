import { expect, type Page, test } from "@playwright/test";

/**
 * Contrast for the three surfaces axe structurally cannot reach.
 *
 * `accessibility.spec.ts` excludes `[contenteditable]` / `.ProseMirror`, which
 * for a document editor means its scans never cover the surface a user spends
 * all of their time in. The excluded cases are:
 *
 *   - authorship colours (`--tandem-author-user` / `--tandem-author-claude`),
 *     applied as inline text colour via `data-tandem-author`
 *   - highlight fills behind body copy
 *   - annotation underline decorations
 *
 * axe is not the only tool that can answer a contrast question. The WCAG
 * relative-luminance formula is a dozen lines, so these are measured directly.
 *
 * Two things make this honest rather than decorative:
 *
 * 1. Highlights are `rgba()`. Reading the token and comparing it to the text
 *    colour would measure a colour that is never on screen — what the user sees
 *    is the highlight *composited over* the editor background. So the fill is
 *    alpha-composited first, and the assertion runs against the result.
 * 2. Colours resolve through a canvas readback, because Chromium serialises
 *    `oklch()` as `color(srgb …)` and parsing those 0-1 floats as 0-255 yields
 *    a confident wrong answer — a mistake this work made once already.
 */

const THEMES = ["light", "dark", "warm"] as const;

const HIGHLIGHTS = ["yellow", "green", "blue", "pink"] as const;

type Result = { name: string; ratio: number; min: number };

async function probe(page: Page, theme: string): Promise<Result[]> {
  return page.evaluate(
    ({ t, highlights }) => {
      document.documentElement.setAttribute("data-theme", t);

      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

      /** Paint a CSS colour and read it back as [r,g,b,a] with a=0-1. */
      function paint(css: string): [number, number, number, number] {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      }

      const tok = (name: string) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim();

      /** src over dst — what the eye actually receives for a translucent fill. */
      function over(
        src: [number, number, number, number],
        dst: [number, number, number, number],
      ): [number, number, number, number] {
        const a = src[3];
        return [
          Math.round(src[0] * a + dst[0] * (1 - a)),
          Math.round(src[1] * a + dst[1] * (1 - a)),
          Math.round(src[2] * a + dst[2] * (1 - a)),
          1,
        ];
      }

      function luminance([r, g, b]: [number, number, number, number]) {
        const f = (c: number) => {
          c /= 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      }

      const ratio = (a: [number, number, number, number], b: [number, number, number, number]) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
      };

      const out: Array<{ name: string; ratio: number; min: number }> = [];
      const editorBg = paint(tok("--tandem-bg"));
      const bodyFg = paint(tok("--tandem-fg"));

      // 1. Authorship, as TEXT colour, so 4.5:1 against the editor background.
      //
      // The rendered colour is NOT the raw token. `editor.css` mixes it toward
      // the body foreground before painting:
      //   [data-tandem-author="user"]   -> color-mix(author-user 58%, fg)
      //   [data-tandem-author="claude"] -> color-mix(author-claude 64%, fg)
      // Probing the raw token instead reported 2.66:1 / 2.99:1 / 4.09:1 and
      // would have sent someone off to retune brand colours that in fact render
      // fine. The percentages are duplicated here deliberately: if they change
      // in editor.css and not here, this measures a colour the product no
      // longer paints, so the two must move together.
      const MIX: Record<string, number> = { user: 58, claude: 64 };
      for (const who of ["user", "claude"]) {
        const c = tok(`--tandem-author-${who}`);
        if (!c) continue;
        const rendered = paint(`color-mix(in srgb, ${c} ${MIX[who]}%, ${tok("--tandem-fg")})`);
        out.push({ name: `authorship: ${who} text`, ratio: ratio(rendered, editorBg), min: 4.5 });
      }

      // 2. Body text ON each highlight fill, composited over the editor bg.
      for (const h of highlights) {
        const fill = tok(`--tandem-highlight-${h}`);
        if (!fill) continue;
        const composited = over(paint(fill), editorBg);
        out.push({
          name: `highlight ${h}: body text on fill`,
          ratio: ratio(bodyFg, composited),
          min: 4.5,
        });
      }

      // 3. Annotation underlines are non-text indicators: SC 1.4.11 asks 3:1
      //    against the surface they sit on.
      for (const kind of ["comment", "note", "suggestion"]) {
        const c = tok(
          `--tandem-${kind === "comment" ? "accent" : kind === "note" ? "warning" : "suggestion"}`,
        );
        if (c)
          out.push({
            name: `${kind} underline vs editor bg`,
            ratio: ratio(paint(c), editorBg),
            min: 3,
          });
      }

      return out;
    },
    { t: theme, highlights: HIGHLIGHTS as unknown as string[] },
  );
}

for (const theme of THEMES) {
  test(`editor-surface contrast — ${theme}`, async ({ page }) => {
    await page.goto("/");
    await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 15_000 });

    const results = await probe(page, theme);

    // Without this, a broken token lookup would return [] and pass vacuously.
    expect(results.length).toBeGreaterThanOrEqual(8);

    const failures = results
      .filter((r) => r.ratio < r.min)
      .map((r) => `${r.name}: ${r.ratio}:1 (needs ${r.min}:1)`);

    expect(failures, `${theme} editor-surface contrast`).toEqual([]);
  });
}
