import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  switchToAnnotationsTab,
} from "./helpers";

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
});

test.afterEach(async () => {
  try {
    const status = (await mcp.callTool("tandem_status")) as {
      data?: { openDocuments?: Array<{ documentId: string }> };
    };
    const docs = status?.data?.openDocuments ?? [];
    await Promise.all(docs.map((d) => mcp.callTool("tandem_close", { documentId: d.documentId })));
  } catch {
    // Server may have shut down
  }
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("settings popover opens via settings-btn and exposes dwell slider", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  // Click the toolbar settings button — uses the new testid from PR #227
  const settingsBtn = page.locator("[data-testid='settings-btn']");
  await expect(settingsBtn).toBeVisible({ timeout: 5_000 });
  await settingsBtn.click();

  // Popover mounts with its own testid
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });

  // Dwell slider is present and adjustable — proves the new slider and its
  // testid are wired up. The actual broadcast into CTRL_ROOM is covered by
  // the event-queue-dwell unit test; here we just verify the UI surface.
  const dwellSlider = popover.locator("[data-testid='dwell-time-slider']");
  await expect(dwellSlider).toBeVisible();
  await expect(dwellSlider).toHaveAttribute("type", "range");

  // Layout buttons — exercises another batch of new testids from #223
  await expect(popover.locator("[data-testid='layout-tabbed-btn']")).toBeVisible();
  await expect(popover.locator("[data-testid='layout-three-panel-btn']")).toBeVisible();
  await expect(popover.locator("[data-testid='editor-width-slider']")).toBeVisible();
});

test("bulk-confirm resets when a filter changes (issue #199 regression)", async ({ page }) => {
  // Need 2+ pending annotations to show the "Acknowledge All" button
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  // Two annotations within the title so both definitely target valid
  // ranges. "Test Document" spans offsets 2–14; split into "Test" [2,6]
  // and "Document" [7,15].
  await mcp.callTool("tandem_comment", {
    from: 2,
    to: 6,
    text: "First",
  });
  await mcp.callTool("tandem_highlight", {
    from: 7,
    to: 15,
    color: "yellow",
  });
  // Sanity check: confirm both annotations exist before navigating.
  const annotations = (await mcp.callTool("tandem_getAnnotations", {})) as {
    data?: { annotations?: unknown[] };
  };
  expect(annotations?.data?.annotations?.length ?? 0).toBeGreaterThanOrEqual(2);

  await page.goto("/");
  await switchToAnnotationsTab(page);
  // Wait for the bulk-accept button directly — it only mounts when
  // pending.length > 1, which implicitly waits for both annotations
  // to sync over Hocuspocus.
  const bulkAccept = page.locator("[data-testid='bulk-accept-btn']");
  await expect(bulkAccept).toBeVisible({ timeout: 15_000 });
  await bulkAccept.click();

  const confirm = page.locator("[data-testid='bulk-confirm-btn']");
  await expect(confirm).toBeVisible({ timeout: 2_000 });

  // Change the author filter — this is the exact bug class from issue #199.
  // The pre-fix code only reset on `pending.length` changes, so changing a
  // filter (which doesn't necessarily change the length) would leave the
  // confirm dialog pointing at a stale set of annotations.
  await page.locator("[data-testid='filter-author']").selectOption("claude");

  // Confirm must be dismissed — this is the pinned regression behavior.
  await expect(confirm).not.toBeVisible({ timeout: 2_000 });
  // And the Acknowledge All button must be back in its default state (or
  // absent if the filter emptied the pending set — both are acceptable
  // post-fix outcomes; the bug was the confirm persisting, which is gone).
});

