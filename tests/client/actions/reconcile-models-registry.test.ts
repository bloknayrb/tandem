// @vitest-environment happy-dom

/**
 * Tests for the localStorage→server reconcile (#1123 M2), which replaces the M1a
 * seeder. It GETs the current server ETag, POSTs the projected localStorage
 * registry as `{ file, ifMatch }`, sets a NEW flag on success/409-adopt, and
 * settles the store's reconcile gate on success or a *confirmed skip* (not on a
 * real POST failure — R2-B).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetModelsReconcileGuardForTests,
  MODELS_RECONCILED_FLAG_KEY,
  reconcileModelsToServerOnce,
} from "../../../src/client/actions/reconcile-models-registry";
import {
  _resetModelsStoreForTests,
  createModels,
  initializeStore,
} from "../../../src/client/hooks/useModels.svelte.js";
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

/** GET → {file, etag}; POST → `postStatus`. */
function stubFetch(postStatus = 200) {
  return vi.fn(async (_url: string, init?: { method?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          file: { schemaVersion: 1, models: [], defaultModelId: null },
          etag: "e0",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: postStatus < 400 }), { status: postStatus });
  });
}

/** The POST body of the (last) POST call in a fetch mock. */
function postBody(mock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const call = mock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );
  return JSON.parse((call![1] as RequestInit).body as string);
}

beforeEach(() => {
  localStorage.clear();
  _resetModelsReconcileGuardForTests();
  _resetModelsStoreForTests(); // rearm the reconcile gate
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reconcileModelsToServerOnce", () => {
  it("GETs the etag then POSTs the projected registry as {file, ifMatch}, sets the flag", async () => {
    seedSettings();
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await reconcileModelsToServerOnce();

    expect(outcome).toBe("reconciled");
    const methods = fetchMock.mock.calls.map(([, i]) => (i as RequestInit)?.method ?? "GET");
    expect(methods).toEqual(["GET", "POST"]);
    const body = postBody(fetchMock);
    expect(body.ifMatch).toBe("e0");
    // Assert the WHOLE projected entry — a dropped field (e.g. `endpoint`) would
    // ship green here and only 400 against the real server.
    expect((body.file as { models: unknown[] }).models[0]).toEqual(localModel);
    expect((body.file as { defaultModelId: string }).defaultModelId).toBe("m-1");
    expect(localStorage.getItem(MODELS_RECONCILED_FLAG_KEY)).toBe("1");
  });

  it("initializeStore settles the CRUD gate on reconcile success (a later write does not hang)", async () => {
    seedSettings();
    vi.stubGlobal("fetch", stubFetch());
    await initializeStore();
    // If the gate were still pending, this write would never resolve.
    await expect(createModels().setDefault(null)).resolves.toBeUndefined();
  });

  it("preserves apiKeyRef and params in the projection", async () => {
    const rich = { ...localModel, apiKeyRef: "ref-xyz", params: { temperature: 0.4 } };
    seedSettings({ models: [rich] });
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    await reconcileModelsToServerOnce();
    expect((postBody(fetchMock).file as { models: unknown[] }).models[0]).toEqual(rich);
  });

  it("drops the transient _legacyApiKey from the projection", async () => {
    seedSettings({ models: [{ ...localModel, _legacyApiKey: "sk-PLAINTEXT" }] });
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    await reconcileModelsToServerOnce();
    const body = postBody(fetchMock);
    expect((body.file as { models: Record<string, unknown>[] }).models[0]).not.toHaveProperty(
      "_legacyApiKey",
    );
    expect(JSON.stringify(body)).not.toContain("sk-PLAINTEXT");
  });

  it("does NOT fetch when settings are _readOnly (downgraded client must not clobber)", async () => {
    seedSettings({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await reconcileModelsToServerOnce();
    expect(outcome).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
    // A confirmed skip still opens the gate via initializeStore.
    _resetModelsReconcileGuardForTests();
    _resetModelsStoreForTests();
    await initializeStore();
    await expect(createModels().setDefault(null)).resolves.toBeUndefined();
  });

  it("does NOT fetch when there are no models", async () => {
    seedSettings({ models: [], defaultModelId: null });
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    await reconcileModelsToServerOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT fetch when the flag is already set (idempotent)", async () => {
    seedSettings();
    localStorage.setItem(MODELS_RECONCILED_FLAG_KEY, "1");
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    await reconcileModelsToServerOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the flag unset when the POST fails (retries next boot)", async () => {
    seedSettings();
    const fetchMock = stubFetch(500);
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await reconcileModelsToServerOnce();
    expect(outcome).toBe("failed");
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === "POST")).toBe(true);
    expect(localStorage.getItem(MODELS_RECONCILED_FLAG_KEY)).toBeNull();
  });

  it("a failed reconcile leaves the CRUD gate CLOSED (initializeStore does not open it)", async () => {
    seedSettings();
    vi.stubGlobal("fetch", stubFetch(500));
    await initializeStore(); // reconcile fails → gate must stay pending
    // The write blocks on the never-settled gate; assert it does NOT resolve
    // within a turn of the event loop (Promise.race against a microtask sentinel).
    let resolved = false;
    void createModels()
      .setDefault(null)
      .then(() => {
        resolved = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it("adopts the server and sets the flag on a 409 (a concurrent writer won)", async () => {
    seedSettings();
    const fetchMock = stubFetch(409);
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await reconcileModelsToServerOnce();
    expect(outcome).toBe("reconciled");
    expect(localStorage.getItem(MODELS_RECONCILED_FLAG_KEY)).toBe("1");
  });

  it("runs at most once per session (module guard)", async () => {
    seedSettings();
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    await reconcileModelsToServerOnce();
    await reconcileModelsToServerOnce();
    // One GET + one POST from the first call only.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
