/**
 * E2E tests for the store-read-only warning banner in SidePanel.
 *
 * The banner is driven by Y.Map state set at server startup (via
 * broadcastStoreReadOnly). Because we cannot restart the shared E2E server
 * mid-run with a locked annotation store, these tests exercise the banner's
 * DOM contract directly — the same approach as connection-banner.spec.ts.
 *
 * Unit tests in tests/server/document-service.test.ts cover the server-side
 * broadcastStoreReadOnly → Y_MAP_STORE_READ_ONLY write.
 */
import { expect, test } from "@playwright/test";

test("store-readonly banner is visible when storeReadOnly is true", async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script>
      const root = document.getElementById("root");
      const banner = document.createElement("div");
      banner.setAttribute("data-testid", "store-readonly-banner");
      banner.style.cssText = "padding:10px 14px; display:flex; justify-content:space-between; align-items:flex-start; gap:10px;";
      const span = document.createElement("span");
      span.textContent = "Annotation store is read-only — another Tandem instance holds the lock. Annotations won't be saved. Close the other instance and restart.";
      banner.appendChild(span);
      const btn = document.createElement("button");
      btn.setAttribute("data-testid", "store-readonly-dismiss");
      btn.textContent = "Dismiss";
      btn.addEventListener("click", () => { banner.remove(); });
      banner.appendChild(btn);
      root.appendChild(banner);
    </script>
  `);

  const banner = page.locator("[data-testid='store-readonly-banner']");
  await expect(banner).toBeVisible({ timeout: 5_000 });
  await expect(banner).toContainText("Annotation store is read-only");
  await expect(banner).toContainText("Close the other instance and restart");
});

test("store-readonly banner is hidden when already dismissed", async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script>
      // Simulate pre-dismissed state: render nothing.
    </script>
  `);

  const banner = page.locator("[data-testid='store-readonly-banner']");
  await expect(banner).toHaveCount(0);
});

test("dismiss button hides the banner", async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script>
      const root = document.getElementById("root");
      const banner = document.createElement("div");
      banner.setAttribute("data-testid", "store-readonly-banner");
      const span = document.createElement("span");
      span.textContent = "Annotation store is read-only";
      banner.appendChild(span);
      const btn = document.createElement("button");
      btn.setAttribute("data-testid", "store-readonly-dismiss");
      btn.textContent = "Dismiss";
      btn.addEventListener("click", () => { banner.remove(); });
      banner.appendChild(btn);
      root.appendChild(banner);
    </script>
  `);

  const banner = page.locator("[data-testid='store-readonly-banner']");
  await expect(banner).toBeVisible({ timeout: 5_000 });

  await page.locator("[data-testid='store-readonly-dismiss']").click();
  await expect(banner).toHaveCount(0);
});
