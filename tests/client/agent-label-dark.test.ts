// @vitest-environment happy-dom

/**
 * Dark-guarantee regression test for the agent-label source (#1123 M2).
 *
 * M2 relocated the Models registry to a server-authoritative store. The agent
 * LABEL (annotation bylines, status pill, aria-labels) must stay byte-identical
 * while dark (`BYO_MODELS_ENABLED=false`). The trap: a user who configured a
 * cloud model under v0.13.x — BEFORE `BYO_MODELS_ENABLED` existed, when the
 * Models tab + first-run picker shipped reachable — carries that model in
 * localStorage, and pre-M2 the label resolved from there ("GPT"/"Claude"). If the
 * label read the (empty, unfetched-while-dark) store instead, their byline would
 * silently regress to "Assistant". `agentLabelSource()` guards this by reading
 * localStorage settings while dark and the store only when lit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetModelsStoreForTests,
  agentLabelSource,
  getModelsSnapshot,
} from "../../src/client/hooks/useModels.svelte.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/client/hooks/useTandemSettings.js";
import { FALLBACK_AGENT_LABEL, resolveAgentLabel } from "../../src/client/utils/agentLabel.js";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants.js";

function seedLocalStorageModel(entry: Record<string, unknown>, defaultModelId: string): void {
  localStorage.setItem(
    TANDEM_SETTINGS_KEY,
    JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, models: [entry], defaultModelId }),
  );
}

beforeEach(() => {
  localStorage.clear();
  _resetModelsStoreForTests(); // store starts empty, exactly as while dark (no load)
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agentLabelSource — dark invariant (BYO_MODELS_ENABLED=false)", () => {
  it("resolves a v0.13.x cohort's configured cloud model from localStorage, NOT the empty store", () => {
    seedLocalStorageModel(
      { id: "m1", provider: "openai", displayName: "My GPT", modelId: "gpt-4o", enabled: true },
      "m1",
    );

    // The pure store snapshot is empty (never loaded while dark) …
    expect(getModelsSnapshot().models).toEqual([]);
    // … but the LABEL source reads localStorage, so the byline stays "GPT".
    const source = agentLabelSource();
    expect(source.models.map((m) => m.id)).toEqual(["m1"]);
    expect(resolveAgentLabel(source, "family")).toBe("GPT");
    expect(resolveAgentLabel(source, "model")).toBe("My GPT");
  });

  it("falls back to 'Assistant' when localStorage has no configured model (common dark case)", () => {
    // No seed → loadSettings returns the default empty registry.
    expect(agentLabelSource().models).toEqual([]);
    expect(resolveAgentLabel(agentLabelSource(), "family")).toBe(FALLBACK_AGENT_LABEL);
  });
});
