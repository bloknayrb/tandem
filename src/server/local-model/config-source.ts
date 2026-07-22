/**
 * Local-model config resolution (#1123 M1a, ADR-039).
 *
 * Resolves the collaborator loop's `{endpoint, modelId, transport}` from the
 * server-side Models registry (`src/server/models/`) — no browser session
 * required. Reads the in-memory registry cache SYNCHRONOUSLY (the collaborator's
 * `resolveConfig` seam is `() => LocalModelConfig | null`); the cache is warmed
 * at boot by `primeModelStoreCache()` before the collaborator starts.
 *
 * The collaborator still resolves this ONCE at boot and caches it (M1a makes no
 * collaborator change, per D-C). Dynamic re-resolution after a post-boot config
 * change is deferred to M4 (see the TODO(M4) in collaborator.ts) — while
 * `BYO_MODELS_ENABLED` is false the loop never subscribes, so this is inert.
 *
 * Inert (returns null) when: no default set, the default entry is missing or
 * disabled, the default is a CLOUD provider (cloud BYO keys are v1.1 — the loop
 * only drives local endpoints), the entry has no endpoint, or the endpoint
 * fails the loopback check. The engine re-validates the endpoint at fetch time
 * (validate-at-use / TOCTOU); this resolve-time check is defense-in-depth.
 */
import { isLocalProvider } from "../../shared/models/contract.js";
import { getCachedModelsFile } from "../models/registry.js";
import { type LocalModelConfig, validateEndpoint } from "./config.js";

export function resolveLocalModelConfig(): LocalModelConfig | null {
  try {
    const file = getCachedModelsFile();
    if (!file.defaultModelId) return null;
    const entry = file.models.find((m) => m.id === file.defaultModelId);
    if (!entry || !entry.enabled) return null;
    if (!isLocalProvider(entry.provider)) return null; // cloud default → inert (v1.1)
    if (!entry.endpoint) return null;
    if (!validateEndpoint(entry.endpoint).ok) return null;
    return {
      endpoint: entry.endpoint,
      modelId: entry.modelId,
      // Both local kinds (Ollama, llama.cpp) expose an OpenAI-compatible
      // `/v1/chat/completions`, so `v1` is uniform for now. Ollama-native
      // `/api/chat` can become an optional per-entry transport later (M2/M4).
      transport: "v1",
    };
  } catch {
    // No error channel on this seam — a resolution failure means "inert".
    return null;
  }
}
