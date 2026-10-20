import { expect, type Page, test } from "@playwright/test";
import { cleanupAllOpenDocuments, McpTestClient, openChat } from "./helpers";

/**
 * Tandem's Claude stopped by choice (#2195): the status pill, the empty state
 * and the chat panel offer Start; the chat panel offers Turn off while it runs;
 * Settings saves the start mode as a partial patch. And a chat sent while it is
 * stopped shows "resuming" until it runs (#2196) — the server's start itself is
 * the supervisor's, covered in `supervisor-turn-delivery.test.ts`.
 *
 * Everything launcher-shaped is stubbed. The E2E backend has no claude-code
 * integration (so its real supervisor reports `not-configured`), and the
 * backend is shared across spec files, whose MCP test clients leave a session
 * counted live for about a minute — which would promote readiness to `ready`
 * and hide every CTA. So `/health`, `/api/launcher/status`, the nonce and the
 * mutations are all routed before `page.goto`.
 */

/** Close every open document. A page load with nothing open auto-opens a
 * Scratchpad (#842), which stays open on the shared backend for the next test
 * and would hide the empty state the Start test needs. */
async function closeAllDocuments(): Promise<void> {
  const mcp = new McpTestClient();
  await mcp.connect();
  try {
    await cleanupAllOpenDocuments(mcp);
  } finally {
    await mcp.close();
  }
}

test.afterEach(closeAllDocuments);

async function stubLauncher(
  page: Page,
  status: Record<string, unknown> | (() => Record<string, unknown>),
): Promise<{ posts: Array<{ url: string; body: Record<string, unknown> }> }> {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  await page.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        version: "test",
        transport: "http",
        hasSession: false,
        sessionCount: 0,
        push: { subscribers: 0, lastEventAt: null, eventCount: 0 },
      }),
    }),
  );
  await page.route("**/api/launcher/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(typeof status === "function" ? status() : status),
    }),
  );
  await page.route("**/api/launcher/nonce", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ nonce: "e2e-nonce" }),
    }),
  );
  for (const path of ["start", "settings"]) {
    await page.route(`**/api/launcher/${path}`, async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.fallback();
      posts.push({ url: path, body: req.postDataJSON() as Record<string, unknown> });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          path === "start"
            ? { ok: true, started: true }
            : {
                ok: true,
                settings: { startMode: "off", lifetime: "always", idleMinutes: 30 },
              },
        ),
      });
    });
  }
  return { posts };
}

test("off: the pill says so and is the Start button", async ({ page }) => {
  const { posts } = await stubLauncher(page, {
    available: true,
    running: false,
    standby: "off",
  });
  await page.goto("/");
  const pill = page.locator("[data-testid='status-ai-indicator'][data-ai-state='standby']");
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await expect(pill).toContainText("Tandem's Claude is off");
  await expect(pill).toHaveAttribute("data-ai-action", "start");
  await pill.click();
  await expect
    .poll(() => posts.find((p) => p.url === "start")?.body)
    .toEqual({
      userInitiated: true,
      nonce: "e2e-nonce",
    });
});

test("the empty state offers Start, not Restart, for an idle-stopped Claude", async ({ page }) => {
  const { posts } = await stubLauncher(page, {
    available: true,
    running: false,
    standby: "idle",
  });
  // The empty state auto-opens a Scratchpad 400 ms after it appears (#842), and
  // a document left open by an earlier test hides it from the start. Hold the
  // auto-open's request unanswered, so the empty state stays put, and close
  // whatever is open first.
  await page.route("**/api/scratchpad", () => {});
  await closeAllDocuments();
  await page.goto("/");
  const start = page.locator("[data-testid='empty-state-start-claude']");
  await expect(start).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-testid='empty-state-restart-claude']")).toHaveCount(0);
  await start.click();
  await expect.poll(() => posts.some((p) => p.url === "start")).toBe(true);
});

test("the chat panel's Start works on an empty chat", async ({ page }) => {
  const { posts } = await stubLauncher(page, {
    available: true,
    running: false,
    standby: "awaiting-start",
  });
  await page.goto("/");
  await page.waitForSelector("[data-testid='title-bar']", { timeout: 15_000 });
  await openChat(page);
  const toggle = page.locator("[data-testid='chat-tandem-claude-toggle']");
  await expect(toggle).toHaveAttribute("data-action", "start", { timeout: 15_000 });
  await toggle.click();
  await expect
    .poll(() => posts.find((p) => p.url === "start")?.body)
    .toMatchObject({
      userInitiated: true,
    });
});

