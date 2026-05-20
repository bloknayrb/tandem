import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
import { cleanupAllOpenDocuments, McpTestClient, nextFrames } from "./helpers";

/**
 * Settings → Models tab E2E (Wave 2 PR 8b, #659).
 *
 * Covers:
 *   1. Disclosure banner is visible the moment the tab is selected.
 *   2. Empty-state CTA "Add your first model" opens the edit modal.
 *   3. Add a cloud (Anthropic) model — row appears with correct fields.
 *   4. Edit a cloud model — apiKey input renders masked (`••••${last4}`)
 *      and the DOM value is NEVER the real key. Replace key reveals an
 *      empty editable input.
 *   5. Toggle enabled flips state.
 *   6. Delete via two-step confirm flow.
 *   7. v2→v3 migration boot — pre-seed v2 blob, mount, assert Models tab
 *      renders with empty list (catches a broken migration that nukes
 *      settings).
 *   8. v99 forward-compat boot — pre-seed `schemaVersion: 99` with a
 *      custom field, reload, assert the custom field is preserved.
 *
 * Test-fixture API keys use the form `sk-test-DO-NOT-USE-{provider}` so
 * grep-based secret scanners match cleanly and false-positives are easy
 * to filter.
 */

let mcp: McpTestClient;
let tmpDir: string;

const SETTINGS_MODAL = "[data-testid='settings-modal']";
const MODELS_TAB = "[data-testid='settings-modal-tab-models']";
const BANNER = "[data-testid='models-disclosure-banner']";
const ADD_BTN = "[data-testid='model-add-btn']";
const MODAL = "[data-testid='model-edit-modal']";

async function openSettingsModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tandemTest?: { openSettingsModal: () => void } };
    if (!w.__tandemTest?.openSettingsModal) {
      throw new Error("__tandemTest.openSettingsModal is not installed");
    }
    w.__tandemTest.openSettingsModal();
  });
  await expect(page.locator(SETTINGS_MODAL)).toBeVisible({ timeout: 5_000 });
}

async function gotoModelsTab(page: Page): Promise<void> {
  await openSettingsModal(page);
  await page.locator(MODELS_TAB).click();
}

async function clearModelsRegistry(page: Page): Promise<void> {
  await page.evaluate((key) => {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      parsed.models = [];
      localStorage.setItem(key, JSON.stringify(parsed));
    } catch {
      /* ignore */
    }
  }, TANDEM_SETTINGS_KEY);
  await page.reload();
}

test.beforeAll(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-e2e-models-"));
  fs.writeFileSync(path.join(tmpDir, "sample.md"), "# sample\n", "utf-8");
});

test.afterAll(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test.beforeEach(async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  // Reset the registry between tests so each starts from empty.
  await clearModelsRegistry(page);
});

test("disclosure banner is visible the moment the Models tab is selected", async ({ page }) => {
  await gotoModelsTab(page);
  await expect(page.locator(BANNER)).toBeVisible();
  await expect(page.locator(BANNER)).toContainText("unencrypted");
});

