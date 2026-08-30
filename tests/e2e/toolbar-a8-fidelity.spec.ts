import { expect, test } from "@playwright/test";
import path from "path";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openAnnotatePopup,
  selectTextStable,
} from "./helpers";

/**
 * Locks the A8 fidelity pass on the formatting bar and the selection popup.
 *
 * Two classes of regression are pinned here, and neither had any coverage
 * before:
 *
 *  1. **Interaction states.** `popup-annotate-btn`, `popup-show-formatbar-btn`,
 *     `popup-highlight-none` and the colour swatches shipped as inline-styled
 *     bare <button>s with no `:hover` and no project focus ring. They were not
 *     a WCAG failure (nothing set `outline: none`, so the UA ring landed), but
 *     the hover affordance was absent outright and the ring was inconsistent
 *     with every CSS-classed sibling. Asserting computed style on hover is the
 *     only thing that catches a rule being dropped in a future refactor.
 *
 *  2. **The width budget.** The icon redraw costs ~+48px of bar width, ~+40 of
 *     it inside the `overflow-x: clip` track. No spec in the suite ran at the
 *     800px Tauri `minWidth` (the only `setViewportSize` anywhere is 640px in
 *     formatting-bar-popovers.spec.ts, and Playwright's default is 1280), so
 *     the budget had no gate at all. Truncation there is silent AND
 *     unrecoverable — `overflow-x: clip` creates no scroll container, so a
 *     truncated focused control cannot be scrolled into view.
 */

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

/** Opens the doc and returns the editor locator, ready for a selection. */
async function openDoc(page: import("@playwright/test").Page) {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  return editor;
}

/** Click into the editor and hold a stable selection, opening the popup. */
async function selectFirstParagraph(editor: import("@playwright/test").Locator) {
  await editor.click();
  await selectTextStable(editor.locator("p").first());
}

