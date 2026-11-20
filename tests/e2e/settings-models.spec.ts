import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CURRENT_SCHEMA_VERSION } from "../../src/client/hooks/useTandemSettings";
import { BYO_MODELS_ENABLED, TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
import type { ModelsEntry, ModelsFile } from "../../src/shared/models/contract";
import {
  cleanupAllOpenDocuments,
  EMPTY_MODELS_FILE,
  expectOnlyAllowanceNotices,
  McpTestClient,
  nextFrames,
  readServerAnswerer,
  readServerModels,
  resetLocalModelState,
  seedModels,
} from "./helpers";
import {
  ANSWERER_LOCAL_NOTICE,
  defaultIsCloudLine,
  FIRST_LOCAL_MODEL_TOAST_TEXT,
  MODEL_SAVE_REASON,
  MODEL_UNAVAILABLE_TEXT,
  nameFallback,
  providerHeading,
  USE_IT_FOR_CHAT_LABEL,
} from "./local-model-strings";

// Local models ship dark: the Models tab is filtered out while the flag is off,
// so this whole file is skipped there (pinned by
// tests/scripts/e2e-local-model-skip-wiring.test.ts; the flip deletes it).
test.skip(!BYO_MODELS_ENABLED, "Models UI gated off until BYO_MODELS_ENABLED (#1123)");

/**
 * Settings → Models E2E (#659; rewritten for local providers in #1123 PR 8a,
 * ADR-039's amendment on E2E for the Models specs).
 *
 * The registry, who answers chat and the commenting switch are SERVER state
 * (the registry has been server-only since #1123 M2), so each test starts and
 * ends with `resetLocalModelState` from Node, never a browser-storage write.
 * Cloud providers can no longer be added (P4/W3); an old cloud entry is seeded
 * on the server to show how it is listed. No test may reach a real model
 * server: every entry saved through the window gets the Endpoint
 * `http://127.0.0.1:9` first (the discard port; nothing listens there), and
 * every seeded one has it too. No request may reach `/api/models/secrets`: a
 * local entry carries no key.
 *
 * The page is the Vite client, not Tandem's own window: its writes are
 * admitted through the development allowance and may raise its notices,
 * which `expectOnlyAllowanceNotices` accepts and nothing else.
 */

const SETTINGS_MODAL = "[data-testid='settings-modal']";
const MODELS_TAB = "[data-testid='settings-modal-tab-models']";
const ADD_BTN = "[data-testid='model-add-btn']";
const MODAL = "[data-testid='model-edit-modal']";
const CHIP = "[data-testid='titlebar-default-model']";
const NO_SERVER_ENDPOINT = "http://127.0.0.1:9";

let mcp: McpTestClient;
let tmpDir: string;
let secretsRequests: string[] = [];

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
  await expect(page.locator("[data-testid='chat-answerer-section']")).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator(SETTINGS_MODAL)).toHaveCount(0);
}

/** Add a local entry through the window, Endpoint pointed nowhere. */
async function addThroughWindow(page: Page, modelId: string, name = ""): Promise<void> {
  await page.locator(ADD_BTN).click();
  await expect(page.locator(MODAL)).toBeVisible();
  if (name) await page.locator("[data-testid='model-edit-displayname']").fill(name);
  await page.locator("[data-testid='model-edit-modelid']").fill(modelId);
  await page.locator("[data-testid='model-edit-endpoint']").fill(NO_SERVER_ENDPOINT);
  await page.locator("[data-testid='model-edit-save']").click();
  await expect(page.locator(MODAL)).toHaveCount(0);
}

function localEntry(over: Partial<ModelsEntry> = {}): ModelsEntry {
  return {
    id: randomUUID(),
    provider: "local-ollama",
    displayName: "Seeded local",
    modelId: "seeded-model",
    endpoint: NO_SERVER_ENDPOINT,
    enabled: true,
    ...over,
  };
}

function cloudEntry(over: Partial<ModelsEntry> = {}): ModelsEntry {
  return {
    id: randomUUID(),
    provider: "anthropic",
    displayName: "Cloud Default",
    modelId: "claude-old",
    enabled: true,
    ...over,
  };
}

function fileOf(models: ModelsEntry[], defaultModelId: string | null): ModelsFile {
  return { ...EMPTY_MODELS_FILE, models, defaultModelId };
}

