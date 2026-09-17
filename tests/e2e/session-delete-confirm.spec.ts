import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * #1773 — the open dialog's per-session `×` and "Clear all" used to call the
 * delete routes on the first click, with no confirmation, undo or toast. Both
 * are now inline two-step confirms (the BulkActions shape).
 *
 * Deterministic without server-side session state: the `/api/sessions` list is
 * route-fulfilled with a fixed two-row payload (precedent settings-modal.spec.ts
 * :164) and the mutating routes are counted rather than executed, so the real
 * session store is never touched.
 *
 * The stub is kept at exactly TWO rows on purpose. One `session-delete` button
 * exists per row inside a keyed {#each}, so a bare `getByTestId("session-delete")`
 * would be a strict-mode violation *only when the fix works* — every locator
 * below is scoped to its row instead.
 */

let mcp: McpTestClient;
let tmpDir: string;

const SESSION_ROWS = [
  { filePath: "C:/notes/alpha.md", lastAccessed: Date.now(), annotationCount: 3 },
  { filePath: "C:/notes/beta.md", lastAccessed: Date.now(), annotationCount: 1 },
];

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

/**
 * Route-stub the sessions list and TIMESTAMP every call to one mutating route.
 *
 * Timestamps rather than a bare counter, because "0 calls right after arming"
 * is not a testable claim: `expect.poll` returns on its first passing sample,
 * so a counter that starts at 0 satisfies it instantly and supplies no settle
 * time at all — a request dispatched a moment later is never observed. What IS
 * deterministic is ordering: wait for the ONE call the confirm click must
 * produce, then assert it post-dates that click. On an arm-also-fires build the
 * observed call is the arm's, whose timestamp precedes the click, and the
 * assertion fails whether or not the confirm's own request has landed yet.
 * Same process, so `Date.now()` here and in the test body share one clock.
 */
async function stubSessions(
  page: import("@playwright/test").Page,
  mutatingRoute: string,
): Promise<() => number[]> {
  const calls: number[] = [];
  // The two patterns are disjoint by construction: a Playwright URL glob must
  // match the whole URL, and "**/api/sessions" has nothing to match the POSTs'
  // trailing "/delete" or "/clear" against. Registration order is therefore not
  // load-bearing here — unlike the component test, where the stub branches on
  // `includes()` and the prefix genuinely does overlap.
  await page.route(mutatingRoute, async (route) => {
    calls.push(Date.now());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ error: false, data: {} }),
    });
  });
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ error: false, data: { sessions: SESSION_ROWS } }),
    });
  });
  return () => calls;
}

/**
 * Assert the one observed request post-dates the confirm click, i.e. the ARM
 * click fired nothing. See the stubSessions doc comment for why this is the
 * discriminator and a "still 0 calls" read is not.
 */
function expectFiredOnlyOnConfirm(calls: number[], confirmClickAt: number) {
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBeGreaterThanOrEqual(confirmClickAt);
}

/** Open the document, show the dialog and expand the saved-sessions list. */
async function openSessionsList(page: import("@playwright/test").Page) {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" })).toBeVisible({
    timeout: 15_000,
  });

  await page.keyboard.press("Control+o");
  await expect(page.getByTestId("file-open-dialog")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("sessions-toggle").click();
  await expect(page.getByTestId("session-row")).toHaveCount(2, { timeout: 5_000 });
}

test("the per-session × arms a confirm instead of deleting (#1773)", async ({ page }) => {
  const deleteCalls = await stubSessions(page, "**/api/sessions/delete");
  await openSessionsList(page);

  const firstRow = page.getByTestId("session-row").nth(0);
  await firstRow.getByTestId("session-delete").click();
  await expect(firstRow.getByTestId("session-delete-confirm")).toBeVisible({ timeout: 2_000 });

  // The row is still there, so the arm did not delete it through the UI. The
  // "no request fired" half is the ordering assertion below, not a read here.
  await expect(page.getByTestId("session-row")).toHaveCount(2);

  const confirmClickAt = Date.now();
  await firstRow.getByTestId("session-delete-confirm").click();
  await expect.poll(() => deleteCalls().length, { timeout: 5_000 }).toBe(1);
  expectFiredOnlyOnConfirm(deleteCalls(), confirmClickAt);
  await expect(page.getByTestId("session-row")).toHaveCount(1);
});

test("Clear all arms its own confirm instead of clearing (#1773)", async ({ page }) => {
  const clearCalls = await stubSessions(page, "**/api/sessions/clear");
  await openSessionsList(page);

  await page.getByTestId("sessions-clear-all").click();
  await expect(page.getByTestId("sessions-clear-all-confirm")).toBeVisible({ timeout: 2_000 });
  await expect(page.getByTestId("session-row")).toHaveCount(2);

  const confirmClickAt = Date.now();
  await page.getByTestId("sessions-clear-all-confirm").click();
  await expect.poll(() => clearCalls().length, { timeout: 5_000 }).toBe(1);
  expectFiredOnlyOnConfirm(clearCalls(), confirmClickAt);
  await expect(page.getByTestId("sessions-empty")).toBeVisible({ timeout: 5_000 });
});