test("popup controls that had no hover affordance now have one", async ({ page }) => {
  const editor = await openDoc(page);
  await selectFirstParagraph(editor);

  const annotate = page.locator("[data-testid='popup-annotate-btn']");
  await expect(annotate).toBeVisible();

  // Resting vs hovered background must actually differ. Comparing the two
  // measured values (rather than asserting a literal colour) keeps the test
  // theme-agnostic and token-agnostic while still failing if the rule is lost.
  const restingBg = await annotate.evaluate((el) => getComputedStyle(el).backgroundColor);
  await annotate.hover();
  await expect
    .poll(async () => annotate.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(restingBg);

  const swatch = page.locator("[data-testid='popup-highlight-yellow']");
  const restingTransform = await swatch.evaluate((el) => getComputedStyle(el).transform);
  await swatch.hover();
  // The chip scales on hover; `none` -> a matrix() is the observable change.
  await expect
    .poll(async () => swatch.evaluate((el) => getComputedStyle(el).transform))
    .not.toBe(restingTransform);
});

test("the Annotate button carries no authorship colour", async ({ page }) => {
  const editor = await openDoc(page);
  await selectFirstParagraph(editor);

  const annotate = page.locator("[data-testid='popup-annotate-btn']");
  await expect(annotate).toBeVisible();

  // #1444: authorship/destination colour belongs only on controls that set or
  // change `audience`. Annotate sets none — it opens a composer that defaults
  // to outbound — so wearing the private/you blue asserted the opposite of what
  // the button does. Pin it against the token's own resolved value so a
  // re-introduction fails here rather than in review.
  const [authorUser, borderColor, textColor] = await annotate.evaluate((el) => {
    const cs = getComputedStyle(el);
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--tandem-author-user")
      .trim();
    return [token, cs.borderTopColor, cs.color];
  });
  expect(authorUser).not.toBe("");
  expect(borderColor).not.toBe(authorUser);
  expect(textColor).not.toBe(authorUser);
});

test("the highlight swatch group has an accessible name", async ({ page }) => {
  const editor = await openDoc(page);
  await selectFirstParagraph(editor);

  // Was an aria-label on a roleless <div>, which AT ignores entirely.
  await expect(page.getByRole("group", { name: "Highlight colors" })).toBeVisible();

  // It must NOT have become role="button": toolbar-redesign.spec.ts:227 asserts
  // exactly four buttons matching /Highlight /, and a fifth reds there. Not
  // re-asserted here — that contract already has an owner.
});

test("every bar control renders on the shared 26px control metrics", async ({ page }) => {
  await openDoc(page);

  // Regression net for a real bug this pass introduced and every other test
  // missed: a control's metrics were moved into the shared .tandem-toolbar-ctl
  // sheet without the class being added to its markup, so it fell all the way
  // back to UA button defaults — 2px black border, 17px tall, grey fill — and
  // the whole suite stayed green because nothing asserted bar geometry.
  //
  // The set is DERIVED, not enumerated. An enumeration seeded from the fix can
  // only catch the bug already fixed; the first draft of this test listed four
  // controls and omitted both DecorationsMenu halves, which is precisely where
  // the entire metrics block was deleted. Note the set must be every <button>
  // in the bar — selecting on `.tandem-toolbar-ctl` cannot work, because a
  // control that lost the class would drop out of the selector and the test
  // would pass. Every button in the bar at rest is a shared control (the
  // heading menu and LinkEditor render only behind an {#if}), with one
  // documented exception carved out below.
  const bar = page.locator("[data-testid='formatting-bar']");
  await expect(bar).toBeVisible();

  // The DecorationsMenu split halves are 20px INSIDE a 26px container — the
  // preview's own arithmetic (1.11-titlebar-decorations.html:78-82: 20px halves
  // + 2px container padding + 1px border). They are the one intentional
  // departure from the flat 26px recipe, so they are measured separately rather
  // than loosening the sweep's assertion for everything else.
  const SPLIT_HALVES = ["decorations-mute-toggle", "decorations-menu-caret"];

  const measured = await bar.evaluate(
    (el, exclude) =>
      [...el.querySelectorAll("button")]
        .map((b) => {
          const cs = getComputedStyle(b);
          return {
            id: (b as HTMLElement).dataset.testid || b.getAttribute("aria-label") || "?",
            testid: (b as HTMLElement).dataset.testid ?? "",
            height: cs.height,
            borderWidth: cs.borderTopWidth,
          };
        })
        .filter((m) => !exclude.includes(m.testid)),
    SPLIT_HALVES,
  );

  // Fail closed on an EXACT count. A floor is the wrong shape here: it makes the
  // sweep vacuous-proof but not deletion-proof, and 13 — the first draft's
  // value — happened to be exactly FormattingToolbar's own button count, so four
  // of the bar's controls could disappear without reddening anything.
  //
  // 17, with the two split halves excluded above:
  //   13 from FormattingToolbar — undo, redo, B, I, S, `<>`, link, heading,
  //      bullet list, ordered list, blockquote, horizontal rule, code block
  //    2 from HighlightColorPicker — the apply button AND the colour toggle
  //      (it is two controls, not one; that is the count this first got wrong)
  //    1 formatbar-source-toggle
  //    1 formatbar-hide-btn
  //
  // Count, not an id list: the heading button's accessible name tracks the
  // level under the cursor ("Heading 1"), so pinning names here would couple
  // this geometry sweep to the fixture document's structure.
  expect(
    measured.map((m) => m.id).sort(),
    "the formatting bar's control set changed. If you ADDED or REMOVED a control " +
      "deliberately, update this count; otherwise a control has gone missing from " +
      "the bar and nothing else in the suite asserts bar geometry",
  ).toHaveLength(17);

  // The UA default is a 2px border; every styled control here uses 1px
  // (transparent at rest). That is the tell that the class went missing.
  const offRecipe = measured.filter((m) => m.height !== "26px" || m.borderWidth !== "1px");
  expect(offRecipe, "bar controls not on the shared 26px / 1px control metrics").toEqual([]);

  // The split still has to land the compound control on the bar's 26px, and its
  // halves still have to be styled rather than UA chrome (UA is a 2px border at
  // ~17px tall, so 20px/1px distinguishes them).
  const split = page.locator("[data-testid='decorations-menu']");
  await expect(split).toBeVisible();
  expect(await split.evaluate((el) => getComputedStyle(el).height)).toBe("26px");
  for (const id of SPLIT_HALVES) {
    const half = page.locator(`[data-testid='${id}']`);
    const box = await half.evaluate((node) => {
      const cs = getComputedStyle(node);
      return { height: cs.height, borderWidth: cs.borderTopWidth };
    });
    expect(box.height, `${id} left the split's 20px half height`).toBe("20px");
    expect(box.borderWidth, `${id} is falling back to UA button chrome`).toBe("1px");
  }
});

test("the decorations split reads as one pill in both states", async ({ page }) => {
  await openDoc(page);

  // The control is a single compound affordance, so it must carry its own pill
  // at REST — not only when the eye is on. It shipped flat, with the `.on` tint
  // as the only thing that ever drew a shape, so muted decorations left an eye
  // and a caret floating unattached. Two properties make it read as one pill:
  // the container owns a border + radius regardless of state, and the halves'
  // INNER corners are square so the pair has one continuous silhouette.
  const split = page.locator("[data-testid='decorations-menu']");
  await expect(split).toBeVisible();

  const container = await split.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { borderWidth: cs.borderTopWidth, radius: cs.borderTopLeftRadius };
  });
  expect(container.borderWidth, "the split lost its resting container border").toBe("1px");
  expect(parseFloat(container.radius), "the split lost its pill radius").toBeGreaterThan(10);

  // Inner corners square, outer corners pill — measured on the corners that
  // face the seam, which is what previously made the halves read as two chips.
  const corners = await split.evaluate((el) => {
    const g = (sel: string) => {
      const cs = getComputedStyle(el.querySelector(sel)!);
      return {
        tl: parseFloat(cs.borderTopLeftRadius),
        tr: parseFloat(cs.borderTopRightRadius),
      };
    };
    return {
      main: g("[data-testid='decorations-mute-toggle']"),
      caret: g("[data-testid='decorations-menu-caret']"),
    };
  });
  expect(corners.main.tr, "the eye half re-rounded its inner corner").toBe(0);
  expect(corners.caret.tl, "the caret half re-rounded its inner corner").toBe(0);
  expect(corners.main.tl, "the eye half lost its outer pill corner").toBeGreaterThan(10);
  expect(corners.caret.tr, "the caret half lost its outer pill corner").toBeGreaterThan(10);
});

