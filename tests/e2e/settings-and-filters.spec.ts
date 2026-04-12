import { expect, test } from "@playwright/test";
import path from "path";
import {
  CTRL_ROOM,
  DEFAULT_MCP_PORT,
  LEFT_PANEL_WIDTH_KEY,
  PANEL_WIDTH_KEY,
  SELECTION_DWELL_DEFAULT_MS,
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
  await mcp.callTool("tandem_highlight", { from: 16, to: 24, color: "yellow" });
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
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });
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

  const threePanelSaved = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { layout?: string }).layout : null;
  }, TANDEM_SETTINGS_KEY);
  expect(threePanelSaved).toBe("three-panel");

  // Switch back.
  await page.locator("[data-testid='layout-tabbed-btn']").click();
  await expect(page.locator("[data-testid='panel-resize-handle']")).toHaveCount(1);
  await expect(page.locator("[data-testid='left-panel-resize-handle']")).toHaveCount(0);
});

test("three-panel layout resizes left/right widths independently", async ({ page }) => {
  // Production wires the left handle to `tandem-left-panel-width` and the
  // right handle to `tandem-panel-width`. The regression this guards against
  // is #228's bundled-state bug where both handles wrote to the same key.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

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
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

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
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });
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
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

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
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

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
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  // Clear all width state before starting.
  await page.evaluate(
    ([leftKey, rightKey]) => {
      localStorage.removeItem(leftKey);
      localStorage.removeItem(rightKey);
    },
    [LEFT_PANEL_WIDTH_KEY, PANEL_WIDTH_KEY],
  );
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

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

test("side panel keeps active annotation in view on filter change", async ({ page }) => {
  // The sibling branch of the filter-change effect: when an annotation is
  // active (review mode), the list should scroll *it* into view instead of
  // jumping to the top (#202). We assert both that the card is visible AND
  // that scrollTop > 0 — the latter proves the scroll-to-top fallback did
  // not fire (which would be a silent regression).
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
  const cards = page.locator("[data-testid^='annotation-card-']");
  await expect(cards).toHaveCount(15);

  // Activate an annotation near the bottom. Review mode + Tab navigation is
  // the only code path that sets activeAnnotationId from the side panel —
  // clicking a card just scrolls the editor via scrollToAnnotation(), it
  // does NOT mark the annotation as active.
  await page.locator("[data-testid='review-mode-btn']").click();
  await expect(page.locator("text=Reviewing 1 /")).toBeVisible({ timeout: 5_000 });
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
  }
  await expect(page.locator("text=Reviewing 13 /")).toBeVisible({ timeout: 2_000 });
  const targetCard = cards.nth(12);

  // Reset the scroll so the effect has to work to put the card back in view.
  await scrollContainer.evaluate((el) => {
    el.scrollTop = 0;
  });

  // Change the type filter. The effect should scroll the active card into
  // view instead of resetting to scrollTop = 0.
  await page.locator("[data-testid='filter-type']").selectOption("comment");

  // (a) The active card must end up inside the scroll container's visible area.
  await expect
    .poll(
      async () => {
        const listBox = await scrollContainer.boundingBox();
        const cardBox = await targetCard.boundingBox();
        if (!listBox || !cardBox) return false;
        return cardBox.y + cardBox.height > listBox.y && cardBox.y < listBox.y + listBox.height;
      },
      { timeout: 2_000 },
    )
    .toBe(true);

  // (b) scrollTop must be nonzero — proves the scroll-to-top fallback did NOT
  // run. Without this, the test passes trivially in tall viewports.
  const finalScroll = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(finalScroll).toBeGreaterThan(0);
});

