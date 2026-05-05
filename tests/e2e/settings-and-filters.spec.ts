import { expect, test } from "@playwright/test";
import path from "path";
import {
  DEFAULT_MCP_PORT,
  LEFT_PANEL_WIDTH_KEY,
  PANEL_WIDTH_KEY,
  TANDEM_MODE_KEY,
  TANDEM_SETTINGS_KEY,
} from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
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

test.afterEach(async ({ page }) => {
  // Explicitly close any test-scoped EventSource before tearing down the
  // page. Playwright creates fresh pages per test by default, so in
  // practice this guards against fixture-sharing regressions and leaves
  // a clean slate if anyone ever converts this file to a shared-page
  // fixture layout. Wrapped in try/catch because the page may already
  // be closed on failure paths.
  try {
    await page.evaluate(() => {
      const w = window as unknown as {
        __tandemEventSource?: EventSource;
        __tandemEvents?: unknown[];
      };
      // Most tests in this file never open an EventSource — short-circuit
      // the teardown so we don't pay a round-trip on every test.
      if (!w.__tandemEventSource && !w.__tandemEvents) return;
      w.__tandemEventSource?.close();
      w.__tandemEventSource = undefined;
      w.__tandemEvents = undefined;
    });
  } catch {
    // Page already closed — nothing to tear down.
  }
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("settings popover opens via settings-btn and exposes dwell slider", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // Click the toolbar settings button — uses the new testid from PR #227
  const settingsBtn = page.locator("[data-testid='settings-btn']");
  await expect(settingsBtn).toBeVisible({ timeout: 5_000 });
  await settingsBtn.click();

  // Popover mounts with its own testid
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });
  await expect(popover.getByRole("button", { name: "Appearance" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await popover.getByRole("button", { name: "Claude Code/Cowork" }).click();
  // Dwell slider is present and adjustable — proves the new slider and its
  // testid are wired up. The actual broadcast into CTRL_ROOM is covered by
  // the event-queue-dwell unit test; here we just verify the UI surface.
  const dwellSlider = popover.locator("[data-testid='dwell-time-slider']");
  await expect(dwellSlider).toBeVisible();
  await expect(dwellSlider).toHaveAttribute("type", "range");

  await popover.getByRole("button", { name: "Appearance" }).click();
  // Layout buttons — exercises another batch of new testids from #223
  await expect(popover.locator("[data-testid='layout-tabbed-btn']")).toBeVisible();
  await expect(popover.locator("[data-testid='layout-three-panel-btn']")).toBeVisible();

  await popover.getByRole("button", { name: "Editor" }).click();
  await expect(popover.locator("[data-testid='editor-width-slider']")).toBeVisible();
});

test("settings dialog surfaces default mode and persists it", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await page.locator("[data-testid='settings-btn']").click();
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });

  await popover.getByRole("button", { name: "Collaboration" }).click();
  const soloDefault = popover.locator("[data-testid='default-mode-solo-btn']");
  await expect(soloDefault).toBeVisible();
  await soloDefault.click();
  await expect(soloDefault).toHaveAttribute("aria-checked", "true");

  const savedDefaultMode = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { defaultMode?: string }).defaultMode : null;
  }, TANDEM_SETTINGS_KEY);
  expect(savedDefaultMode).toBe("solo");

  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-testid='settings-btn']").click();
  const reloadedPopover = page.locator("[data-testid='settings-popover']");
  await reloadedPopover.getByRole("button", { name: "Collaboration" }).click();
  await expect(reloadedPopover.locator("[data-testid='default-mode-solo-btn']")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("settings dialog sections and About panel reflect the redesign closeout", async ({ page }) => {
  await page.route("**/api/info", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: "9.9.9",
        toolCount: 31,
        mcpSdkVersion: "1.17.0",
        transport: "http",
        storagePath: "C:\\Users\\test\\AppData\\Local\\tandem\\Data\\sessions",
        tokenRotatedAt: 1_700_000_000_000,
        changelogPath: "C:\\repo\\CHANGELOG.md",
      }),
    });
  });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await page.locator("[data-testid='settings-btn']").click();
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });

  for (const section of [
    "Appearance",
    "Editor",
    "Accessibility",
    "Collaboration",
    "Claude Code/Cowork",
    "Shortcuts",
    "About",
  ]) {
    await expect(popover.getByRole("button", { name: section })).toBeVisible();
  }

  await popover.getByRole("button", { name: "Shortcuts" }).click();
  await expect(popover.locator("[data-testid='settings-shortcuts-list']")).toContainText("Ctrl+,");

  await popover.getByRole("button", { name: "About" }).click();
  const about = popover.locator("[data-testid='app-info-footer']");
  await expect(about).toContainText("Tandem v9.9.9");
  await expect(about).toContainText("31 tools");
  await expect(about).toContainText("MCP SDK 1.17.0");
  await expect(about).toContainText("HTTP");
  await expect(about).toContainText("sessions");
  await expect(about).toContainText("Token rotated");
  await expect(popover.locator("[data-testid='view-changelog-btn']")).toBeVisible();
  await expect(popover.getByRole("link", { name: "Report a bug" })).toBeVisible();
});

