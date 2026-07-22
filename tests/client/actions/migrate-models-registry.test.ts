import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetModelsMigrationGuardForTests,
  MODELS_MIGRATED_FLAG_KEY,
  migrateModelsRegistryOnce,
} from "../../../src/client/actions/migrate-models-registry";
import { CURRENT_SCHEMA_VERSION } from "../../../src/client/hooks/useTandemSettings.js";
import { TANDEM_SETTINGS_KEY } from "../../../src/shared/constants.js";

const localModel = {
  id: "m-1",
  provider: "local-ollama",
  displayName: "Local",
  modelId: "qwen2.5:14b",
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
};

function seedSettings(over: Record<string, unknown> = {}): void {
  localStorage.setItem(
    TANDEM_SETTINGS_KEY,
    JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      models: [localModel],
      defaultModelId: "m-1",
      ...over,
    }),
  );
}

function okFetch() {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
}

describe("migrateModelsRegistryOnce", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetModelsMigrationGuardForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the projected registry once and sets the flag", async () => {
    seedSettings();
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await migrateModelsRegistryOnce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/models");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.models[0].id).toBe("m-1");
    expect(body.defaultModelId).toBe("m-1");
    expect(localStorage.getItem(MODELS_MIGRATED_FLAG_KEY)).toBe("1");
  });

  it("drops the transient _legacyApiKey from the projection", async () => {
    seedSettings({ models: [{ ...localModel, _legacyApiKey: "sk-PLAINTEXT" }] });
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await migrateModelsRegistryOnce();

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.models[0]).not.toHaveProperty("_legacyApiKey");
    expect(JSON.stringify(body)).not.toContain("sk-PLAINTEXT");
  });

  it("does NOT POST when settings are _readOnly (downgraded client must not clobber)", async () => {
    // A stored schemaVersion newer than this build → loadSettings tags _readOnly.
    seedSettings({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await migrateModelsRegistryOnce();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT POST when there are no models", async () => {
    seedSettings({ models: [], defaultModelId: null });
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await migrateModelsRegistryOnce();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT POST when the flag is already set (idempotent)", async () => {
    seedSettings();
    localStorage.setItem(MODELS_MIGRATED_FLAG_KEY, "1");
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await migrateModelsRegistryOnce();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the flag unset when the POST fails (retries next boot)", async () => {
    seedSettings();
    const fetchMock = vi.fn(() => Promise.resolve(new Response("nope", { status: 500 })));
    vi.stubGlobal("fetch", fetchMock);

    await migrateModelsRegistryOnce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(MODELS_MIGRATED_FLAG_KEY)).toBeNull();
  });

  it("runs at most once per session (module guard)", async () => {
    seedSettings();
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await migrateModelsRegistryOnce();
    await migrateModelsRegistryOnce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
