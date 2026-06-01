import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  switchToAnnotationsTab,
} from "./helpers";

// Phase 4 / #798 — annotation-rail card arrival motion (A4).
//
// The visual tween can't be frame-captured reliably (the document-timeline
// "frozen capture clock"), so this asserts the *outcome*: the arriving card
// settles fully visible with no inline height/opacity left clamped at 0 — a
// botched `cardEnter` (e.g. a height-0 collapse that never reverts) would
// strand the card invisible. Single annotation so `.first()` is unambiguous.
//
// The *exit* path (A10/A1 — card leaves pending on accept/dismiss) is covered
// by `cardMotion.test.ts` (the cardExit direction + read-and-clear logic) and,
// on CI, by the existing annotation-lifecycle specs whose
// `expect(acceptBtn).not.toBeVisible()` only passes once the outro completes
// and the card unmounts. It's intentionally not re-asserted here: any exit
// assertion depends on the accept→resolve flow, which is flaky against this
// worktree's local dev server (it fails identically on master) — CI is the
// authoritative signal for it.

const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";

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

test("arriving card settles fully visible with no clamped height/opacity (A4)", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await switchToAnnotationsTab(page);

  // Annotation arrives after load → the local `in:cardEnter` transition runs.
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Arrival motion check",
    textSnapshot: TITLE_TEXT,
  });

  const card = page.locator("[data-testid^='annotation-card-']").first();
  await expect(card).toBeVisible({ timeout: 10_000 });

  // After the enter settles, Svelte clears the transition's inline styles, so
  // the card must be at its natural geometry — not stuck at the collapsed
  // start frame. Poll the computed box rather than snapshot a mid-tween frame.
  await expect
    .poll(async () => card.evaluate((el) => Math.round(el.getBoundingClientRect().height)), {
      timeout: 5_000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => card.evaluate((el) => Number(getComputedStyle(el).opacity)), {
      timeout: 5_000,
    })
    .toBeGreaterThan(0.99);
});
