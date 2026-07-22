/**
 * Renders the Tandem logotype to flat PNGs for the README.
 *
 * The canonical logotype lives in the Tandem Design System project as a live HTML
 * composition -- Comfortaa 700 with the blue/orange T mark substituted for the letter T,
 * positioned by CSS. GitHub renders neither webfonts nor CSS in markdown, so the wordmark
 * has to be flattened into an image before it can head the README. The CSS below is
 * transcribed verbatim from the DS `preview/brand-logo.html`; the negative glyph margins
 * are tuned to this specific mark's whitespace, so do not re-derive them.
 *
 * Outputs a light and a dark ink variant on transparent backgrounds, consumed by the
 * README's <picture> block. Run with: node scripts/render-logotype.mjs
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const ASSETS_DIR = path.join(REPO_ROOT, "docs", "assets");
const MARK_PATH = path.join(ASSETS_DIR, "logo.png");

const FONT_SIZE = 96;
const SCALE = 3;

// The mark keeps its own colours; only the wordmark ink changes between variants.
const VARIANTS = [
  { file: "logotype-light.png", ink: "oklch(0.24 0.018 60)" }, // DS logotype ink
  { file: "logotype-dark.png", ink: "oklch(0.94 0.006 280)" }, // dark-theme --tandem-fg
];

/**
 * Crops a PNG data URI to its alpha bounding box.
 *
 * The DS composition points at its own tightly-cropped `assets/logo-mark.png`, and the
 * `0.78em` height plus negative margins are tuned to that crop. The repo's copy of the
 * mark is a 1000x1000 square with transparent padding, so applying the DS values to it
 * directly renders the T undersized and floating above the baseline. Trimming to the
 * alpha bbox reconstructs the crop the DS values expect, and makes the composition
 * independent of however the source file happens to be padded.
 */
async function trimToAlphaBounds(page, dataUri) {
  return page.evaluate(
    (src) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onerror = () => reject(new Error("mark failed to decode"));
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const { data } = ctx.getImageData(0, 0, img.width, img.height);

          let top = img.height;
          let left = img.width;
          let right = -1;
          let bottom = -1;
          for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
              if (data[(y * img.width + x) * 4 + 3] === 0) continue;
              if (y < top) top = y;
              if (y > bottom) bottom = y;
              if (x < left) left = x;
              if (x > right) right = x;
            }
          }
          if (right < 0) {
            reject(new Error("mark is fully transparent"));
            return;
          }

          const out = document.createElement("canvas");
          out.width = right - left + 1;
          out.height = bottom - top + 1;
          out.getContext("2d").drawImage(canvas, -left, -top);
          resolve(out.toDataURL("image/png"));
        };
        img.src = src;
      }),
    dataUri,
  );
}

/**
 * Builds a self-contained page for one variant.
 *
 * Note the deliberate absence of any background declaration: Playwright's `omitBackground`
 * only suppresses its own default white fill and cannot see through a painted
 * background-color, so html/body must stay transparent for the PNG to composite over
 * both GitHub themes.
 */
function buildHtml(ink, markDataUri) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { display: inline-block; }

  .logotype {
    font-family: "Comfortaa", sans-serif;
    font-weight: 700;
    color: ${ink};
    line-height: 1;
    letter-spacing: -0.035em;
    font-size: ${FONT_SIZE}px;
    white-space: nowrap;
    /* The mark is taller than the ascender and its negative left margin reaches outside
       the text box, so an unpadded element screenshot clips the T. Render with slack and
       trim the result to its alpha bounds instead. */
    padding: 0.25em;
  }
  .logo-glyph {
    height: 0.78em;
    width: auto;
    display: inline-block;
    vertical-align: baseline;
    margin-right: -0.18em;
    margin-left: -0.05em;
  }
</style>
</head>
<body>
  <div class="logotype"><img class="logo-glyph" src="${markDataUri}" alt="T">andem</div>
</body>
</html>`;
}

/**
 * Fails loudly when Comfortaa did not actually apply to the wordmark.
 *
 * `document.fonts.ready` resolves whether loading succeeded or failed, and
 * `document.fonts.check()` only reports the document's FontFaceSet -- a typo'd font-family
 * on .logotype itself would still pass both. Measuring the real element against a forced
 * sans-serif render is what catches a silent fallback, which would otherwise ship a
 * plausible-looking but wrong logotype.
 */
async function assertFontApplied(page) {
  const result = await page.evaluate(async (fontSize) => {
    await document.fonts.ready;
    const loaded = document.fonts.check(`700 ${fontSize}px Comfortaa`);

    const el = document.querySelector(".logotype");
    const actual = el.getBoundingClientRect().width;

    const original = el.style.fontFamily;
    el.style.fontFamily = "sans-serif";
    const fallback = el.getBoundingClientRect().width;
    el.style.fontFamily = original;

    return { loaded, actual, fallback };
  }, FONT_SIZE);

  if (!result.loaded) {
    throw new Error("Comfortaa 700 did not load -- check network access to fonts.googleapis.com");
  }

  const delta = Math.abs(result.actual - result.fallback) / result.fallback;
  if (delta < 0.01) {
    throw new Error(
      `Comfortaa did not apply to .logotype: width ${result.actual.toFixed(1)}px is within ` +
        `1% of the sans-serif fallback (${result.fallback.toFixed(1)}px). Refusing to write a ` +
        `logotype rendered in the wrong typeface.`,
    );
  }

  return delta;
}

async function main() {
  if (!fs.existsSync(MARK_PATH)) {
    throw new Error(`Mark not found at ${MARK_PATH}`);
  }
  const rawMark = `data:image/png;base64,${fs.readFileSync(MARK_PATH).toString("base64")}`;

  const browser = await chromium.launch();
  try {
    const scratch = await browser.newPage();
    const markDataUri = await trimToAlphaBounds(scratch, rawMark);

    for (const { file, ink } of VARIANTS) {
      const page = await browser.newPage({ deviceScaleFactor: SCALE });
      await page.setContent(buildHtml(ink, markDataUri), { waitUntil: "networkidle" });

      const delta = await assertFontApplied(page);
      console.log(
        `  ${file}: Comfortaa applied (${(delta * 100).toFixed(1)}% wider than fallback)`,
      );

      const padded = await page.locator(".logotype").screenshot({ omitBackground: true });
      await page.close();

      const trimmed = await trimToAlphaBounds(
        scratch,
        `data:image/png;base64,${padded.toString("base64")}`,
      );
      const out = path.join(ASSETS_DIR, file);
      fs.writeFileSync(out, Buffer.from(trimmed.split(",")[1], "base64"));

      console.log(`  wrote ${path.relative(REPO_ROOT, out)}`);
    }
    await scratch.close();
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
