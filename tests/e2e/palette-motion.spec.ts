import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

// Phase 4 / #798 A11: the command-palette modal entrance is a real component-
// `<style>` CSS animation (not a WAAPI Svelte transition), so it exposes a live
// `animationName`. `no-preference` keeps Playwright from suppressing motion. This
// lives in its own file so the `reducedMotion` override never leaks into the
// motion-agnostic palette tests in keyboard-shortcuts.spec.ts.
test.use({ reducedMotion: "no-preference" });

let mcp: McpTestClient;
let tmpDir: string;

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

test("the command palette modal has the entrance animation wired (A11, #798)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");

  await page.keyboard.press("Control+Shift+P");
  const palette = page.locator("[data-testid='command-palette']");
  await expect(palette).toBeVisible({ timeout: 3_000 });

  // The modal binds `animation: tandem-palette-modal-in`. The property persists in
  // computed style after the 260ms run, so reading it any time after open proves
  // the entrance is wired (a positive assertion — it FAILS loudly, never silently,
  // if reduce-motion suppressed it). Svelte hashes the keyframe name, so match the
  // original as a substring.
  const animationName = await palette.evaluate((el) => getComputedStyle(el).animationName);
  expect(animationName).not.toBe("none");
  expect(animationName).toContain("tandem-palette-modal-in");
});