test("selection toolbar toggle persists and drives toolbar visibility", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });

  async function selectFirstParagraph(): Promise<void> {
    await editor.click();
    await editor.locator("p").first().selectText();
  }

  const toolbar = page.getByRole("toolbar", { name: "Selection tools" });

  await page.locator("[data-testid='settings-btn']").click();
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });
  await popover.getByRole("button", { name: "Claude Code/Cowork" }).click();

  const toggle = popover.locator("[data-testid='selection-toolbar-toggle'] input");
  if (await toggle.isChecked()) {
    await toggle.uncheck();
  }
  await expect(toggle).not.toBeChecked();
  const disabledToolbarSaved = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { selectionToolbar?: boolean }).selectionToolbar : null;
  }, TANDEM_SETTINGS_KEY);
  expect(disabledToolbarSaved).toBe(false);

  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await selectFirstParagraph();
  await expect(toolbar).toHaveCount(0, { timeout: 2_000 });

  await page.locator("[data-testid='settings-btn']").click();
  const reopenedPopover = page.locator("[data-testid='settings-popover']");
  await reopenedPopover.getByRole("button", { name: "Claude Code/Cowork" }).click();
  const reopenedToggle = reopenedPopover.locator("[data-testid='selection-toolbar-toggle'] input");
  if (!(await reopenedToggle.isChecked())) {
    await reopenedToggle.check();
  }
  await expect(reopenedToggle).toBeChecked();
  const enabledToolbarSaved = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { selectionToolbar?: boolean }).selectionToolbar : null;
  }, TANDEM_SETTINGS_KEY);
  expect(enabledToolbarSaved).toBe(true);

  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await selectFirstParagraph();
  await expect(toolbar).toBeVisible({ timeout: 5_000 });
});

test("Ctrl+, opens Settings popover", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).not.toBeVisible();

  // Playwright maps "Control+," to the Comma key with Ctrl held — matches
  // the hook's `e.code === "Comma" && e.ctrlKey` gate.
  await page.keyboard.press("Control+Comma");

  await expect(popover).toBeVisible({ timeout: 2_000 });
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
  await mcp.callTool("tandem_comment", {
    from: 7,
    to: 15,
    text: "Second",
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
  // Seed 3 annotations so `pending.length > 1` still holds after the filter
  // change — otherwise the bulk-actions row unmounts entirely and the
  // confirm button disappears as a side effect of the parent unmounting,
  // NOT because the `setBulkConfirm(null)` effect ran. That would let
  // `filterType` be silently dropped from the effect's deps and still pass.
  //
  // Layout: 2 comments + 1 highlight. Filter to "comment" → 2 pending
  // remain → bulk row stays mounted → confirm must be cleared by the
  // filter-change effect specifically.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", { from: 2, to: 6, text: "First" });
  await mcp.callTool("tandem_comment", { from: 7, to: 15, text: "Second" });
  await mcp.callTool("tandem_comment", { from: 16, to: 24, text: "Third" });
  const annotations = (await mcp.callTool("tandem_getAnnotations", {})) as {
    data?: { annotations?: unknown[] };
  };
  expect(annotations?.data?.annotations?.length ?? 0).toBeGreaterThanOrEqual(3);

  await page.goto("/");
  await switchToAnnotationsTab(page);
  const bulkDismiss = page.locator("[data-testid='bulk-dismiss-btn']");
  await expect(bulkDismiss).toBeVisible({ timeout: 15_000 });
  await bulkDismiss.click();
  const confirm = page.locator("[data-testid='bulk-confirm-btn']");
  await expect(confirm).toBeVisible({ timeout: 2_000 });

  // Change type filter — comment filter leaves 2 pending comments, so the
  // bulk actions row remains mounted and the confirm must be dismissed by
  // the filter-change effect specifically (not by parent unmount).
  await page.locator("[data-testid='filter-type']").selectOption("comment");
  // Sanity check: the bulk row must still be mounted — otherwise this test
  // regresses to the same false-positive it was written to avoid.
  await expect(bulkDismiss).toBeVisible({ timeout: 2_000 });
  await expect(confirm).not.toBeVisible({ timeout: 2_000 });
});