test("the decorations split is a raised button its segments press into", async ({ page }) => {
  await openDoc(page);

  const split = page.locator("[data-testid='decorations-menu']");
  const eye = page.locator("[data-testid='decorations-mute-toggle']");
  const caret = page.locator("[data-testid='decorations-menu-caret']");
  await expect(split).toBeVisible();

  const shadowOf = (l: typeof split) => l.evaluate((el) => getComputedStyle(el).boxShadow);
  const isInset = (s: string) => s.includes("inset");

  // RAISED container. An earlier revision made this a sunk tray, which reads as
  // recessed and leaves the segments nowhere to press INTO — the three states
  // (decorations on / muted / menu open) then had to be carried by colour
  // alone. The border+radius assertions above are satisfied by either
  // treatment, so the raise needs its own assertion.
  const containerShadow = await shadowOf(split);
  expect(containerShadow, "the split lost its raised shadow").not.toBe("none");
  expect(containerShadow, "the split's own shadow must not be inset").not.toContain("inset");

  // The caret is raised at REST — it presses only while held or while its menu
  // is open, so a resting inset here would be permanently-pressed chrome.
  expect(isInset(await shadowOf(caret)), "the caret reads as pressed at rest").toBe(false);

  // The menu-open press is driven off aria-expanded, which is already the
  // menu's source of truth — no extra state class to drift.
  await expect(caret).toHaveAttribute("aria-expanded", "false");
  await caret.click();
  await expect(caret).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => isInset(await shadowOf(caret))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(caret).toHaveAttribute("aria-expanded", "false");

  // The eye is pressed exactly while decorations are shown, and carries a
  // crossed-out glyph while they are muted — the button is UNPRESSED when
  // muted, so a plain eye there would read as "decorations are on".
  const glyphPaths = () => eye.evaluate((el) => el.querySelectorAll("svg path").length);

  const startedOn = await eye.evaluate((el) => el.classList.contains("on"));
  if (!startedOn) await eye.click();
  await expect(eye).toHaveClass(/\bon\b/);
  await expect.poll(async () => isInset(await shadowOf(eye))).toBe(true);
  const shownPaths = await glyphPaths();

  await eye.click();
  await expect(eye).not.toHaveClass(/\bon\b/);
  await expect.poll(async () => isInset(await shadowOf(eye))).toBe(false);
  const mutedPaths = await glyphPaths();

  expect(mutedPaths, "the muted eye is not a distinct crossed-out glyph").toBeGreaterThan(
    shownPaths,
  );

  if (startedOn) await eye.click();
});

