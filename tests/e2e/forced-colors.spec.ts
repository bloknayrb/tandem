import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * Windows High Contrast / forced-colors mode (v1.0 gate criterion A3).
 *
 * Sixteen `@media (forced-colors: active)` blocks exist across the client and
 * `index.html`. Until this file, not one of them had ever been executed — they
 * were written from knowledge of the mode rather than from observing it, and a
 * media query that never matches is indistinguishable from a media query that
 * matches and does nothing.
 *
 * What makes the mode worth its own suite is that the user agent, not the page,
 * decides the colours. Two of its overrides break ordinary visual design:
 *
 *   - `box-shadow` is dropped entirely. Every floating surface whose edge was a
 *     shadow becomes edgeless.
 *   - `background-color` is replaced with a system colour. Every control that
 *     signalled its state purely by fill — a status dot, a pressed toggle, a
 *     selected tab — signals nothing.
 *
 * Both failures are invisible to axe: the DOM is unchanged, the contrast is
 * whatever the OS chose, and the markup is correct. They are only visible by
 * rendering under the media query and asking what boundary is left.
 *
 * These assertions came with a free negative control. The first run went out
 * with the emulation not applying, and the boundary and state-indicator tests
 * FAILED — under ordinary rendering the title bar has no border and the status
 * dots have no outline, because in ordinary rendering they do not need one.
 * They pass only once the media query is live. So each is confirmed to be
 * measuring the forced-colors blocks rather than something true either way.
 */

test.describe.configure({ timeout: 90_000 });

// NOT `test.use({ forcedColors: "active" })`.
//
// That is the documented option and it is inert here: on Playwright 1.58 with
// bundled headless Chromium 145, `matchMedia("(forced-colors: active)")`
// reports false under it — verified on a blank `setContent` page, so it is the
// emulation and not anything about Tandem. It fails silently, which is the
// dangerous shape: every assertion in this file would have run against ordinary
// rendering and passed, reporting a criterion as covered that was never once
// exercised. That is precisely what the guard test below exists to catch, and
// it caught it on the first run.
//
// The same emulation driven straight over CDP does work, so this suite sends
// `Emulation.setEmulatedMedia` itself. Chromium-only, which is acceptable: the
// criterion is Windows High Contrast, and Tandem's desktop WebView is Chromium.
async function enableForcedColors(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "forced-colors", value: "active" }],
  });
}

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

async function boot(page: Page) {
  // Before navigation, so the media query is already active at first paint —
  // the token remap in `index.html` is evaluated then.
  await enableForcedColors(page);
  await page.goto("/");
  await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 15_000 });
}

/**
 * The guard. Every other assertion in this file is conditional on the mode
 * actually being active — without this, a Playwright option that silently
 * stopped working would turn the whole suite into a set of assertions about
 * ordinary rendering that all pass for the wrong reason.
 */
test("forced-colors mode is genuinely active", async ({ page }) => {
  await boot(page);
  const active = await page.evaluate(() => matchMedia("(forced-colors: active)").matches);
  expect(active, "emulation is not applying — nothing else in this file is meaningful").toBe(true);
});

test("the root token remap in index.html executes", async ({ page }) => {
  await boot(page);

  // index.html's forced-colors block rebinds the neutral tokens onto system
  // colours. This is the one block every other surface depends on, and it lives
  // in the inline <style> that ships verbatim (no minifier, no autoprefixer),
  // so nothing else would catch it being dropped.
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: cs.getPropertyValue("--tandem-bg").trim(),
      fg: cs.getPropertyValue("--tandem-fg").trim(),
      border: cs.getPropertyValue("--tandem-border").trim(),
    };
  });

  // Custom properties are substituted, not resolved, so these read back as the
  // literal system-colour keywords.
  expect(tokens.bg).toBe("Canvas");
  expect(tokens.fg).toBe("CanvasText");
  expect(tokens.border).toBe("CanvasText");
});

/**
 * Surfaces whose boundary is a `box-shadow` in normal rendering. Under forced
 * colors the shadow is gone, so each needs a real border to remain a distinct
 * surface rather than dissolving into the page.
 */
const SHADOWED_SURFACES = [
  { name: "title bar", selector: "[data-testid='title-bar']" },
  { name: "active tab pill", selector: ".tab-pill[data-active='true']" },
];

