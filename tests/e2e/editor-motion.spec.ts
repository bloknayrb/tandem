import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

// Phase 4 / #798 — editor-surface motion (A18 find-hop, A6a anchor-pulse,
// A20a slash-menu entrance). All three are one-shot CSS `@keyframes` on global
// (unhashed) stylesheets, so they genuinely emit `animationstart`.
//
// This spec keeps the one assertion code review *cannot* enforce: the slash-menu
// entrance must fire exactly once on open and NOT replay on the per-keystroke
// re-render (the container is display-gated, not rebuilt — a future refactor that
// moved the animation onto a per-render element would silently break this). A18's
// and A6a's firing is fundamental "element gains an animation-declaring class →
// animationstart" CSS (A18 verified during development against the live find
// decoration; A6a's `classList.add` path is exercised by Editor.svelte and
// confirmed by crdt review) and isn't re-asserted here — driving find's tick-
// derived match state and the annotation activeId trigger is harness-flaky and
// not what the motion adds.
//
// `reducedMotion: "no-preference"` is required — Playwright suppresses motion by
// default, which would no-op the @media-guarded animation and make this vacuous.

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

const slashInCount = (page: Page) =>
  page.evaluate(
    () => ((window as any).__anim as string[]).filter((n) => n === "tandem-slash-menu-in").length,
  );

test("slash-menu entrance (A20a) fires once on open and does not replay while filtering", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", { timeout: 10_000 });

  await page.evaluate(() => {
    (window as any).__anim = [] as string[];
    document.addEventListener(
      "animationstart",
      (e) => (window as any).__anim.push((e as AnimationEvent).animationName),
      true,
    );
  });

  await editor.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" /");
  await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
  await expect.poll(() => slashInCount(page)).toBe(1);

  // Filtering re-renders the rows but the container stays display:block — the
  // entrance must NOT re-fire.
  await page.keyboard.type("h");
  await page.waitForTimeout(300);
  expect(await slashInCount(page)).toBe(1);
});
