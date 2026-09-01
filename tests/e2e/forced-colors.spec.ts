import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  cssAlpha,
  McpTestClient,
  openAnnotatePopup,
  submitAnnotation,
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

/**
 * #1444's destination markers, which are the one thing in this file that
 * deliberately does NOT rely on colour surviving.
 *
 * `--tandem-author-user` and `--tandem-author-claude` are the two authorship
 * colours, and `index.html`'s forced-colors block maps BOTH onto `CanvasText`.
 * So the markers cannot be a cobalt dot and a coral dot: under this mode they
 * would be the same dot. They are a filled disc (the agent) and a ring (you),
 * and the shape is what has to survive.
 *
 * The aggregate "state-by-fill indicators" test above cannot cover this — its
 * `boot()` renders neither a selection popup nor an annotation, and its
 * non-empty guard is aggregate, so appending these selectors to it would add
 * zero coverage and could never fail. Hence a separate test that actually
 * renders both markers.
 *
 * `outlined || bordered` is deliberately NOT the assertion: both markers are
 * bordered, so that check passes for either and distinguishes nothing. The
 * assertion is that their BACKGROUNDS differ — one filled, one transparent.
 */
test("destination markers stay distinguishable by shape, not colour", async ({ page }) => {
  await boot(page);

  const editor = page.locator(".tiptap");
  await editor.click();
  await editor.locator("p").first().selectText();
  await openAnnotatePopup(page);

  // Both composer markers are present, and this is the only surface where the
  // pair is co-present — the card and batch bar render a lone disc, where the
  // marker reinforces the label rather than being the signal.
  const sendMarker = page.locator("[data-testid='popup-comment-submit'] > span");
  const noteMarker = page.locator("[data-testid='popup-note-submit'] > span");
  await expect(sendMarker).toHaveCount(1);
  await expect(noteMarker).toHaveCount(1);

  // The toHaveCount assertions above are the retrying wait, so by here both
  // spans exist and `read` can throw rather than widening every field to null.
  const shapes = await page.evaluate(() => {
    const read = (testid: string) => {
      const span = document.querySelector(`[data-testid='${testid}'] > span`);
      if (!span) throw new Error(`${testid} marker did not render`);
      const cs = getComputedStyle(span);
      return {
        background: cs.backgroundColor,
        borderWidth: cs.borderTopWidth,
        width: cs.width,
      };
    };
    return { send: read("popup-comment-submit"), note: read("popup-note-submit") };
  });

  // Both are rings-or-discs of the same size with a real border...
  for (const [name, s] of Object.entries(shapes)) {
    expect(parseFloat(s.width), `${name} marker has no width`).toBeGreaterThan(0);
    expect(parseFloat(s.borderWidth), `${name} marker lost its border`).toBeGreaterThan(0);
  }

  // ...and the fill is what tells them apart. `transparent` is forcing-exempt,
  // so the ring stays a ring; a regression to colour-only keying would make
  // these two equal.
  expect(
    shapes.note.background,
    "the private marker must stay unfilled — with both authorship colours mapped to CanvasText, fill is the only thing distinguishing it",
  ).not.toBe(shapes.send.background);
  // Assert the ALPHA, not a literal colour string. Under forced colors a
  // `transparent` background computes against the forced Canvas rather than
  // resolving to the `rgba(0, 0, 0, 0)` it does in ordinary rendering — this
  // run returns `rgba(255, 255, 255, 0)`. The RGB triple is the UA's business;
  // alpha 0 is the thing that makes the ring a ring.
  // Was a hand-rolled regex taking "the last number before the paren", which
  // reads the BLUE channel out of a three-component `rgb()` — so an opaque
  // black fill scored alpha 0 and passed this very assertion. `cssAlpha`
  // counts components instead.
  const noteAlpha = cssAlpha(shapes.note.background);
  expect(noteAlpha, `the private marker must have no fill; got ${shapes.note.background}`).toBe(0);

  // The audience toggle's SELECTED state. Under forcing, the sliding thumb's
  // --tandem-surface and the track's --tandem-surface-sunk both map to Canvas,
  // so the fill that shows which audience is active disappears and this outline
  // is the only thing left saying so. Its ModeToggle twin carries an identical
  // rule and an in-source note that this spec pins it; without the assertion
  // below, deleting the rule here would stay green.
  const pressedOutline = await page
    .locator("[data-testid='popup-comment-submit']")
    .evaluate((el) => getComputedStyle(el).outlineWidth);
  const unpressedOutline = await page
    .locator("[data-testid='popup-note-submit']")
    .evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(
    parseFloat(pressedOutline),
    "the selected audience segment must carry a forced-colors outline — it is the only selection indicator there",
  ).toBeGreaterThan(0);
  expect(
    parseFloat(unpressedOutline),
    "the unselected segment must NOT be outlined, or the indicator distinguishes nothing",
  ).toBe(0);

  // The card's Send carries the same disc, and has no other E2E coverage at
  // all. It renders only for a USER-authored pending note — an imported one
  // takes the Accept/Reject branch instead and has no marker.
  await page.locator("[data-testid='popup-annotation-input']").fill("marker check");
  await submitAnnotation(page, "note");

  const cardSend = page.locator("[data-testid^='send-to-claude-btn-']").first();
  await expect(cardSend).toBeVisible({ timeout: 10_000 });
  const cardMarker = await cardSend.locator("> span").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { background: cs.backgroundColor, borderWidth: cs.borderTopWidth, width: cs.width };
  });
  expect(parseFloat(cardMarker.width)).toBeGreaterThan(0);
  expect(parseFloat(cardMarker.borderWidth)).toBeGreaterThan(0);
  expect(cardMarker.background, "the card's Send marker must stay filled").toBe(
    shapes.send.background,
  );
});

