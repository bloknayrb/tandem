/**
 * Logging-hygiene contract for `createModels` (#659 Wave 2 PR 8a).
 *
 * The Models registry stores API keys and (for local providers) endpoint
 * URLs in plaintext localStorage today. The disclosure banner in
 * `SettingsModelsTab.svelte` makes that explicit to the user. What the
 * user does NOT consent to is having the key text echoed into a thrown
 * Error message, a `console.warn`, or any other surface a future
 * exception handler might log to disk or telemetry.
 *
 * This file pins the invariant: no error message produced by the CRUD
 * facade may contain the literal `apiKey` or `endpoint` value supplied
 * in the call.
 */

import { describe, expect, it } from "vitest";
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
    schemaVersion: 3,
    primaryTab: "annotations",
    panelOrder: "chat-editor-annotations",
    editorWidthPercent: 100,
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
    holdAnnotationsWhileOffline: true,
    marginView: false,
    models: initialModels,
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

describe("createModels — error messages never leak apiKey or endpoint values", () => {
  it("addModel with bad provider — error stringifies without the apiKey", () => {
    const state = makeStubState();
    const models = createModels(state);
    let caught: unknown = null;
    try {
      models.addModel({
        // @ts-expect-error — runtime guard under test.
        provider: "invalid",
        displayName: "x",
        modelId: "x",
        apiKey: LEAKY_KEY,
        enabled: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(LEAKY_KEY);
    // Stack traces also bear the message; verify there too.
    expect((caught as Error).stack ?? "").not.toContain(LEAKY_KEY);
  });

  it("addModel with bad provider — error stringifies without the endpoint", () => {
    const state = makeStubState();
    const models = createModels(state);
    let caught: unknown = null;
    try {
      models.addModel({
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

  it("updateModel with bad provider — error stringifies without the apiKey", () => {
    const state = makeStubState();
    const models = createModels(state);
    const id = models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      apiKey: LEAKY_KEY,
      enabled: true,
    });

    let caught: unknown = null;
    try {
      models.updateModel(id, {
        // @ts-expect-error — runtime guard under test.
        provider: "invalid",
        apiKey: `${LEAKY_KEY}-rotated`,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(LEAKY_KEY);
    expect((caught as Error).message).not.toContain(`${LEAKY_KEY}-rotated`);
  });
});