/** The toast carrying `text`, found inside the toast stack. */
function toastWith(page: Page, text: string): Locator {
  return page
    .locator("[data-testid='toast-container'] > [data-testid^='toast-']")
    .filter({ hasText: text });
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
  await resetLocalModelState("settings-models");
  secretsRequests = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/models/secrets")) secretsRequests.push(req.url());
  });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
});

test.afterEach(async ({ page }) => {
  if (!BYO_MODELS_ENABLED) return;
  // The reset runs even when an assertion here fails: a server left with chat
  // set to a local model would break every later spec's chat.
  try {
    // A local entry carries no key, so nothing may ever reach the secrets route.
    expect(secretsRequests).toEqual([]);
    await expectOnlyAllowanceNotices(page);
  } finally {
    await resetLocalModelState("settings-models");
  }
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

test("add a local model: prefill, Save's reasons in order, optional name, first model is Default", async ({
  page,
}) => {
  const provider = page.locator("[data-testid='model-edit-provider']");
  const endpoint = page.locator("[data-testid='model-edit-endpoint']");
  const modelId = page.locator("[data-testid='model-edit-modelid']");
  const save = page.locator("[data-testid='model-edit-save']");
  const reason = page.locator("[data-testid='model-edit-save-reason']");

  await gotoModelsTab(page);
  await page.locator(ADD_BTN).click();
  await expect(page.locator(MODAL)).toBeVisible();

  // Local providers only, Ollama first and prefilled (P4, V2).
  await expect(provider).toHaveValue("local-ollama");
  const options = await provider
    .locator("option")
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(options.every((v) => v.startsWith("local-"))).toBe(true);
  await expect(endpoint).toHaveValue("http://127.0.0.1:11434");
  await expect(reason).toHaveText(MODEL_SAVE_REASON.noModelId);

  // llama.cpp has no usual address, so the Endpoint empties. With BOTH fields
  // blank the Model ID's reason wins (first match, Model ID first).
  await provider.selectOption("local-llamacpp");
  await expect(endpoint).toHaveValue("");
  await expect(reason).toHaveText(MODEL_SAVE_REASON.noModelId);
  await modelId.fill("qwen-test");
  await expect(reason).toHaveText(MODEL_SAVE_REASON.noEndpoint);
  await expect(save).toHaveAttribute("aria-disabled", "true");

  // LM Studio is prefilled too; Other is not (V2).
  await provider.selectOption("local-lmstudio");
  await expect(endpoint).toHaveValue("http://127.0.0.1:1234");
  await provider.selectOption("local-other");
  await expect(endpoint).toHaveValue("");

  // Back to Ollama: its prefill returns. Name left blank (V18).
  await provider.selectOption("local-ollama");
  await expect(endpoint).toHaveValue("http://127.0.0.1:11434");
  await endpoint.fill(NO_SERVER_ENDPOINT);
  await expect(reason).toHaveCount(0);
  await save.click();
  await expect(page.locator(MODAL)).toHaveCount(0);

  const row = page.locator("[data-testid^='model-row-']");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(nameFallback("local-ollama"));
  await expect(row).toContainText("qwen-test");

  // On the server: one entry, named by the fallback, and the Default (L6).
  await expect
    .poll(async () => {
      const { file } = await readServerModels();
      const [e] = file.models;
      return file.models.length === 1
        ? {
            provider: e.provider,
            displayName: e.displayName,
            modelId: e.modelId,
            endpoint: e.endpoint,
            isDefault: file.defaultModelId === e.id,
          }
        : file.models.length;
    })
    .toEqual({
      provider: "local-ollama",
      displayName: nameFallback("local-ollama"),
      modelId: "qwen-test",
      endpoint: NO_SERVER_ENDPOINT,
      isDefault: true,
    });
});

test("the first local model's confirmation stays until pressed; pressing it sets chat to the local model", async ({
  page,
}) => {
  // Installed before the page loads, so the toast's timers run on this clock.
  await page.clock.install();
  await page.reload();

  await gotoModelsTab(page);
  await addThroughWindow(page, "chat-model", "Chat Model");

  const confirmation = toastWith(page, FIRST_LOCAL_MODEL_TOAST_TEXT);
  await expect(confirmation).toBeVisible();
  const action = confirmation.locator("[data-testid^='toast-action-']");
  await expect(action).toHaveText(USE_IT_FOR_CHAT_LABEL);
  await expect(page.locator(CHIP)).toHaveCount(0);

  // Longer than any timed toast lives (an error's 8 s), under the 30 s
  // reconnect timeout: it is still there (W2), and chat is still Claude (P5).
  await page.clock.fastForward(25_000);
  await expect(confirmation).toBeVisible();
  expect(await readServerAnswerer()).toBe("claude");

  await action.click();
  await expect.poll(readServerAnswerer).toBe("local");
  await expect(confirmation).toHaveCount(0);
  await expect(toastWith(page, ANSWERER_LOCAL_NOTICE)).toBeVisible();

  await closeSettings(page);
  await expect(page.locator(CHIP)).toBeVisible();
  await expect(page.locator(CHIP)).toContainText("Chat Model");
});

test("the title chip shows only while chat is set to an enabled local Default", async ({
  page,
}) => {
  const entry = localEntry({ displayName: "Chip Model" });
  await seedModels(fileOf([entry], entry.id));
  await page.reload();
  const claude = page.locator("[data-testid='chat-answerer-claude']");
  const local = page.locator("[data-testid='chat-answerer-local']");

  // Chat on Claude: no chip.
  await gotoModelsTab(page);
  await expect(claude).toHaveAttribute("aria-checked", "true");
  await closeSettings(page);
  await expect(page.locator(CHIP)).toHaveCount(0);

  // Chat on the local model: the chip, with its name.
  await gotoModelsTab(page);
  await local.click();
  await expect.poll(readServerAnswerer).toBe("local");
  await closeSettings(page);
  await expect(page.locator(CHIP)).toContainText("Chip Model");

  // Back to Claude: gone.
  await gotoModelsTab(page);
  await claude.click();
  await expect.poll(readServerAnswerer).toBe("claude");
  await closeSettings(page);
  await expect(page.locator(CHIP)).toHaveCount(0);

  // Local again, then the Default switched off: gone, with chat still local.
  await gotoModelsTab(page);
  await local.click();
  await expect.poll(readServerAnswerer).toBe("local");
  await closeSettings(page);
  await expect(page.locator(CHIP)).toBeVisible();
  await gotoModelsTab(page);
  await page.locator(`[data-testid='model-toggle-${entry.id}']`).click();
  await expect.poll(async () => (await readServerModels()).file.models[0]?.enabled).toBe(false);
  expect(await readServerAnswerer()).toBe("local");
  await closeSettings(page);
  await expect(page.locator(CHIP)).toHaveCount(0);
});

test("a cloud Default the user set is kept when a local model is added (DD1)", async ({ page }) => {
  const cloud = cloudEntry();
  await seedModels(fileOf([cloud], cloud.id));
  await page.reload();

  await gotoModelsTab(page);
  await addThroughWindow(page, "local-after-cloud");
  await expect.poll(async () => (await readServerModels()).file.models.length).toBe(2);
  expect((await readServerModels()).file.defaultModelId).toBe(cloud.id);
  // The tab says why the local model will not answer.
  await expect(page.locator(SETTINGS_MODAL)).toContainText(defaultIsCloudLine(cloud.displayName));

  await page.locator("[data-testid='chat-answerer-local']").click();
  await expect.poll(readServerAnswerer).toBe("local");
  await closeSettings(page);
  await expect(page.locator(CHIP)).toHaveCount(0);
  expect((await readServerModels()).file.defaultModelId).toBe(cloud.id);
});

test("On/Off and Delete with its confirm step", async ({ page }) => {
  const entry = localEntry({ displayName: "To toggle and delete" });
  await seedModels(fileOf([entry], entry.id));
  await page.reload();
  await gotoModelsTab(page);

  const toggle = page.locator(`[data-testid='model-toggle-${entry.id}']`);
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await readServerModels()).file.models[0]?.enabled).toBe(false);

  const row = page.locator(`[data-testid='model-row-${entry.id}']`);
  await page.locator(`[data-testid='model-delete-btn-${entry.id}']`).click();
  await expect(row).toBeVisible();
  await page.locator(`[data-testid='model-delete-confirm-${entry.id}']`).click();
  await expect(page.locator("[data-testid^='model-row-']")).toHaveCount(0);
  await expect(page.locator("[data-testid='models-empty-state']")).toBeVisible();
  await expect.poll(async () => (await readServerModels()).file.models.length).toBe(0);
});

