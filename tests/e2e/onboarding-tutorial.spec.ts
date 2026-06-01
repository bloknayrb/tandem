import { expect, test } from "@playwright/test";
import path from "path";
import { cleanupAllOpenDocuments, McpTestClient } from "./helpers";

// Phase 4 / #798 A22: the progress-dot pop is a real component-`<style>` CSS
// animation (unlike the WAAPI bar transitions), so it emits a live
// `animationName`. `no-preference` keeps Playwright from suppressing motion.
test.use({ reducedMotion: "no-preference" });

let mcp: McpTestClient;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
});

test("welcome document shows tutorial and can walk through its steps", async ({ page }) => {
  await mcp.callTool("tandem_open", {
    filePath: path.join(process.cwd(), "sample", "welcome.md"),
  });

  await page.goto("/");
  const tutorial = page.locator("[data-testid='onboarding-tutorial']");
  await expect(tutorial).toBeVisible({ timeout: 10_000 });

  await expect(tutorial).toContainText("Review an annotation");
  await page.locator("[data-testid='tutorial-next-btn']").click();
  await expect(tutorial).toContainText("Ask a question");
  await page.locator("[data-testid='tutorial-next-btn']").click();
  await expect(tutorial).toContainText("Make an edit");
  await page.locator("[data-testid='tutorial-next-btn']").click();
  await expect(tutorial).toContainText("You're ready!");
});

test("the current progress dot has the pop animation wired (A22, #798)", async ({ page }) => {
  await mcp.callTool("tandem_open", {
    filePath: path.join(process.cwd(), "sample", "welcome.md"),
  });

  await page.goto("/");
  await expect(page.locator("[data-testid='onboarding-tutorial']")).toBeVisible({
    timeout: 10_000,
  });

  // The dot at i === currentStep carries `.is-current`, which binds
  // `animation: tutorial-dot-pop`. The property persists after the 200ms run, so
  // reading it any time after mount proves the pop is wired (a positive assertion
  // — it FAILS loudly, never silently, if reduce-motion suppressed it). Svelte
  // hashes the keyframe name, so match the original name as a substring.
  const current = page.locator(".tut-dot.is-current").first();
  await expect(current).toBeVisible();
  const animationName = await current.evaluate((el) => getComputedStyle(el).animationName);
  expect(animationName).not.toBe("none");
  expect(animationName).toContain("tutorial-dot-pop");
});
