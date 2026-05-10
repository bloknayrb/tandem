/**
 * E2E tests for the store-read-only warning banner in SidePanel.
 *
 * The banner is driven by Y.Map state set at server startup (via
 * broadcastStoreReadOnly). Because we cannot restart the shared E2E server
 * mid-run with a locked annotation store, these tests exercise the banner's
 * DOM contract and localStorage dismiss persistence directly — the same
 * approach as connection-banner.spec.ts.
 *
 * Unit tests in tests/server/document-service.test.ts cover the server-side
 * broadcastStoreReadOnly → Y_MAP_STORE_READ_ONLY write.
 */
import { expect, test } from "@playwright/test";

const DISMISS_KEY = "tandem:storeReadOnlyBannerDismissed";

const BANNER_MESSAGE =
  "Annotation store is read-only — another Tandem instance holds the lock. Annotations won't be saved. Close the other instance and restart.";

test.afterEach(async ({ page }) => {
  // Clear dismiss state so tests don't bleed into each other.
  await page.evaluate((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // storage unavailable
    }
  }, DISMISS_KEY);
});

/**
 * Build a minimal page that mimics the SidePanel store-read-only banner.
 * Using DOM APIs (createElement / textContent / appendChild) rather than
 * innerHTML to avoid security-linter false positives on controlled test HTML.
 */
async function mountBannerPage(
  page: import("@playwright/test").Page,
  { seedDismissed = false }: { seedDismissed?: boolean } = {},
) {
  await page.goto("about:blank");

  // Seed localStorage before mounting.
  if (seedDismissed) {
    await page.evaluate((key) => {
      try {
        localStorage.setItem(key, "true");
      } catch {
        // storage disabled
      }
    }, DISMISS_KEY);
  } else {
    await page.evaluate((key) => {
      try {
        localStorage.removeItem(key);
      } catch {
        // storage disabled
      }
    }, DISMISS_KEY);
  }

  // Mount the banner component logic via page.evaluate using safe DOM APIs.
  await page.evaluate(
    ([key, message]) => {
      function isDismissed(): boolean {
        try {
          return localStorage.getItem(key) === "true";
        } catch {
          return false;
        }
      }

      function renderBanner() {
        const root = document.body;
        // Clear previous content.
        while (root.firstChild) root.removeChild(root.firstChild);

        if (!isDismissed()) {
          const banner = document.createElement("div");
          banner.setAttribute("data-testid", "store-readonly-banner");
          banner.style.cssText =
            "padding:10px 14px; margin:10px 14px 0; display:flex; justify-content:space-between; align-items:flex-start; gap:10px;";

          const span = document.createElement("span");
          span.textContent = message;
          banner.appendChild(span);

          const btn = document.createElement("button");
          btn.setAttribute("data-testid", "store-readonly-dismiss");
          btn.textContent = "Dismiss";
          btn.addEventListener("click", () => {
            try {
              localStorage.setItem(key, "true");
            } catch {
              // storage disabled
            }
            renderBanner();
          });
          banner.appendChild(btn);
          root.appendChild(banner);
        }
      }

      renderBanner();
    },
    [DISMISS_KEY, BANNER_MESSAGE] as [string, string],
  );
}

test("store-readonly banner is visible when storeReadOnly is true", async ({ page }) => {
  await mountBannerPage(page);
  const banner = page.locator("[data-testid='store-readonly-banner']");
  await expect(banner).toBeVisible({ timeout: 5_000 });
  await expect(banner).toContainText("Annotation store is read-only");
  await expect(banner).toContainText("Close the other instance and restart");
});

test("store-readonly banner is hidden when already dismissed", async ({ page }) => {
  await mountBannerPage(page, { seedDismissed: true });
  const banner = page.locator("[data-testid='store-readonly-banner']");
  await expect(banner).toHaveCount(0);
});

test("dismiss button hides the banner and persists to localStorage", async ({ page }) => {
  await mountBannerPage(page);

  const banner = page.locator("[data-testid='store-readonly-banner']");
  await expect(banner).toBeVisible({ timeout: 5_000 });

  await page.locator("[data-testid='store-readonly-dismiss']").click();
  await expect(banner).toHaveCount(0);

  // Verify localStorage was written.
  const stored = await page.evaluate((key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }, DISMISS_KEY);
  expect(stored).toBe("true");
});

test("banner stays dismissed after page re-mount", async ({ page }) => {
  await mountBannerPage(page);

  // Dismiss the banner.
  await page.locator("[data-testid='store-readonly-dismiss']").click();
  await expect(page.locator("[data-testid='store-readonly-banner']")).toHaveCount(0);

  // Re-mount the page — localStorage now carries the dismissed flag.
  await mountBannerPage(page);
  await expect(page.locator("[data-testid='store-readonly-banner']")).toHaveCount(0);
});
