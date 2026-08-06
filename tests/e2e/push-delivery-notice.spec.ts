import { expect, test } from "@playwright/test";
import { cleanupAllOpenDocuments, McpTestClient } from "./helpers";

/**
 * The delivery notice: a comment or chat message saved while an agent IS
 * attached but nothing is pushing to it.
 *
 * This is the state a hand-launched `claude` session is in — the channel shim
 * needs a flag most users never type — and before this notice existed the
 * handler returned silently the moment a session was present, which is exactly
 * that case. The user got no feedback at all, under a status pill reading
 * "AI connected".
 *
 * `/health` is stubbed rather than arranged, because the two fields are
 * structurally disjoint: the harness can produce `subscribers: 0` naturally (no
 * channel shim runs in E2E) but not a live `hasSession` without attaching a
 * real MCP transport for the duration. Stubbing sets both at once and lets each
 * case flip a single variable.
 */

let mcp: McpTestClient;

test.beforeAll(async () => {
  mcp = new McpTestClient();
  await mcp.initialize();
});

test.afterAll(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
});

/** Stub `/health` with a chosen session + push-consumer state. */
async function stubHealth(
  page: import("@playwright/test").Page,
  opts: { hasSession: boolean; subscribers: number },
): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        version: "test",
        transport: "http",
        hasSession: opts.hasSession,
        push: { subscribers: opts.subscribers, lastEventAt: null, eventCount: 0 },
      }),
    });
  });
}

test("a chat send with an attached agent but no push consumer explains the delay", async ({
  page,
}) => {
  await stubHealth(page, { hasSession: true, subscribers: 0 });
  await page.goto("/");
  await page.waitForSelector("[data-testid='title-bar']", { timeout: 15_000 });

  // Send a chat message — ChatPanel dispatches `tandem:addressed-ai` after it
  // persists, which is what the notice hangs off.
  await page.locator("[data-testid='chat-composer-input']").fill("are you there?");
  await page.locator("[data-testid='chat-composer-input']").press("Enter");

  const toast = page.locator("[data-testid='toast-container']");
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toContainText("next time it checks in");
  // Affirms the save and frames the gap as deferred delivery — never
  // "failed"/"lost", because nothing was lost.
  await expect(toast).toContainText("saved");
  // NOT the agent-absence notice: an agent is attached.
  await expect(toast).not.toContainText("no AI is connected");
});

test("the same send stays silent when a push consumer IS attached", async ({ page }) => {
  // The negative control. Without it, a notice that fired unconditionally
  // would pass the test above.
  await stubHealth(page, { hasSession: true, subscribers: 1 });
  await page.goto("/");
  await page.waitForSelector("[data-testid='title-bar']", { timeout: 15_000 });

  await page.locator("[data-testid='chat-composer-input']").fill("are you there?");
  await page.locator("[data-testid='chat-composer-input']").press("Enter");

  // Give the handler its probe round-trip before asserting absence.
  await page.waitForTimeout(1_500);
  await expect(page.locator("[data-testid='toast-container']")).not.toContainText(
    "next time it checks in",
  );
});