test("an old cloud entry is listed as unavailable, writes nothing, and can be deleted (P4, W3)", async ({
  page,
}) => {
  const cloud = cloudEntry({ displayName: "Old Opus" });
  await seedModels(fileOf([cloud], null));
  await page.reload();
  await gotoModelsTab(page);

  const modal = page.locator(SETTINGS_MODAL);
  await expect(modal).toContainText(providerHeading("anthropic"));
  await expect(page.locator(`[data-testid='model-row-${cloud.id}']`)).toContainText("Old Opus");
  await expect(page.locator(`[data-testid='model-unavailable-${cloud.id}']`)).toHaveText(
    MODEL_UNAVAILABLE_TEXT,
  );
  const def = page.locator(`[data-testid='model-default-${cloud.id}']`);
  const toggle = page.locator(`[data-testid='model-toggle-${cloud.id}']`);
  await expect(def).toHaveAttribute("aria-disabled", "true");
  await expect(toggle).toHaveAttribute("aria-disabled", "true");

  const { etag } = await readServerModels();
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/models") {
      posts.push(req.postData() ?? "");
    }
  });
  await def.click({ force: true });
  await toggle.click({ force: true });

  // The positive anchor: the View window opens and closes, focus returning.
  const view = page.locator(`[data-testid='model-edit-btn-${cloud.id}']`);
  await expect(view).toHaveText("View");
  await view.click();
  await expect(page.locator("[data-testid='model-edit-unavailable-provider']")).toHaveText(
    providerHeading("anthropic"),
  );
  await expect(page.locator("[data-testid='model-edit-provider-note']")).toHaveText(
    MODEL_UNAVAILABLE_TEXT,
  );
  const close = page.locator("[data-testid='model-edit-unavailable-close']");
  await expect(close).toBeFocused();
  await close.click();
  await expect(page.locator(MODAL)).toHaveCount(0);
  await expect(view).toBeFocused();

  // Only now: nothing was sent, and the server still holds what was seeded.
  expect(posts).toEqual([]);
  expect((await readServerModels()).etag).toBe(etag);
  await expect(def).not.toBeChecked();
  await expect(toggle).toBeChecked();

  // Delete works on it.
  await page.locator(`[data-testid='model-delete-btn-${cloud.id}']`).click();
  await page.locator(`[data-testid='model-delete-confirm-${cloud.id}']`).click();
  await expect.poll(async () => (await readServerModels()).file.models.length).toBe(0);

  // And Add offers no cloud provider.
  await page.locator(ADD_BTN).click();
  const options = await page
    .locator("[data-testid='model-edit-provider'] option")
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(options.length).toBeGreaterThan(0);
  expect(options.filter((v) => !v.startsWith("local-"))).toEqual([]);
  await page.locator("[data-testid='model-edit-cancel']").click();
});