test("the annotation type survives forcing as a word, not just an icon", async ({ page }) => {
  // The ONLY carrier of annotation type under High Contrast, and until now
  // nothing referenced `.ach-badge-word` or the `@media (forced-colors: active)`
  // block that reveals it. Deleting either left the suite green while the type
  // lost every carrier at once: the card tint collapses to Canvas (so author
  // and type both stop being colour-coded), and the glyph is hidden precisely
  // because a force-adjusted 13px outline is not a reliable discriminator.
  //
  // Asserting a real bounding box rather than `toBeVisible()`: the word is
  // hidden by `clip-path: inset(50%)` at 1x1, which Playwright still reports as
  // visible. A reveal that undoes only SOME of the five hiding properties would
  // pass a visibility check and paint nothing.
  await boot(page);

  const editor = page.locator(".tiptap");
  await editor.click();
  await editor.locator("p").first().selectText();
  await openAnnotatePopup(page);
  await page.locator("[data-testid='popup-annotation-input']").fill("forced-colors type check");
  await submitAnnotation(page, "note");

  const badge = page.locator(".annotation-type-badge").first();
  await expect(badge).toBeVisible({ timeout: 10_000 });

  const shape = await badge.evaluate((el) => {
    const svg = el.querySelector("svg") as SVGElement | null;
    const word = el.querySelector(".ach-badge-word") as HTMLElement | null;
    const wordRect = word?.getBoundingClientRect();
    return {
      svgDisplay: svg ? getComputedStyle(svg).display : "missing",
      hasWord: Boolean(word),
      wordText: word?.textContent?.trim() ?? "",
      wordWidth: wordRect?.width ?? 0,
      wordHeight: wordRect?.height ?? 0,
      wordClipPath: word ? getComputedStyle(word).clipPath : "missing",
    };
  });

  expect(shape.hasWord, "the visually-hidden type word is gone from the markup").toBe(true);
  expect(shape.svgDisplay, "the glyph must be hidden under forcing, not doubled up").toBe("none");
  expect(shape.wordText.toLowerCase()).toContain("note");
  expect(
    shape.wordClipPath,
    `the reveal must undo clip-path; got ${shape.wordClipPath}`,
  ).not.toContain("inset(50%)");
  expect(shape.wordWidth, "the revealed word has no width — it paints nothing").toBeGreaterThan(4);
  expect(shape.wordHeight, "the revealed word has no height — it paints nothing").toBeGreaterThan(
    4,
  );

  // This half FOUND A BUG rather than confirming one, so it is not decoration.
  // The reveal swaps a 13px glyph for a padded word, `.ach-badge` is
  // `flex-shrink: 0`, and `.ach-row` is `space-between` with
  // `overflow: hidden` — so the row had nowhere to give. At the side panel's
  // 250px the content wanted 278px and the right-hand 28px was silently cut
  // off: the tail of `.ach-author`, i.e. the timestamp. Invisible in every
  // other spec, because nothing else renders this row with a word in the badge.
  //
  // The fix is `flex-wrap: wrap` + `row-gap` on `.ach-row` and `.ach-type`
  // inside the forced-colors block of AnnotationCardHeader.svelte. Delete
  // either declaration and headerClipped goes back to true.
  //
  // COVERAGE BOUND, because the passing number below is easy to over-read:
  // this measures "Private note" (12 characters), which is what this card
  // shows. The longest label in the set is "Suggested replacement" at 21, and
  // it is still NOT covered — seeding a suggestion into this fixture needs the
  // MCP document-open sequence the other specs do, and doing it just to widen
  // this assertion put a second unrelated failure mode into a test whose job
  // is the reveal. That gap is #1724.
  const row = await badge.evaluate((el) => {
    const header = el.closest(".ach-row") as HTMLElement | null;
    const author = header?.querySelector(".ach-author") as HTMLElement | null;
    if (!header || !author) throw new Error("the badge is not inside a card header row");
    return {
      headerClipped: header.scrollWidth > header.clientWidth + 1,
      authorClipped: author.scrollWidth > author.clientWidth + 1,
      authorWidth: author.getBoundingClientRect().width,
    };
  });
  expect(row.headerClipped, "the revealed word overflows the header row").toBe(false);
  expect(row.authorClipped, "the revealed word starved the author side out of the row").toBe(false);
  expect(row.authorWidth, "the author side was squeezed to nothing").toBeGreaterThan(20);
});
