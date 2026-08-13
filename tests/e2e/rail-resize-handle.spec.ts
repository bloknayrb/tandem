import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  RAIL_HANDLE_TESTID,
  type RailSide,
  setRailVisible,
} from "./helpers";

/**
 * #1396 — the drag strip must not overhang the visible rail.
 *
 * The mechanic (flex `stretch` + margins) is documented on the shared
 * `.rail-shell, .rail-resize-handle` rule in App.svelte. The source-level guard
 * on the *shape* of that fix lives in
 * tests/design-system-impl/rail-clearance-contract.test.ts.
 *
 * This spec states the invariant itself — the strip's edges coincide with its
 * rail's — by measuring real boxes in a real browser, which is what would
 * actually have caught the bug. The alignment half stays true under any correct
 * structure; the inset floor below reads margins off the handle itself, so a
 * structural fix that moved the clearance to a wrapper would SUPERSEDE it, the
 * same way it supersedes the source-level contract test.
 */

let mcp: McpTestClient;
let tmpDir: string;

/** The floor below is deliberately density-agnostic — see `expectAligned`. */
const MIN_INSET_PX = 40;

const SHELL_SELECTOR: Record<RailSide, string> = {
  left: ".rail-shell-left",
  right: ".rail-shell-right",
};

type Margins = { marginTop: number; marginBottom: number };

async function expectAligned(page: import("@playwright/test").Page, side: RailSide) {
  await setRailVisible(page, side, true);
  const selectors: [string, string] = [
    `[data-testid='${RAIL_HANDLE_TESTID[side]}']`,
    SHELL_SELECTOR[side],
  ];

  // Polled because the rail was just toggled open by a keypress and mount plus
  // layout has to settle. (Not the shell's 360ms width transition — that
  // animates width and box-shadow, neither of which moves the measured axis.)
  await expect
    .poll(
      async () => {
        const m = await page.evaluate(([handleSel, shellSel]) => {
          const h = document.querySelector(handleSel);
          const s = document.querySelector(shellSel);
          if (!h || !s) return null;
          const hb = h.getBoundingClientRect();
          const sb = s.getBoundingClientRect();
          const hs = getComputedStyle(h);
          return {
            topAligned: Math.abs(hb.top - sb.top) <= 1,
            bottomAligned: Math.abs(hb.bottom - sb.bottom) <= 1,
            marginTop: parseFloat(hs.marginTop),
            marginBottom: parseFloat(hs.marginBottom),
          };
        }, selectors);
        return m && { topAligned: m.topAligned, bottomAligned: m.bottomAligned };
      },
      { timeout: 5_000 },
    )
    .toEqual({ topAligned: true, bottomAligned: true });

  // A real inset on the HANDLE. Alignment alone still passes if the shared rule
  // is deleted outright and BOTH siblings drop to zero — the motivating
  // regression this catches that alignment doesn't (it also catches either token
  // being retuned below the floor). No parent hop (undeclared DOM structure) and
  // no per-density number: the top inset is a fixed 52px, but the bottom rides
  // --tandem-space-5 and so is 52/60/68px across compact/cozy/spacious — any
  // exact figure would be wrong at two of the three.
  //
  // Re-measured rather than captured from the poll: one extra round-trip total,
  // and it keeps the value type-checked instead of cast out of a closure.
  const settled: Margins | null = await page.evaluate(([handleSel]) => {
    const h = document.querySelector(handleSel);
    if (!h) return null;
    const hs = getComputedStyle(h);
    return { marginTop: parseFloat(hs.marginTop), marginBottom: parseFloat(hs.marginBottom) };
  }, selectors);

  expect(settled).not.toBeNull();
  expect(settled?.marginTop).toBeGreaterThanOrEqual(MIN_INSET_PX);
  expect(settled?.marginBottom).toBeGreaterThanOrEqual(MIN_INSET_PX);
}

test.beforeEach(async ({ page }) => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  // The E2E server sets TANDEM_NO_SAMPLE=1 against a per-run-wiped app-data dir,
  // so nothing is open at boot — open a fixture, then wait for the editor, which
  // also proves we are past App.svelte's `{#if !yjsSync.ready}` branch (the
  // editor row, and therefore both rails, do not exist inside it).
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("left rail: the drag strip spans exactly the visible rail", async ({ page }) => {
  await expectAligned(page, "left");
});

test("right rail: the drag strip spans exactly the visible rail", async ({ page }) => {
  await expectAligned(page, "right");
});
