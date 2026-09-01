import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  RAIL_HANDLE_TESTID,
  setRailVisible,
} from "./helpers";

/**
 * Characterization coverage for the transient chat reveal, written BEFORE
 * ADR-035 Unit 10c moves that state out of `App.svelte`.
 *
 * The reveal is Chat floated over a *collapsed* right rail: `focusChat()` opens
 * it, and it is torn down by Escape, an outside click, a successful send, or a
 * document switch. Every one of those paths was uncovered end-to-end. Unit 10c
 * re-plumbs all of them, so this file is the net the extraction gets to fail
 * against — it records what the app does today, not what it should do.
 *
 * **`railHoverReveal` is seeded off, and the honest reason is narrower than the
 * one this file was planned around.** There is genuinely no DOM signal that
 * distinguishes the chat reveal from the *hover* float: `App.svelte` puts
 * `class:floating` and `data-testid="rail-float-right"` on the shell for
 * `railFloat.right || chatReveal` alike, the setting defaults to `true`
 * (`useTandemSettings.ts`), hover-float arms 120ms after `mouseenter` on a
 * collapsed rail, and Playwright's `.click()` leaves the real pointer where it
 * clicked. The plan predicted that "a click inside does not close it" and
 * "sending closes it" would therefore be **green with their guard deleted**, and
 * that the seeding was the only thing making them real.
 *
 * **Run, both were RED with the guard deleted and the seeding removed.** So the
 * confound exists in the markup but does not reach these two assertions, and the
 * seeding is defensive rather than load-bearing. It stays: it costs one line and
 * it removes a 120ms timing race from a signal every spec here reads. Do not
 * re-derive the stronger claim from the shared testid — it was measured and it
 * is wrong.
 *
 * Seeding a partial blob has a second consequence worth knowing before you add
 * a case: `normalizeKnownFields` reads a missing `primaryTab` as `"chat"`, so
 * these runs open on the Chat tab. That is what the reveal wants anyway, and it
 * is why nothing here calls `switchToAnnotationsTab`.
 */

let mcp: McpTestClient;
let tmpDir: string;

/** Seed `railHoverReveal: false` before boot — see the file header. */
async function disableHoverReveal(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const KEY = "tandem:settings";
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    } catch {
      existing = {};
    }
    localStorage.setItem(KEY, JSON.stringify({ ...existing, railHoverReveal: false }));
  });
}

const REVEAL = "[data-testid='rail-float-right']";
const COMPOSER = "[data-testid='chat-composer-input']";
const RIGHT_HANDLE = `[data-testid='${RAIL_HANDLE_TESTID.right}']`;

/**
 * Collapse the right rail and open the reveal, returning the reveal locator.
 *
 * Uses the `tandem:focus-chat` window event rather than the Ctrl+Shift+J chord.
 * The chord works, but it is also Chrome's DevTools shortcut; CDP key dispatch
 * does not normally trigger browser UI, and resting a whole file on that is a
 * bet this file does not need to take. One spec below drives the chord anyway,
 * so the binding itself stays covered.
 */
/**
 * Seed the hover setting, open `sample.md`, and wait for its tab.
 *
 * Every spec but the document-switch one starts exactly here, and the seeding
 * has to happen before `page.goto` -- which is the step easiest to drop when
 * copying a test, and drops silently.
 */
async function bootWithSample(page: import("@playwright/test").Page): Promise<void> {
  await disableHoverReveal(page);
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible();
}

async function openReveal(page: import("@playwright/test").Page) {
  // Rail collapsed: `focusChat` only reveals when the rail is NOT already up.
  // `setRailVisible` rather than the chord inline -- it presses only when the
  // rail is not already in the wanted state, where a bare press would toggle a
  // collapsed rail back open and fail the assertion it is paired with.
  await setRailVisible(page, "right", false);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("tandem:focus-chat")));
  const reveal = page.locator(REVEAL);
  await expect(reveal).toHaveCount(1);
  await expect(page.locator(COMPOSER)).toBeVisible();
  return reveal;
}

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md", "sample2.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("focusChat over a collapsed rail opens the reveal, and the rail stays collapsed", async ({
  page,
}) => {
  await bootWithSample(page);

  await openReveal(page);

  // The distinguishing half: a reveal is NOT a pinned rail. If `focusChat`
  // ever pinned instead of floating, every other assertion in this file would
  // still pass, so the handle's absence is what makes them mean anything.
  await expect(page.locator(RIGHT_HANDLE)).toHaveCount(0);
});