test("the popup's pill controls share the bar's control metrics", async ({ page }) => {
  const editor = await openDoc(page);
  await selectFirstParagraph(editor);

  // The popup is deliberately heterogeneous — the 18px colour swatches are not
  // toolbar controls — so this one is a named list rather than a derived sweep,
  // covering the two controls in it that ARE on the shared recipe.
  for (const id of ["popup-show-formatbar-btn", "popup-annotate-btn"]) {
    const el = page.locator(`[data-testid='${id}']`);
    await expect(el, `${id} should be present`).toBeVisible();
    const box = await el.evaluate((node) => {
      const cs = getComputedStyle(node);
      return { height: cs.height, borderWidth: cs.borderTopWidth };
    });
    expect(box.height, `${id} lost its shared control height`).toBe("26px");
    expect(box.borderWidth, `${id} is falling back to UA button chrome`).toBe("1px");
  }
});

test("the formatting bar does not truncate at the 800px desktop minimum", async ({ page }) => {
  // 800px is src-tauri/tauri.conf.json's minWidth; spacious is the worst case
  // because --tandem-space-6 (the pill's max-width inset) is 48px there vs 32px
  // cozy, and --tandem-space-1 rises 4->6px on top.
  await page.addInitScript(
    ([key, density]) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      window.localStorage.setItem(key, JSON.stringify({ ...parsed, density }));
    },
    [TANDEM_SETTINGS_KEY, "spacious"] as const,
  );
  await page.setViewportSize({ width: 800, height: 900 });

  await openDoc(page);
  await expect(page.locator("html")).toHaveAttribute("data-density", "spacious", {
    timeout: 5_000,
  });

  const track = page.locator("[data-testid='formatting-bar-track']");
  await expect(track).toBeVisible();

  const { scrollWidth, clientWidth } = await track.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));

  // scrollWidth > clientWidth means content is being clipped away. There is no
  // scroll container to recover it, so this is a hard failure, not a cosmetic
  // one. If this reds, the lever is ToolbarButton padding 0 7px -> 0 6px, then
  // 16px icons -> 14px. Do NOT touch the overflow-* longhands on
  // .tandem-fmtbar-track: a scrollable value on one axis computes the other's
  // `visible` to `auto` and re-clips the heading/highlight/link popovers.
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

/**
 * Reduced motion is what makes the widths below settled BY CONSTRUCTION rather
 * than by waiting. `popupEnter` animates width 0 -> natural over
 * ENTER_POPUP_MS (440ms) and `motionOff()` in cardMotion.ts checks
 * `matchMedia("(prefers-reduced-motion: reduce)")`, returning `{ duration: 0 }`
 * under it; the P1/P2 morph transitions are guarded the same way.
 *
 * The alternative — polling for two consecutive equal width samples — looks
 * rigorous and is not: `popupEnter` eases OUT, so dw/dt approaches zero at the
 * tail and two rounded samples repeat well before the animation ends. That
 * version passed only because Playwright's default poll ladder
 * (100/250/500/1000ms) happens to land a sample at ~850ms, past the entrance.
 * Configure `expect.timeout`, or take a Playwright default change, and it
 * silently starts measuring mid-animation.
 *
 * This test measures settled geometry, not motion, so nothing of value is lost.
 */