test("side panel scrolls to top (+ logs warn) when active annotation is filtered out", async ({
  page,
}) => {
  // Branch 3 of the filter-change scroll-reset effect: an annotation is
  // active (via review-mode Tab navigation), then the user changes filters
  // in a way that excludes that annotation. The card is no longer in the
  // DOM, so `querySelector` misses — the effect must fall through to
  // scroll-to-top AND log a `[tandem]`-prefixed warn so "scroll jumped"
  // bug reports are diagnosable.
  const consoleWarnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") consoleWarnings.push(msg.text());
  });

  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  // Seed 14 comments + 1 highlight (15 total — matches the sibling overflow
  // tests at :480-523 where 15 is the known-good count for overflowing the
  // scroll container across viewport sizes). The highlight is what we'll
  // filter to so every active comment gets filtered out.
  await Promise.all([
    ...Array.from({ length: 14 }, (_, i) =>
      mcp.callTool("tandem_comment", {
        from: 2,
        to: 6,
        text: `note ${i}`,
        textSnapshot: "Test",
      }),
    ),
    mcp.callTool("tandem_highlight", {
      from: 7,
      to: 15,
      color: "yellow",
      textSnapshot: "Document",
    }),
  ]);

  await page.goto("/");
  await switchToAnnotationsTab(page);

  const scrollContainer = page.locator("[data-testid='annotation-list-scroll-container']");
  await expect(scrollContainer).toBeVisible();
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(15);

  // Enter review mode and Tab to a middle comment so it becomes the active
  // annotation. Review-mode Tab is the only path that sets activeAnnotationId
  // from the side panel.
  await page.locator("[data-testid='review-mode-btn']").click();
  await expect(page.locator("text=Reviewing 1 /")).toBeVisible({ timeout: 5_000 });
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
  }
  await expect(page.locator("text=Reviewing 6 /")).toBeVisible({ timeout: 2_000 });

  // Scroll the list down so we can detect the scroll-to-top fallback.
  await scrollContainer.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const scrollBefore = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeGreaterThan(0);

  // Filter to "highlight" — the active annotation is a comment, so its
  // card leaves the DOM. The effect must log the warn and scroll to 0.
  await page.locator("[data-testid='filter-type']").selectOption("highlight");

  await expect
    .poll(async () => scrollContainer.evaluate((el) => el.scrollTop), {
      timeout: 2_000,
    })
    .toBe(0);

  // The fallback warn must have fired. This is the diagnostic-log contract
  // added in commit 52576aa — losing it means "scroll jumped unexpectedly"
  // becomes invisible in bug reports again.
  const matched = consoleWarnings.some((m) =>
    /\[tandem\] SidePanel: active annotation .* not found on filter change/.test(m),
  );
  expect(matched).toBe(true);
});

test("dwell-time slider value persists across reload", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  await page.locator("[data-testid='settings-btn']").click();
  const slider = page.locator("[data-testid='dwell-time-slider']");
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
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-testid='settings-btn']").click();
  const reloadedSlider = page.locator("[data-testid='dwell-time-slider']");
  await expect(reloadedSlider).toHaveValue("2000");
});

