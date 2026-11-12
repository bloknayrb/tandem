// @vitest-environment happy-dom

/**
 * #2404 — what each of the three callers of the two settings routes does when
 * the server answers 403 `OWN_WINDOW_ONLY` (this page is not Tandem's own
 * window): it latches the shared "blocked" state, never shows the click as
 * applied, and gives a plain reason where a surface outside the Models tab
 * needs one. Also: the reconcile action marks its write as the reconcile.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as false,
}));

const { _resetLocalModelSettingsForTests, createLocalModelSettings } = await import(
  "../../src/client/hooks/useLocalModelSettings.svelte.js"
);
const { _resetModelsStoreForTests, _settleReconcile, createModels } = await import(
  "../../src/client/hooks/useModels.svelte.js"
);
const { _resetModelsWriteAccessForTests, _setPageOriginForTests, createModelsWriteAccess } =
  await import("../../src/client/hooks/useModelsWriteAccess.svelte.js");
const {
  _resetModelsReconcileGuardForTests,
  MODELS_RECONCILED_FLAG_KEY,
  reconcileModelsToServerOnce,
} = await import("../../src/client/actions/reconcile-models-registry.js");
const { CURRENT_SCHEMA_VERSION } = await import("../../src/client/hooks/useTandemSettings.js");
const { TANDEM_SETTINGS_KEY } = await import("../../src/shared/constants.js");

const REFUSAL = {
  error: "FORBIDDEN",
  code: "OWN_WINDOW_ONLY",
  message: "Local-model settings can only be changed in Tandem's own window.",
};

interface Call {
  url: string;
  method: string;
  body?: unknown;
}
let calls: Call[] = [];
/** How the fake server answers a POST to a settings route. */
let postAnswer: () => Response;
/** How it answers a GET of the editing setting; null = a network error. */
let editingOnServer: boolean | null = true;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  calls = [];
  editingOnServer = true;
  postAnswer = () => json(403, REFUSAL);
  localStorage.clear();
  _resetModelsWriteAccessForTests();
  // A development page: live until the server says otherwise.
  _setPageOriginForTests("http://127.0.0.1:5173");
  _resetLocalModelSettingsForTests();
  _resetModelsStoreForTests();
  _resetModelsReconcileGuardForTests();
  _settleReconcile();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({
        url: String(url),
        method,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      if (String(url).includes("/secrets/")) {
        return new Response(method === "DELETE" ? '{"existed":true}' : null, {
          status: method === "DELETE" ? 200 : 204,
        });
      }
      if (method === "POST") return postAnswer();
      if (String(url).endsWith("/local-settings")) {
        if (editingOnServer === null) throw new TypeError("fetch failed");
        return json(200, { editing: editingOnServer });
      }
      return json(200, {
        file: { schemaVersion: 1, models: [], defaultModelId: null },
        etag: "e0",
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _resetModelsWriteAccessForTests();
});

const LOCAL = {
  provider: "local-ollama" as const,
  displayName: "Local",
  modelId: "qwen2.5:14b",
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
};

describe("useModels — a refused write", () => {
  it("rolls back, latches the blocked state, and leaves the server's plain reason as the error", async () => {
    const models = createModels();
    const access = createModelsWriteAccess();
    expect(access.blocked).toBe(false);

    expect(await models.addModel(LOCAL)).toBeNull();

    expect(models.models).toEqual([]);
    expect(models.saveError).toBe(REFUSAL.message);
    expect(access.blocked).toBe(true);
    // One POST: a refusal is not retried like a busy or stale answer.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("after one refusal, a save with an API key stores no secret and sends nothing", async () => {
    const models = createModels();
    await models.addModel(LOCAL);
    calls = [];

    expect(
      await models.addModel(
        { ...LOCAL, provider: "anthropic", endpoint: undefined },
        "sk-test-DO-NOT-USE",
      ),
    ).toBeNull();

    expect(calls).toEqual([]);
    expect(models.saveError).toBe(REFUSAL.message);
  });

  it("a 403 with another code is an ordinary failure and does not latch", async () => {
    postAnswer = () => json(403, { error: "FORBIDDEN", code: "BAD_ORIGIN" });
    const models = createModels();
    expect(await models.addModel(LOCAL)).toBeNull();
    expect(models.saveError).toBe("Failed to save model changes.");
    expect(createModelsWriteAccess().blocked).toBe(false);
  });
});

describe("useLocalModelSettings — a refused switch", () => {
  it("from a known value: the box goes back to what the server holds, with no per-click message and no second read", async () => {
    const s = createLocalModelSettings();
    await s.load();
    expect(s.editing).toBe(true);
    calls = [];

    await s.setEditing(false);

    expect(s.known).toBe(true);
    expect(s.editing).toBe(true); // never shown as switched off
    expect(s.saveNotice).toBeNull(); // the tab's one notice is the reason
    expect(s.loadFailed).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(createModelsWriteAccess().blocked).toBe(true);
  });

  it("from an unknown value (Switch off while the read had failed): it ends unknown, never unticked", async () => {
    editingOnServer = null;
    const s = createLocalModelSettings();
    await s.load();
    expect(s.known).toBe(false);
    calls = [];

    await s.setEditing(false);

    expect(s.known).toBe(false);
    expect(s.loadFailed).toBe(true);
    expect(s.saveNotice).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(createModelsWriteAccess().blocked).toBe(true);
  });
});

describe("the one-time reconcile", () => {
  function seed(): void {
    localStorage.setItem(
      TANDEM_SETTINGS_KEY,
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        models: [{ id: "m-1", ...LOCAL }],
        defaultModelId: "m-1",
      }),
    );
  }

  it("marks its write as the reconcile, so the server does not tell the user 'your change…' for it", async () => {
    postAnswer = () => json(200, { etag: "e1" });
    seed();
    expect(await reconcileModelsToServerOnce()).toBe("reconciled");
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { reconcile?: unknown }).reconcile).toBe(true);
    expect(Object.keys(post?.body as object).sort()).toEqual(["file", "ifMatch", "reconcile"]);
  });

  it("refused: it is retried at the next start (flag unset), logged, and the tab will say why", async () => {
    seed();
    expect(await reconcileModelsToServerOnce()).toBe("failed");
    expect(localStorage.getItem(MODELS_RECONCILED_FLAG_KEY)).toBeNull();
    expect(createModelsWriteAccess().blocked).toBe(true);
  });
});