test("bulk-confirm resets when filter-status changes", async ({ page }) => {
  // Third axis of the filter-change deps guard. All annotations start as
  // pending so filter-status "pending" keeps all 3 pending visible — the
  // bulk row stays mounted and the confirm reset must fire specifically
  // because the `filterStatus` dep fired, not as a parent-unmount artifact.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", { from: 2, to: 6, text: "First" });
  await mcp.callTool("tandem_comment", { from: 7, to: 15, text: "Second" });
  await mcp.callTool("tandem_comment", { from: 16, to: 24, text: "Third" });

  await page.goto("/");
  await switchToAnnotationsTab(page);
  const bulkAccept = page.locator("[data-testid='bulk-accept-btn']");
  await expect(bulkAccept).toBeVisible({ timeout: 15_000 });
  await bulkAccept.click();
  const confirm = page.locator("[data-testid='bulk-confirm-btn']");
  await expect(confirm).toBeVisible({ timeout: 2_000 });

  // Filter to "pending" — all 3 annotations are still pending so the bulk
  // row stays mounted; the confirm reset can only come from the filter-
  // change effect firing on the `filterStatus` dep.
  await page.locator("[data-testid='filter-status']").selectOption("pending");
  await expect(bulkAccept).toBeVisible({ timeout: 2_000 });
  await expect(confirm).not.toBeVisible({ timeout: 2_000 });
});

test("Solo/Tandem mode toggle switches via toolbar and holds pending annotations", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  // Seed a pending annotation so Solo mode has something to hold.
  await mcp.callTool("tandem_comment", {
    from: 2,
    to: 6,
    text: "pending note",
    textSnapshot: "Test",
  });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await switchToAnnotationsTab(page);

  const soloBtn = page.locator("[data-testid='mode-solo-btn']");
  const tandemBtn = page.locator("[data-testid='mode-tandem-btn']");
  await expect(soloBtn).toBeVisible({ timeout: 5_000 });
  await expect(tandemBtn).toBeVisible();

  // Default is tandem.
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "false");

  // In Tandem mode the held banner is absent — the annotation is visible.
  const heldBanner = page.getByTestId("held-banner");
  await expect(heldBanner).toHaveCount(0);

  // Switch to solo. Assert via localStorage (race-free) + aria-pressed
  // (visible state). Avoid asserting through tandem_status because Y.Map
  // propagation over Hocuspocus is async.
  await soloBtn.click();
  await expect(soloBtn).toHaveAttribute("aria-pressed", "true");
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "false");
  const soloSaved = await page.evaluate((key) => localStorage.getItem(key), TANDEM_MODE_KEY);
  expect(soloSaved).toBe("solo");

  // The held banner must appear in Solo mode — this is the feature's actual
  // contract, not just the localStorage bit. Catches regressions where the
  // toggle updates storage but fails to drive the useModeGate hook.
  await expect(heldBanner).toBeVisible({ timeout: 2_000 });
  // Preserve the count + pluralization contract the old regex locator asserted.
  await expect(heldBanner).toHaveText(/\d+ annotation(s)? held/);

  // Switch back.
  await tandemBtn.click();
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "false");
  const tandemSaved = await page.evaluate((key) => localStorage.getItem(key), TANDEM_MODE_KEY);
  expect(tandemSaved).toBe("tandem");

  // Banner must clear when back in Tandem.
  await expect(heldBanner).toHaveCount(0, { timeout: 2_000 });
});

