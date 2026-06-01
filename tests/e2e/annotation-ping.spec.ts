import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

// Phase 4 / #798 — A4 editor gutter ping. Two integration assertions the pure
// `shouldPing` unit test can't reach, both about the liveness gate:
//   1. a genuine post-go-live arrival fires `tandem-annotation-ping`;
//   2. an annotation present BEFORE the editor goes live (bulk load) stays
//      silent — the misfire crdt + annotation-model review caught in the
//      original timestamp-only design (tutorial seeding / docx import stamp
//      fresh timestamps, so freshness alone would storm pings on first run).
//
// `tandem-annotation-ping` is a global (unhashed) CSS @keyframes, so it emits
// animationstart. `reducedMotion: "no-preference"` is required or Playwright
// suppresses the animation and the assertions go vacuous.

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

async function captureAnimations(page: Page) {
  await page.evaluate(() => {
    (window as any).__anim = [] as string[];
    document.addEventListener(
      "animationstart",
      (e) => (window as any).__anim.push((e as AnimationEvent).animationName),
      true,
    );
  });
}
const pingCount = (page: Page) =>
  page.evaluate(
    () => ((window as any).__anim as string[]).filter((n) => n === "tandem-annotation-ping").length,
  );

test("a genuine post-load annotation arrival fires the gutter ping (A4)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", { timeout: 10_000 });
  await captureAnimations(page);
  await page.waitForTimeout(800); // past the liveness settling window

  await mcp.callTool("tandem_comment", {
    from: 2,
    to: 15,
    text: "arrival ping",
    textSnapshot: "Test Document",
  });
  await expect.poll(() => pingCount(page), { timeout: 8_000 }).toBeGreaterThan(0);
});

test("an annotation present before go-live (bulk load) does NOT ping (A4)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  // Created BEFORE the page loads → syncs during the settling window → folded
  // into the seen-set at go-live → must never ping.
  await mcp.callTool("tandem_comment", {
    from: 2,
    to: 15,
    text: "bulk-load comment",
    textSnapshot: "Test Document",
  });
  await page.goto("http://127.0.0.1:5173");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", { timeout: 10_000 });
  await captureAnimations(page);
  await page.waitForTimeout(1500); // well past go-live; the pre-existing annotation stays silent
  expect(await pingCount(page)).toBe(0);
});
