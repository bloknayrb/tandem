import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CURRENT_SCHEMA_VERSION } from "../../src/client/hooks/useTandemSettings";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
import { cleanupAllOpenDocuments, McpTestClient, nextFrames } from "./helpers";

/**
 * Settings → Models tab E2E (#659).
 *
 * Covers:
 *   1. Empty-state CTA "Add your first model" opens the edit modal.
 *   2. Add a cloud (Anthropic) model — row appears with correct fields and
 *      the plaintext API key NEVER lands in localStorage; only an opaque
 *      `apiKeyRef` is persisted (the key goes through the keychain endpoint).
 *   3. Edit a cloud model — `apiKeyRef` is shown masked; the entry's
 *      plaintext is NOT in the DOM. Replace key reveals an editable input.
 *   4. Toggle enabled flips state.
 *   5. Delete via two-step confirm flow.
 *   6. Default selection: setting a default, persisting through reload,
 *      and the titlebar chip surfacing the active model's displayName.
 *   7. v2 migration boot — pre-seed v2 blob, mount, assert Models tab
 *      renders with empty list (catches a broken migration that nukes
 *      settings); persisted shape carries schemaVersion 7 + defaultModelId.
 *   8. Legacy plaintext key migration: seed a pre-v7 blob with `apiKey`,
 *      assert the migration banner appears, click Migrate, banner disappears
 *      and the entry now carries `apiKeyRef`.
 *   9. v99 forward-compat boot — pre-seed `schemaVersion: 99` with a
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
      parsed.defaultModelId = null;
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
  // CI's `check` job runs on a stock ubuntu-latest with no libsecret /
  // dbus, so the real OS-keychain backend throws `KeychainUnavailableError`
  // on every secret store. The E2E layer cares about the data-model
  // contract (plaintext never lands in localStorage; only the opaque
  // `apiKeyRef` does) — NOT about the system keychain being up. Stub the
  // POST/DELETE routes here so the in-product flow runs end-to-end against
  // a fake-but-real network layer. The server-side unit tests in
  // `tests/server/models/api-routes.test.ts` cover the real keychain path
  // with an in-memory backend.
  await page.route("**/api/models/secrets/**", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      await route.fulfill({ status: 204, body: "" });
    } else if (method === "DELETE") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ existed: true }),
      });
    } else {
      await route.continue();
    }
  });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await clearModelsRegistry(page);
});

test("empty state — CTA opens the edit modal", async ({ page }) => {
  await gotoModelsTab(page);
  await expect(page.locator("[data-testid='models-empty-state']")).toBeVisible();
  await page.locator(ADD_BTN).click();
  await expect(page.locator(MODAL)).toBeVisible();
  await page.locator("[data-testid='model-edit-cancel']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);
  await expect(page.locator("[data-testid='models-empty-state']")).toBeVisible();
});

test("add cloud model — row appears and plaintext key is NOT persisted to localStorage", async ({
  page,
}) => {
  const PLAINTEXT = "sk-test-DO-NOT-USE-anthropic-newlyTyped";
  await gotoModelsTab(page);
  await page.locator(ADD_BTN).click();
  await expect(page.locator(MODAL)).toBeVisible();

  await page.locator("[data-testid='model-edit-provider']").selectOption("anthropic");
  await page.locator("[data-testid='model-edit-displayname']").fill("My Opus");
  await page.locator("[data-testid='model-edit-modelid']").fill("claude-opus-4-7");
  await page.locator("[data-testid='model-edit-apikey']").fill(PLAINTEXT);
  await page.locator("[data-testid='model-edit-save']").click();

  await expect(page.locator(MODAL)).toHaveCount(0);
  const row = page.locator("[data-testid^='model-row-']").first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("My Opus");
  await expect(row).toContainText("claude-opus-4-7");

  // Critical: the plaintext key the user typed must NEVER reach
  // localStorage. The persisted entry should carry only an opaque
  // `apiKeyRef`; the plaintext was POSTed to the keychain endpoint.
  const persisted = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, TANDEM_SETTINGS_KEY);
  const entry = persisted?.models?.[0];
  expect(entry).toBeDefined();
  expect(entry.apiKey).toBeUndefined();
  expect(entry.apiKeyRef).toBeDefined();
  expect(typeof entry.apiKeyRef).toBe("string");
  expect(entry.apiKeyRef.length).toBeGreaterThan(0);
  // Whole-blob assertion: the plaintext must not appear anywhere in the
  // settings blob (defends against a future bug that leaks via a sibling
  // field).
  expect(JSON.stringify(persisted)).not.toContain(PLAINTEXT);
});

test("edit cloud model — API key input renders masked and plaintext is never in the DOM", async ({
  page,
}) => {
  // Add a model via the UI so we go through the real keychain flow.
  const PLAINTEXT = "sk-test-DO-NOT-USE-anthropic-existingValue";
  await gotoModelsTab(page);
  await page.locator(ADD_BTN).click();
  await page.locator("[data-testid='model-edit-displayname']").fill("Seeded");
  await page.locator("[data-testid='model-edit-modelid']").fill("claude-opus-4-7");
  await page.locator("[data-testid='model-edit-apikey']").fill(PLAINTEXT);
  await page.locator("[data-testid='model-edit-save']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);

  // Open the edit modal — `apiKeyRef` is present, so the input is hidden
  // behind the masked label + Replace-key button.
  const row = page.locator("[data-testid^='model-row-']").first();
  await row.locator("[data-testid^='model-edit-btn-']").click();
  await expect(page.locator(MODAL)).toBeVisible();

  await expect(page.locator("[data-testid='model-edit-apikey']")).toHaveCount(0);
  // The plaintext value the user typed must not appear anywhere in the
  // modal DOM — the only way it should ever exist on the client now is in
  // the running tab's transient state, not in persisted storage or the DOM
  // tree of the edit modal.
  const dom = await page.locator(MODAL).innerHTML();
  expect(dom).not.toContain(PLAINTEXT);

  // Replace key reveals an editable input.
  await page.locator("[data-testid='model-edit-apikey-replace-btn']").click();
  const input = page.locator("[data-testid='model-edit-apikey']");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "password");
  await expect(input).toHaveValue("");
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

  await page.locator(`[data-testid='model-delete-btn-${rowId}']`).click();
  await expect(row).toBeVisible();
  await expect(page.locator(`[data-testid='model-delete-confirm-${rowId}']`)).toBeVisible();

  await page.locator(`[data-testid='model-delete-confirm-${rowId}']`).click();
  await expect(page.locator("[data-testid^='model-row-']")).toHaveCount(0);
  await expect(page.locator("[data-testid='models-empty-state']")).toBeVisible();
});

test("default selection persists across reload and the titlebar chip surfaces it", async ({
  page,
}) => {
  await gotoModelsTab(page);
  await page.locator(ADD_BTN).click();
  await page.locator("[data-testid='model-edit-displayname']").fill("My default model");
  await page.locator("[data-testid='model-edit-modelid']").fill("claude-opus-4-7");
  await page.locator("[data-testid='model-edit-apikey']").fill("sk-test-DO-NOT-USE-anthropic");
  await page.locator("[data-testid='model-edit-save']").click();

  const row = page.locator("[data-testid^='model-row-']").first();
  const rowId = (await row.getAttribute("data-testid"))!.replace("model-row-", "");
  const defaultRadio = page.locator(`[data-testid='model-default-${rowId}']`);
  await defaultRadio.click();
  await expect(defaultRadio).toBeChecked();

  // Persisted shape carries `defaultModelId` matching the row id.
  const persisted = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, TANDEM_SETTINGS_KEY);
  expect(persisted?.defaultModelId).toBe(rowId);

  // Close the settings modal to expose the titlebar.
  await page.keyboard.press("Escape");

  // The titlebar chip surfaces the active model's displayName and is clickable.
  const chip = page.locator("[data-testid='titlebar-default-model']");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("My default model");

  // Reload — both the persisted defaultModelId and the chip survive.
  await page.reload();
  await expect(page.locator("[data-testid='titlebar-default-model']")).toContainText(
    "My default model",
  );
  const reloaded = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, TANDEM_SETTINGS_KEY);
  expect(reloaded?.defaultModelId).toBe(rowId);
});

test("legacy plaintext key migration banner — appears, migrates, then disappears", async ({
  page,
}) => {
  // Pre-seed a pre-v7 blob with a plaintext `apiKey` to drive the migration
  // banner. The `_legacyApiKey` field is the in-memory marker `parseModels`
  // sets; the banner triggers off `models.hasLegacyKeys`.
  const LEGACY_KEY = "sk-test-DO-NOT-USE-anthropic-legacy";
  await page.evaluate(
    ({ key, legacy }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          schemaVersion: 6,
          leftPanelVisible: false,
          rightPanelVisible: true,
          models: [
            {
              id: "legacy-1",
              provider: "anthropic",
              displayName: "Legacy entry",
              modelId: "claude-opus-4-7",
              apiKey: legacy,
              enabled: true,
            },
          ],
        }),
      );
    },
    { key: TANDEM_SETTINGS_KEY, legacy: LEGACY_KEY },
  );
  await page.reload();
  await gotoModelsTab(page);

  // Banner is visible — the entry was loaded with a transient `_legacyApiKey`.
  const banner = page.locator("[data-testid='models-legacy-migration-banner']");
  await expect(banner).toBeVisible();

  await page.locator("[data-testid='models-legacy-migrate-btn']").click();

  // After migration the banner disappears and the entry now carries
  // `apiKeyRef` instead of `_legacyApiKey`/`apiKey`.
  await expect(banner).toHaveCount(0);
  const persisted = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, TANDEM_SETTINGS_KEY);
  expect(persisted?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  expect(persisted?.models?.[0]?.apiKey).toBeUndefined();
  expect(persisted?.models?.[0]?.apiKeyRef).toBeDefined();
  // The plaintext must NEVER appear in localStorage post-migration.
  expect(JSON.stringify(persisted)).not.toContain(LEGACY_KEY);
});

test("v2 → v7 migration boot — Models tab renders with empty list, settings survive", async ({
  page,
}) => {
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
  await expect(page.locator("[data-testid='models-empty-state']")).toBeVisible();

  // Trigger a real settings write to flush the migrated shape to localStorage.
  await page.locator("[data-testid='model-add-btn']").click();
  await page.locator("[data-testid='model-edit-displayname']").fill("Migration sentinel");
  await page.locator("[data-testid='model-edit-modelid']").fill("claude-opus-4-7");
  await page.locator("[data-testid='model-edit-apikey']").fill("sk-test-DO-NOT-USE-anthropic");
  await page.locator("[data-testid='model-edit-save']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);

  const settings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, TANDEM_SETTINGS_KEY);
  expect(settings?.theme).toBe("dark");
  expect(settings?.textSize).toBe("l");
  expect(settings?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  expect(settings?.models?.length).toBe(1);
  expect(settings?.models?.[0]?.displayName).toBe("Migration sentinel");
  // v7 introduces `defaultModelId` initialized to null on the migration.
  expect(settings).toHaveProperty("defaultModelId");
});

test("v99 forward-compat boot — unknown field is preserved", async ({ page }) => {
  await page.evaluate((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        schemaVersion: 99,
        leftPanelVisible: true,
        rightPanelVisible: true,
        models: [],
        defaultModelId: null,
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

  const settings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, TANDEM_SETTINGS_KEY);
  expect(settings?.futureField).toBe("preserved-value");
  expect(settings?.schemaVersion).toBe(99);
});
