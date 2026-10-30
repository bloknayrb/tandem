import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  clearChat,
  createFixtureDir,
  McpTestClient,
  openSettingsViaBrandMenu,
} from "./helpers";

/**
 * Chat-reply notifications (#2168), end to end in the browser build: a real
 * `tandem_reply` over MCP, observed by the page, routed through the attention
 * dispatcher into the Web Notifications API.
 *
 * `Notification` is replaced before any page script runs with a recorder whose
 * permission is already "granted", so no prompt is involved. Focus is driven
 * two ways. Window `blur`/`focus` events move it after boot: Playwright's focus
 * emulation pins `document.hasFocus()` to true, which is why
 * `useWindowAttention` tracks the events rather than polling it. And
 * `startUnfocused` overrides `hasFocus()` before any page script runs, so the
 * window is away from its very first frame (`readInitialFocus`) with no
 * synthetic event involved — boot sends no input, so the trusted-input
 * correction never fires.
 */

test.describe.configure({ timeout: 90_000 });

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const posted: Array<{ title: string; body?: string; tag?: string }> = [];
    (window as unknown as { __notifications: typeof posted }).__notifications = posted;
    class RecordingNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string; tag?: string }) {
        posted.push({ title, body: options?.body, tag: options?.tag });
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = RecordingNotification;
  });
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
});

test.afterEach(async () => {
  await clearChat("chat-notifications");
  try {
    await cleanupAllOpenDocuments(mcp);
    await mcp.close();
  } finally {
    cleanupFixtureDir(tmpDir);
  }
});

const posted = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __notifications: Array<{ title: string; body?: string }> })
        .__notifications,
  );

async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 10_000 });
}

/**
 * Every LATER load of this page reports `document.hasFocus() === false`, so
 * `useWindowAttention` seeds `focused` false and the window starts away.
 * Registered per call, so a test can boot focused first and away afterwards.
 */
async function startUnfocused(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Document.prototype.hasFocus = () => false;
  });
}

/** Long enough for the 750 ms coalescing window to have fired if it were going to. */
const QUIET_MS = 2_000;

test("a reply while the window is unfocused notifies once and marks the title", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));

  await mcp.callTool("tandem_reply", { text: "Here is the answer." });
  await expect.poll(() => posted(page), { timeout: 10_000 }).toHaveLength(1);
  const [first] = await posted(page);
  // Default content level is "document": names the file, no reply text.
  expect(first.title).toBe("Claude replied in sample.md");
  expect(first.body ?? "").toBe("");
  await expect(page).toHaveTitle(/^\(1\) /);

  // Back on the window: the count clears.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).not.toHaveTitle(/^\(\d+\+?\) /);
});

test("a reply while focused never notifies", async ({ page }) => {
  await boot(page);
  await mcp.callTool("tandem_reply", { text: "Answer while you watch." });
  await page.waitForTimeout(QUIET_MS);
  expect(await posted(page)).toHaveLength(0);
});

test("a window that loads without focus notifies for a reply", async ({ page }) => {
  // Positive control for the test below: the same `hasFocus` override, with
  // nothing else in the way, does produce a notification. Without it, a
  // regression that silenced every notification in an unfocused-at-load
  // window would pass the negative checks there too.
  await startUnfocused(page);
  await boot(page);

  await mcp.callTool("tandem_reply", { text: "Here is the answer." });
  await expect.poll(() => posted(page), { timeout: 10_000 }).toHaveLength(1);
  expect((await posted(page))[0].title).toBe("Claude replied in sample.md");
  await expect(page).toHaveTitle(/^\(1\) /);
});