test("the annotate composer is sized to its own content, not the format row", async ({ page }) => {
  // Emulated on the PAGE rather than declared via `test.use({ reducedMotion })`:
  // the fixture form is rejected by this project's resolved Playwright test
  // types, and page-level emulation is the narrower tool anyway — it scopes the
  // preference to this one test instead of a whole describe block. Set before
  // navigation because the CSS media queries are live and `motionOff()` reads
  // matchMedia at animation time.
  await page.emulateMedia({ reducedMotion: "reduce" });

  const editor = await openDoc(page);
  await selectFirstParagraph(editor);

  const popup = page.locator(".selection-popup");
  const measureWidth = () => popup.evaluate((el) => el.getBoundingClientRect().width);

  const formatWidth = Math.round(await measureWidth());
  // Fail closed: a popup that measured ~0 would satisfy every comparison below.
  expect(
    formatWidth,
    "the format-state popup measured near zero — it is not rendered, or reduced " +
      "motion stopped collapsing the entrance animation",
  ).toBeGreaterThan(200);

  await page.locator("[data-testid='popup-annotate-btn']").click();
  await expect(popup).toHaveClass(/is-annotate/);
  const annotateWidth = Math.round(await measureWidth());

  // A `0fr`-collapsed .morph-block keeps its full inline size, and
  // .selection-popup is a column flex box — so the composer was stretched to
  // whichever block was wider, i.e. the format row. After the A8 icon redraw
  // that row exceeded .composer-card's 420px cap, and the cap (documented as
  // vestigial) silently became the card's width: 420px of card for 278px of
  // footer. The design gives the composer its own 300px modal, independent of
  // the format row (1.11-selection-converged.html:82).
  expect(
    annotateWidth,
    "the composer is being stretched to the format row's width again",
  ).toBeLessThan(formatWidth - 40);

  // …and it must still fit its own footer rather than clipping it. The action
  // row is `justify-content: flex-end`, so an overflow truncates on the LEFT
  // and is silent (.morph-block is overflow: clip).
  const actions = popup.locator(".composer-actions");
  const fit = await actions.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  expect(fit.scroll, "the composer footer is being clipped").toBeLessThanOrEqual(fit.client);
});

/**
 * The composer's focus-dependent guards must key on the POPUP, not the textarea.
 *
 * Four guards in Toolbar.svelte skip work while the user is composing. They
 * used to ask `document.activeElement === textareaEl`, which reports a user who
 * has merely moved to a sibling control as having left. Tab is the case no
 * `preventDefault` can close — the audience segments bind handleComposerKeyDown
 * precisely because a keyboard user Tabs onto them, and there is no mousedown to
 * prevent — so this was reachable with every existing guard in place.
 *
 * The consequence was silent and unrecoverable: once focus was off the textarea,
 * a scroll reached the scroll-dismiss guard, which calls dismissPopup(), which
 * sets `annotationText = ""`. Type a note, press Tab, scroll to re-read the
 * passage you are annotating, and the draft is gone with no undo.
 *
 * The existing coverage in toolbar-redesign.spec.ts pins only the
 * mousedown-on-segment variant, which the preventDefault already handled.
 */