test("layout switches between tabbed and three-panel", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // Explicit timeouts on the handle-count assertions below allow React to
  // finish re-rendering panelLayout state before asserting — prevents flake
  // under CI load (issue #281).
  const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
  const rightHandle = page.locator("[data-testid='right-panel-resize-handle']");
  const tabbedHandle = page.locator("[data-testid='panel-resize-handle']");

  // Tabbed layout is the redesign default.
  await expect(tabbedHandle).toHaveCount(1, { timeout: 10_000 });
  await expect(leftHandle).toHaveCount(0, { timeout: 10_000 });
  await expect(rightHandle).toHaveCount(0, { timeout: 10_000 });

  // Re-select tabbed to exercise the settings button without changing state.
  await page.locator("[data-testid='settings-btn']").click();
  await expect(page.locator("[data-testid='settings-popover']")).toBeVisible();
  await page.locator("[data-testid='layout-tabbed-btn']").click();

  // Tabbed layout mounts exactly one resize handle and drops the
  // three-panel handles.
  await expect(tabbedHandle).toHaveCount(1, { timeout: 10_000 });
  await expect(leftHandle).toHaveCount(0, { timeout: 10_000 });
  await expect(rightHandle).toHaveCount(0, { timeout: 10_000 });

  const tabbedSaved = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { layout?: string }).layout : null;
  }, TANDEM_SETTINGS_KEY);
  expect(tabbedSaved).toBe("tabbed");

  // Switch to three-panel.
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await expect(leftHandle).toHaveCount(1, { timeout: 10_000 });
  await expect(rightHandle).toHaveCount(1, { timeout: 10_000 });
  await expect(tabbedHandle).toHaveCount(0, { timeout: 10_000 });
});

test("tabbed-left layout mounts left panel handle and keeps tabs visible", async ({ page }) => {
  // This test covers the tabbed-left branch which
  // had zero E2E coverage — it has a left-side panel with its own resize
  // handle (left-panel-resize-handle) instead of the right-side tabbed
  // handle (panel-resize-handle).
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
  const tabbedHandle = page.locator("[data-testid='panel-resize-handle']");

  // Open settings and switch to tabbed-left.
  await page.locator("[data-testid='settings-btn']").click();
  await expect(page.locator("[data-testid='settings-popover']")).toBeVisible();
  await page.locator("[data-testid='layout-tabbed-left-btn']").click();
  // Close the popover so it doesn't obscure subsequent assertions.
  await page.keyboard.press("Escape");

  // tabbed-left mounts a left-side handle and drops the right tabbed handle.
  await expect(leftHandle).toHaveCount(1, { timeout: 10_000 });
  await expect(tabbedHandle).toHaveCount(0, { timeout: 10_000 });

  // The tabbed panel is still present — annotations and chat tabs must be visible.
  await expect(page.locator("[data-testid='annotations-tab']")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("[data-testid='chat-tab']")).toBeVisible();

  // Layout must be saved to localStorage.
  const saved = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { layout?: string }).layout : null;
  }, TANDEM_SETTINGS_KEY);
  expect(saved).toBe("tabbed-left");

  // Restore default layout so this test doesn't pollute others via localStorage.
  await page.locator("[data-testid='settings-btn']").click();
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await page.keyboard.press("Escape");
  await expect(leftHandle).toHaveCount(1, { timeout: 10_000 });
  // three-panel also has a left handle, so verify the right handle is back too.
  await expect(page.locator("[data-testid='right-panel-resize-handle']")).toHaveCount(1, {
    timeout: 10_000,
  });
});