test("Ctrl+Shift+J opens the reveal too", async ({ page }) => {
  await bootWithSample(page);

  await setRailVisible(page, "right", false);

  // The bound chord, so the keybinding is covered and not only the window
  // event the other specs use.
  await page.keyboard.press("Control+Shift+J");
  await expect(page.locator(REVEAL)).toHaveCount(1);
  await expect(page.locator(COMPOSER)).toBeVisible();
});

test("Escape closes the reveal", async ({ page }) => {
  await bootWithSample(page);

  const reveal = await openReveal(page);
  // From the composer, because that is where focus lands and because the
  // teardown listener is capture-phase specifically so it beats the textarea.
  await page.locator(COMPOSER).press("Escape");
  await expect(reveal).toHaveCount(0);
  await expect(page.locator(RIGHT_HANDLE)).toHaveCount(0);
});

test("a click outside the rail closes the reveal", async ({ page }) => {
  await bootWithSample(page);

  const reveal = await openReveal(page);
  await page.locator(".ProseMirror").click();
  await expect(reveal).toHaveCount(0);
});

test("a click INSIDE the reveal does not close it", async ({ page }) => {
  await bootWithSample(page);

  const reveal = await openReveal(page);
  // The capture-phase `pointerdown` handler returns early for any target inside
  // `.rail-shell-right`. Deleting that early return turns this spec red -- with
  // or without the hover seeding; see the header.
  await page.locator(COMPOSER).click();
  await expect(reveal).toHaveCount(1);
  await expect(page.locator(COMPOSER)).toBeVisible();
});

test("sending a message closes the reveal", async ({ page }) => {
  await bootWithSample(page);

  const reveal = await openReveal(page);
  await page.locator(COMPOSER).fill("characterization message");
  await page.locator(COMPOSER).press("Enter");
  await expect(reveal).toHaveCount(0);
});

test("switching document closes the reveal", async ({ page }) => {
  await disableHoverReveal(page);
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("/");
  const first = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  await expect(first).toBeVisible();

  const reveal = await openReveal(page);
  // **Ctrl+Tab, not a click on the tab strip, and that is the whole point.**
  // A click lands outside `.rail-shell-right`, so the capture-phase
  // `pointerdown` closer fires first and the spec then passes with the
  // document-switch effect DELETED -- measured, not assumed: the clicking
  // version was GREEN against exactly that mutant. A keyboard switch raises no
  // pointer event, so the effect is the only thing left that can close it.
  await page.keyboard.press("Control+Tab");
  await expect(reveal).toHaveCount(0);
});

test("#1719: selecting Annotations from inside the reveal collapses the whole rail", async ({
  page,
}) => {
  // A CHARACTERIZATION of a known defect, not an endorsement. Selecting the
  // Annotations tab runs `selectRailTab`, which tears the reveal down — and the
  // reveal was the only thing rendering the rail, so the user gets neither tab
  // and no message. Filed as #1719; **delete this spec when it is fixed.**
  //
  // The assertion is the positive post-state, not the symptom: "the composer is
  // hidden" is equally true once #1719 is fixed, which would leave a pin that
  // stays green through its own repair. A fix leaves the rail OPEN on
  // Annotations, so asserting the rail is fully collapsed is what fails then.
  await bootWithSample(page);

  const reveal = await openReveal(page);
  await page.locator("[data-testid='annotations-tab']").click();

  await expect(reveal).toHaveCount(0);
  // The rail handle is the discriminator: it is how every spec detects rail
  // visibility, and a #1719 fix leaves the rail open, which puts it back.
  await expect(page.locator(RIGHT_HANDLE)).toHaveCount(0);
  // VISIBILITY, not presence. The rail tabs are always mounted and the shell
  // collapses by CSS, so `annotations-tab` still resolves to one element with
  // the rail shut -- a `toHaveCount(0)` here fails against today's behaviour
  // and would have read as the defect being absent.
  await expect(page.locator("[data-testid='annotations-tab']")).not.toBeVisible();
});
