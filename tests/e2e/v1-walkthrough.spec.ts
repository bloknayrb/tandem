import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * The v1.0 setup walkthrough, end to end in the browser (#2198).
 *
 * The harness sets `TANDEM_DISABLE_FIRST_RUN_WIZARD=1` and its server is not a
 * v1.0 release, so the server half (the marker, the confirm route's gates, the
 * Apply that finishes it, the boot hold) is pinned in vitest. Here the
 * first-run answer and the confirm are route-fulfilled, so the spec drives the
 * client's half against them: the wizard opens by itself, closing it does not
 * dismiss it for the version (it comes back on the next launch — a fresh
 * browser context), and Keep confirms the version it was shown for. The
 * confirm is fulfilled too: the real server would answer 409 at a 0.x version,
 * and must never be loosened to make this pass.
 */

const WIZARD = "[data-testid='integration-wizard']";
const KEEP = "[data-testid='integration-wizard-keep-setup']";
const CLOSE = "[data-testid='integration-wizard-close']";
const VERSION = "1.0.0";

interface Server {
  walkthrough: boolean;
  /** A server start: each launch() is a new one. */
  launch: number;
  confirms: unknown[];
}

async function serve(context: BrowserContext, server: Server): Promise<void> {
  await context.route("**/api/integrations/first-run-needed", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        needed: server.walkthrough,
        walkthrough: server.walkthrough,
        serverVersion: VERSION,
        launchId: `launch-${server.launch}`,
        confirmationNonce: "e2e-nonce",
      }),
    }),
  );
  await context.route("**/api/integrations/walkthrough-confirm", (route) => {
    server.confirms.push(route.request().postDataJSON());
    server.walkthrough = false;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, tandemClaude: "held" }),
    });
  });
}

/** A launch: a fresh context has fresh sessionStorage, as a restarted app does. */
async function launch(
  browser: import("@playwright/test").Browser,
  server: Server,
): Promise<{ context: BrowserContext; page: Page }> {
  // A context made here does not inherit the project's `use`, so the base
  // URL is passed on explicitly.
  server.launch += 1;
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await serve(context, server);
  const page = await context.newPage();
  await page.goto("/");
  return { context, page };
}

test("the walkthrough comes back each launch until Keep, and Keep confirms its version", async ({
  browser,
}) => {
  const server: Server = { walkthrough: true, launch: 0, confirms: [] };

  // Launch 1: it opens by itself, offering Keep. Closing it does not write the
  // per-version dismissal that ends the first-run prompt for good.
  const first = await launch(browser, server);
  await expect(first.page.locator(WIZARD)).toBeVisible({ timeout: 15_000 });
  await expect(first.page.locator(KEEP)).toBeVisible({ timeout: 10_000 });
  await first.page.locator(CLOSE).click();
  await expect(first.page.locator(WIZARD)).toHaveCount(0);
  expect(
    await first.page.evaluate(() => localStorage.getItem("tandem:wizard-dismissed")),
  ).toBeNull();
  // Not again in this session: a reload of the same tab stays closed.
  await first.page.reload();
  await first.page.waitForLoadState("load");
  await first.page.waitForTimeout(1_500);
  await expect(first.page.locator(WIZARD)).toHaveCount(0);
  await first.context.close();

  // Launch 2: back again. Keep confirms the version it was shown for.
  const second = await launch(browser, server);
  await expect(second.page.locator(KEEP)).toBeVisible({ timeout: 15_000 });
  await second.page.locator(KEEP).click();
  await expect(second.page.locator(WIZARD)).toHaveCount(0);
  expect(server.confirms).toEqual([{ serverVersion: VERSION }]);
  await second.context.close();

  // Launch 3: the server says it is done — no wizard.
  const third = await launch(browser, server);
  await third.page.waitForTimeout(2_000);
  await expect(third.page.locator(WIZARD)).toHaveCount(0);
  await third.context.close();
});