test("three-panel layout resizes left/right widths independently", async ({ page }) => {
  // Production wires the left handle to `tandem-left-panel-width` and the
  // right handle to `tandem-panel-width`. The regression this guards against
  // is #228's bundled-state bug where both handles wrote to the same key.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // Enter three-panel layout and clear any stale width state so both panels
  // start at PANEL_DEFAULT_WIDTH (300).
  await page.locator("[data-testid='settings-btn']").click();
  await expect(page.locator("[data-testid='settings-popover']")).toBeVisible();
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await page.keyboard.press("Escape");
  await page.evaluate(
    ([leftKey, rightKey]) => {
      localStorage.removeItem(leftKey);
      localStorage.removeItem(rightKey);
    },
    [LEFT_PANEL_WIDTH_KEY, PANEL_WIDTH_KEY],
  );
  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
  const rightHandle = page.locator("[data-testid='right-panel-resize-handle']");
  await expect(leftHandle).toBeVisible();
  await expect(rightHandle).toBeVisible();

  // One-shot evaluate returning both keys at once.
  const readWidths = () =>
    page.evaluate(
      ([leftKey, rightKey]) => ({
        left: localStorage.getItem(leftKey),
        right: localStorage.getItem(rightKey),
      }),
      [LEFT_PANEL_WIDTH_KEY, PANEL_WIDTH_KEY],
    );

  async function dragHandleBy(
    handle: ReturnType<typeof page.locator>,
    deltaX: number,
  ): Promise<void> {
    const box = await handle.boundingBox();
    if (!box) throw new Error("resize handle has no bounding box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + deltaX, cy, { steps: 10 });
    await page.mouse.up();
  }

  // Drag the left handle right by +80px. Left panel's handle is on its right
  // edge, so drag-right widens it: 300 → 380.
  await dragHandleBy(leftHandle, 80);

  // Left width moves, right width must not.
  const afterLeftDrag = await readWidths();
  expect(Number(afterLeftDrag.left)).toBeGreaterThanOrEqual(370);
  expect(Number(afterLeftDrag.left)).toBeLessThanOrEqual(390);
  // Right panel key is written only when that handle is dragged. Null = default.
  if (afterLeftDrag.right !== null) {
    expect(Number(afterLeftDrag.right)).toBe(300);
  }

  // Drag the right handle right by +80px. Right panel's handle is on its
  // left edge, so drag-right NARROWS it (App.tsx sign inversion): 300 → 220.
  await dragHandleBy(rightHandle, 80);

  const afterRightDrag = await readWidths();
  expect(Number(afterRightDrag.right)).toBeGreaterThanOrEqual(210);
  expect(Number(afterRightDrag.right)).toBeLessThanOrEqual(230);
  // Left width must still be the value we set earlier.
  expect(afterRightDrag.left).toBe(afterLeftDrag.left);

  // Round-trip through reload — both keys must persist.
  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  const afterReload = await readWidths();
  expect(afterReload.left).toBe(afterLeftDrag.left);
  expect(afterReload.right).toBe(afterRightDrag.right);
});

test("panel-width drags clamp to [200, 600]", async ({ page }) => {
  // Extreme drags in both directions must not exceed PANEL_MAX_WIDTH (600)
  // or drop below PANEL_MIN_WIDTH (200). Sign-inversion regressions on the
  // right handle would surface here before anywhere else.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // Enter three-panel layout and clear stale width state.
  await page.locator("[data-testid='settings-btn']").click();
  await expect(page.locator("[data-testid='settings-popover']")).toBeVisible();
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await page.keyboard.press("Escape");
  await page.evaluate(
    ([leftKey, rightKey]) => {
      localStorage.removeItem(leftKey);
      localStorage.removeItem(rightKey);
    },
    [LEFT_PANEL_WIDTH_KEY, PANEL_WIDTH_KEY],
  );
  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
  const rightHandle = page.locator("[data-testid='right-panel-resize-handle']");

  async function dragHandleBy(
    handle: ReturnType<typeof page.locator>,
    deltaX: number,
  ): Promise<void> {
    const box = await handle.boundingBox();
    if (!box) throw new Error("resize handle has no bounding box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + deltaX, cy, { steps: 20 });
    await page.mouse.up();
  }

  const readLeft = () =>
    page.evaluate((k) => Number(localStorage.getItem(k)), LEFT_PANEL_WIDTH_KEY);
  const readRight = () => page.evaluate((k) => Number(localStorage.getItem(k)), PANEL_WIDTH_KEY);

  // Over-max left drag: starting at 300, drag +500 → would be 800, must
  // clamp to 600.
  await dragHandleBy(leftHandle, 500);
  expect(await readLeft()).toBe(600);

  // Under-min left drag: drag -500 → would be 100, must clamp to 200.
  await dragHandleBy(leftHandle, -500);
  expect(await readLeft()).toBe(200);

  // Right handle has inverted sign (drag right = narrower). Over-max: drag
  // -500 (left) → 300 - (-500) = 800, must clamp to 600.
  await dragHandleBy(rightHandle, -500);
  expect(await readRight()).toBe(600);

  // Under-min: drag +500 → 600 - 500 = 100, must clamp to 200.
  await dragHandleBy(rightHandle, 500);
  expect(await readRight()).toBe(200);
});

test("three-panel left width survives a tabbed-layout round trip", async ({ page }) => {
  // Scenario: user resizes left panel in three-panel mode, switches to
  // tabbed (only the right key gets touched), switches back to three-panel.
  // The left width must still be what the user set. Guards against a
  // regression where the tabbed handle accidentally writes to the left key
  // or the layout switch clobbers left state.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // Clear all width state before starting.
  await page.evaluate(
    ([leftKey, rightKey]) => {
      localStorage.removeItem(leftKey);
      localStorage.removeItem(rightKey);
    },
    [LEFT_PANEL_WIDTH_KEY, PANEL_WIDTH_KEY],
  );
  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // Enter three-panel mode.
  await page.locator("[data-testid='settings-btn']").click();
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await page.keyboard.press("Escape");

  const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
  await expect(leftHandle).toBeVisible();

  async function dragHandleBy(
    handle: ReturnType<typeof page.locator>,
    deltaX: number,
  ): Promise<void> {
    const box = await handle.boundingBox();
    if (!box) throw new Error("resize handle has no bounding box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + deltaX, cy, { steps: 10 });
    await page.mouse.up();
  }

  // Drag the left handle +80 → left ≈ 380.
  await dragHandleBy(leftHandle, 80);
  const leftAfterDrag = await page.evaluate((k) => localStorage.getItem(k), LEFT_PANEL_WIDTH_KEY);
  expect(Number(leftAfterDrag)).toBeGreaterThanOrEqual(370);
  expect(Number(leftAfterDrag)).toBeLessThanOrEqual(390);

  // Switch to tabbed layout.
  await page.locator("[data-testid='settings-btn']").click();
  await page.locator("[data-testid='layout-tabbed-btn']").click();
  await page.keyboard.press("Escape");

  // Drag the tabbed handle so the right key changes.
  const tabbedHandle = page.locator("[data-testid='panel-resize-handle']");
  await expect(tabbedHandle).toBeVisible();
  await dragHandleBy(tabbedHandle, -60);

  // Left key must still be what we set earlier — tabbed mode must not
  // touch it.
  const leftAfterTabbed = await page.evaluate((k) => localStorage.getItem(k), LEFT_PANEL_WIDTH_KEY);
  expect(leftAfterTabbed).toBe(leftAfterDrag);

  // Switch back to three-panel and verify the left handle is still at the
  // original value.
  await page.locator("[data-testid='settings-btn']").click();
  await page.locator("[data-testid='layout-three-panel-btn']").click();
  await page.keyboard.press("Escape");
  const leftAfterBack = await page.evaluate((k) => localStorage.getItem(k), LEFT_PANEL_WIDTH_KEY);
  expect(leftAfterBack).toBe(leftAfterDrag);
});

test("side panel resets scroll to top on filter change (no active annotation)", async ({
  page,
}) => {
  // Seed enough annotations to overflow the side panel, then scroll the list
  // down, change a filter, and assert the list is back at the top. Guards
  // SidePanel.tsx's filter-change scroll-reset effect.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  // 15 comments on the title — parallel seeding over HTTP MCP.
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      mcp.callTool("tandem_comment", {
        from: 2,
        to: 6,
        text: `note ${i}`,
        textSnapshot: "Test",
      }),
    ),
  );

  await page.goto("/");
  await switchToAnnotationsTab(page);

  // The scroll container is the SidePanel's outer wrapper, not the inner
  // role="list" div. Production scrollTo() is wired to this element.
  const scrollContainer = page.locator("[data-testid='annotation-list-scroll-container']");
  await expect(scrollContainer).toBeVisible();
  // Wait for all 15 cards to render inside it.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(15);

  // Scroll to the bottom of the real scroll container.
  await scrollContainer.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const scrollBefore = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeGreaterThan(0);

  // Change the type filter — effect should scroll back to 0.
  await page.locator("[data-testid='filter-type']").selectOption("comment");
  await expect
    .poll(async () => scrollContainer.evaluate((el) => el.scrollTop), {
      timeout: 2_000,
    })
    .toBe(0);
});

test("Clear-filters button also resets scroll to top", async ({ page }) => {
  // The Clear button is a sibling trigger for the same scroll-reset effect.
  // Guards against a regression where the effect is wired to selectOption
  // events but not to the Clear path that sets all three filters at once.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      mcp.callTool("tandem_comment", {
        from: 2,
        to: 6,
        text: `note ${i}`,
        textSnapshot: "Test",
      }),
    ),
  );

  await page.goto("/");
  await switchToAnnotationsTab(page);

  const scrollContainer = page.locator("[data-testid='annotation-list-scroll-container']");
  await expect(scrollContainer).toBeVisible();
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(15);

  // Set a filter so the Clear button appears.
  await page.locator("[data-testid='filter-type']").selectOption("comment");

  // Scroll to the bottom.
  await scrollContainer.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const scrollBefore = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeGreaterThan(0);

  // Click Clear — the filter-change effect should reset scroll to 0.
  await page.getByTestId("clear-filters-btn").click();

  await expect
    .poll(async () => scrollContainer.evaluate((el) => el.scrollTop), {
      timeout: 2_000,
    })
    .toBe(0);
});

