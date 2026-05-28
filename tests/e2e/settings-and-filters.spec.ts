import { expect, test } from "@playwright/test";
import path from "path";
import { DEFAULT_MCP_PORT, TANDEM_MODE_KEY, TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openAnnotatePopup,
  openSettingsPopover,
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

  await openSettingsPopover(page);

  // Popover mounts with its own testid
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });
  await expect(popover.getByRole("button", { name: "Appearance" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await popover.getByRole("button", { name: "AI Assistant" }).click();
  // Dwell slider is present and adjustable — proves the new slider and its
  // testid are wired up. The actual broadcast into CTRL_ROOM is covered by
  // the event-queue-dwell unit test; here we just verify the UI surface.
  const dwellSlider = popover.locator("[data-testid='dwell-time-slider']");
  await expect(dwellSlider).toBeVisible();
  await expect(dwellSlider).toHaveAttribute("type", "range");

  await popover.getByRole("button", { name: "Appearance" }).click();

  await popover.getByRole("button", { name: "Editor" }).click();
  // Reading-measure preset control (Phase 3.5 Stage B; replaced the % slider).
  await expect(popover.locator("[data-testid='editor-measure-comfortable']")).toBeVisible();
});

test("settings dialog surfaces default mode and persists it", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openSettingsPopover(page);
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
  await openSettingsPopover(page);
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

  await openSettingsPopover(page);
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });

  for (const section of [
    "Appearance",
    "Editor",
    "Accessibility",
    "Collaboration",
    "AI Assistant",
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

  await openSettingsPopover(page);
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });
  await popover.getByRole("button", { name: "AI Assistant" }).click();

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

  await openSettingsPopover(page);
  const reopenedPopover = page.locator("[data-testid='settings-popover']");
  await reopenedPopover.getByRole("button", { name: "AI Assistant" }).click();
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

test("Solo/Tandem mode toggle switches via toolbar (Wave M: fade-not-hide)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  // Seed a pending annotation — Wave M keeps it visible (faded) in solo mode.
  await mcp.callTool("tandem_comment", {
    from: 2,
    to: 6,
    text: "pending note",
    textSnapshot: "Test",
  });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await switchToAnnotationsTab(page);
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 10_000,
  });

  const soloBtn = page.locator("[data-testid='mode-solo-btn']");
  const tandemBtn = page.locator("[data-testid='mode-tandem-btn']");
  await expect(soloBtn).toBeVisible({ timeout: 5_000 });
  await expect(tandemBtn).toBeVisible();

  // Default is tandem.
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "false");

  // No held affordance in any mode — Wave M replaces held-hiding with a
  // CSS opacity fade. sb-held is permanently absent.
  const heldButton = page.getByTestId("sb-held");
  await expect(heldButton).toHaveCount(0);

  // Switch to solo. Assert via localStorage (race-free) + aria-pressed.
  await soloBtn.click();
  await expect(soloBtn).toHaveAttribute("aria-pressed", "true");
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "false");
  const soloSaved = await page.evaluate((key) => localStorage.getItem(key), TANDEM_MODE_KEY);
  expect(soloSaved).toBe("solo");

  // Wave M: annotation is visible (not held). The CSS fade is at 0.45 opacity
  // but the card is still in the DOM — count must remain 1.
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(1, {
    timeout: 2_000,
  });
  // No held bucket — sb-held never renders.
  await expect(heldButton).toHaveCount(0);

  // Switch back via the toggle. Wave M's toggle is two distinct buttons —
  // each sets the mode unconditionally, so re-clicking solo would no-op.
  await tandemBtn.click();
  await expect(tandemBtn).toHaveAttribute("aria-pressed", "true");
  await expect(soloBtn).toHaveAttribute("aria-pressed", "false");
  const tandemSaved = await page.evaluate((key) => localStorage.getItem(key), TANDEM_MODE_KEY);
  expect(tandemSaved).toBe("tandem");

  // Still no held affordance in Tandem.
  await expect(heldButton).toHaveCount(0);
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

  await openSettingsPopover(page);
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name: "AI Assistant" }).click();
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
  await openSettingsPopover(page);
  const reloadedPopover = page.locator("[data-testid='settings-popover']");
  await reloadedPopover.getByRole("button", { name: "AI Assistant" }).click();
  const reloadedSlider = reloadedPopover.locator("[data-testid='dwell-time-slider']");
  await expect(reloadedSlider).toHaveValue("2000");
});