test("a typed draft survives Tab-ing out of the textarea and scrolling", async ({ page }) => {
  const editor = await openDoc(page);
  await selectFirstParagraph(editor);

  await openAnnotatePopup(page);
  const popup = page.locator(".selection-popup");
  await expect(popup).toHaveClass(/is-annotate/);

  const input = page.locator("[data-testid='popup-annotation-input']");
  await input.fill("a draft worth keeping");

  // Tab lands on a footer control — a documented interaction, not an edge case.
  await input.press("Tab");
  await expect(input, "Tab did not move focus off the composer textarea").not.toBeFocused();

  // The gesture that used to eat the draft. Dispatched on the editor so it
  // reaches the capture-phase scroll listener onOutsideEvent installs at
  // `document` — capture is what lets a listener there see an inner-scroll
  // event that never bubbles.
  await editor.evaluate((el) => {
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect(popup, "the popup was dismissed by a scroll while still in use").toHaveClass(
    /is-annotate/,
  );
  await expect(input, "the draft was silently cleared").toHaveValue("a draft worth keeping");
});

/**
 * Drag-select the first paragraph, releasing the pointer at `releaseX`.
 *
 * The popup's horizontal origin is the raw `pointerup` clientX (Toolbar.svelte's
 * `onPointerUp` sets `pointerAnchorX = e.clientX`), NOT where the text ends — so
 * releasing past the end of the line is what makes the anchor, and therefore the
 * `maxLeft` clamp, controllable from a test instead of a function of whatever
 * width the fixture's prose happens to render at.
 */
async function dragSelectParagraph(
  page: import("@playwright/test").Page,
  editor: import("@playwright/test").Locator,
  releaseX: number,
) {
  // The FIRST line box, not the element box. At a narrow viewport the paragraph
  // wraps, and the element box's vertical centre then lands in the gap between
  // the two lines — the drag selects nothing and every assertion downstream goes
  // vacuous. Measured: at 620px this paragraph is 51px tall over two lines.
  const box = await editor
    .locator("p")
    .first()
    .evaluate((el) => {
      // A Range over the contents, NOT el.getClientRects() — a block element
      // reports one border-box rect however many lines it wraps to, so the
      // "first line" read off the element IS the whole paragraph, and at a
      // narrow viewport its vertical centre lands in the gap between two lines
      // where the drag selects nothing.
      const range = document.createRange();
      range.selectNodeContents(el);
      const line = range.getClientRects()[0];
      return { x: line.x, y: line.y, height: line.height };
    });
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(releaseX, y, { steps: 8 });
  await page.mouse.up();
}

/**
 * Poll until the popup's geometry stops changing.
 *
 * Waiting for a value to *change* is not enough anywhere in this test, and that
 * is a trap worth naming: after the resize the popup's `left` moves the moment
 * `viewportWidth` updates, which happens BEFORE the measurement that is the
 * whole point. Polling for change passes on that first move and lets the
 * teardown beat the write, so the test goes green on a broken build.
 */
async function settleRect(popup: import("@playwright/test").Locator) {
  let previous = "";
  await expect
    .poll(
      async () => {
        const current = await popup.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return `${Math.round(r.left)}x${Math.round(r.width)}`;
        });
        const stable = current === previous;
        previous = current;
        return stable;
      },
      { message: "the popup never stopped moving or resizing" },
    )
    .toBe(true);
}

/**
 * Horizontal containment of the selection popup — asserted nowhere else.
 *
 * `toolbar-redesign.spec.ts`'s "stays within a short viewport" checks `box.y`
 * and `box.y + box.height` only, so the right-edge clamp in
 * computeSelectionToolbarPosition had no gate at all.
 *
 * The clamp is `maxLeft = viewportWidth - EDGE_GAP - toolbarWidth`, and
 * `toolbarWidth` stopped describing one thing when `.morph-block:not(.is-active)`
 * dropped to `width: 0`: the format state measures ~452px and the annotate state
 * ~278px. Measure in annotate state, carry that value into a format-state
 * appearance, and `maxLeft` is under-constrained by ~174px.
 *
 * THREE THINGS ARE LOAD-BEARING and the obvious shortcuts defeat all of them:
 *
 *  - **Blur without collapsing.** Clicking the editor to leave the composer
 *    collapses the selection, which tears the popup down before any measurement
 *    happens. `blur()` on the focused element leaves the editor selection alone.
 *  - **A controlled anchor.** With the anchor wherever the fixture's prose ends
 *    (~306px here) the clamp never binds at all, and the test passes on a broken
 *    build. Releasing the drag at 700px puts it inside the window where a stale
 *    width changes the answer.
 *  - **Sampling every frame.** The overhang lasts only ENTER_POPUP_MS; the
 *    settle then re-measures and the popup snaps back. A single sample taken
 *    "once the popup is visible" races that correction.
 *
 * Deliberately NOT under reduced motion: `beginEntrance` returns before setting
 * `entering` there, so the freeze this exercises does not exist.
 */
