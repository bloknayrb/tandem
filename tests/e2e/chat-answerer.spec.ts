import { expect, type Page, test } from "@playwright/test";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants";
import { expectOnlyAllowanceNotices, resetLocalModelState } from "./helpers";
import { ANSWERER_LOCAL_NOTICE, CHAT_ANSWERER_CLAUDE_STATUS } from "./local-model-strings";

// Local models ship dark: the Models tab is filtered out while the flag is off,
// so this whole file is skipped there (pinned by
// tests/scripts/e2e-local-model-skip-wiring.test.ts; the flip deletes it).
test.skip(!BYO_MODELS_ENABLED, "Models UI gated off until BYO_MODELS_ENABLED (#1123)");

/**
 * "Who answers your chat" in Settings → Models (#1123 part B, R2, R10.3).
 *
 * Skipped at file level while local models ship dark; the advisory
 * `byo-flag-on` CI job runs it lit (ADR-039, #1123 PR 8a). Who answers chat is
 * SERVER state that outlives the page, so it is reset from Node before and
 * after each test (`resetLocalModelState`).
 *
 * The page is the Vite client on the harness port, not Tandem's own window;
 * `playwright.config.ts` gives the backend the development allowance for that
 * one origin. A switch admitted through the allowance is not an own-window
 * switch, so the server raises its warning notice, which this spec expects.
 */

const SETTINGS_MODAL = "[data-testid='settings-modal']";
const MODELS_TAB = "[data-testid='settings-modal-tab-models']";

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
  await resetLocalModelState("chat-answerer");
  await page.goto("/");
});

test.afterEach(async ({ page }) => {
  if (!BYO_MODELS_ENABLED) return;
  try {
    await expectOnlyAllowanceNotices(page);
  } finally {
    await resetLocalModelState("chat-answerer");
  }
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
    CHAT_ANSWERER_CLAUDE_STATUS,
  );

  // Arrow keys move focus only: nothing is sent.
  await claude.focus();
  await page.keyboard.press("ArrowRight");
  await expect(local).toBeFocused();
  await page.keyboard.press("Home");
  await expect(claude).toBeFocused();
  // Read after a completed positive anchor (focus moved twice), so a POST the
  // arrow keys sent would have been recorded by now.
  expect(posts).toEqual([]);

  // Space on the other position selects it: one POST.
  await local.focus();
  await page.keyboard.press(" ");
  await expect(local).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => posts).toEqual([JSON.stringify({ answerer: "local" })]);
  await expect(page.locator("[data-testid='toast-container']")).toContainText(
    ANSWERER_LOCAL_NOTICE,
  );

  // Enter on the other position selects it too: back to Claude (so later
  // specs start from the default) with one more POST.
  await claude.focus();
  await page.keyboard.press("Enter");
  await expect(claude).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => posts).toEqual([
    JSON.stringify({ answerer: "local" }),
    JSON.stringify({ answerer: "claude" }),
  ]);
});
