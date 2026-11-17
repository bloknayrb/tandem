import { expect, type Page, test } from "@playwright/test";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants";

/**
 * "Who answers your chat" in Settings → Models (#1123 part B, R2, R10.3).
 *
 * SKIP-GUARDED like `settings-models.spec.ts`: the Models tab is hidden while
 * `BYO_MODELS_ENABLED` is off, so the whole suite is skipped and runs the
 * moment the flag flips. CI's E2E backend has the flag baked off, so until
 * then this spec has never run.
 *
 * The page is the Vite client on the harness port, not Tandem's own window;
 * `playwright.config.ts` gives the backend the development allowance for that
 * one origin. A switch admitted through the allowance is not an own-window
 * switch, so the server raises its warning notice, which this spec expects.
 */

const SETTINGS_MODAL = "[data-testid='settings-modal']";
const MODELS_TAB = "[data-testid='settings-modal-tab-models']";
const ALLOWANCE_LOCAL_NOTICE =
  "Your chat was set to be answered by a local model. If you did not do this, set who answers your chat back to Claude in Settings → Models.";

async function gotoModelsTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tandemTest?: { openSettingsModal: () => void } };
    if (!w.__tandemTest?.openSettingsModal) {
      throw new Error("__tandemTest.openSettingsModal is not installed");
    }
    w.__tandemTest.openSettingsModal();
  });
  await expect(page.locator(SETTINGS_MODAL)).toBeVisible({ timeout: 5_000 });
  await page.locator(MODELS_TAB).click();
}

test.beforeEach(async ({ page }) => {
  test.skip(!BYO_MODELS_ENABLED, "Models UI gated off until BYO_MODELS_ENABLED (#1123)");
  await page.goto("/");
});

test("the control reads Claude by default and switches only on the user's selection", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/models/chat-answerer")) {
      posts.push(req.postData() ?? "");
    }
  });
  await gotoModelsTab(page);
  const claude = page.locator("[data-testid='chat-answerer-claude']");
  const local = page.locator("[data-testid='chat-answerer-local']");
  await expect(claude).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-testid='chat-answerer-status']")).toHaveText(
    "Chat is set to Claude. Local models are not sent your chat.",
  );

  // Arrow keys move focus only: nothing is sent.
  await claude.focus();
  await page.keyboard.press("ArrowRight");
  await expect(local).toBeFocused();
  await page.keyboard.press("Home");
  await expect(claude).toBeFocused();
  expect(posts).toEqual([]);

  // Space on the other position selects it: one POST.
  await local.focus();
  await page.keyboard.press(" ");
  await expect(local).toHaveAttribute("aria-checked", "true");
  expect(posts).toEqual([JSON.stringify({ answerer: "local" })]);
  await expect(page.locator("[data-testid='toast-container']")).toContainText(
    ALLOWANCE_LOCAL_NOTICE,
  );

  // Back to Claude, so later specs start from the default.
  await claude.click();
  await expect(claude).toHaveAttribute("aria-checked", "true");
  expect(posts).toHaveLength(2);
});
