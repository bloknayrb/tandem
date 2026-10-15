import { expect, type Locator, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  setRailVisible,
} from "./helpers";

/**
 * #2014 — a chat reveal over a hover-floating rail must not land `.floating`
 * and `.float-closing` on the right shell at the same time.
 *
 * `App.svelte`'s hover-float lifecycle is `idle → floating → closing → idle`,
 * "the two phases mutually exclusive", but `class:floating` is OR-ed with
 * `railContent.revealOpen` while `class:float-closing` is not. With the reveal
 * open, a focus-out still hands off to the closing phase, both classes land,
 * the later `float-closing` rule wins at equal specificity and carries
 * `forwards`, and the revealed panel is held off-screen for `FLOAT_CLOSE_MS`.
 *
 * This cannot be reached from vitest: the lifecycle lives in `App.svelte`
 * script scope with no exported seam.
 */

test.use({ contextOptions: { reducedMotion: "no-preference" } });
// ^ `reducedMotion` is a BrowserContextOption, so it is routed through
// `contextOptions` (precedent: `annotation-ping.spec.ts`). It is a cheap guard
// on `motionOff`, not a fix for a Playwright default — the default is already
// `no-preference`.

// Duplicated literals, deliberately: these are unexported module consts in
// `src/client/App.svelte` (`HOVER_LEAVE_MS`, `FLOAT_CLOSE_MS`) and the
// `.rail-shell.collapsed` width in its stylesheet. Keep them in step by hand.
const HOVER_LEAVE_MS = 180;
const FLOAT_CLOSE_MS = 300;
const COLLAPSED_WIDTH = "14px";

const SHELL = ".rail-shell-right";
const COMPOSER = "[data-testid='chat-composer-input']";
// The `floating` class itself. `\bfloating\b` would also match
// `rail-floating-chrome` (`-` is a word boundary), which the closing phase
// carries too, so it is not a witness that the hover armed.
const FLOATING = /(?:^|\s)floating(?:\s|$)/;

let mcp: McpTestClient;
let tmpDir: string;

/**
 * Collapse the right rail and wait for the collapse to SETTLE, so a later
 * `hover()` targets the at-rest 14px shell.
 *
 * `setRailVisible` returns when the handle unmounts, which is the START of the
 * shell's 360 ms width transition. A hover that lands mid-transition aims at
 * the centre of a still-wide shell: `mouseenter` fires, the shell shrinks out
 * from under the pointer, `mouseleave` follows, and `onRailShellLeave` clears
 * the 120 ms enter timer before `railFloat.right` is ever set. Measured:
 * `hover({ force: true })` straight after `setRailVisible` failed 5 of 5 runs
 * that way, with the enter/leave pair in an event log, and passed 20 of 20
 * with this wait in front. Inferred, not measured: the unforced `hover()`
 * reaches the same point because its stability check can accept two identical
 * rects at the transition's start.
 *
 * The wait is on the computed width, the property the hover depends on; it
 * reads the in-flight value during the transition, so it passes only once the
 * shell is at rest (at most a frame before `transitionend`, with the width
 * already serialising as 14px).
 * The `animating` class is NOT a substitute: the 400 ms fallback timer in
 * `handleRailVisChange` can clear it before `transitionend` if the transition
 * started late.
 */
async function collapseRightRail(page: Page): Promise<Locator> {
  await setRailVisible(page, "right", false);
  const shell = page.locator(SHELL);
  await expect(shell).toHaveCSS("width", COLLAPSED_WIDTH);
  return shell;
}

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

