// @vitest-environment happy-dom

/**
 * `loading` / `reload` are flag-gated (`loadFromServer` early-returns while dark),
 * so this file mocks `BYO_MODELS_ENABLED=true` to exercise the lit path. This is
 * the ONLY seam used for flag-on coverage — a `vi.mock` of the constant, NOT a
 * runtime env/define override (the production const stays a literal `false`; a
 * build-define would crash the vite client bundle — see the M2b plan §3.8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/shared/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true,
}));

const { _resetModelsStoreForTests, createModels, loadFromServer } = await import(
  "../../src/client/hooks/useModels.svelte.js"
);

const serverFile = {
  schemaVersion: 1,
  models: [
    {
      id: "srv-1",
      provider: "local-ollama",
      displayName: "Local",
      modelId: "qwen2.5:14b",
      enabled: true,
    },
  ],
  defaultModelId: "srv-1",
};

let getCount = 0;

function stubGet() {
  return vi.fn(async () => {
    getCount++;
    return new Response(JSON.stringify({ file: serverFile, etag: `e-${getCount}` }), {
      status: 200,
    });
  });
}

beforeEach(() => {
  getCount = 0;
  _resetModelsStoreForTests();
  vi.stubGlobal("fetch", stubGet());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("models store — loading / reload (flag mocked ON)", () => {
  it("loadFromServer toggles loading true→false and populates from the server", async () => {
    const models = createModels();
    expect(models.loading).toBe(false);

    const p = loadFromServer(); // synchronous flag check + `_loading = true` before the await
    expect(models.loading).toBe(true);

    await p;
    expect(models.loading).toBe(false);
    expect(models.models.map((m) => m.id)).toEqual(["srv-1"]);
    expect(models.defaultModelId).toBe("srv-1");
  });

  it("reload re-fetches even after a completed load (clears the in-flight dedup)", async () => {
    const models = createModels();
    await loadFromServer();
    expect(getCount).toBe(1);

    await models.reload();
    expect(getCount).toBe(2); // a second GET actually hit the server
    expect(models.loading).toBe(false);
  });
});
