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

/** Route-stub the sessions list and count calls to one mutating route. */
async function stubSessions(
  page: import("@playwright/test").Page,
  mutatingRoute: string,
): Promise<() => number> {
  let calls = 0;
  // The two patterns are disjoint by construction: a Playwright URL glob must
  // match the whole URL, and "**/api/sessions" has nothing to match the POSTs'
  // trailing "/delete" or "/clear" against. Registration order is therefore not
  // load-bearing here — unlike the component test, where the stub branches on
  // `includes()` and the prefix genuinely does overlap.
  await page.route(mutatingRoute, async (route) => {
    calls += 1;
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

  // expect.poll, not a bare read: the counter lives in the Node-side route
  // handler, so a read taken right after toBeVisible() can be sampled before an
  // arm-and-ALSO-fire request has arrived.
  await expect.poll(deleteCalls, { timeout: 1_000 }).toBe(0);

  await firstRow.getByTestId("session-delete-confirm").click();
  await expect.poll(deleteCalls, { timeout: 5_000 }).toBe(1);
  await expect(page.getByTestId("session-row")).toHaveCount(1);
});

test("Clear all arms its own confirm instead of clearing (#1773)", async ({ page }) => {
  const clearCalls = await stubSessions(page, "**/api/sessions/clear");
  await openSessionsList(page);

  await page.getByTestId("sessions-clear-all").click();
  await expect(page.getByTestId("sessions-clear-all-confirm")).toBeVisible({ timeout: 2_000 });
  await expect.poll(clearCalls, { timeout: 1_000 }).toBe(0);
  await expect(page.getByTestId("session-row")).toHaveCount(2);

  await page.getByTestId("sessions-clear-all-confirm").click();
  await expect.poll(clearCalls, { timeout: 5_000 }).toBe(1);
  await expect(page.getByTestId("sessions-empty")).toBeVisible({ timeout: 5_000 });
});
