/**
 * Combine the per-surface design baselines into ONE self-contained HTML
 * gallery — the durable output of `npm run capture:design-baselines`.
 *
 * Why a single file: OpenDesign flattens every file under
 * docs/design-system-impl into one list, so 16 per-surface baselines clutter
 * the project view. This collapses them to a single OD artifact: a sticky
 * surface picker on the left, each captured baseline embedded in an
 * `<iframe srcdoc>` so its inlined `<html data-theme>` + full stylesheet stay
 * fully isolated (no theme/CSS collision between light and dark scenes).
 *
 * Tradeoff (accepted 2026-05-24): the old per-surface git diff at PR review
 * is gone — the combined file is large and not hand-diffable. Phase 1.1–1.6
 * are merged, so the per-surface diff ritual has served its purpose.
 *
 * Pipeline: the capture spec writes each scene to PARTS_DIR as it's captured
 * (on disk, so a Playwright worker restart on retry can't lose it), then
 * globalTeardown calls combineFromParts() to fold them into OUT_FILE.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Per-scene HTML lands here during capture (outside the OD-watched tree). */
export const PARTS_DIR = path.join(__dirname, ".parts");

/** The single combined gallery. */
export const OUT_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "docs",
  "design-system-impl",
  "preview",
  "baselines",
  "baselines.html",
);

export interface Capture {
  surface: string;
  theme: "light" | "dark";
  /** Full standalone HTML document for this surface + theme. */
  html: string;
}

/**
 * Top-to-bottom-of-the-app ordering so the gallery reads intuitively.
 * Surfaces not listed here append afterward in first-seen order.
 */
const SURFACE_ORDER = [
  "title-bar",
  "formatting-bar",
  "editor-body",
  "outline-panel",
  "side-panel-annotations",
  "annotation-card-comment",
  "command-palette",
  "settings-modal",
  "toast-container",
];

const THEME_ORDER: Capture["theme"][] = ["light", "dark"];

/** Escape a full HTML document for embedding in a double-quoted srcdoc attr. */
function escapeForSrcdoc(html: string): string {
  return html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** "side-panel-annotations" -> "Side panel annotations" */
function prettifySurface(surface: string): string {
  const words = surface.split("-");
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

function orderedSurfaces(captures: Capture[]): string[] {
  const seen = new Set(captures.map((c) => c.surface));
  const ordered = SURFACE_ORDER.filter((s) => seen.has(s));
  const extras = [...seen].filter((s) => !ordered.includes(s));
  return [...ordered, ...extras];
}

export function buildCombinedHtml(captures: Capture[]): string {
  const surfaces = orderedSurfaces(captures);
  const capturedAt = new Date().toISOString().slice(0, 10);

  const navLinks = surfaces
    .map((s) => `<li><a href="#${s}">${prettifySurface(s)}</a></li>`)
    .join("\n          ");

  const sections = surfaces
    .map((surface) => {
      const frames = THEME_ORDER.flatMap((theme) => {
        const cap = captures.find((c) => c.surface === surface && c.theme === theme);
        if (!cap) return [];
        return [
          `        <figure class="frame frame--${theme}">
          <figcaption>${theme}</figcaption>
          <iframe loading="lazy" title="${prettifySurface(surface)} — ${theme}" srcdoc="${escapeForSrcdoc(cap.html)}"></iframe>
        </figure>`,
        ];
      }).join("\n");
      return `      <section class="surface" id="${surface}">
        <h2>${prettifySurface(surface)}</h2>
        <div class="frames">
${frames}
        </div>
      </section>`;
    })
    .join("\n");

  // Gallery shell. Defaults to data-show="both" so every baseline is visible
  // even if a renderer strips the filter <script>; the script only narrows.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design baselines — all surfaces</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #161616; color: #eaeaea; }
  .shell { display: grid; grid-template-columns: 220px 1fr; align-items: start; }
  nav.toc { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 16px; background: #111; border-right: 2px solid #ff5b3a; }
  nav.toc strong { display: block; color: #ff5b3a; margin-bottom: 4px; }
  nav.toc .meta { color: #888; font-size: 11px; margin-bottom: 16px; }
  nav.toc ul { list-style: none; margin: 0; padding: 0; }
  nav.toc li { margin: 2px 0; }
  nav.toc a { color: #cfcfcf; text-decoration: none; display: block; padding: 4px 8px; border-radius: 4px; }
  nav.toc a:hover { background: #222; color: #fff; }
  .filter { display: flex; gap: 4px; margin: 12px 0 18px; }
  .filter button { flex: 1; padding: 5px 0; border: 1px solid #333; border-radius: 4px; background: #1c1c1c; color: #cfcfcf; cursor: pointer; font: inherit; }
  .filter button[aria-pressed="true"] { background: #ff5b3a; border-color: #ff5b3a; color: #111; font-weight: 600; }
  main { padding: 16px 24px 64px; min-width: 0; }
  section.surface { margin-bottom: 48px; scroll-margin-top: 16px; }
  section.surface h2 { margin: 0 0 12px; font-size: 18px; color: #fff; border-bottom: 1px solid #2a2a2a; padding-bottom: 6px; }
  .frames { display: flex; flex-direction: column; gap: 20px; }
  figure.frame { margin: 0; }
  figure.frame figcaption { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 6px; }
  figure.frame iframe { width: 100%; height: 80vh; min-height: 520px; border: 1px solid #333; border-radius: 6px; background: #fff; display: block; }
  body[data-show="light"] .frame--dark { display: none; }
  body[data-show="dark"] .frame--light { display: none; }
</style>
</head>
<body data-show="both">
  <div class="shell">
    <nav class="toc">
      <strong>Design baselines</strong>
      <div class="meta">tandem · ${capturedAt}</div>
      <div class="filter" role="group" aria-label="Theme filter">
        <button type="button" data-show="both" aria-pressed="true">Both</button>
        <button type="button" data-show="light" aria-pressed="false">Light</button>
        <button type="button" data-show="dark" aria-pressed="false">Dark</button>
      </div>
      <ul>
          ${navLinks}
      </ul>
    </nav>
    <main>
${sections}
    </main>
  </div>
  <script>
    const buttons = Array.from(document.querySelectorAll(".filter button"));
    for (const btn of buttons) {
      btn.addEventListener("click", () => {
        document.body.dataset.show = btn.dataset.show;
        for (const b of buttons) b.setAttribute("aria-pressed", String(b === btn));
      });
    }
  </script>
</body>
</html>`;
}

/**
 * Read every per-scene file from PARTS_DIR, fold into OUT_FILE. Returns the
 * number of scenes combined. Run from globalTeardown after the capture spec.
 */
export function combineFromParts(): number {
  const captures: Capture[] = [];
  for (const file of fs.readdirSync(PARTS_DIR)) {
    const m = file.match(/^(.+)-(light|dark)\.html$/);
    if (!m) continue;
    captures.push({
      surface: m[1],
      theme: m[2] as Capture["theme"],
      html: fs.readFileSync(path.join(PARTS_DIR, file), "utf-8"),
    });
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, buildCombinedHtml(captures), "utf-8");
  return captures.length;
}