test("settings popover stays within viewport on short screens (#306)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });

  await page.setViewportSize({ width: 1024, height: 400 }); // 400px guarantees maxHeight overflow
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openSettingsPopover(page);

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
  const eventsUrl = `http://127.0.0.1:${DEFAULT_MCP_PORT}/api/events`;
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

  // Wait well past the maximum dwell time. Server-side, the timer is scheduled
  // with `getDwellMs()` from awareness.ts:30-42, which reads CTRL_ROOM Y.Map.
  // Default `SELECTION_DWELL_DEFAULT_MS` is 1000ms; the slider ceiling is 3000ms.
  // 4000ms = 3000ms ceiling + 1000ms RTT headroom for the would-be SSE round-trip.
  // This is a "prove a negative" wait — no shorter signal exists for the absence
  // of an event. See ADR / issue #188 for the buffering rationale.
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

  // Wave M (#776): selection shows the action surface; clicking Annotate
  // reveals the textarea. Originally AR3 surfaced the textarea on selection.
  await openAnnotatePopup(page);
  const noteInput = page.locator("[data-testid='popup-annotation-input']");

  // Type note content and submit via "Note to self".
  await noteInput.fill("my private note");
  await page.locator("[data-testid='popup-note-submit']").click();

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

// ─── Narrow-width responsive layout tests (issue #515) ───────────────────────

/** Open sample.md, navigate to the app, and open the settings dialog at the given viewport. */
async function openSettingsDialog(
  page: import("@playwright/test").Page,
  width = 600,
  height = 800,
) {
  await page.setViewportSize({ width, height });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await openSettingsPopover(page);
  const dialog = page.locator("[data-testid='settings-popover']");
  await expect(dialog).toBeVisible({ timeout: 3_000 });
  return dialog;
}

test("settings dialog at 600x800 viewport — section nav reachable without horizontal scroll", async ({
  page,
}) => {
  const dialog = await openSettingsDialog(page);

  // Nav buttons should all be within the dialog bounds (no horizontal overflow).
  // overflow:hidden on the dialog means scrollWidth === clientWidth, but we
  // want to confirm each button's right edge is inside the dialog, proving
  // the single-column layout is in effect and buttons are not clipped away.
  const navButtons = dialog.locator("nav[aria-label='Settings sections'] button");
  await expect(navButtons.first()).toBeVisible();

  // Collect all button rects in a single round-trip to avoid N serial calls.
  const { dialogRight, buttonRects } = await page.evaluate(() => {
    const dlg = document.querySelector("[data-testid='settings-popover']")!;
    const btns = Array.from(dlg.querySelectorAll("nav[aria-label='Settings sections'] button"));
    const dr = dlg.getBoundingClientRect();
    return {
      dialogRight: dr.x + dr.width,
      buttonRects: btns.map((b) => {
        const r = b.getBoundingClientRect();
        return { width: r.width, right: r.x + r.width };
      }),
    };
  });

  for (const btn of buttonRects) {
    expect(btn.width).toBeGreaterThan(0);
    expect(btn.right).toBeLessThanOrEqual(dialogRight + 1);
  }
});

test("settings dialog at 600x800 viewport — Tab cycles through visible controls without dead-ends", async ({
  page,
}) => {
  const dialog = await openSettingsDialog(page);

  // Tab through the dialog at least 5 times, collecting focused elements.
  // Each Tab press must (a) keep focus inside the dialog and (b) move focus.
  const seenHandles: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    const focusedId = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? (el.dataset.testid ?? el.tagName + el.textContent?.slice(0, 20)) : "none";
    });
    seenHandles.push(focusedId);

    const focusInDialog = await dialog.evaluate((dlg) => dlg.contains(document.activeElement));
    expect(focusInDialog).toBe(true);
  }

  const distinct = new Set(seenHandles);
  expect(distinct.size).toBeGreaterThanOrEqual(2);
});

test("settings dialog resize from 1280 to 600 with focus inside — focus survives reflow", async ({
  page,
}) => {
  const dialog = await openSettingsDialog(page, 1280, 800);

  // Tab twice to land focus on an interactive control inside the dialog.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");

  // Guard: confirm focus is inside before triggering reflow.
  const focusInDialogBefore = await dialog.evaluate((dlg) => dlg.contains(document.activeElement));
  expect(focusInDialogBefore).toBe(true);

  await page.setViewportSize({ width: 600, height: 800 });

  await page.keyboard.press("Tab");
  const focusInDialogAfter = await dialog.evaluate((dlg) => dlg.contains(document.activeElement));
  expect(focusInDialogAfter).toBe(true);
});

test("settings dialog at 600x800 viewport — section content readable, no clipped controls", async ({
  page,
}) => {
  const dialog = await openSettingsDialog(page);

  // Single-column layout at 600px means content spans the full dialog width.
  // A width under 200px indicates the two-column grid is still active and
  // content is crushed into an unusable strip.
  const contentBox = await dialog.locator("[data-testid='settings-content']").boundingBox();
  expect(contentBox).not.toBeNull();
  expect(contentBox!.width).toBeGreaterThanOrEqual(200);
});
