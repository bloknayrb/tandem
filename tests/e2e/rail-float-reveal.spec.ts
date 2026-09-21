import { expect, test } from "@playwright/test";
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
// `src/client/App.svelte` (`HOVER_ENTER_MS`, `HOVER_LEAVE_MS`,
// `FLOAT_CLOSE_MS`). Keep them in step by hand.
const HOVER_ENTER_MS = 120;
const HOVER_LEAVE_MS = 180;
const FLOAT_CLOSE_MS = 300;

const SHELL = ".rail-shell-right";
const COMPOSER = "[data-testid='chat-composer-input']";

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

test("an open chat reveal never co-exists with the float-closing phase (#2014)", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();

  // `railHoverReveal` is deliberately NOT seeded off — the hover float is what
  // is under test here.
  await setRailVisible(page, "right", false);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("tandem:focus-chat")));

  const shell = page.locator(SHELL);
  await expect(shell).toHaveClass(/\bfloating\b/);
  await expect(page.locator(COMPOSER)).toBeVisible();

  // Arm the hover float. The wait is a deterministic hold, NOT a poll on
  // `[data-testid='rail-float-right']`: that testid is present from
  // `revealOpen` alone, so a poll resolves immediately, the pointer can leave
  // inside the 120 ms enter delay, `onRailShellLeave` clears the pending enter
  // timer, `railFloat.right` is never set, and `maybeHideFloat`'s
  // `if (!railFloat[side]) return;` fires first — green on unfixed master.
  await shell.hover();
  await page.waitForTimeout(HOVER_ENTER_MS + 150);

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