test("the selection popup stays inside the viewport near the right edge", async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 800 });
  const editor = await openDoc(page);
  const popup = page.locator(".selection-popup");

  await dragSelectParagraph(page, editor, 700);
  await expect(popup).toBeVisible();
  await openAnnotatePopup(page);
  await expect(popup).toHaveClass(/is-annotate/);

  // Wait for the composer to actually hold focus first: openAnnotateMode focuses
  // the textarea from a rAF, so blurring before that lands is a no-op the rAF
  // then undoes — and the test passes on a broken build because the metrics skip
  // was doing its job for the wrong reason.
  await expect(page.locator("[data-testid='popup-annotation-input']")).toBeFocused();
  // …and for the morph to finish, or the width this records is a mid-animation
  // frame rather than the annotate state's real width.
  await settleRect(popup);

  // Leave the textarea WITHOUT collapsing the editor selection, then resize so
  // the metrics effect re-runs and records the annotate-state width for real.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.setViewportSize({ width: 900, height: 800 });
  // The resize handler is rAF-throttled and the measurement runs behind it, so
  // wait for the whole chain to come to rest — see settleRect on why "changed"
  // is the wrong condition here.
  await settleRect(popup);

  // Collapse the selection to tear the popup down. This is clearDwell()'s other
  // caller (updateSelectionAffordance's `!next` branch), and it is the teardown a
  // user actually performs between two selections.
  await editor.click();
  await expect(popup).toHaveCount(0);

  // Sample every frame across the whole entrance and keep the worst overhang.
  const sampler = page.evaluate(async () => {
    const started = performance.now();
    let worst = Number.NEGATIVE_INFINITY;
    while (performance.now() - started < 1500) {
      const el = document.querySelector(".selection-popup");
      if (el) worst = Math.max(worst, el.getBoundingClientRect().right - window.innerWidth);
      await new Promise(requestAnimationFrame);
    }
    return worst;
  });
  await dragSelectParagraph(page, editor, 700);
  const overflow = await sampler;

  expect(
    overflow,
    "the sampler never saw the popup — the selection did not reopen it",
  ).toBeGreaterThan(Number.NEGATIVE_INFINITY);
  expect(
    Math.round(overflow),
    "the popup overhangs the right viewport edge during its entrance — maxLeft " +
      "was derived from a toolbarWidth measured in a narrower state",
  ).toBeLessThanOrEqual(0);
});

/**
 * Ctrl+Alt+M is the one appearance that never gets a second chance to measure.
 *
 * `openRequestedComposer` opens straight into the composer and rAF-focuses the
 * textarea. rAF callbacks run before ResizeObserver delivery in the same frame
 * (measured in Chromium, not assumed), so by the time updateToolbarMetrics runs
 * the textarea already holds focus. A focus gate that suppressed MEASUREMENT
 * rather than RE-measurement therefore left `toolbarWidth` at 0 for the life of
 * that composer, and `maxLeft` in computeSelectionToolbarPosition clamps against
 * `viewportWidth - EDGE_GAP - 0` — wider than the viewport, so nothing clamps.
 * Measured before the fix: the composer sat 202px off the right edge and STAYED
 * there, through the settle and for as long as it was open.
 *
 * TWO ASSERTIONS, because they are not the same claim:
 *
 *  - **Settled containment is the contract.** This is the one that was broken.
 *  - **The transient is bounded, not zero.** The width is animated and read back
 *    through a ResizeObserver, which delivers one frame late, so the clamp is
 *    always computed from the previous frame's width. Early in the unroll the
 *    width grows ~80px/frame, which is worth ~34px of overhang for ~2 frames.
 *    That is inherent to measuring an animation from its own output and is not
 *    worth chasing; the bound is here so a regression to the 202px class fails
 *    loudly rather than hiding under a loosened assertion.
 *
 * TWO THINGS ARE LOAD-BEARING in the setup, and skipping either yields a
 * decorative test that passes on a broken build — the first draft did exactly
 * that:
 *
 *  - **A pointer-set anchor.** `beginEntrance` latches `pointerAnchorX` (the
 *    pointerup clientX) when a pointerup armed the dwell, and `caretAnchorX`
 *    otherwise. The keyboard path is NOT controllable from a test: a Shift+End
 *    over this fixture measured an anchor of x=40, which leaves the popup
 *    entirely on-screen whether or not the clamp runs. Releasing a drag at 560
 *    in a 620px viewport is what puts the anchor inside the window where the
 *    measurement changes the answer.
 *  - **Beating the dwell.** The composer must be the FIRST appearance, or a
 *    dwell popup measures `toolbarWidth` first and this becomes a test of the
 *    path it is not about. Ctrl+Alt+M lands milliseconds after the pointerup,
 *    well inside DWELL_MS, and the `toHaveCount(0)` makes the alternative a
 *    loud failure rather than a quiet weaker pass.
 */