for (const s of SHADOWED_SURFACES) {
  test(`${s.name} keeps a visible boundary without its shadow`, async ({ page }) => {
    await boot(page);
    const el = page.locator(s.selector).first();
    await expect(el).toBeVisible({ timeout: 10_000 });

    const box = await el.evaluate((node) => {
      const cs = getComputedStyle(node as HTMLElement);
      const widths = [
        cs.borderTopWidth,
        cs.borderBottomWidth,
        cs.borderLeftWidth,
        cs.borderRightWidth,
      ];
      const styles = [
        cs.borderTopStyle,
        cs.borderBottomStyle,
        cs.borderLeftStyle,
        cs.borderRightStyle,
      ];
      return {
        // A border only counts if it has BOTH width and a style — `1px none`
        // renders nothing, and reading width alone would call it a pass.
        bordered: widths.some((w, i) => parseFloat(w) > 0 && styles[i] !== "none"),
        outlined: parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== "none",
        shadow: cs.boxShadow,
      };
    });

    // Recorded rather than asserted: whether the UA reports the dropped shadow
    // as `none` or leaves the declaration visible in the computed style is an
    // engine detail. What matters is the boundary that survives it.
    expect(
      box.bordered || box.outlined,
      `${s.name} has no border or outline under forced colors (box-shadow: ${box.shadow}) — ` +
        `its only visual boundary in normal rendering is a shadow, which this mode removes`,
    ).toBe(true);
  });
}

/**
 * Controls that carry state by fill alone. `background-color` is overridden by
 * the OS here, so an outline or border is the only way the state survives.
 * These are exactly the elements the existing forced-colors blocks target —
 * this is the first time those blocks are checked against a rendered page.
 */
test("state-by-fill indicators keep a non-colour boundary", async ({ page }) => {
  await boot(page);

  const findings = await page.evaluate(() => {
    const selectors = [".status-dot", ".claude-dot", ".mode-toggle button[aria-pressed='true']"];
    const out: Array<{ sel: string; ok: boolean }> = [];
    for (const sel of selectors) {
      for (const node of Array.from(document.querySelectorAll(sel))) {
        const el = node as HTMLElement;
        // Skip anything not rendered — an absent control is not a failure of
        // this criterion, and asserting on one would make the result depend on
        // incidental app state.
        if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
        const cs = getComputedStyle(el);
        const outlined = parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== "none";
        const bordered = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
        out.push({ sel, ok: outlined || bordered });
      }
    }
    return out;
  });

  // Non-empty guard: if none of these render, the assertion below passes
  // vacuously and reports a criterion as covered that was never exercised.
  expect(
    findings.length,
    "no state-by-fill indicators were rendered — this test proved nothing",
  ).toBeGreaterThan(0);

  const failures = findings.filter((f) => !f.ok).map((f) => f.sel);
  expect(
    failures,
    "state is carried by background-color alone, which forced-colors overrides",
  ).toEqual([]);
});

/**
 * Icons drawn with literal `fill` / `stroke` attributes.
 *
 * `forced-color-adjust: auto` (the default) makes the UA override `fill` and
 * `stroke` along with everything else — but only for values coming from CSS.
 * A hardcoded colour that survives leaves an icon that can land on a same-hue
 * system background and disappear. `currentColor` always follows the forced
 * text colour, which is why it is the rule in this codebase.
 */
test("visible icons do not paint themselves a fixed colour", async ({ page }) => {
  await boot(page);

  const offenders = await page.evaluate(() => {
    const bad: string[] = [];
    for (const node of Array.from(document.querySelectorAll("svg [fill], svg [stroke]"))) {
      const el = node as SVGElement;
      if (!(el.ownerSVGElement?.getBoundingClientRect().width ?? 0)) continue;
      for (const attr of ["fill", "stroke"]) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        const literal =
          v !== "currentColor" && v !== "none" && v !== "inherit" && !v.startsWith("url(");
        if (!literal) continue;
        // `var(--tandem-*)` is fine: index.html remaps those onto system
        // colours under this media query, which is the whole point of routing
        // through tokens instead of hex.
        if (v.startsWith("var(--tandem-")) continue;
        bad.push(`<${el.tagName} ${attr}="${v}">`);
      }
    }
    return Array.from(new Set(bad));
  });

  expect(
    offenders,
    "SVG attributes with a hardcoded colour — use currentColor or a --tandem-* token",
  ).toEqual([]);
});