test("bulk-confirm resets when filter-type changes", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  // Two annotations within the title so both definitely target valid
  // ranges. "Test Document" spans offsets 2–14; split into "Test" [2,6]
  // and "Document" [7,15].
  await mcp.callTool("tandem_comment", {
    from: 2,
    to: 6,
    text: "First",
  });
  await mcp.callTool("tandem_highlight", {
    from: 7,
    to: 15,
    color: "yellow",
  });
  const annotations = (await mcp.callTool("tandem_getAnnotations", {})) as {
    data?: { annotations?: unknown[] };
  };
  expect(annotations?.data?.annotations?.length ?? 0).toBeGreaterThanOrEqual(2);

  await page.goto("/");
  await switchToAnnotationsTab(page);
  const bulkDismiss = page.locator("[data-testid='bulk-dismiss-btn']");
  await expect(bulkDismiss).toBeVisible({ timeout: 15_000 });
  await bulkDismiss.click();
  const confirm = page.locator("[data-testid='bulk-confirm-btn']");
  await expect(confirm).toBeVisible({ timeout: 2_000 });

  // Change type filter — same regression class, different axis.
  // The first annotation is a comment; filtering to "highlight" changes
  // what's pending-visible, which must dismiss the stale confirm dialog.
  await page.locator("[data-testid='filter-type']").selectOption("highlight");
  await expect(confirm).not.toBeVisible({ timeout: 2_000 });
});

test("Solo/Tandem mode toggle switches via toolbar", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  const soloBtn = page.locator("[data-testid='mode-solo-btn']");
  const tandemBtn = page.locator("[data-testid='mode-tandem-btn']");
  await expect(soloBtn).toBeVisible({ timeout: 5_000 });
  await expect(tandemBtn).toBeVisible();

  // Default is tandem.
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "false");

  // Switch to solo. Assert via localStorage (race-free) + aria-pressed
  // (visible state). Avoid asserting through tandem_status because Y.Map
  // propagation over Hocuspocus is async.
  await soloBtn.click();
  await expect(soloBtn).toHaveAttribute("aria-pressed", "true");
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "false");
  const soloSaved = await page.evaluate(() => localStorage.getItem("tandem:mode"));
  expect(soloSaved).toBe("solo");

  // Switch back.
  await tandemBtn.click();
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "false");
  const tandemSaved = await page.evaluate(() => localStorage.getItem("tandem:mode"));
  expect(tandemSaved).toBe("tandem");
});

test("layout switches between tabbed and three-panel", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  // Tabbed layout (default) mounts exactly one resize handle.
  await expect(page.locator("[data-testid='panel-resize-handle']")).toHaveCount(1);
  await expect(page.locator("[data-testid='left-panel-resize-handle']")).toHaveCount(0);

  // Switch to three-panel.
  await page.locator("[data-testid='settings-btn']").click();
  await expect(page.locator("[data-testid='settings-popover']")).toBeVisible();
  await page.locator("[data-testid='layout-three-panel-btn']").click();

  // Three-panel mounts separate left and right handles and drops the
  // tabbed-layout handle.
  await expect(page.locator("[data-testid='left-panel-resize-handle']")).toHaveCount(1);
  await expect(page.locator("[data-testid='right-panel-resize-handle']")).toHaveCount(1);
  await expect(page.locator("[data-testid='panel-resize-handle']")).toHaveCount(0);

  const threePanelSaved = await page.evaluate(() => {
    const raw = localStorage.getItem("tandem:settings");
    return raw ? (JSON.parse(raw) as { layout?: string }).layout : null;
  });
  expect(threePanelSaved).toBe("three-panel");

  // Switch back.
  await page.locator("[data-testid='layout-tabbed-btn']").click();
  await expect(page.locator("[data-testid='panel-resize-handle']")).toHaveCount(1);
  await expect(page.locator("[data-testid='left-panel-resize-handle']")).toHaveCount(0);
});

test("dwell-time slider value persists across reload", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  await page.locator("[data-testid='settings-btn']").click();
  const slider = page.locator("[data-testid='dwell-time-slider']");
  await expect(slider).toBeVisible({ timeout: 2_000 });

  // Programmatically set the slider to a known value and fire the input event.
  // Playwright's fill() works for range inputs, but a native event dispatch
  // is more reliable since some handlers listen on "input" rather than "change".
  await slider.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = "2000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const savedDwell = await page.evaluate(() => {
    const raw = localStorage.getItem("tandem:settings");
    return raw ? (JSON.parse(raw) as { selectionDwellMs?: number }).selectionDwellMs : null;
  });
  expect(savedDwell).toBe(2000);

  // Reload and confirm the slider shows the saved value.
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-testid='settings-btn']").click();
  const reloadedSlider = page.locator("[data-testid='dwell-time-slider']");
  await expect(reloadedSlider).toHaveValue("2000");
});