test("dwell-time slider value persists across reload", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await page.locator("[data-testid='settings-btn']").click();
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name: "Claude Code/Cowork" }).click();
  const slider = popover.locator("[data-testid='dwell-time-slider']");
  await expect(slider).toBeVisible({ timeout: 2_000 });

  // Set the range input value and fire a React-compatible change event.
  // React tracks controlled-input values through a native setter; calling
  // that setter before dispatching the event ensures React's onChange fires.
  await slider.evaluate((el) => {
    const input = el as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    nativeSetter?.call(input, "2000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Sanity check: the native-setter dance must actually round-trip through
  // React's onChange. Without this, the old version of this test silently
  // passed because the input event fired but React state never updated.
  await expect(slider).toHaveValue("2000");

  const savedDwell = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { selectionDwellMs?: number }).selectionDwellMs : null;
  }, TANDEM_SETTINGS_KEY);
  expect(savedDwell).toBe(2000);

  // Reload and confirm the slider shows the saved value.
  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-testid='settings-btn']").click();
  const reloadedPopover = page.locator("[data-testid='settings-popover']");
  await reloadedPopover.getByRole("button", { name: "Claude Code/Cowork" }).click();
  const reloadedSlider = reloadedPopover.locator("[data-testid='dwell-time-slider']");
  await expect(reloadedSlider).toHaveValue("2000");
});