test("Ctrl+Alt+M's composer is clamped inside the viewport on its first appearance", async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 800 });
  const editor = await openDoc(page);
  const popup = page.locator(".selection-popup");

  await dragSelectParagraph(page, editor, 560);
  await expect(
    popup,
    "the dwell popup opened first and pre-measured toolbarWidth — this test no " +
      "longer exercises the first-appearance path",
  ).toHaveCount(0);

  // Sample every frame across the entrance AND past its settle, so the two
  // assertions below are answering different questions off one run.
  const sampler = page.evaluate(async () => {
    const started = performance.now();
    let worst = Number.NEGATIVE_INFINITY;
    let settled = Number.NEGATIVE_INFINITY;
    while (performance.now() - started < 1500) {
      const el = document.querySelector(".selection-popup");
      if (el) {
        const over = el.getBoundingClientRect().right - window.innerWidth;
        worst = Math.max(worst, over);
        settled = over;
      }
      await new Promise(requestAnimationFrame);
    }
    return { worst, settled };
  });
  await page.keyboard.press("Control+Alt+m");
  const { worst, settled } = await sampler;

  expect(
    worst,
    "the sampler never saw the popup — Ctrl+Alt+M did not open the composer",
  ).toBeGreaterThan(Number.NEGATIVE_INFINITY);
  expect(
    Math.round(settled),
    "the Ctrl+Alt+M composer is still hanging off the right edge after its " +
      "entrance settles — its appearance was never measured, so maxLeft " +
      "clamped against a toolbarWidth of 0",
  ).toBeLessThanOrEqual(0);
  expect(
    Math.round(worst),
    "the overhang during the unroll is larger than the ResizeObserver's " +
      "one-frame lag can account for — the clamp is running on a width that " +
      "describes something other than this popup",
  ).toBeLessThanOrEqual(60);
});

/**
 * The same first-appearance measurement, with the entrance animation removed.
 *
 * This is the arm that pins the `toolbarWidth !== 0` half of the focus gate.
 * With motion on, the entrance branch grows the width monotonically and the
 * popup is already correctly sized by the time the gate is reached, so the gate
 * has nothing left to do — a build that blocks measurement outright still
 * passes the animated test above. Reduced motion is where it bites:
 * `beginEntrance` returns before setting `entering` (there is no width unroll to
 * protect), so the entrance branch never runs at all and the ONLY chance to
 * measure this composer is the one the focus gate would swallow.
 *
 * Driven through the in-app `reduceMotion` setting rather than Playwright's
 * `reducedMotion` context option, because `motionOff()` reads both and the
 * setting is the half the product owns.
 *
 * There is no transient to tolerate here — the popup is full width on its first
 * frame — so this arm asserts the strict bound the animated one cannot.
 */
test("Ctrl+Alt+M's composer is clamped under reduced motion, where nothing animates", async ({
  page,
}) => {
  await page.addInitScript(
    ([key]) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      window.localStorage.setItem(key, JSON.stringify({ ...parsed, reduceMotion: true }));
    },
    [TANDEM_SETTINGS_KEY] as const,
  );
  await page.setViewportSize({ width: 620, height: 800 });
  const editor = await openDoc(page);
  const popup = page.locator(".selection-popup");

  await dragSelectParagraph(page, editor, 560);
  await expect(popup, "the dwell popup opened first and pre-measured toolbarWidth").toHaveCount(0);

  const sampler = page.evaluate(async () => {
    const started = performance.now();
    let worst = Number.NEGATIVE_INFINITY;
    while (performance.now() - started < 1200) {
      const el = document.querySelector(".selection-popup");
      if (el) worst = Math.max(worst, el.getBoundingClientRect().right - window.innerWidth);
      await new Promise(requestAnimationFrame);
    }
    return worst;
  });
  await page.keyboard.press("Control+Alt+m");
  const overflow = await sampler;

  expect(
    overflow,
    "the sampler never saw the popup — Ctrl+Alt+M did not open the composer",
  ).toBeGreaterThan(Number.NEGATIVE_INFINITY);
  expect(
    Math.round(overflow),
    "the composer hangs off the right edge under reduced motion — the focus " +
      "gate blocked the only measurement this appearance gets",
  ).toBeLessThanOrEqual(0);
});