test("empty state — CTA opens the edit modal", async ({ page }) => {
  await gotoModelsTab(page);
  await expect(page.locator("[data-testid='models-empty-state']")).toBeVisible();
  await page.locator(ADD_BTN).click();
  await expect(page.locator(MODAL)).toBeVisible();
  // Cancel — modal closes, empty state returns.
  await page.locator("[data-testid='model-edit-cancel']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);
  await expect(page.locator("[data-testid='models-empty-state']")).toBeVisible();
});

test("add cloud model — row appears with correct fields", async ({ page }) => {
  await gotoModelsTab(page);
  await page.locator(ADD_BTN).click();
  await expect(page.locator(MODAL)).toBeVisible();

  await page.locator("[data-testid='model-edit-provider']").selectOption("anthropic");
  await page.locator("[data-testid='model-edit-displayname']").fill("My Opus");
  await page.locator("[data-testid='model-edit-modelid']").fill("claude-opus-4-7");
  await page.locator("[data-testid='model-edit-apikey']").fill("sk-test-DO-NOT-USE-anthropic");
  await page.locator("[data-testid='model-edit-save']").click();

  await expect(page.locator(MODAL)).toHaveCount(0);
  const row = page.locator("[data-testid^='model-row-']").first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("My Opus");
  await expect(row).toContainText("claude-opus-4-7");
});

test("edit cloud model — API key input is masked and never round-trips through DOM", async ({
  page,
}) => {
  // Seed an entry directly so we know the exact key text.
  const SEEDED_KEY = "sk-test-DO-NOT-USE-anthropic-seededValue";
  await page.evaluate(
    ({ key, seededKey }) => {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      parsed.models = [
        {
          id: "seeded-id",
          provider: "anthropic",
          displayName: "Seeded",
          modelId: "claude-opus-4-7",
          apiKey: seededKey,
          enabled: true,
        },
      ];
      parsed.schemaVersion = 3;
      localStorage.setItem(key, JSON.stringify(parsed));
    },
    { key: TANDEM_SETTINGS_KEY, seededKey: SEEDED_KEY },
  );
  await page.reload();
  await gotoModelsTab(page);
  await page.locator("[data-testid='model-edit-btn-seeded-id']").click();
  await expect(page.locator(MODAL)).toBeVisible();

  // No editable input rendered for the apiKey while in masked mode.
  await expect(page.locator("[data-testid='model-edit-apikey']")).toHaveCount(0);
  // The masked label shows the last 4 chars of the seeded key.
  await expect(page.locator(MODAL)).toContainText(`••••••••${SEEDED_KEY.slice(-4)}`);

  // Snapshot the full DOM and assert the seeded key text does NOT appear
  // anywhere — this is the load-bearing assertion against the modal
  // round-tripping the existing key through a `value=` attribute.
  const dom = await page.locator(MODAL).innerHTML();
  expect(dom).not.toContain(SEEDED_KEY);

  // Click "Replace key" — input becomes editable and empty.
  await page.locator("[data-testid='model-edit-apikey-replace-btn']").click();
  const input = page.locator("[data-testid='model-edit-apikey']");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "password");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toHaveValue("");

  // Enter a new key, save.
  await input.fill("sk-test-DO-NOT-USE-anthropic-newValue");
  await page.locator("[data-testid='model-edit-save']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);

  // Verify the new key landed in settings (and the seeded one didn't).
  const persisted = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, TANDEM_SETTINGS_KEY);
  expect(persisted?.models?.[0]?.apiKey).toBe("sk-test-DO-NOT-USE-anthropic-newValue");
});

test("toggle enabled flips state", async ({ page }) => {
  await gotoModelsTab(page);
  await page.locator(ADD_BTN).click();
  await page.locator("[data-testid='model-edit-displayname']").fill("Toggle test");
  await page.locator("[data-testid='model-edit-modelid']").fill("claude-opus-4-7");
  await page.locator("[data-testid='model-edit-apikey']").fill("sk-test-DO-NOT-USE-anthropic");
  await page.locator("[data-testid='model-edit-save']").click();

  const row = page.locator("[data-testid^='model-row-']").first();
  const toggle = row.locator("[data-testid^='model-toggle-']");
  await expect(toggle).toBeChecked();

  await toggle.click();
  await expect(toggle).not.toBeChecked();
});

test("delete with confirm flow", async ({ page }) => {
  await gotoModelsTab(page);
  await page.locator(ADD_BTN).click();
  await page.locator("[data-testid='model-edit-displayname']").fill("To delete");
  await page.locator("[data-testid='model-edit-modelid']").fill("claude-opus-4-7");
  await page.locator("[data-testid='model-edit-apikey']").fill("sk-test-DO-NOT-USE-anthropic");
  await page.locator("[data-testid='model-edit-save']").click();

  const row = page.locator("[data-testid^='model-row-']").first();
  await expect(row).toBeVisible();
  const rowId = (await row.getAttribute("data-testid"))!.replace("model-row-", "");

  // First click on "Delete" surfaces the confirm row but doesn't yet
  // delete — guards against fat-finger clicks.
  await page.locator(`[data-testid='model-delete-btn-${rowId}']`).click();
  await expect(row).toBeVisible();
  await expect(page.locator(`[data-testid='model-delete-confirm-${rowId}']`)).toBeVisible();

  // Confirm — row removed, empty state returns.
  await page.locator(`[data-testid='model-delete-confirm-${rowId}']`).click();
  await expect(page.locator("[data-testid^='model-row-']")).toHaveCount(0);
  await expect(page.locator("[data-testid='models-empty-state']")).toBeVisible();
});

