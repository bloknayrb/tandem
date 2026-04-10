import { expect, test } from "@playwright/test";
import path from "path";
import {
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

test.afterEach(async () => {
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
  const heldBanner = page.getByText(/\d+ annotation(s)? held/);
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
