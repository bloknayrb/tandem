import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { E2E_MCP_PORT } from "../../scripts/test-ports.js";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
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
 * with window `blur`/`focus` events: Playwright's focus emulation pins
 * `document.hasFocus()` to true, which is why `useWindowAttention` tracks the
 * events rather than polling it.
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
  try {
    const res = await fetch(`http://127.0.0.1:${E2E_MCP_PORT}/api/chat`, { method: "DELETE" });
    if (!res.ok) console.warn(`[chat-notifications] clearing chat answered ${res.status}`);
  } catch (err) {
    console.warn("[chat-notifications] clearing chat failed:", err);
  }
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

test("a reply while focused, an inProgress ack, and history never notify", async ({ page }) => {
  // History: a reply that exists before the page loads.
  await mcp.callTool("tandem_reply", { text: "Old reply from before the page loaded." });
  await boot(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await mcp.callTool("tandem_reply", { text: "On it.", inProgress: true });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await mcp.callTool("tandem_reply", { text: "Answer while you watch." });
  // Give the 750 ms coalescing window ample time to have fired if it were going to.
  await page.waitForTimeout(2_000);
  expect(await posted(page)).toHaveLength(0);
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