test("v2→v6 migration boot — Models tab renders with empty list, settings survive", async ({
  page,
}) => {
  // Pre-seed a v2 blob (no `models` field, schemaVersion: 2). The loader
  // walks v2→v3→v4→v5→v6 in memory; persistence happens only when something
  // calls updateSettings. So we trigger a real write (add a model) which
  // forces mergeAndClampSettings to persist the migrated shape, then
  // assert the persisted blob carries schemaVersion: 6 + the seeded
  // theme/textSize.
  await page.evaluate((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        schemaVersion: 2,
        leftPanelVisible: true,
        rightPanelVisible: true,
        theme: "dark",
        textSize: "l",
      }),
    );
  }, TANDEM_SETTINGS_KEY);
  await page.reload();

  await gotoModelsTab(page);
  // The empty state proves the migration provided an empty `models` array
  // (the tab unconditionally renders the empty branch when `models.length === 0`).
  await expect(page.locator("[data-testid='models-empty-state']")).toBeVisible();

  // Trigger a real settings write to flush the migrated shape to localStorage.
  await page.locator("[data-testid='model-add-btn']").click();
  await page.locator("[data-testid='model-edit-displayname']").fill("Migration sentinel");
  await page.locator("[data-testid='model-edit-modelid']").fill("claude-opus-4-7");
  await page.locator("[data-testid='model-edit-apikey']").fill("sk-test-DO-NOT-USE-anthropic");
  await page.locator("[data-testid='model-edit-save']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);

  // Now inspect the persisted shape — the migration must have preserved
  // the v2 fields (theme, textSize) and climbed to schemaVersion: 6 (v3
  // added `models`, v4 was a no-op intermediate, v5 stripped the rail-tab
  // fields entirely, v6 drops the legacy `showIntegrationWizard` field —
  // wizard lifecycle moved to its own `tandem:wizard-dismissed` key).
  const settings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, TANDEM_SETTINGS_KEY);
  expect(settings?.theme).toBe("dark");
  expect(settings?.textSize).toBe("l");
  expect(settings?.schemaVersion).toBe(6);
  expect(settings?.models?.length).toBe(1);
  expect(settings?.models?.[0]?.displayName).toBe("Migration sentinel");
});

test("v99 forward-compat boot — unknown field is preserved", async ({ page }) => {
  // Pre-seed a v99 blob with a custom field — the loader's forward-compat
  // clause must preserve `futureField` and refuse to write settings on
  // subsequent updates.
  await page.evaluate((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        schemaVersion: 99,
        leftPanelVisible: true,
        rightPanelVisible: true,
        models: [],
        futureField: "preserved-value",
      }),
    );
  }, TANDEM_SETTINGS_KEY);
  await page.reload();

  // Install a setItem spy AFTER reload (which wipes window state) so it
  // captures any erroneous write to the settings key during the Models tab
  // mount. Concrete signal beats "wait for settling". The original setItem
  // is stashed on `window.__origSetItem` so the test can restore it after
  // assertion — keeps the patch from leaking if context reuse is ever
  // enabled (e.g. someone debugging with `--workers=1` + shared context).
  await page.evaluate((key) => {
    const w = window as unknown as {
      __settingsWrites: string[];
      __origSetItem: (k: string, v: string) => void;
    };
    w.__settingsWrites = [];
    w.__origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === key) w.__settingsWrites.push(String(v));
      return w.__origSetItem.call(this, k, v);
    };
  }, TANDEM_SETTINGS_KEY);

  // Navigate to Models tab — the tab mounts a parallel `createTandemSettings()`
  // which inherits the _readOnly flag from loadSettings.
  await gotoModelsTab(page);
  await nextFrames(page); // flush mount effects

  // Concrete assertion: no write landed on the settings key. `useTandemSettings`
  // writes are synchronous today, so a single read after `nextFrames` would
  // suffice; the short poll exists to make the failure mode less brittle
  // against minor timing shifts in the mount path.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as unknown as { __settingsWrites: string[] }).__settingsWrites.length,
        ),
      { timeout: 300, intervals: [50, 100, 100, 50] },
    )
    .toBe(0);

  // Restore the patched setItem so subsequent navigations in this page (or
  // shared-context fixtures, if ever introduced) are unaffected.
  await page.evaluate(() => {
    const w = window as unknown as { __origSetItem: (k: string, v: string) => void };
    Storage.prototype.setItem = w.__origSetItem;
  });

  // The settings blob must still contain `futureField` after the load.
  const settings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, TANDEM_SETTINGS_KEY);
  expect(settings?.futureField).toBe("preserved-value");
  expect(settings?.schemaVersion).toBe(99);
});
