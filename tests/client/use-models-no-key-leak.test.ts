// @vitest-environment happy-dom

/**
 * Logging-hygiene contract for `createModels` (#659).
 *
 * The Models registry stores API keys in the OS keychain via `POST
 * /api/models/secrets/:ref`. The plaintext travels through `addModel` /
 * `updateModel` as a separate `plaintextApiKey` argument — it must never
 * reach an Error message, console.warn, or any other surface that a
 * future exception handler might log to disk or telemetry.
 *
 * This file pins the invariant: no error produced by the CRUD facade may
 * contain the literal plaintext or endpoint values supplied in the call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels } from "../../src/client/hooks/useModels.svelte.js";
import type {
  ModelRegistryEntry,
  TandemSettings,
  TandemSettingsState,
} from "../../src/client/hooks/useTandemSettings.svelte.js";

function makeStubState(initialModels: ModelRegistryEntry[] = []): TandemSettingsState {
  let inner: TandemSettings = {
    leftPanelVisible: false,
    rightPanelVisible: true,
    schemaVersion: 7,
    primaryTab: "annotations",
    panelOrder: "chat-editor-annotations",
    editorMeasure: "comfortable",
    selectionDwellMs: 1000,
    showAuthorship: true,
    reduceMotion: false,
    textSize: "m",
    theme: "system",
    accentHue: 275,
    editorFont: "serif",
    density: "cozy",
    defaultMode: "tandem",
    highContrast: false,
    annotationPatterns: false,
    selectionToolbar: true,
    soloRailHidden: true,
    degradedBannerDelayMs: 30000,
    sidecarRetryStrategy: "exponential",
    marginView: false,
    models: initialModels,
    defaultModelId: null,
  };
  return {
    get settings() {
      return inner;
    },
    updateSettings(partial) {
      if (inner._readOnly) return;
      inner = { ...inner, ...partial };
    },
  };
}

// Distinctive sentinel values — easy to grep for in error strings.
const LEAKY_KEY = "SECRETSENTINEL_apikey_abcdef1234567890";
const LEAKY_ENDPOINT = "https://SECRETSENTINEL.example/v1";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createModels — error messages never leak apiKey or endpoint values", () => {
  it("addModel with bad provider — error stringifies without the plaintext key", async () => {
    const state = makeStubState();
    const models = createModels(state);
    let caught: unknown = null;
    try {
      await models.addModel(
        {
          // @ts-expect-error — runtime guard under test.
          provider: "invalid",
          displayName: "x",
          modelId: "x",
          enabled: true,
        },
        LEAKY_KEY,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(LEAKY_KEY);
    expect((caught as Error).stack ?? "").not.toContain(LEAKY_KEY);
  });

  it("addModel with bad provider — error stringifies without the endpoint", async () => {
    const state = makeStubState();
    const models = createModels(state);
    let caught: unknown = null;
    try {
      await models.addModel({
        // @ts-expect-error — runtime guard under test.
        provider: "invalid",
        displayName: "x",
        modelId: "x",
        endpoint: LEAKY_ENDPOINT,
        enabled: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(LEAKY_ENDPOINT);
    expect((caught as Error).stack ?? "").not.toContain(LEAKY_ENDPOINT);
  });

  it("updateModel with bad provider — error stringifies without the plaintext", async () => {
    const state = makeStubState();
    // First call: succeed by returning 204.
    let storeCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        storeCalls++;
        return new Response(null, { status: 204 });
      }),
    );
    const models = createModels(state);
    const id = await models.addModel(
      {
        provider: "anthropic",
        displayName: "A",
        modelId: "claude-opus-4-7",
        enabled: true,
      },
      LEAKY_KEY,
    );
    expect(storeCalls).toBe(1);

    let caught: unknown = null;
    try {
      await models.updateModel(
        id,
        {
          // @ts-expect-error — runtime guard under test.
          provider: "invalid",
        },
        `${LEAKY_KEY}-rotated`,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(LEAKY_KEY);
    expect((caught as Error).message).not.toContain(`${LEAKY_KEY}-rotated`);
  });

  it("storeSecret 503 error does not include the plaintext", async () => {
    const state = makeStubState();
    const models = createModels(state);
    let caught: unknown = null;
    try {
      await models.addModel(
        {
          provider: "anthropic",
          displayName: "A",
          modelId: "claude-opus-4-7",
          enabled: true,
        },
        LEAKY_KEY,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(LEAKY_KEY);
    expect((caught as Error).stack ?? "").not.toContain(LEAKY_KEY);
  });
});