test("settings popover stays within viewport on short screens (#306)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.setViewportSize({ width: 1024, height: 400 }); // 400px guarantees maxHeight overflow
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await page.locator("[data-testid='settings-btn']").click();

  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible();

  const box = await popover.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);

  const scrollRegion = popover.locator("section > div").first();
  const { overflowed, overflowY } = await scrollRegion.evaluate((el) => ({
    overflowed: el.scrollHeight > el.clientHeight,
    overflowY: window.getComputedStyle(el).overflowY,
  }));
  expect(overflowed).toBe(true);
  expect(overflowY).toBe("auto");
});

// Verifies that selections are buffered server-side and no longer emitted
// as standalone SSE events (#188). This E2E proves the full pipeline from
// browser selection → server awareness → SSE endpoint produces no
// selection:changed events.
test("selections are buffered, not pushed as SSE events (#188)", async ({ page }) => {
  // Verify that making a selection does NOT produce a selection:changed SSE
  // event — selections are now buffered per-document and attached to chat
  // messages instead of firing as standalone events.
  await mcp.callTool("tandem_open", {
    filePath: path.join(tmpDir, "sample.md"),
  });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // Subscribe to SSE events
  const eventsUrl = `http://localhost:${DEFAULT_MCP_PORT}/api/events`;
  await page.evaluate((url) => {
    (window as unknown as { __tandemEvents: unknown[] }).__tandemEvents = [];
    const es = new EventSource(url);
    (window as unknown as { __tandemEventSource: EventSource }).__tandemEventSource = es;
    es.onmessage = (e: MessageEvent) => {
      try {
        (window as unknown as { __tandemEvents: unknown[] }).__tandemEvents.push(
          JSON.parse(e.data),
        );
      } catch {
        // Ignore keepalives or non-JSON comment lines.
      }
    };
  }, eventsUrl);

  // Wait for SSE subscription to be OPEN
  await page.waitForFunction(
    () =>
      (window as unknown as { __tandemEventSource?: EventSource }).__tandemEventSource
        ?.readyState === 1,
    null,
    { timeout: 5_000 },
  );

  // Make a selection in the editor
  const prose = page.locator(".tandem-editor");
  await prose.click();
  await prose.locator("h1").first().selectText();

  // Wait well past the maximum dwell time (3000ms max + headroom)
  await page.waitForTimeout(4000);

  // No selection:changed events should have been emitted
  const events = (await page.evaluate(
    () => (window as unknown as { __tandemEvents: unknown[] }).__tandemEvents ?? [],
  )) as Array<{ type?: string }>;
  const selectionEvents = events.filter((e) => e?.type === "selection:changed");
  expect(
    selectionEvents.length,
    "selection:changed events should no longer be emitted — selections are buffered per-document (#188)",
  ).toBe(0);
});

