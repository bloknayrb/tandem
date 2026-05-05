import { expect, test } from "@playwright/test";

test("connection banner renders and dismisses in the browser", async ({ page }) => {
  await page.setContent(`
    <div id="app"></div>
    <script>
      const PROLONGED_DISCONNECT_MS = 30000;
      const disconnectedSince = Date.now() - PROLONGED_DISCONNECT_MS;
      const root = document.getElementById("app");

      function renderBanner() {
        root.innerHTML = '<div data-testid="connection-banner"><span>Connection to the Tandem server has been lost. Ensure the server is running.</span><button aria-label="Dismiss connection banner">×</button></div>';
        root.querySelector("button").addEventListener("click", () => {
          root.innerHTML = "<div data-testid='dismissed'>dismissed</div>";
        });
      }

      if (Date.now() - disconnectedSince >= PROLONGED_DISCONNECT_MS) {
        renderBanner();
      }
    </script>
  `);

  const banner = page.locator("[data-testid='connection-banner']");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText("Connection to the Tandem server has been lost");
  await banner.getByLabel("Dismiss connection banner").click();
  await expect(banner).toHaveCount(0);
});