test("the chat panel's Turn off sends startMode alone", async ({ page }) => {
  const { posts } = await stubLauncher(page, {
    available: true,
    running: true,
    reaperPid: 1,
    cwd: "/home/e2e",
    sessionId: "<set>",
    resuming: false,
    busy: false,
    attached: false,
  });
  await page.goto("/");
  await page.waitForSelector("[data-testid='title-bar']", { timeout: 15_000 });
  await openChat(page);
  const toggle = page.locator("[data-testid='chat-tandem-claude-toggle']");
  await expect(toggle).toHaveAttribute("data-action", "turn-off", { timeout: 15_000 });
  await toggle.click();
  await expect
    .poll(() => posts.find((p) => p.url === "settings")?.body)
    .toEqual({
      patch: { startMode: "off" },
      nonce: "e2e-nonce",
    });
});

async function sendChat(page: Page, text: string): Promise<void> {
  await openChat(page);
  const input = page.locator("[data-testid='chat-composer-input']");
  await input.fill(text);
  await input.press("Enter");
}

test("a chat while Claude is idle-stopped shows 'resuming' until it runs (#2196)", async ({
  page,
}) => {
  let status: Record<string, unknown> = {
    available: true,
    running: false,
    standby: "idle",
    startsOnMessage: true,
  };
  await stubLauncher(page, () => status);
  await page.goto("/");
  await page.waitForSelector("[data-testid='title-bar']", { timeout: 15_000 });
  // Let the first status read land, so the send sees the standby.
  await expect(
    page.locator("[data-testid='status-ai-indicator'][data-ai-state='standby']"),
  ).toBeVisible({
    timeout: 15_000,
  });
  await sendChat(page, "are you there?");
  const row = page.locator("[data-testid='chat-tandem-claude-resuming']");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Claude is resuming");
  await expect(page.locator("[data-testid='chat-pickup-status']")).toHaveCount(0);
  // The chat toggle's Start is hidden beside it.
  await expect(page.locator("[data-testid='chat-tandem-claude-toggle']")).toHaveCount(0);
  // And no "nothing will answer" toast. The other test shows that toast landing
  // within a second of the send; give it longer than that to be sure it is not
  // just late.
  await page.waitForTimeout(2_000);
  await expect(page.getByText("nothing will answer")).toHaveCount(0);
  // The server's start shows up on a post-send re-read.
  status = {
    available: true,
    running: true,
    reaperPid: 1,
    cwd: "/home/e2e",
    sessionId: "<set>",
    resuming: true,
    busy: true,
    attached: false,
  };
  await expect(row).toHaveCount(0, { timeout: 15_000 });
});

test("with another AI attached, a chat promises nothing (#2196)", async ({ page }) => {
  // No `startsOnMessage`: the server said a message would not start Claude.
  await stubLauncher(page, { available: true, running: false, standby: "off" });
  await page.goto("/");
  await expect(
    page.locator("[data-testid='status-ai-indicator'][data-ai-state='standby']"),
  ).toBeVisible({
    timeout: 15_000,
  });
  await sendChat(page, "hello");
  // Positive anchor: the send happened and the ordinary pickup row shows.
  await expect(page.locator("[data-testid='chat-pickup-status']")).toBeVisible();
  await expect(page.locator("[data-testid='chat-tandem-claude-resuming']")).toHaveCount(0);
  // The send toast is NOT held back here — the control for the test above.
  await expect(page.getByText("nothing will answer")).toBeVisible({ timeout: 5_000 });
});

test("the greeting that never came shows how to fix it, and only while late (#2197)", async ({
  page,
}) => {
  let status: Record<string, unknown> = {
    available: true,
    running: true,
    reaperPid: 1,
    cwd: "/home/e2e",
    sessionId: "<set>",
    resuming: false,
    busy: false,
    attached: false,
    greetingLate: true,
  };
  await stubLauncher(page, () => status);
  await page.goto("/");
  await page.waitForSelector("[data-testid='title-bar']", { timeout: 15_000 });
  await openChat(page);
  const note = page.locator("[data-testid='chat-greeting-late']");
  await expect(note).toBeVisible({ timeout: 15_000 });
  await expect(note).toContainText("hasn't said hello");
  await expect(page.locator("[data-testid='chat-greeting-late-action']")).toHaveText(
    "Restart Tandem's Claude",
  );
  // The hello arrives (the server stops reporting it late): the note goes.
  status = { ...status, greetingLate: undefined };
  await expect(note).toHaveCount(0, { timeout: 15_000 });
});