// The legacy plaintext-key migration banner was removed in #1123 M2b: the store
// loads from the `.strict()` server (never carries `_legacyApiKey`), so
// `hasLegacyKeys` could never be true. Legacy plaintext in localStorage is
// dropped by the reconcile's `projectEntry` (R2-D). No banner, no test.

test("v2 → current schema migration boot — settings survive; a model added lands on the server", async ({
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
  await addThroughWindow(page, "migration-sentinel", "Migration sentinel");

  await expect
    .poll(async () => (await readServerModels()).file.models.map((m) => m.displayName))
    .toEqual(["Migration sentinel"]);
  // A model write never touches the browser settings blob (the registry is the
  // server's), so make a real settings write to flush the migrated shape.
  await page.locator("[data-testid='settings-modal-tab-appearance']").click();
  await page.locator("[data-testid='text-size-s-btn']").click();
  const stored = () =>
    page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, TANDEM_SETTINGS_KEY);
  await expect.poll(async () => (await stored())?.textSize).toBe("s");
  const settings = await stored();
  expect(settings?.theme).toBe("dark");
  expect(settings?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  // The registry is the server's: the browser blob holds no copy of the entry.
  expect(JSON.stringify(settings)).not.toContain("migration-sentinel");
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
  // mount. The original setItem is stashed on `window.__origSetItem` so the
  // test can restore it after assertion.
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

  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as unknown as { __settingsWrites: string[] }).__settingsWrites.length,
        ),
      { timeout: 300, intervals: [50, 100, 100, 50] },
    )
    .toBe(0);

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
