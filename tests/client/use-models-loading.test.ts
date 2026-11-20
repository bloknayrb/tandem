// @vitest-environment happy-dom

/**
 * `loading` / `reload` are flag-gated (`loadFromServer` early-returns while dark),
 * so this file mocks `BYO_MODELS_ENABLED=true` to exercise the lit path. This is
 * the ONLY seam used for flag-on coverage — a `vi.mock` of the constant, NOT a
 * runtime env/define override (the production const is a plain literal, `true` since 0.32; a
 * build-define would crash the vite client bundle — see #1123's M2b plan §3.8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  // Pinned true here so the lit path is tested whatever the production literal
  // says (it is `true` since 0.32), without widening the export type.
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
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

  it("sets loadFailed (and saveError) on a failed load; a successful reload clears both", async () => {
    // First GET fails (500), second (reload) succeeds.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ file: serverFile, etag: "e-ok" }), { status: 200 });
      }),
    );
    const models = createModels();

    await loadFromServer();
    expect(models.loadFailed).toBe(true);
    expect(models.loading).toBe(false);
    expect(models.saveError).toBeTruthy();
    expect(models.models).toEqual([]); // empty ONLY because the load failed

    await models.reload();
    expect(models.loadFailed).toBe(false);
    expect(models.saveError).toBeNull();
    expect(models.models.map((m) => m.id)).toEqual(["srv-1"]);
  });
});

// #1123 (R1.3): `loaded` says the list has loaded in this page, for the
// first-run window. The lit design, quoted from the brief on #1123
// (issuecomment-6965850014, R1.3): "one `$state` set true when the first load
// succeeds and never set false, exposed on `ModelsState`, reset in
// `_resetModelsStoreForTests`."
describe("models store — loaded (flag mocked ON)", () => {
  function failThenSucceed(failures: number) {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call <= failures) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ file: serverFile, etag: "e-ok" }), { status: 200 });
      }),
    );
  }

  it("is false before and during the first load, and true after it succeeds", async () => {
    const models = createModels();
    expect(models.loaded).toBe(false);
    const p = loadFromServer();
    expect(models.loaded).toBe(false);
    await p;
    expect(models.loaded).toBe(true);
  });

  // The one user the window is for has no model saved: an empty list that
  // loaded is loaded. A getter that tracked the list's size would fail here.
  it("is true after a successful load of an empty list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              file: { schemaVersion: 1, models: [], defaultModelId: null },
              etag: "e-empty",
            }),
            { status: 200 },
          ),
      ),
    );
    const models = createModels();
    await loadFromServer();
    expect(models.models).toEqual([]);
    expect(models.loaded).toBe(true);
  });

  it("stays true after a later failed reload", async () => {
    const models = createModels();
    await loadFromServer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await models.reload();
    expect(models.loadFailed).toBe(true);
    expect(models.loaded).toBe(true);
  });

  it("is false after a failed first load, and true once a reload succeeds", async () => {
    failThenSucceed(1);
    const models = createModels();
    await loadFromServer();
    expect(models.loaded).toBe(false);
    await models.reload();
    expect(models.loaded).toBe(true);
  });

  it("is false again after the test reset", async () => {
    const models = createModels();
    await loadFromServer();
    expect(models.loaded).toBe(true);
    _resetModelsStoreForTests();
    expect(models.loaded).toBe(false);
  });
});
