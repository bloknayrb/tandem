import { expect, test } from "@playwright/test";

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

// No MCP client: the whole point is that this state does not require a real
// agent. `/health` is stubbed, the send is client-side, and nothing here opens
// or mutates a document — so there is nothing to clean up between runs.

/**
 * Reveal the chat composer.
 *
 * `ChatPanel` is always mounted (CSS display toggle, so local state survives
 * panel switches), which means "not visible" here is a layout state, not an
 * unmounted component — hence checking visibility rather than presence, and
 * toggling only when it is actually hidden.
 */
async function openChat(page: import("@playwright/test").Page): Promise<void> {
  const composer = page.locator("[data-testid='chat-composer-input']");
  if (await composer.isVisible()) return;
  const rail = page.locator("[data-testid='titlebar-toggle-right']");
  if ((await rail.count()) > 0) await rail.click();
  const tab = page.locator("[data-testid='chat-tab']");
  if ((await tab.count()) > 0) await tab.click();
  await expect(composer).toBeVisible({ timeout: 10_000 });
}

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
  await openChat(page);

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
  // NOT the agent-absence notice: an agent is attached. The two notices are the
  // two branches of one handler, so this exclusion is the whole point of the
  // test — and it must quote the OTHER branch's live copy. It read "no AI is
  // connected" until that string was past-tensed to "no AI was connected" (the
  // tray persists `warning`s, so present tense outlives its moment); the
  // assertion went vacuously true and would have stayed green while the wrong
  // notice fired. Keep it in sync with `App.svelte`'s `no-agent` message, or
  // re-key both onto a testid.
  await expect(toast).not.toContainText("no AI was connected");
});

test("the same send stays silent when a push consumer IS attached", async ({ page }) => {
  // The negative control for the user-visible behaviour. Verified by mutation
  // that it pins the FAST PATH in `App.svelte` (`chip === null && pushDelivery
  // === "attached"` returns before the decision function is reached), not
  // `addressedAiNotice`'s rule 3 — forcing rule 3 to fire unconditionally
  // leaves this green. Rule 3 itself is pinned by
  // `tests/client/addressed-ai-notice.test.ts`, where the same mutation fails
  // two cases. Both paths must stay silent, so both are worth having; this one
  // is the one a user would notice.
  await stubHealth(page, { hasSession: true, subscribers: 1 });
  await page.goto("/");
  await page.waitForSelector("[data-testid='title-bar']", { timeout: 15_000 });
  await openChat(page);

  const composer = page.locator("[data-testid='chat-composer-input']");
  await composer.fill("are you there?");
  await composer.press("Enter");

  // Prove the send actually happened, so "no toast" means "deliberately
  // silent" rather than "the event never fired".
  await expect(composer).toHaveValue("", { timeout: 5_000 });

  // Give the handler its probe round-trip before asserting absence.
  await page.waitForTimeout(1_500);
  // By text, not via the container: when nothing is raised the container is
  // absent entirely, and `not.toContainText` on a missing element fails rather
  // than passing.
  await expect(page.getByText("next time it checks in")).toHaveCount(0);
});
