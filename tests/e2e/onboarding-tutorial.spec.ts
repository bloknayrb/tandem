import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  McpTestClient,
  openChat,
  switchToAnnotationsTab,
} from "./helpers";

// Phase 4 / #798 A22: the check-pop is a real component-`<style>` CSS
// animation, so it emits a live `animationName`. Routed through
// `contextOptions`: `reducedMotion` is a BrowserContextOption, not a
// PlaywrightTestOption, so the bare `test.use({ reducedMotion })` form is
// silently discarded by the runner.
test.use({ contextOptions: { reducedMotion: "no-preference" } });

/**
 * #1711 — the getting-started checklist, end to end (the roadmap's v1.0
 * Tutorial exit gate): every item ticked by the real action, on a welcome
 * document whose seeds still anchor afterwards.
 *
 * The welcome document is a COPY under a temp `sample/` dir: the server seeds
 * any path ending `sample/welcome.md`, and this spec types into it, which
 * autosaves — opening the repo's own sample would rewrite it.
 */

let mcp: McpTestClient;
let tmpDir: string;
let welcomePath: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tandem-e2e-onboarding-"));
  mkdirSync(path.join(tmpDir, "sample"));
  welcomePath = path.join(tmpDir, "sample", "welcome.md");
  copyFileSync(path.join(process.cwd(), "sample", "welcome.md"), welcomePath);
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const item = (page: Page, id: "review" | "ask" | "edit") =>
  page.locator(`[data-testid='tutorial-item-${id}']`);

type AnnotationsData = {
  annotations: Array<{ id: string; range: { from: number; to: number }; anchor?: string }>;
};

test("the checklist completes end to end, only by the real actions, with anchors holding", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: welcomePath });
  await page.goto("/");

  const strip = page.locator("[data-testid='onboarding-tutorial']");
  await expect(strip).toBeVisible({ timeout: 10_000 });
  for (const id of ["review", "ask", "edit"] as const) {
    await expect(item(page, id)).toHaveAttribute("data-done", "false");
  }
  // No Next: the only forward control appears once every item is ticked.
  await expect(page.locator("[data-testid='tutorial-next-btn']")).toHaveCount(0);

  // 1. Accept Claude's suggestion seed. `applySuggestion` runs a focused local
  //    editor transaction, so this is also the regression check that accepting
  //    a suggestion does not tick "Make an edit".
  await switchToAnnotationsTab(page);
  const accept = page.locator("[data-testid='accept-btn-tutorial-suggest-1']");
  await expect(accept).toBeVisible({ timeout: 10_000 });
  await accept.click();
  await expect(item(page, "review")).toHaveAttribute("data-done", "true");
  await expect(item(page, "edit")).toHaveAttribute("data-done", "false");

  // 2. Ask Claude something through Chat. No AI is attached to the harness, so
  //    no reply comes — the send alone ticks it, as it does keyless.
  await openChat(page);
  await page.locator("[data-testid='chat-composer-input']").fill("What can you do?");
  await page.locator("[data-testid='chat-send-btn']").click();
  await expect(item(page, "ask")).toHaveAttribute("data-done", "true");
  await expect(item(page, "edit")).toHaveAttribute("data-done", "false");

  // 3. Make an edit: type at the very end of the document.
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Typed by the onboarding test.");
  await expect(item(page, "edit")).toHaveAttribute("data-done", "true");

  // All three: "You're ready!" with Done. Assert before the 3 s auto-complete.
  await expect(strip).toContainText("You're ready!");

  // Anchors holding: after the accept and the edit, the remaining Claude-facing
  // seed still covers its target text.
  const anns = (await mcp.callTool("tandem_getAnnotations")) as { data: AnnotationsData };
  const comment = anns.data.annotations.find((a) => a.id === "tutorial-comment-1");
  expect(comment, "tutorial-comment-1 is missing after the interaction").toBeDefined();
  expect(comment?.anchor).not.toBe("degraded");
  const text = (await mcp.callTool("tandem_getTextContent")) as { data: { text: string } };
  expect(text.data.text.slice(comment?.range.from, comment?.range.to)).toBe(
    "edit this document at the same time",
  );

  // Completes: the strip goes away (Done, or the 3 s timer if it wins the race)
  // and stays gone across a reload.
  const done = page.locator("[data-testid='tutorial-next-btn']");
  if (await done.isVisible()) await done.click().catch(() => {});
  await expect(strip).toHaveCount(0, { timeout: 5_000 });
  await page.reload();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(strip).toHaveCount(0);
});

test("the × dismisses the checklist", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: welcomePath });
  await page.goto("/");
  const strip = page.locator("[data-testid='onboarding-tutorial']");
  await expect(strip).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-testid='tutorial-dismiss-btn']").click();
  await expect(strip).toHaveCount(0);
});

test("a check pops when its item ticks (A22, #798)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: welcomePath });
  await page.goto("/");
  await expect(page.locator("[data-testid='onboarding-tutorial']")).toBeVisible({
    timeout: 10_000,
  });

  await openChat(page);
  await page.locator("[data-testid='chat-composer-input']").fill("hello");
  await page.locator("[data-testid='chat-send-btn']").click();
  const dot = item(page, "ask").locator(".tut-dot");
  await expect(dot).toHaveClass(/is-popped/);
  // Svelte hashes the keyframe name, so match the original name as a substring.
  const animationName = await dot.evaluate((el) => getComputedStyle(el).animationName);
  expect(animationName).toContain("tutorial-dot-pop");
});
