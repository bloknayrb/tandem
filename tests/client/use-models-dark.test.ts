// @vitest-environment happy-dom

/**
 * The Models store while local models are dark (#1123 M2), moved out of
 * `use-models.test.ts` so that file holds in either state of the flag. The
 * guard pinned: `loadFromServer`'s `BYO_MODELS_ENABLED` early return in
 * `useModels.svelte.ts` — a dark build never fetches `GET /api/models`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetModelsStoreForTests,
  getModelsSnapshot,
  loadFromServer,
} from "../../src/client/hooks/useModels.svelte.js";

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

beforeEach(() => {
  _resetModelsStoreForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("models store, dark", () => {
  it("loadFromServer does NO fetch while dark (BYO_MODELS_ENABLED=false)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await loadFromServer();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getModelsSnapshot().models).toEqual([]);
  });
});