test("an open chat reveal never co-exists with the float-closing phase (#2014)", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // `railHoverReveal` is deliberately NOT seeded off — the hover float is what
  // is under test here.
  const shell = await collapseRightRail(page);

  // Arm the hover float BEFORE opening the reveal. Once the reveal is open,
  // `.floating`, `[data-testid='rail-float-right']` and the float chrome all
  // come from `revealOpen` alone, so nothing in the DOM can show the hover
  // armed. A hover that never armed leaves `railFloat.right` unset and
  // `maybeHideFloat`'s `if (!railFloat[side]) return;` fires first — green on
  // unfixed master. With no reveal open yet, `.floating` is that witness, and
  // polling for it is safe: nothing moves the pointer until it resolves, so it
  // waits out the enter delay on its own.
  await shell.hover();
  await expect(shell).toHaveClass(FLOATING);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("tandem:focus-chat")));
  await expect(page.locator(COMPOSER)).toBeVisible();
  // The blur below is only the focus exit the issue names if the composer
  // holds focus; without it `maybeHideFloat` would run from the leave timer
  // instead.
  await expect(page.locator(COMPOSER)).toBeFocused();

  // Move the pointer away, then take the keyboard/programmatic focus exit the
  // issue identifies (an outside pointerdown cannot be used: the capture-phase
  // closer in `rail-content.svelte.ts` tears the reveal down first).
  await page.mouse.move(8, 400);
  await page.waitForTimeout(HOVER_LEAVE_MS + 80);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // `focusout` runs `maybeHideFloat` synchronously, so sample immediately and
  // then across the whole closing window. A plain sampling loop, NOT
  // `expect.poll`: `expect.poll` retries until the assertion PASSES, so a poll
  // for `float-closing === false` succeeds the moment the class clears and is
  // green on unfixed master. This fails on the first true.
  const readClasses = () =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return {
        closing: !!el?.classList.contains("float-closing"),
        floating: !!el?.classList.contains("floating"),
      };
    }, SHELL);

  const deadline = Date.now() + FLOAT_CLOSE_MS;
  for (;;) {
    const { closing, floating } = await readClasses();
    expect(closing).toBe(false);
    expect(floating).toBe(true);
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(50);
  }

  // The reveal is still usable at the end — kills a "fix" that closes the
  // reveal on focus-out instead.
  await expect(page.locator(COMPOSER)).toBeVisible();
});

test("a chat reveal opened DURING the retreat cancels it (#2014)", async ({ page }) => {
  // The opposite entry order to the test above, and the half a
  // `maybeHideFloat`-only fix does not cover: the closing phase is already
  // armed when the reveal opens, so the arm that refuses to ENTER it never
  // runs. `.floating` arrives from `revealOpen` on top of a `.float-closing`
  // nothing clears, and the closing keyframe's `forwards` fill holds the
  // summoned panel off-screen for the rest of FLOAT_CLOSE_MS.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  const shell = await collapseRightRail(page);

  // Arm the hover float with no reveal open (witnessed by `.floating`, as in
  // the first test), then leave so the retreat starts.
  await shell.hover();
  await expect(shell).toHaveClass(FLOATING);

  await page.mouse.move(8, 400);
  await page.waitForTimeout(HOVER_LEAVE_MS + 80);
  // The retreat window is only FLOAT_CLOSE_MS = 300 ms wide, and every
  // Playwright round trip eats into it. Checking `float-closing` from the
  // driver and THEN dispatching in a second round trip can land the dispatch
  // after `closeTimer` has already cleared the class on a loaded runner --
  // every later sample then reads `{closing: false, floating: true}` and the
  // spec passes with `cancelFloatClose("right")` deleted from `focusChat`.
  // So the check, the dispatch and the first sample all happen IN PAGE, in a
  // single round trip: the closing phase is asserted immediately before the
  // event, and the class re-read two frames later, after Svelte has flushed.
  // Without the fix that re-read is still `closing: true`.
  const afterReveal = await page.evaluate(async (sel) => {
    const el = document.querySelector(sel);
    const closingBefore = !!el?.classList.contains("float-closing");
    // Inside the closing window: the chat shortcut's own path (`focusChat`).
    window.dispatchEvent(new CustomEvent("tandem:focus-chat"));
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
    );
    return {
      closingBefore,
      closing: !!el?.classList.contains("float-closing"),
      floating: !!el?.classList.contains("floating"),
    };
  }, SHELL);
  // The retreat really was running when the reveal opened -- otherwise the
  // assertions below prove nothing.
  expect(afterReveal.closingBefore).toBe(true);
  expect(afterReveal.closing).toBe(false);
  expect(afterReveal.floating).toBe(true);

  // Sampled across the rest of the window rather than polled, for the reason
  // the first test states: a poll for `float-closing === false` passes the
  // moment the timer drops it and is green on the defect.
  const readClasses = () =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return {
        closing: !!el?.classList.contains("float-closing"),
        floating: !!el?.classList.contains("floating"),
      };
    }, SHELL);

  const deadline = Date.now() + FLOAT_CLOSE_MS;
  for (;;) {
    const { closing, floating } = await readClasses();
    expect(closing).toBe(false);
    expect(floating).toBe(true);
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(50);
  }

  await expect(page.locator(COMPOSER)).toBeVisible();
});
