// @vitest-environment happy-dom

/**
 * A settings READ refused with `OWN_WINDOW_ONLY` logs the Models tab's notice,
 * not a bare status line. In `npm run dev:tauri` (no source server on :3479)
 * the window is the Vite page on `http://127.0.0.1:5173` and the sidecar is a
 * release bundle, so `GET /api/models` answers 403 on every load; the log is
 * where a developer looks first, and it should name `TANDEM_MODELS_DEV_ORIGIN`
 * (the workaround in CONTRIBUTING.md) instead of "→ 403".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

const { _resetModelsStoreForTests, loadFromServer } = await import(
  "../../src/client/hooks/useModels.svelte.js"
);
const { _resetLocalModelSettingsForTests, loadLocalModelSettings } = await import(
  "../../src/client/hooks/useLocalModelSettings.svelte.js"
);
const { _resetModelsWriteAccessForTests, _setPageOriginForTests } = await import(
  "../../src/client/hooks/useModelsWriteAccess.svelte.js"
);
const { ERROR_CODE_OWN_WINDOW_ONLY, MODELS_DEV_ORIGIN_ENV } = await import(
  "../../src/shared/models/contract.js"
);

const DEV_PAGE = "http://127.0.0.1:5173";

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetModelsStoreForTests();
  _resetLocalModelSettingsForTests();
  _resetModelsWriteAccessForTests();
  _setPageOriginForTests(DEV_PAGE);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
  _resetModelsWriteAccessForTests();
});

const loaders = [
  ["GET /api/models", loadFromServer, "[models] load failed"],
  [
    "GET /api/models/local-settings",
    loadLocalModelSettings,
    "[models] local-model settings load failed",
  ],
] as const;

describe.each(loaders)("%s refused as not Tandem's own window", (_name, load, prefix) => {
  it("logs the notice naming the development variable for this page", async () => {
    respond(403, { error: "FORBIDDEN", code: ERROR_CODE_OWN_WINDOW_ONLY, message: "x" });
    await load();
    expect(warn).toHaveBeenCalledTimes(1);
    const [first, detail] = warn.mock.calls[0];
    expect(first).toBe(prefix);
    expect(String(detail)).toContain(`403 ${ERROR_CODE_OWN_WINDOW_ONLY}`);
    expect(String(detail)).toContain(`${MODELS_DEV_ORIGIN_ENV}=${DEV_PAGE}`);
  });

  it.each([
    [403, { error: "FORBIDDEN", message: "Loopback only." }],
    [500, { error: "boom" }],
  ])("logs a plain status error for a %i without the own-window code", async (status, body) => {
    respond(status, body);
    await load();
    const [, detail] = warn.mock.calls[0];
    expect(String(detail)).toContain(`→ ${status}`);
    expect(String(detail)).not.toContain(MODELS_DEV_ORIGIN_ENV);
  });
});
