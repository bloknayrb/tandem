import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  clearChat,
  createFixtureDir,
  McpTestClient,
  openChat,
} from "./helpers";

/**
 * Chat auto-scroll moves the messages list and nothing else.
 *
 * It used to call `scrollIntoView` on an end sentinel, which scrolls EVERY
 * scrollable ancestor — including `.rail-full-right`, which is `overflow: hidden`
 * but still script-scrollable. The rail's content (the tabs row with it) shifted
 * by a distance the user could not scroll back, and every document-level scroll
 * listener saw a scroll event per frame of the smooth scroll (measured in #2329,
 * where the selection popup's scroll-dismiss had to learn to ignore it).
 *
 * The rail had something to scroll only because the panel's srOnly live region
 * is `position: absolute` and the list was not positioned, so the announcer's
 * static position at the end of the history extended the RAIL's overflow
 * (measured: 2517px of content in a 552px rail). The list is now its containing
 * block. Either half alone keeps the rail still; this spec pins the containment
 * half (the rail has no overflow) and the outcome, and the ChatPanel unit tests
 * pin the mechanism half (the list is scrolled, `scrollIntoView` never called).
 */

test.describe.configure({ timeout: 90_000 });

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
});

test.afterEach(async () => {
  await clearChat("chat-autoscroll");
  try {
    await cleanupAllOpenDocuments(mcp);
    await mcp.close();
  } finally {
    cleanupFixtureDir(tmpDir);
  }
});

const RAIL = ".rail-full-right";
const MESSAGES = "[data-testid='chat-messages']";

test("a message arriving with chat open scrolls the list, never the rail", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 10_000 });
  await openChat(page);

  // Enough history that the list overflows, so the arriving message has to scroll.
  const long = "A reply long enough to wrap across several lines of the chat panel. ".repeat(4);
  for (let i = 0; i < 12; i++) await mcp.callTool("tandem_reply", { text: `${i}: ${long}` });
  const list = page.locator(MESSAGES);
  await expect(list).toContainText("11: ");
  // Precondition: there is something to scroll, or the positive control below is vacuous.
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // Let the history's own smooth scrolls finish before resetting, so none is
  // still running when the list is moved to the top and the recorder starts.
  const fromBottom = () => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(fromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(1);

  // Start from a known state: rail unscrolled, list away from the bottom, and a
  // recorder for scroll events on the rail itself (scroll does not bubble, so
  // listening on the element is what sees them).
  await page.evaluate(
    ([railSel, listSel]) => {
      const rail = document.querySelector(railSel) as HTMLElement;
      rail.scrollTop = 0;
      (document.querySelector(listSel) as HTMLElement).scrollTop = 0;
      const w = window as unknown as { __railScrolls: number };
      w.__railScrolls = 0;
      rail.addEventListener("scroll", () => {
        w.__railScrolls++;
      });
    },
    [RAIL, MESSAGES] as const,
  );

  // Precondition for the positive control: the reset really left the list at the top.
  expect(await fromBottom()).toBeGreaterThan(1);
  await mcp.callTool("tandem_reply", { text: "the newest message" });
  await expect(list).toContainText("the newest message");

  // Positive control: auto-scroll still reaches the bottom of the list.
  await expect.poll(fromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(1);

  const rail = await page
    .locator(RAIL)
    .evaluate((el) => ({ top: el.scrollTop, overflow: el.scrollHeight - el.clientHeight }));
  expect(rail.overflow, "nothing in the rail gives a script anything to scroll").toBe(0);
  expect(rail.top).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { __railScrolls: number }).__railScrolls),
  ).toBe(0);
});