test("an inProgress ack and history never notify; a real reply does", async ({ page }) => {
  // Precondition: `Y_MAP_CHAT_SEEN_INITIALIZED` is already set when the page
  // that sees the history boots. Its FIRST synced load marks every reply then
  // present as seen, so without this boot the history reply below would be
  // filtered out by the dispatcher's `isSeen` check and never reach the reply
  // detector's baseline at all — and the test would pass with the baseline
  // broken. The marker lives in CTRL_ROOM on the server and outlives the
  // page, so one plain boot sets it, whatever earlier specs did. The unread
  // assertion after the second boot is what proves it held.
  await boot(page);
  // `boot` waits for the editor, which needs the ctrl room synced; give the
  // seen-initialise effect a moment to have written before the page goes.
  await page.waitForTimeout(500);
  await page.goto("about:blank");

  // History: a reply that exists before the page that will watch it loads.
  // Seconds old, so the detector's `staleMs` backstop cannot be what drops it.
  await mcp.callTool("tandem_reply", { text: "Old reply from before the page loaded." });

  await startUnfocused(page);
  await boot(page);
  // The history reply is UNREAD: the away window does not acknowledge it, and
  // the first-sync baseline did not mark it seen — which it would have, had
  // the marker been unset. So only the reply detector stands between it and a
  // notification.
  await expect(page.locator("[aria-label='1 unread message']")).toBeAttached({
    timeout: 10_000,
  });
  await page.waitForTimeout(QUIET_MS);
  expect(await posted(page), "history must not notify").toHaveLength(0);

  // The ack-before-work reply (#2165): "working on it" is not the answer.
  await mcp.callTool("tandem_reply", { text: "On it.", inProgress: true });
  await page.waitForTimeout(QUIET_MS);
  expect(await posted(page), "an inProgress ack must not notify").toHaveLength(0);

  // The negative checks ran first, so the dispatcher's 30 s notify limit has
  // not been spent and cannot be what kept them quiet.
  await mcp.callTool("tandem_reply", { text: "Here is the answer." });
  await expect.poll(() => posted(page), { timeout: 10_000 }).toHaveLength(1);
  expect((await posted(page))[0].title).toBe("Claude replied in sample.md");
});

test("the Notifications settings tab persists its controls", async ({ page }) => {
  await boot(page);
  await openSettingsViaBrandMenu(page);
  await page.locator("[data-testid='settings-modal-tab-notifications']").click();
  await expect(page.locator("[data-testid='notifications-permission-status']")).toContainText(
    "allows",
  );
  await page.locator("[data-testid='notifications-content-select']").selectOption("preview");
  await page.locator("[data-testid='notifications-sound-select']").selectOption("none");
  await expect(page.locator("[data-testid='notifications-volume-slider']")).toBeDisabled();

  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("tandem:settings") ?? "{}"),
  );
  expect(stored.chatNotificationContent).toBe("preview");
  expect(stored.chatSound).toBe("none");
});

test("trusted input after a blur counts as the user being back", async ({ page }) => {
  // The synthetic blur stands in for a window that lost (or never had) focus;
  // a real keypress is trusted input, which corrects it without any `focus`
  // event — the case a false `document.hasFocus()` seed at load depends on.
  await boot(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.keyboard.press("Shift");

  await mcp.callTool("tandem_reply", { text: "Answer after you pressed a key." });
  await page.waitForTimeout(2_000);
  expect(await posted(page)).toHaveLength(0);
  await expect(page).not.toHaveTitle(/^\(\d+\+?\) /);
});

test("with 'visible beside other apps' on, a blurred visible window does not notify", async ({
  page,
}) => {
  // Each test gets a fresh browser context, so this setting does not leak.
  await boot(page);
  await openSettingsViaBrandMenu(page);
  await page.locator("[data-testid='settings-modal-tab-notifications']").click();
  const toggle = page.locator("[data-testid='notifications-visible-toggle'] input");
  await toggle.check();
  await expect(toggle).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid='settings-modal']")).toBeHidden();

  // Blur AFTER the last input, so the trusted-input correction cannot be what
  // keeps the window active — only the setting can.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await mcp.callTool("tandem_reply", { text: "Answer beside your terminal." });
  await page.waitForTimeout(2_000);
  expect(await posted(page)).toHaveLength(0);
});
