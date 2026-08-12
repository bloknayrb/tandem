import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * #1396 — the drag strip must not overhang the visible rail.
 *
 * The strip is a flex sibling of `.rail-shell` in the editor row, which has no
 * `align-items` and therefore stretches every child. Under `stretch` an item's
 * margins inset its stretched cross size, so while only the shell carried the
 * titlebar / status-pill clearances the strip stretched the full column and its
 * hover tint ran past the rail at both ends.
 *
 * The source-level guard (one shared declaration rather than two copies) lives
 * in tests/design-system-impl/rail-clearance-contract.test.ts. This spec is the
 * rendered-geometry half: it measures the real boxes in a real browser, which is
 * what would actually have caught the bug.
 */

let mcp: McpTestClient;
let tmpDir: string;

/** The floor below is deliberately density-agnostic — see `expectAligned`. */
const MIN_INSET_PX = 40;

type Side = "left" | "right";

const HANDLE_TESTID: Record<Side, string> = {
  // The right handle's testid is overridden at the call site in App.svelte.
  left: "left-panel-resize-handle",
  right: "panel-resize-handle",
};

const SHELL_SELECTOR: Record<Side, string> = {
  left: ".rail-shell-left",
  right: ".rail-shell-right",
};

const TOGGLE_KEY: Record<Side, string> = {
  left: "Alt+Shift+ArrowLeft",
  right: "Alt+Shift+ArrowRight",
};

/**
 * Make the side's rail visible so its handle renders, whatever the defaults are.
 *
 * Expected defaults today: `leftPanelVisible: false` / `rightPanelVisible: true`
 * (src/client/hooks/useTandemSettings.ts), `defaultMode: "tandem"` (same file,
 * mirroring TANDEM_MODE_DEFAULT in src/shared/constants.ts) and
 * `soloRailHidden: true` (same file — only bites in solo mode). If any of those
 * flip, this helper still gets the rail open and the `toHaveCount(1)` below is
 * what reports the surprise, instead of a later assertion measuring a phantom.
 */
async function openRail(page: import("@playwright/test").Page, side: Side) {
  const handle = page.locator(`[data-testid='${HANDLE_TESTID[side]}']`);
  if ((await handle.count()) === 0) {
    await page.keyboard.press(TOGGLE_KEY[side]);
  }
  await expect(handle).toHaveCount(1, { timeout: 3_000 });
  return handle;
}

async function expectAligned(page: import("@playwright/test").Page, side: Side) {
  const handle = await openRail(page, side);
  const shell = page.locator(SHELL_SELECTOR[side]);
  await expect(shell).toHaveCount(1);

  // (a) The clearance is literally the same computed value on both siblings.
  const margins = await page.evaluate(
    ([handleSel, shellSel]) => {
      const h = document.querySelector(handleSel) as HTMLElement;
      const s = document.querySelector(shellSel) as HTMLElement;
      const hs = getComputedStyle(h);
      const ss = getComputedStyle(s);
      return {
        handleTop: hs.marginTop,
        handleBottom: hs.marginBottom,
        shellTop: ss.marginTop,
        shellBottom: ss.marginBottom,
      };
    },
    [`[data-testid='${HANDLE_TESTID[side]}']`, SHELL_SELECTOR[side]],
  );
  expect(margins.handleTop).toBe(margins.shellTop);
  expect(margins.handleBottom).toBe(margins.shellBottom);

  // (b) …and the rendered boxes start and end on the same lines. Polled: the
  // shell carries a 360ms width transition, so a rail just toggled open is
  // still settling.
  await expect
    .poll(
      async () => {
        const hb = await handle.boundingBox();
        const sb = await shell.boundingBox();
        if (!hb || !sb) return null;
        return {
          top: Math.abs(hb.y - sb.y) <= 1,
          bottom: Math.abs(hb.y + hb.height - (sb.y + sb.height)) <= 1,
        };
      },
      { timeout: 5_000 },
    )
    .toEqual({ top: true, bottom: true });

  // (c) A real inset on the HANDLE, so deleting the shared rule reds this even
  // if the shell lost its clearance in lockstep. No parent hop (undeclared DOM
  // structure) and no per-density number: the top inset is a fixed 52px, but the
  // bottom rides --tandem-space-5 and so is 52/60/68px across
  // compact/cozy/spacious — any exact figure would be wrong at two densities.
  expect(parseFloat(margins.handleTop)).toBeGreaterThanOrEqual(MIN_INSET_PX);
  expect(parseFloat(margins.handleBottom)).toBeGreaterThanOrEqual(MIN_INSET_PX);
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