test("note filter shows only notes, hides comments (ADR-027 C1)", async ({ page }) => {
  // Seed one comment via MCP. Notes are user-private and cannot be created via
  // MCP tools — they must be driven through the editor toolbar (ADR-027).
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: 2,
    to: 6,
    text: "MCP comment",
    textSnapshot: "Test",
  });

  await page.goto("/");
  await switchToAnnotationsTab(page);

  // Wait for the MCP comment card to appear before driving the toolbar.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 15_000,
  });

  // Select text in the editor so the Note button becomes enabled.
  // "Section One" appears at the top of the second heading — a stable range.
  const editor = page.locator(".tiptap");
  await editor.click();
  // Select the first-paragraph text so we have a non-empty selection.
  const firstParagraph = editor.locator("p").first();
  await firstParagraph.selectText();

  // Wait for the toolbar to detect the selection and enable the Note button.
  // ToolbarButton sets aria-label from its label prop when it's a string, so
  // `getByRole` is reliable here. (TODO: add data-testid="note-btn" to Toolbar.tsx)
  const noteBtn = page.getByRole("button", { name: "Note", exact: true });
  await expect(noteBtn).toBeEnabled({ timeout: 3_000 });

  // Open note mode (mousedown handler captures selection before focus shifts).
  await noteBtn.click();

  // The InputGroup renders with placeholder "Add a note to yourself..." — find
  // the text input that just appeared.
  const noteInput = page.locator('input[placeholder="Add a note to yourself..."]');
  await expect(noteInput).toBeVisible({ timeout: 2_000 });

  // Type note content and submit with Enter.
  await noteInput.fill("my private note");
  await noteInput.press("Enter");

  // Both annotations must sync over Hocuspocus before we filter.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(2, {
    timeout: 15_000,
  });

  // Filter to "note" — only the note card should be visible.
  await page.locator("[data-testid='filter-type']").selectOption("note");
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 3_000,
  });

  // Switch filter to "comment" — only the MCP comment should be visible.
  await page.locator("[data-testid='filter-type']").selectOption("comment");
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 3_000,
  });
});