// Bridge-layer coverage that cannot be exercised by
// `tests/server/event-queue-dwell.test.ts:122` ("respects custom dwell time
// from CTRL_ROOM awareness"). The unit test writes directly to the server-side
// CTRL_ROOM awareness map and drives `vi.advanceTimersByTime`, bypassing:
//   1. SettingsPopover → useTandemSettings → localStorage persistence
//   2. App.tsx useEffect → awareness.set(Y_MAP_DWELL_MS, value) broadcast
//   3. Hocuspocus client → server sync of CTRL_ROOM awareness
//   4. awareness.ts editor extension writing real DOM selection into
//      per-document user awareness
//   5. SSE channel delivery through /api/events
// This E2E proves all five links are wired correctly; do not delete it as
// "already covered by unit tests."
test("dwell-time slider value is honored by the selection event pipeline", async ({ page }) => {
  // Capture the fixture's documentId so the positive assertion below can
  // match against the actual document, not just `toBeTruthy()`. This closes
  // a silent-failure hole: without the strict match, a selection event from
  // an unrelated document (or a future regression that leaks CTRL_ROOM
  // events) would pass the check trivially.
  const openResult = (await mcp.callTool("tandem_open", {
    filePath: path.join(tmpDir, "sample.md"),
  })) as { error: false; data: { documentId: string } } | { error: true };
  if (openResult.error !== false) {
    throw new Error("tandem_open failed in dwell-time test setup");
  }
  const fixtureDocId = openResult.data.documentId;

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });

  // --- Step 0: Reset CTRL_ROOM dwell to default before doing anything.
  // CTRL_ROOM's Y_MAP_DWELL_MS is server-side state shared across every
  // E2E test within the same webServer lifetime. Playwright's per-context
  // isolation does NOT reset it, so a preceding test that set dwell=2000
  // (the persistence test above) would leave stale CTRL_ROOM state. Without
  // this reset, the negative-window assertion below can pass for the wrong
  // reason (stale 2000ms value happens to exceed the 1500ms negative wait).
  //
  // Route through the slider UI so App.tsx's broadcast useEffect fires, which
  // is the only non-invasive way to rewrite CTRL_ROOM's awareness map.
  // We bounce through a non-default value first to guarantee React's onChange
  // fires (React skips no-op value writes on controlled inputs, and a fresh
  // page's in-memory state is already SELECTION_DWELL_DEFAULT_MS so a
  // direct single write of that value would be a no-op that neither persists
  // to localStorage nor triggers App.tsx's broadcast effect).
  const bounceValue = SELECTION_DWELL_DEFAULT_MS + 100;
  await setDwellSliderValue(page, bounceValue);
  await setDwellSliderValue(page, SELECTION_DWELL_DEFAULT_MS);
  await expect
    .poll(
      async () =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          return raw ? (JSON.parse(raw) as { selectionDwellMs?: number }).selectionDwellMs : null;
        }, TANDEM_SETTINGS_KEY),
      { timeout: 2_000 },
    )
    .toBe(SELECTION_DWELL_DEFAULT_MS);
  // Give the Hocuspocus client a beat to push the awareness write to the
  // server before we start relying on it.
  await page.waitForTimeout(250);
  // Close the popover so future clicks in the editor dispatch selection.
  // Wait for the hidden state explicitly — otherwise the next
  // `setDwellSliderValue(2500)` call races the close animation and its
  // `isVisible()` branch would skip the re-open click.
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid='settings-popover']")).toBeHidden({ timeout: 2_000 });

  // --- Step 3: Subscribe to SSE with an absolute URL.
  // `page.evaluate(() => new EventSource("/api/events"))` would resolve
  // against the page origin (Vite :5173), which does NOT proxy /api/events.
  // Must be absolute to the MCP HTTP server (:3479).
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

  // --- Step 4: Open settings popover and set slider to 2500ms.
  await setDwellSliderValue(page, 2500);

  // --- Step 5: Pre-assertion — localStorage reflects the broadcast.
  // Catches broadcast-key regressions without requiring timing. If this
  // fails, the pipeline is broken upstream of the server and there's no
  // point proceeding to the timing checks.
  const savedDwell = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { selectionDwellMs?: number }).selectionDwellMs : null;
  }, TANDEM_SETTINGS_KEY);
  expect(savedDwell).toBe(2500);

  // --- Step 6: Close settings popover so selection clicks reach the editor.
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid='settings-popover']")).toBeHidden({ timeout: 2_000 });

  // --- Step 7: Wait for SSE subscription to be OPEN before making the
  // selection. Without this, the test can silently false-pass because the
  // selection event fires before the subscription was established.
  await page.waitForFunction(
    () =>
      (window as unknown as { __tandemEventSource?: EventSource }).__tandemEventSource
        ?.readyState === 1, // EventSource.OPEN
    null,
    { timeout: 5_000 },
  );

  // Give the awareness write from setDwellSliderValue a beat to propagate to
  // the server — otherwise the selection dwell timer we're about to trigger
  // would schedule with the stale value.
  await page.waitForTimeout(250);

  // --- Step 8: Make a real selection in the editor. Mirror how the
  // persistence test dispatches events: use the ProseMirror DOM API via
  // Playwright so the editor's awareness plugin picks it up exactly as a
  // human-driven selection would.
  const prose = page.locator(".ProseMirror");
  await prose.click(); // focus the editor
  // Select the phrase "Test Document" in the H1. `selectText()` selects
  // the entire element; for a steady, non-trivial selection that's fine
  // since the awareness plugin writes the range with truncated text.
  await prose.locator("h1").first().selectText();

  // Mark start time so we can assert the negative window wasn't cut short
  // by CI runner scheduling. Not a strict guard, but a diagnostic hook.
  const negativeStart = Date.now();

  // --- Step 9: Negative window (fixed wait).
  // The default dwell is 1000ms. A regression to default would fire at
  // ~1000ms — this 1500ms wait catches that with 500ms of headroom. Any
  // faster-than-2500ms regression (500ms, 0ms, etc.) is also caught.
  await page.waitForTimeout(1500);
  const negativeElapsed = Date.now() - negativeStart;
  // Diagnostic: a runner preempted for >1500ms would extend the wait,
  // so < 1500 is only possible via clock skew. Log it as a warning rather
  // than failing so CI artifacts show the shape of the flake if it happens.
  if (negativeElapsed < 1500) {
    console.warn(
      `[test] negative-window wait returned early: ${negativeElapsed}ms; this should not happen`,
    );
  }

  const afterNegative = await page.evaluate(
    () => (window as unknown as { __tandemEvents: unknown[] }).__tandemEvents?.length ?? 0,
  );
  expect(
    afterNegative,
    "selection:changed fired before the configured dwell elapsed — slider is not controlling the server pipeline",
  ).toBe(0);

  // --- Step 10: Positive window (bounded poll).
  // Total time-of-selection budget: up to 1500 (neg) + 4000 (poll) = 5500ms,
  // well over the 2500ms dwell even on a slow CI. The poll cadence is
  // [100, 200, 400] so we settle quickly once the event lands.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as unknown as { __tandemEvents: unknown[] }).__tandemEvents?.length ?? 0,
        ),
      { timeout: 4_000, intervals: [100, 200, 400] },
    )
    .toBeGreaterThanOrEqual(1);

  // Verify the received event shape — at least one must be a
  // selection:changed for a real document (not CTRL_ROOM), with a
  // non-empty selectedText payload matching what we selected.
  const events = (await page.evaluate(
    () => (window as unknown as { __tandemEvents: unknown[] }).__tandemEvents ?? [],
  )) as Array<{
    type?: string;
    documentId?: string;
    payload?: { selectedText?: string };
  }>;
  const selectionEvents = events.filter((e) => e?.type === "selection:changed");
  expect(selectionEvents.length).toBeGreaterThanOrEqual(1);
  const first = selectionEvents[0];
  // Strict positive match against the fixture's actual documentId. This
  // implicitly excludes CTRL_ROOM (which is `CTRL_ROOM` from shared
  // constants, not the previously-hardcoded "tandem:ctrl" literal that
  // could never match anything), and also catches any regression that
  // leaks an event from an unrelated document into this test's context.
  expect(first.documentId).toBe(fixtureDocId);
  expect(first.documentId).not.toBe(CTRL_ROOM);
  expect(first.payload?.selectedText ?? "").toContain("Test Document");
});

/**
 * Open the settings popover (if not already open), set the dwell-time slider
 * to the given value, and verify the input reflects it. Uses the React
 * native-setter trick so React's onChange actually fires — a plain `.fill()`
 * doesn't round-trip through React's controlled-input tracking. Leaves the
 * popover open. Safe to call repeatedly.
 */
async function setDwellSliderValue(
  page: import("@playwright/test").Page,
  value: number,
): Promise<void> {
  const popover = page.locator("[data-testid='settings-popover']");
  const isOpen = await popover.isVisible().catch(() => false);
  if (!isOpen) {
    await page.locator("[data-testid='settings-btn']").click();
    await expect(popover).toBeVisible({ timeout: 2_000 });
  }
  const slider = page.locator("[data-testid='dwell-time-slider']");
  await expect(slider).toBeVisible({ timeout: 2_000 });
  await slider.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    nativeSetter?.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await expect(slider).toHaveValue(String(value));
}
